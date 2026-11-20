//! Downloads from Grimmory that pause and go on where they stopped (HTTP Range, the way Katana on
//! Android does it, which Grimmory's content endpoint serves through Spring).
//!
//! - Bytes go into `partial/<id>.part`, with the length and `Last-Modified`/`ETag` beside it. Only a
//!   whole file moves to `books/<id>/<file name>`, so half a book is never taken for a book.
//! - Going on asks for `Range: bytes=<bytes kept>-` with `If-Range`. A 206 is appended only if it starts
//!   exactly there and the length and date still match; a 200 starts over; a 416 or a changed file
//!   throws the partial bytes away.
//! - Waiting is for silence only (60 s without a byte), never for a total time.
//! - A lost connection waits ("Waiting for Grimmory") and goes on by itself; a real error (404, a full
//!   disk) fails with its message, and Try again checks Grimmory right away.

use super::catalog::gbook;
use super::{conn_of, g, is_connection, send, server_message, GErr};
use crate::{db, library, meta};
use futures_util::StreamExt;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use reqwest::StatusCode;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Dl {
    pub book_id: i64,
    /// queued, running, paused, waiting (for Grimmory), failed, done
    pub state: String,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
    pub local_id: Option<i64>,
    pub open_after: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Info {
    total: u64,
    last_modified: Option<String>,
    etag: Option<String>,
}

struct Running {
    stop: Arc<AtomicBool>,
}

fn running() -> &'static Mutex<HashMap<i64, Running>> {
    static R: OnceLock<Mutex<HashMap<i64, Running>>> = OnceLock::new();
    R.get_or_init(Default::default)
}
fn slots() -> &'static tokio::sync::Semaphore {
    static S: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(2))
}
fn retries() -> &'static Mutex<HashMap<i64, u32>> {
    static R: OnceLock<Mutex<HashMap<i64, u32>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

fn part_path(app: &AppHandle, id: i64) -> PathBuf {
    g(app).dir.join("partial").join(format!("{id}.part"))
}
fn info_path(app: &AppHandle, id: i64) -> PathBuf {
    g(app).dir.join("partial").join(format!("{id}.json"))
}
pub fn books_dir(app: &AppHandle) -> PathBuf {
    g(app).dir.join("books")
}

fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() {
        "book".into()
    } else {
        s
    }
}

fn get(app: &AppHandle, id: i64) -> Option<Dl> {
    let conn = conn_of(app);
    conn.query_row(
        "SELECT d.book_id, d.state, d.done, d.total, d.error, d.open_after,
            (SELECT b.id FROM books b WHERE b.grimmory_id = d.book_id AND b.source = 'grimmory' AND b.missing = 0 LIMIT 1)
         FROM gdownloads d WHERE d.book_id = ?1",
        [id],
        |r| {
            Ok(Dl {
                book_id: r.get(0)?,
                state: r.get(1)?,
                done: r.get::<_, i64>(2)? as u64,
                total: r.get::<_, i64>(3)? as u64,
                error: r.get(4)?,
                open_after: r.get::<_, i64>(5)? != 0,
                local_id: r.get(6)?,
            })
        },
    )
    .ok()
}

fn put(app: &AppHandle, id: i64, state: &str, done: u64, total: u64, error: Option<&str>) {
    {
        let conn = conn_of(app);
        let _ = conn.execute(
            "INSERT INTO gdownloads (book_id, state, done, total, error, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(book_id) DO UPDATE SET state = excluded.state, done = excluded.done, total = excluded.total,
                error = excluded.error, updated_at = excluded.updated_at",
            params![id, state, done as i64, total as i64, error, db::now()],
        );
    }
    emit(app, id);
}

fn emit(app: &AppHandle, id: i64) {
    if let Some(d) = get(app, id) {
        let _ = app.emit("grimmory-download", d);
    }
}

enum Outcome {
    Done(PathBuf),
    Paused,
    Waiting(String),
    Failed(String),
}

/// Starts (or goes on with) a book's download.
pub fn start(app: &AppHandle, id: i64) {
    if let Some(r) = running().lock().unwrap().get(&id) {
        // still going (a pause not taken yet): it just goes on
        r.stop.store(false, Ordering::SeqCst);
        if let Some(d) = get(app, id) {
            put(app, id, "running", d.done, d.total, None);
        }
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    running().lock().unwrap().insert(id, Running { stop: stop.clone() });
    let (done, total) = get(app, id).map(|d| (d.done, d.total)).unwrap_or((0, 0));
    put(app, id, "queued", done, total, None);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _slot = slots().acquire().await;
        let outcome = if stop.load(Ordering::SeqCst) { Outcome::Paused } else { run(&app, id, &stop).await };
        running().lock().unwrap().remove(&id);
        let (done, total) = get(&app, id).map(|d| (d.done, d.total)).unwrap_or((0, 0));
        match outcome {
            Outcome::Done(path) => {
                retries().lock().unwrap().remove(&id);
                // a fast download can finish before its size was ever shown
                let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(total);
                match add_to_library(&app, id, &path) {
                    Ok(_) => put(&app, id, "done", size, size, None),
                    Err(e) => put(&app, id, "failed", done, total, Some(&e)),
                }
                let _ = app.emit("library-changed", ());
                let _ = app.emit("grimmory-changed", ());
            }
            Outcome::Paused => {
                // a pause, or a cancel (which already removed the row)
                if get(&app, id).is_some() {
                    put(&app, id, "paused", done, total, None);
                }
            }
            Outcome::Failed(m) => put(&app, id, "failed", done, total, Some(&m)),
            Outcome::Waiting(m) => {
                put(&app, id, "waiting", done, total, Some(&m));
                // go on by itself after 30 s, then 60, 90 ... up to 5 minutes; Grimmory coming back
                // online goes on at once
                let n = {
                    let mut r = retries().lock().unwrap();
                    let n = r.entry(id).or_insert(0);
                    *n += 1;
                    *n
                };
                let wait = Duration::from_secs((30 * n as u64).min(300));
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(wait).await;
                    if get(&app2, id).map_or(false, |d| d.state == "waiting") {
                        start(&app2, id);
                    }
                });
            }
        }
    });
}

async fn run(app: &AppHandle, id: i64, stop: &AtomicBool) -> Outcome {
    let gb = match gbook(&conn_of(app), id) {
        Ok(Some(b)) => b,
        _ => return Outcome::Failed("This book is no longer on Grimmory.".into()),
    };
    let part = part_path(app, id);
    let info_p = info_path(app, id);
    let _ = std::fs::create_dir_all(part.parent().unwrap());
    for _attempt in 0..3 {
        let info: Option<Info> = std::fs::read(&info_p).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if info.is_none() || have == 0 {
            // bytes kept without their info aren't trusted
            let _ = std::fs::remove_file(&part);
            have = 0;
        }
        let info = info.unwrap_or_default();
        if have > 0 && info.total > 0 && have >= info.total {
            return finish(app, id, &part, &gb.file_name);
        }
        let lm = info.last_modified.clone();
        let et = info.etag.clone();
        put(app, id, "running", have, info.total, None);
        let resp = send(app, move |c, base, tok| {
            let mut r = c.get(format!("{base}/api/v1/books/{id}/content")).bearer_auth(tok).header(ACCEPT_ENCODING, "identity");
            if have > 0 {
                r = r.header(RANGE, format!("bytes={have}-"));
                if let Some(v) = et.as_ref().or(lm.as_ref()) {
                    r = r.header(IF_RANGE, v);
                }
            }
            r
        })
        .await;
        let resp = match resp {
            Ok(r) => r,
            Err(GErr::Offline(m)) => return Outcome::Waiting(m),
            Err(e) => return Outcome::Failed(e.to_string()),
        };
        let status = resp.status();
        let header = |h| resp.headers().get(h).and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok()).map(String::from);
        let new_lm = header(LAST_MODIFIED);
        let new_et = header(ETAG);
        let (mut file, mut written, total) = match status {
            StatusCode::PARTIAL_CONTENT if have > 0 => {
                // "bytes 4000-9999/10000"
                let cr = header(CONTENT_RANGE).unwrap_or_default();
                let start = cr.strip_prefix("bytes ").and_then(|r| r.split('-').next()).and_then(|x| x.trim().parse::<u64>().ok());
                let len = cr.rsplit('/').next().and_then(|x| x.trim().parse::<u64>().ok());
                let same_date = match (&info.last_modified, &new_lm) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                };
                if start != Some(have) || len != Some(info.total) || !same_date {
                    // another file on the server now: start over
                    let _ = std::fs::remove_file(&part);
                    continue;
                }
                match tokio::fs::OpenOptions::new().append(true).open(&part).await {
                    Ok(f) => (f, have, info.total),
                    Err(e) => return Outcome::Failed(format!("Couldn't write the book on this PC: {e}")),
                }
            }
            StatusCode::OK | StatusCode::PARTIAL_CONTENT => {
                let total = resp.content_length().unwrap_or(0);
                let info = Info { total, last_modified: new_lm.clone(), etag: new_et.clone() };
                let _ = std::fs::write(&info_p, serde_json::to_vec(&info).unwrap_or_default());
                match tokio::fs::File::create(&part).await {
                    Ok(f) => (f, 0, total),
                    Err(e) => return Outcome::Failed(format!("Couldn't write the book on this PC: {e}")),
                }
            }
            StatusCode::RANGE_NOT_SATISFIABLE => {
                let _ = std::fs::remove_file(&part);
                continue;
            }
            StatusCode::NOT_FOUND => return Outcome::Failed("Grimmory doesn't have this book's file any more.".into()),
            s => {
                let text = resp.text().await.unwrap_or_default();
                let m = server_message(&text);
                return Outcome::Failed(if m.is_empty() { format!("Grimmory answered {}.", s.as_u16()) } else { m });
            }
        };
        let mut body = resp.bytes_stream();
        let mut last = Instant::now();
        loop {
            if stop.load(Ordering::SeqCst) {
                let _ = file.flush().await;
                put(app, id, "paused", written, total, None);
                return Outcome::Paused;
            }
            match body.next().await {
                Some(Ok(chunk)) => {
                    if let Err(e) = file.write_all(&chunk).await {
                        return Outcome::Failed(format!("Couldn't write the book on this PC: {e}"));
                    }
                    written += chunk.len() as u64;
                    if last.elapsed() > Duration::from_millis(300) {
                        last = Instant::now();
                        put(app, id, "running", written, total, None);
                    }
                }
                Some(Err(e)) => {
                    let _ = file.flush().await;
                    put(app, id, "running", written, total, None);
                    if is_connection(&e) {
                        super::failed(app, GErr::Offline(e.to_string()));
                        return Outcome::Waiting("The connection broke off.".into());
                    }
                    return Outcome::Failed(e.to_string());
                }
                None => break,
            }
        }
        let _ = file.flush().await;
        drop(file);
        if total > 0 && written < total {
            put(app, id, "waiting", written, total, None);
            return Outcome::Waiting("The connection broke off.".into());
        }
        if total == 0 {
            let info = Info { total: written, last_modified: new_lm, etag: new_et };
            let _ = std::fs::write(&info_p, serde_json::to_vec(&info).unwrap_or_default());
        }
        return finish(app, id, &part, &gb.file_name);
    }
    Outcome::Failed("Grimmory kept sending a different file. Try again in a moment.".into())
}

fn finish(app: &AppHandle, id: i64, part: &PathBuf, file_name: &Option<String>) -> Outcome {
    let dir = books_dir(app).join(id.to_string());
    let _ = std::fs::create_dir_all(&dir);
    let name = safe_name(file_name.as_deref().unwrap_or("book"));
    let dest = dir.join(&name);
    if let Err(e) = std::fs::rename(part, &dest) {
        return Outcome::Failed(format!("Couldn't keep the book on this PC: {e}"));
    }
    let _ = std::fs::remove_file(info_path(app, id));
    Outcome::Done(dest)
}

/// A finished download joins the library as a Grimmory book (it shows on the Grimmory page, not in Local).
fn add_to_library(app: &AppHandle, gid: i64, path: &PathBuf) -> Result<i64, String> {
    let format = meta::format_of(path).ok_or("Katana Desk can't read this kind of file yet.")?;
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let hash = meta::partial_md5(path);
    let gb = gbook(&conn_of(app), gid).map_err(|e| e.to_string())?;
    let m = meta::read(path, &format);
    let title = gb.as_ref().map(|b| b.title.clone()).or(m.title.clone()).unwrap_or_else(|| meta::title_from_name(path));
    let author = gb.as_ref().and_then(|b| b.authors.clone()).or(m.author.clone());
    let path_s = path.to_string_lossy().to_string();
    let id = {
        let conn = conn_of(app);
        db::upsert_download(&conn, &path_s, &format, &title, author.as_deref(), md.len() as i64, mtime, hash.as_deref(), gid)
            .map_err(|e| e.to_string())?
    };
    // the cover: Grimmory's, when it's on this PC, else the book's own
    let covers_dir = super::covers::dir(app);
    let cover_v = gb.as_ref().and_then(|b| b.cover_v).unwrap_or(0);
    let lib = app.state_library();
    let out = lib.covers_dir.join(format!("{id}.jpg"));
    let cover = if std::fs::copy(covers_dir.join(format!("{gid}-{cover_v}.jpg")), &out).is_ok() {
        Some(out)
    } else {
        m.cover.and_then(|bytes| meta::save_cover(&bytes, &out)).map(|_| out)
    };
    let _ = db::set_cover(&conn_of(app), id, cover.as_ref().map(|p| p.to_string_lossy().to_string()).as_deref());
    library::allow(app, path, false);
    Ok(id)
}

trait LibState {
    fn state_library(&self) -> tauri::State<'_, library::Library>;
}
impl LibState for AppHandle {
    fn state_library(&self) -> tauri::State<'_, library::Library> {
        use tauri::Manager;
        self.state::<library::Library>()
    }
}

/// Downloads waiting for Grimmory go on (Grimmory is back).
pub fn resume_waiting(app: &AppHandle) {
    let ids: Vec<i64> = {
        let conn = conn_of(app);
        let mut st = match conn.prepare("SELECT book_id FROM gdownloads WHERE state IN ('waiting', 'queued')") {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows = st.query_map([], |r| r.get(0));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    };
    for id in ids {
        start(app, id);
    }
}

/// At start: downloads that were going when Katana Desk closed go on.
pub fn restore(app: &AppHandle) {
    {
        let conn = conn_of(app);
        let _ = conn.execute("UPDATE gdownloads SET state = 'queued' WHERE state = 'running'", []);
    }
    resume_waiting(app);
}

// ---- commands ----

#[tauri::command]
pub fn grimmory_downloads(app: AppHandle) -> Vec<Dl> {
    let ids: Vec<i64> = {
        let conn = conn_of(&app);
        let mut st = match conn.prepare("SELECT book_id FROM gdownloads ORDER BY updated_at DESC") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = st.query_map([], |r| r.get(0));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    };
    ids.into_iter().filter_map(|id| get(&app, id)).collect()
}

/// Gets a book. `open_after`: open it as soon as it's here.
#[tauri::command]
pub fn grimmory_download(app: AppHandle, id: i64, open_after: bool) {
    if let Some(d) = get(&app, id) {
        if d.state == "done" && d.local_id.is_some() {
            return emit(&app, id);
        }
    }
    put(&app, id, "queued", 0, 0, None);
    {
        let conn = conn_of(&app);
        let _ = conn.execute("UPDATE gdownloads SET open_after = ?2 WHERE book_id = ?1", params![id, open_after as i64]);
    }
    retries().lock().unwrap().remove(&id);
    start(&app, id);
}

#[tauri::command]
pub fn grimmory_pause(app: AppHandle, id: i64) {
    if let Some(r) = running().lock().unwrap().get(&id) {
        r.stop.store(true, Ordering::SeqCst);
    }
    // shown at once; a running download stops writing at its next few bytes
    if let Some(d) = get(&app, id) {
        if d.state != "done" && d.state != "failed" {
            put(&app, id, "paused", d.done, d.total, None);
        }
    }
}

/// Go on, or Try again: Grimmory is checked right away when it isn't known to be online.
#[tauri::command]
pub async fn grimmory_resume(app: AppHandle, id: i64) {
    retries().lock().unwrap().remove(&id);
    if g(&app).status.lock().unwrap().reach != super::Reach::Online {
        super::check_now(&app).await;
    }
    start(&app, id);
}

/// Stops a download and throws away its partial bytes (the book on Grimmory is untouched).
#[tauri::command]
pub fn grimmory_cancel(app: AppHandle, id: i64) {
    if let Some(r) = running().lock().unwrap().get(&id) {
        r.stop.store(true, Ordering::SeqCst);
    }
    {
        let conn = conn_of(&app);
        let _ = conn.execute("DELETE FROM gdownloads WHERE book_id = ?1 AND state != 'done'", [id]);
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // let a running download stop writing first
        for _ in 0..50 {
            if !running().lock().unwrap().contains_key(&id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = std::fs::remove_file(part_path(&app2, id));
        let _ = std::fs::remove_file(info_path(&app2, id));
        let _ = app2.emit("grimmory-download", Dl { book_id: id, state: "none".into(), done: 0, total: 0, error: None, local_id: None, open_after: false });
    });
}

#[cfg(test)]
mod tests {
    use super::safe_name;
    #[test]
    fn file_names_are_safe_on_windows() {
        assert_eq!(safe_name("A: B / C?.epub"), "A_ B _ C_.epub");
        assert_eq!(safe_name("  "), "book");
    }
}
