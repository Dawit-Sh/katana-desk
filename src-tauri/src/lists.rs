//! Lists (milestone 7): your own reading lists, kept on this PC. A list holds books from Local and from
//! Grimmory alike, keyed `b:<local id>` or `g:<Grimmory id>` (the same keys as custom covers).

use crate::db::now;
use crate::library::Library;
use crate::{err, Res};
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct List {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// the books' keys, newest first
    pub books: Vec<String>,
}

fn changed(app: &AppHandle) {
    let _ = app.emit("lists-changed", ());
}

fn ok_key(key: &str) -> bool {
    let (kind, id) = key.split_once(':').unwrap_or(("", ""));
    matches!(kind, "b" | "g") && !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())
}

#[tauri::command]
pub fn lists(lib: State<Library>) -> Res<Vec<List>> {
    let conn = lib.db.0.lock().unwrap();
    let mut st = conn.prepare("SELECT id, name, created_at, updated_at FROM lists ORDER BY updated_at DESC").map_err(err)?;
    let mut out: Vec<List> = st
        .query_map([], |r| Ok(List { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, updated_at: r.get(3)?, books: vec![] }))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut st = conn.prepare("SELECT list_id, book FROM list_books ORDER BY added_at DESC").map_err(err)?;
    for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(err)? {
        let (id, book) = r.map_err(err)?;
        if let Some(l) = out.iter_mut().find(|l| l.id == id) {
            l.books.push(book);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn list_create(app: AppHandle, lib: State<Library>, name: String, book: Option<String>) -> Res<i64> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A list needs a name.".into());
    }
    let id = {
        let conn = lib.db.0.lock().unwrap();
        let t = now();
        conn.execute("INSERT INTO lists (name, created_at, updated_at) VALUES (?1, ?2, ?2)", params![name, t]).map_err(err)?;
        let id = conn.last_insert_rowid();
        if let Some(b) = book.filter(|b| ok_key(b)) {
            conn.execute("INSERT OR IGNORE INTO list_books (list_id, book, added_at) VALUES (?1, ?2, ?3)", params![id, b, t]).map_err(err)?;
        }
        id
    };
    changed(&app);
    Ok(id)
}

#[tauri::command]
pub fn list_rename(app: AppHandle, lib: State<Library>, id: i64, name: String) -> Res<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A list needs a name.".into());
    }
    lib.db.0.lock().unwrap().execute("UPDATE lists SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, name, now()]).map_err(err)?;
    changed(&app);
    Ok(())
}

/// Removes a list (the books stay where they are). Returns its books, for Undo.
#[tauri::command]
pub fn list_delete(app: AppHandle, lib: State<Library>, id: i64) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    conn.execute("DELETE FROM list_books WHERE list_id = ?1", [id]).map_err(err)?;
    conn.execute("DELETE FROM lists WHERE id = ?1", [id]).map_err(err)?;
    drop(conn);
    changed(&app);
    Ok(())
}

/// Undo for a removed list: it comes back with its books.
#[tauri::command]
pub fn list_restore(app: AppHandle, lib: State<Library>, name: String, created_at: i64, books: Vec<String>) -> Res<i64> {
    let conn = lib.db.0.lock().unwrap();
    let t = now();
    conn.execute("INSERT INTO lists (name, created_at, updated_at) VALUES (?1, ?2, ?3)", params![name, created_at, t]).map_err(err)?;
    let id = conn.last_insert_rowid();
    for (i, b) in books.iter().rev().enumerate() {
        if ok_key(b) {
            conn.execute("INSERT OR IGNORE INTO list_books (list_id, book, added_at) VALUES (?1, ?2, ?3)", params![id, b, t + i as i64]).map_err(err)?;
        }
    }
    drop(conn);
    changed(&app);
    Ok(id)
}

#[tauri::command]
pub fn list_add(app: AppHandle, lib: State<Library>, id: i64, book: String) -> Res<()> {
    if !ok_key(&book) {
        return Err("Unknown book".into());
    }
    let conn = lib.db.0.lock().unwrap();
    let t = now();
    conn.execute("INSERT OR IGNORE INTO list_books (list_id, book, added_at) VALUES (?1, ?2, ?3)", params![id, book, t]).map_err(err)?;
    conn.execute("UPDATE lists SET updated_at = ?2 WHERE id = ?1", params![id, t]).map_err(err)?;
    drop(conn);
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn list_remove(app: AppHandle, lib: State<Library>, id: i64, book: String) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    conn.execute("DELETE FROM list_books WHERE list_id = ?1 AND book = ?2", params![id, book]).map_err(err)?;
    drop(conn);
    changed(&app);
    Ok(())
}
