//! Change cover (milestone 7): your own cover for any book, kept on this PC. Grimmory's covers are never
//! touched. A book is keyed `b:<local id>` (a file on this PC) or `g:<Grimmory id>` (a Grimmory book, its
//! download included); the screens look a book up under both keys, so a Local copy that turns out to be a
//! Grimmory book keeps the cover you gave either.
//!
//! The picture arrives already framed (2:3, moved and zoomed in the dialog) as a JPEG, and is saved in
//! `<covers>/custom/`. The sources the dialog offers come through here as bytes: Grimmory's full-size
//! cover, the book's own cover, its first page (DjVu and comics; PDFs are drawn by PDF.js in the page),
//! a picture file, and Open Library's covers (https://openlibrary.org, searched by title and author).

use crate::db::{self, now};
use crate::library::Library;
use crate::{err, Res};
use rusqlite::params;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Custom {
    pub key: String,
    pub path: String,
    pub source: Option<String>,
    pub updated_at: i64,
}

fn ok_key(key: &str) -> bool {
    let (kind, id) = key.split_once(':').unwrap_or(("", ""));
    matches!(kind, "b" | "g") && !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())
}

fn dir(lib: &Library) -> PathBuf {
    lib.covers_dir.join("custom")
}

#[tauri::command]
pub fn covers_custom(lib: State<Library>) -> Res<Vec<Custom>> {
    let conn = lib.db.0.lock().unwrap();
    let mut st = conn.prepare("SELECT key, path, source, updated_at FROM custom_covers").map_err(err)?;
    let rows = st
        .query_map([], |r| Ok(Custom { key: r.get(0)?, path: r.get(1)?, source: r.get(2)?, updated_at: r.get(3)? }))
        .map_err(err)?;
    Ok(rows.flatten().filter(|c| Path::new(&c.path).exists()).collect())
}

/// Saves a framed cover. The request's body is the JPEG; headers `key` and `source` say whose and from where.
#[tauri::command]
pub fn cover_save(app: AppHandle, lib: State<Library>, request: Request<'_>) -> Res<Custom> {
    let h = |n: &str| request.headers().get(n).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let key = h("key").unwrap_or_default();
    if !ok_key(&key) {
        return Err("Unknown book".into());
    }
    let source = h("source");
    let InvokeBody::Raw(bytes) = request.body() else { return Err("No picture".into()) };
    image::load_from_memory(bytes).map_err(|_| "That isn't a picture Katana Desk can read.".to_string())?;
    let d = dir(&lib);
    std::fs::create_dir_all(&d).map_err(err)?;
    let t = now();
    let out = d.join(format!("{}-{t}.jpg", key.replace(':', "-")));
    std::fs::write(&out, bytes).map_err(err)?;
    let path = out.to_string_lossy().to_string();
    let old: Option<String> = {
        let conn = lib.db.0.lock().unwrap();
        let old = conn.query_row("SELECT path FROM custom_covers WHERE key = ?1", [&key], |r| r.get(0)).ok();
        conn.execute(
            "INSERT INTO custom_covers (key, path, source, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key) DO UPDATE SET path = excluded.path, source = excluded.source, updated_at = excluded.updated_at",
            params![key, path, source, t],
        )
        .map_err(err)?;
        old
    };
    // the cover it replaces was only ours (in the app's own folder)
    if let Some(o) = old.filter(|o| Path::new(o).starts_with(&d) && *o != path) {
        let _ = std::fs::remove_file(o);
    }
    let _ = app.emit("covers-changed", ());
    Ok(Custom { key, path, source, updated_at: t })
}

/// Back to the original: forgets the custom cover.
#[tauri::command]
pub fn cover_reset(app: AppHandle, lib: State<Library>, key: String) -> Res<()> {
    let old: Option<String> = {
        let conn = lib.db.0.lock().unwrap();
        let old = conn.query_row("SELECT path FROM custom_covers WHERE key = ?1", [&key], |r| r.get(0)).ok();
        conn.execute("DELETE FROM custom_covers WHERE key = ?1", [&key]).map_err(err)?;
        old
    };
    if let Some(o) = old.filter(|o| Path::new(o).starts_with(dir(&lib))) {
        let _ = std::fs::remove_file(o);
    }
    let _ = app.emit("covers-changed", ());
    Ok(())
}

fn too_big(bytes: &[u8]) -> Res<()> {
    if bytes.len() > 40 * 1024 * 1024 {
        return Err("That picture is too big (over 40 MB).".into());
    }
    Ok(())
}

/// One source's picture as bytes: `grimmory` (the full cover, a Grimmory book), `book` (the cover inside
/// the file, or the one read from it), `first` (the first page of a DjVu book or a comic).
#[tauri::command]
pub async fn cover_source(app: AppHandle, which: String, book_id: Option<i64>, grimmory_id: Option<i64>) -> Res<Response> {
    match which.as_str() {
        "grimmory" => {
            let id = grimmory_id.ok_or("Not a Grimmory book")?;
            let bytes = crate::grimmory::covers::full(&app, id).await.map_err(err)?;
            Ok(Response::new(bytes))
        }
        "book" | "first" => {
            let id = book_id.ok_or("Not on this PC")?;
            let b = {
                let lib = app.state::<Library>();
                let conn = lib.db.0.lock().unwrap();
                db::book(&conn, id).map_err(err)?.ok_or("The book isn't in the library any more.")?
            };
            tauri::async_runtime::spawn_blocking(move || {
                let path = Path::new(&b.path);
                let bytes = if which == "first" {
                    crate::pages::cover_of(path, &b.format).or_else(|| crate::meta::read(path, &b.format).cover)
                } else {
                    crate::meta::read(path, &b.format).cover.or_else(|| b.cover.as_ref().and_then(|c| std::fs::read(c).ok()))
                };
                bytes.map(Response::new).ok_or_else(|| "This book has no cover of its own.".to_string())
            })
            .await
            .map_err(err)?
        }
        _ => Err("Unknown source".into()),
    }
}

/// A picture file you chose or dropped.
#[tauri::command]
pub async fn cover_file(path: String) -> Res<Response> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("The file couldn't be read: {e}"))?;
    too_big(&bytes)?;
    Ok(Response::new(bytes))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OlCover {
    pub cover_id: i64,
    pub title: String,
    pub author: Option<String>,
    pub year: Option<i64>,
}

fn ol_client() -> Res<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("KatanaDesk/", env!("CARGO_PKG_VERSION"), " (+https://github.com/Dawit-Sh/katana-desk)"))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(err)
}

/// The last word of an author's name, lowercased ("Keiichiro Hirano" -> "hirano"; "Hirano, Keiichiro" -> "hirano").
fn surname(author: &str) -> String {
    let a = author.split(['&', ';']).next().unwrap_or("").trim();
    let a = if let Some((last, _)) = a.split_once(',') { last } else { a.rsplit(' ').next().unwrap_or(a) };
    a.trim().to_lowercase()
}

/// Open Library's covers for a title (and author): one per edition that has a cover. When the author is
/// known, only books by someone with the same surname count (a title alone finds too many strangers).
#[tauri::command]
pub async fn openlibrary_search(title: String, author: Option<String>) -> Res<Vec<OlCover>> {
    let c = ol_client()?;
    let title = title.trim().to_string();
    let author = author.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
    let mut tries: Vec<Vec<(&str, String)>> = vec![];
    if let Some(a) = &author {
        tries.push(vec![("title", title.clone()), ("author", a.clone())]);
        tries.push(vec![("q", format!("{title} {a}"))]);
    } else {
        tries.push(vec![("title", title.clone())]);
    }
    let want = author.as_deref().map(surname).filter(|s| s.len() > 1);
    for q in tries {
        let mut query = q.clone();
        query.push(("fields", "title,author_name,cover_i,first_publish_year,edition_count".into()));
        query.push(("limit", "16".into()));
        let resp = c
            .get("https://openlibrary.org/search.json")
            .query(&query)
            .send()
            .await
            .map_err(|e| format!("Open Library can't be reached ({e})."))?;
        if !resp.status().is_success() {
            return Err(format!("Open Library answered {}.", resp.status().as_u16()));
        }
        let v: serde_json::Value = resp.json().await.map_err(err)?;
        let mut out = vec![];
        let mut seen = std::collections::HashSet::new();
        for d in v["docs"].as_array().cloned().unwrap_or_default() {
            let Some(id) = d["cover_i"].as_i64() else { continue };
            if let Some(w) = &want {
                let by = d["author_name"].as_array().is_some_and(|a| a.iter().filter_map(|x| x.as_str()).any(|x| x.to_lowercase().contains(w.as_str())));
                if !by {
                    continue;
                }
            }
            if id <= 0 || !seen.insert(id) {
                continue;
            }
            out.push(OlCover {
                cover_id: id,
                title: d["title"].as_str().unwrap_or("").to_string(),
                author: d["author_name"].as_array().and_then(|a| a.first()).and_then(|a| a.as_str()).map(String::from),
                year: d["first_publish_year"].as_i64(),
            });
            if out.len() >= 12 {
                break;
            }
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }
    Ok(vec![])
}

/// One Open Library cover: `M` (about 180 px wide, for the list) or `L` (the largest).
#[tauri::command]
pub async fn openlibrary_cover(id: i64, size: String) -> Res<Response> {
    let s = if size == "L" { "L" } else { "M" };
    let c = ol_client()?;
    let resp = c
        .get(format!("https://covers.openlibrary.org/b/id/{id}-{s}.jpg"))
        .send()
        .await
        .map_err(|e| format!("Open Library can't be reached ({e})."))?;
    if !resp.status().is_success() {
        return Err(format!("Open Library answered {}.", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(err)?.to_vec();
    too_big(&bytes)?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys_are_checked() {
        assert!(super::ok_key("b:12"));
        assert!(super::ok_key("g:3756"));
        assert!(!super::ok_key("x:1"));
        assert!(!super::ok_key("b:../1"));
        assert!(!super::ok_key("g:"));
    }

    #[test]
    fn surnames() {
        assert_eq!(super::surname("Keiichiro Hirano"), "hirano");
        assert_eq!(super::surname("Hirano, Keiichiro"), "hirano");
        assert_eq!(super::surname("Bill Ashcroft & Gareth Griffiths"), "ashcroft");
    }
}
