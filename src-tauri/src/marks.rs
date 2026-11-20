//! Bookmarks and per-book reading settings (milestone 3).
//!
//! Bookmarks are shaped for milestone 4's Grimmory sync, the same way as Katana's tables on Android:
//! they key on the local book id (`books.id`, which links to Grimmory through `books.grimmory_id`),
//! carry a stable `uuid`, `remote_id`, `remote_cfi` and `sync_state`, and a removal of a bookmark that
//! Grimmory already has stays as a tombstone (`deleted_at`) until the removal has gone up.

use crate::db::now;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Tables added in schema 3. Additive only.
pub const SCHEMA_V3: &str = "
CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    fraction REAL,
    page_label TEXT,
    chapter TEXT,
    excerpt TEXT,
    title TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    remote_id INTEGER,
    remote_cfi TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS bookmarks_book ON bookmarks(book_id);
CREATE INDEX IF NOT EXISTS bookmarks_remote ON bookmarks(remote_id);
CREATE TABLE IF NOT EXISTS book_prefs (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    prefs TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
";

/// sync_state values: `local` (made here, not on Grimmory yet), `synced`, `dirty` (changed here since),
/// `deleted` (removed here, the removal still has to go up).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub uuid: String,
    pub book_id: i64,
    pub cfi: String,
    pub fraction: Option<f64>,
    pub page_label: Option<String>,
    pub chapter: Option<String>,
    pub excerpt: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub remote_id: Option<i64>,
    pub sync_state: String,
}

const COLS: &str =
    "id, uuid, book_id, cfi, fraction, page_label, chapter, excerpt, title, note, created_at, updated_at, remote_id, sync_state";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: r.get(0)?,
        uuid: r.get(1)?,
        book_id: r.get(2)?,
        cfi: r.get(3)?,
        fraction: r.get(4)?,
        page_label: r.get(5)?,
        chapter: r.get(6)?,
        excerpt: r.get(7)?,
        title: r.get(8)?,
        note: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        remote_id: r.get(12)?,
        sync_state: r.get(13)?,
    })
}

/// A random v4 UUID. std's RandomState is seeded from the OS's random source on every platform Tauri
/// runs on, and each one built in a thread gets fresh keys, so no extra crate is needed.
fn uuid() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut b = [0u8; 16];
    for chunk in b.chunks_mut(8) {
        let mut h = RandomState::new().build_hasher();
        h.write_i64(now());
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn list(conn: &Connection, book_id: i64) -> rusqlite::Result<Vec<Bookmark>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM bookmarks WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY fraction, created_at"
    ))?;
    let rows = st.query_map([book_id], row)?;
    rows.collect()
}

pub struct NewMark<'a> {
    pub book_id: i64,
    pub cfi: &'a str,
    pub fraction: Option<f64>,
    pub page_label: Option<&'a str>,
    pub chapter: Option<&'a str>,
    pub excerpt: Option<&'a str>,
}

pub fn add(conn: &Connection, m: &NewMark) -> rusqlite::Result<Bookmark> {
    // the same place twice is one bookmark (Grimmory answers 409 to a second one at the same CFI)
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM bookmarks WHERE book_id = ?1 AND cfi = ?2 AND deleted_at IS NULL",
            params![m.book_id, m.cfi],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return conn.query_row(&format!("SELECT {COLS} FROM bookmarks WHERE id = ?1"), [id], row);
    }
    let t = now();
    conn.execute(
        "INSERT INTO bookmarks (uuid, book_id, cfi, fraction, page_label, chapter, excerpt, created_at, updated_at, sync_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'local')",
        params![uuid(), m.book_id, m.cfi, m.fraction, m.page_label, m.chapter, m.excerpt, t],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row(&format!("SELECT {COLS} FROM bookmarks WHERE id = ?1"), [id], row)
}

/// Removes a bookmark. One Grimmory never had goes at once; one it has stays as a tombstone so the
/// removal can go up in milestone 4.
pub fn remove(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    let remote: Option<Option<i64>> =
        conn.query_row("SELECT remote_id FROM bookmarks WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    match remote {
        Some(Some(_)) => {
            let t = now();
            conn.execute(
                "UPDATE bookmarks SET deleted_at = ?2, updated_at = ?2, sync_state = 'deleted' WHERE id = ?1",
                params![id, t],
            )?;
        }
        Some(None) => {
            conn.execute("DELETE FROM bookmarks WHERE id = ?1", [id])?;
        }
        None => {}
    }
    Ok(())
}

/// Names a bookmark and gives it a note (the marks panel in milestone 4).
pub fn update(conn: &Connection, id: i64, title: Option<&str>, note: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bookmarks SET title = ?2, note = ?3, updated_at = ?4,
             sync_state = CASE sync_state WHEN 'synced' THEN 'dirty' ELSE sync_state END
         WHERE id = ?1",
        params![id, title, note, now()],
    )?;
    Ok(())
}

pub fn book_prefs(conn: &Connection, book_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT prefs FROM book_prefs WHERE book_id = ?1", [book_id], |r| r.get(0)).optional()
}

pub fn set_book_prefs(conn: &Connection, book_id: i64, prefs: Option<&str>) -> rusqlite::Result<()> {
    match prefs {
        Some(p) => conn.execute(
            "INSERT INTO book_prefs (book_id, prefs, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(book_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at",
            params![book_id, p, now()],
        )?,
        None => conn.execute("DELETE FROM book_prefs WHERE book_id = ?1", [book_id])?,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO books (id, title) VALUES (1, 'A');",
        )
        .unwrap();
        c.execute_batch(SCHEMA_V3).unwrap();
        c
    }

    fn mark<'a>(cfi: &'a str, f: f64) -> NewMark<'a> {
        NewMark { book_id: 1, cfi, fraction: Some(f), page_label: Some("3"), chapter: Some("One"), excerpt: Some("It was") }
    }

    #[test]
    fn same_place_is_one_bookmark() {
        let c = db();
        let a = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        let b = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(list(&c, 1).unwrap().len(), 1);
        assert_eq!(a.sync_state, "local");
        assert_eq!(a.uuid.len(), 36);
    }

    #[test]
    fn listed_in_book_order() {
        let c = db();
        add(&c, &mark("epubcfi(/6/8!/4/2)", 0.5)).unwrap();
        add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        let l = list(&c, 1).unwrap();
        assert_eq!(l[0].fraction, Some(0.1));
        assert_ne!(l[0].uuid, l[1].uuid);
    }

    #[test]
    fn removal_keeps_a_tombstone_only_for_synced_marks() {
        let c = db();
        let a = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        let b = add(&c, &mark("epubcfi(/6/8!/4/2)", 0.5)).unwrap();
        c.execute("UPDATE bookmarks SET remote_id = 9, sync_state = 'synced' WHERE id = ?1", [b.id]).unwrap();
        remove(&c, a.id).unwrap();
        remove(&c, b.id).unwrap();
        assert!(list(&c, 1).unwrap().is_empty());
        let left: Vec<(i64, String)> = c
            .prepare("SELECT id, sync_state FROM bookmarks")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, vec![(b.id, "deleted".to_string())]);
        // a bookmark at the same place can be made again after a removal
        let again = add(&c, &mark("epubcfi(/6/8!/4/2)", 0.5)).unwrap();
        assert_ne!(again.id, b.id);
    }

    #[test]
    fn naming_a_synced_mark_makes_it_dirty() {
        let c = db();
        let a = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        c.execute("UPDATE bookmarks SET sync_state = 'synced' WHERE id = ?1", [a.id]).unwrap();
        update(&c, a.id, Some("Name"), None).unwrap();
        let l = list(&c, 1).unwrap();
        assert_eq!(l[0].sync_state, "dirty");
        assert_eq!(l[0].title.as_deref(), Some("Name"));
    }

    #[test]
    fn prefs_round_trip() {
        let c = db();
        assert_eq!(book_prefs(&c, 1).unwrap(), None);
        set_book_prefs(&c, 1, Some("{\"size\":110}")).unwrap();
        set_book_prefs(&c, 1, Some("{\"size\":120}")).unwrap();
        assert_eq!(book_prefs(&c, 1).unwrap().as_deref(), Some("{\"size\":120}"));
        set_book_prefs(&c, 1, None).unwrap();
        assert_eq!(book_prefs(&c, 1).unwrap(), None);
    }
}
