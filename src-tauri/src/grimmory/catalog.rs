//! The Grimmory library on this PC: every book's summary, its libraries and shelves, in SQLite.
//!
//! First sync: the app API's pages (`/api/v1/app/books`, 50 books a page, Grimmory's most), six at a time,
//! each page written as it arrives, so the library fills in while it loads.
//! Later starts only fetch what changed: new books (newest first until known ones), reading places that
//! moved (last read first, until the last one we saw), books that went away (one list of ids), and
//! once a day a full pass for changed titles and covers. Rows that didn't change aren't written.

use super::place::{parse_time, ServerTime};
use super::{conn_of, emit_status, g, json, set, setting, update_status, GErr, GRes};
use crate::db;
use futures_util::stream::{self, StreamExt};
use md5::{Digest, Md5};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

pub const K_LAST_SYNC: &str = "grimmory.lastSync";
const K_LAST_FULL: &str = "grimmory.lastFull";
const K_READ_MARK: &str = "grimmory.readMark";
const K_SHAPE: &str = "grimmory.rowShape";
const PAGE: usize = 50;
const FULL_EVERY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GBook {
    pub id: i64,
    pub library_id: Option<i64>,
    pub title: String,
    pub authors: Option<String>,
    pub series: Option<String>,
    pub series_number: Option<f64>,
    pub file_type: Option<String>,
    pub file_name: Option<String>,
    pub size_kb: Option<i64>,
    pub added_on: Option<i64>,
    pub last_read: Option<i64>,
    /// 0..1
    pub progress: Option<f64>,
    pub read_status: Option<String>,
    pub cover_v: Option<i64>,
    pub page_count: Option<i64>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub categories: Option<String>,
    pub tags: Option<String>,
    pub published: Option<String>,
    /// the book on this PC (downloaded, or a Local copy of the same file)
    pub local_id: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub kind: String,
    pub id: i64,
    pub name: String,
    pub icon: Option<String>,
    pub book_count: Option<i64>,
    pub book_ids: Vec<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GLibrary {
    pub id: i64,
    pub name: String,
    pub icon: Option<String>,
    pub book_count: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub books: Vec<GBook>,
    pub libraries: Vec<GLibrary>,
    pub shelves: Vec<Shelf>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty())
}
fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
}
fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}
fn list(v: &Value, k: &str) -> Option<String> {
    let a = v.get(k)?.as_array()?;
    let items: Vec<&str> = a.iter().filter_map(|x| x.as_str()).filter(|x| !x.trim().is_empty()).collect();
    if items.is_empty() {
        None
    } else {
        Some(items.join(", "))
    }
}
/// A server instant as epoch ms (book times in the app API are instants; a zone-less one is left out).
fn t(v: &Value, k: &str) -> Option<i64> {
    match parse_time(v.get(k)?)? {
        ServerTime::Zoned(ms) => Some(ms),
        ServerTime::Zoneless => None,
    }
}

/// Writes one page of book summaries. Unchanged rows only get their "seen in this sync" mark.
fn write_page(conn: &mut Connection, items: &[Value], gen: i64) -> rusqlite::Result<Vec<i64>> {
    let tx = conn.transaction()?;
    let mut changed = vec![];
    {
        let mut seen = tx.prepare_cached("UPDATE gbooks SET seen = ?2 WHERE id = ?1 AND sig = ?3")?;
        let mut up = tx.prepare_cached(
            "INSERT INTO gbooks (id, library_id, title, authors, series, series_number, file_id, file_type, file_name,
                size_kb, added_on, last_read, progress, read_status, cover_v, page_count, language, publisher,
                categories, tags, published, rating, sig, seen)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
             ON CONFLICT(id) DO UPDATE SET library_id = excluded.library_id, title = excluded.title,
                authors = excluded.authors, series = excluded.series, series_number = excluded.series_number,
                file_id = excluded.file_id, file_type = excluded.file_type, file_name = excluded.file_name,
                size_kb = excluded.size_kb, added_on = excluded.added_on, last_read = excluded.last_read,
                progress = excluded.progress, read_status = excluded.read_status, cover_v = excluded.cover_v,
                page_count = excluded.page_count, language = excluded.language, publisher = excluded.publisher,
                categories = excluded.categories, tags = excluded.tags, published = excluded.published,
                rating = excluded.rating, sig = excluded.sig, seen = excluded.seen",
        )?;
        for b in items {
            let Some(id) = i(b, "id") else { continue };
            let sig = format!("{:x}", Md5::digest(b.to_string().as_bytes()));
            if seen.execute(params![id, gen, sig])? > 0 {
                continue;
            }
            let title = s(b, "title").or_else(|| s(b, "primaryFileName")).unwrap_or_else(|| format!("Book {id}"));
            up.execute(params![
                id,
                i(b, "libraryId"),
                title,
                list(b, "authors"),
                s(b, "seriesName"),
                f(b, "seriesNumber"),
                i(b, "primaryFileId"),
                s(b, "primaryFileType"),
                s(b, "primaryFileName"),
                i(b, "fileSizeKb"),
                t(b, "addedOn"),
                t(b, "lastReadTime"),
                // Grimmory's list mixes KOReader's 0..1 with its readers' 0..100; the exact place is
                // read per book right after (exact_progress)
                f(b, "readProgress").map(|p| if p > 1.0 { p / 100.0 } else { p }.clamp(0.0, 1.0)),
                s(b, "readStatus"),
                t(b, "coverUpdatedOn"),
                i(b, "pageCount"),
                s(b, "language"),
                s(b, "publisher"),
                list(b, "categories"),
                list(b, "tags"),
                s(b, "publishedDate"),
                i(b, "personalRating"),
                sig,
                gen,
            ])?;
            changed.push(id);
        }
    }
    tx.commit()?;
    Ok(changed)
}

async fn page(app: &AppHandle, n: usize, sort: &str) -> GRes<Value> {
    let sort = sort.to_string();
    json(app, move |c, base, tok| {
        c.get(format!("{base}/api/v1/app/books"))
            .bearer_auth(tok)
            .query(&[("page", n.to_string()), ("size", PAGE.to_string()), ("sort", sort.clone()), ("dir", "desc".into())])
    })
    .await
}

fn content(v: &Value) -> Vec<Value> {
    v.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default()
}

fn progress(app: &AppHandle, done: usize, total: usize) {
    update_status(app, |s| {
        s.sync_done = done;
        s.sync_total = total;
    });
}

/// A book's detail answer in the shape of a list summary (for books the paging skipped).
fn summary_of(mut d: Value) -> Value {
    if let Some(o) = d.as_object_mut() {
        let primary = o
            .get("files")
            .and_then(|f| f.as_array())
            .and_then(|f| f.iter().find(|x| x.get("primary").and_then(|p| p.as_bool()).unwrap_or(false)).cloned());
        if let Some(p) = primary {
            for (from, to) in [("id", "primaryFileId"), ("fileName", "primaryFileName"), ("fileSizeKb", "fileSizeKb")] {
                if let Some(v) = p.get(from) {
                    o.entry(to).or_insert(v.clone());
                }
            }
        }
        for k in ["description", "files", "shelves", "epubProgress", "pdfProgress", "cbxProgress", "audiobookProgress", "koreaderProgress", "fileTypes"] {
            o.remove(k);
        }
    }
    d
}

/// Books Grimmory has that the pages didn't bring (books added in the same second can swap places
/// between pages), fetched one by one. Returns every id Grimmory has.
async fn fill_gaps(app: &AppHandle, gen: i64, have: &HashSet<i64>, changed: &mut Vec<i64>) -> GRes<HashSet<i64>> {
    let all: HashSet<i64> = all_ids(app, &[]).await?.into_iter().collect();
    let missing: Vec<i64> = all.iter().copied().filter(|id| !have.contains(id)).collect();
    let mut details = stream::iter(missing)
        .map(|id| json(app, move |c, base, tok| c.get(format!("{base}/api/v1/app/books/{id}")).bearer_auth(tok)))
        .buffer_unordered(6);
    let mut got = vec![];
    while let Some(r) = details.next().await {
        if let Ok(d) = r {
            got.push(summary_of(d));
        }
    }
    if !got.is_empty() {
        changed.extend(write_page(&mut conn_of(app), &got, gen).map_err(|e| GErr::Other(e.to_string()))?);
    }
    Ok(all)
}

/// The exact reading place of books whose place changed: Grimmory's list can't say which kind it is.
async fn exact_progress(app: &AppHandle, ids: Vec<i64>) {
    let todo: Vec<(i64, String)> = {
        let conn = conn_of(app);
        ids.into_iter()
            .filter_map(|id| {
                conn.query_row("SELECT file_type FROM gbooks WHERE id = ?1 AND last_read IS NOT NULL", [id], |r| r.get::<_, Option<String>>(0))
                    .ok()
                    .map(|t| (id, t.unwrap_or_default()))
            })
            .collect()
    };
    let now = db::now();
    let mut answers = stream::iter(todo)
        .map(|(id, ty)| async move {
            let v = json(app, move |c, base, tok| c.get(format!("{base}/api/v1/app/books/{id}/progress")).bearer_auth(tok)).await;
            (id, ty, v)
        })
        .buffer_unordered(6);
    while let Some((id, ty, v)) = answers.next().await {
        let Ok(v) = v else { continue };
        let format = match ty.as_str() {
            "PDF" => "pdf",
            "CBX" => "cbz",
            _ => "epub",
        };
        let frac = super::sync::place_from(&v, format, now).and_then(|p| p.fraction);
        let _ = conn_of(app).execute("UPDATE gbooks SET progress = ?2 WHERE id = ?1", params![id, frac]);
    }
}

/// Every book, page by page. Returns the ids seen, or an error if any page failed.
async fn fetch_all(app: &AppHandle, gen: i64, changed: &mut Vec<i64>) -> GRes<HashSet<i64>> {
    let first = page(app, 0, "addedOn").await?;
    let total = first.get("totalElements").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
    let pages = first.get("totalPages").and_then(|x| x.as_u64()).unwrap_or(1) as usize;
    let mut ids = HashSet::new();
    let items = content(&first);
    ids.extend(items.iter().filter_map(|b| i(b, "id")));
    changed.extend(write_page(&mut conn_of(app), &items, gen).map_err(|e| GErr::Other(e.to_string()))?);
    let mut done = items.len();
    progress(app, done, total);
    let _ = app.emit("grimmory-changed", ());
    let mut last_emit = std::time::Instant::now();
    let mut results = stream::iter(1..pages).map(|n| page(app, n, "addedOn")).buffer_unordered(6);
    while let Some(r) = results.next().await {
        let v = r?;
        let items = content(&v);
        ids.extend(items.iter().filter_map(|b| i(b, "id")));
        changed.extend(write_page(&mut conn_of(app), &items, gen).map_err(|e| GErr::Other(e.to_string()))?);
        done += items.len();
        progress(app, done.min(total.max(done)), total);
        if last_emit.elapsed().as_millis() > 900 {
            last_emit = std::time::Instant::now();
            let _ = app.emit("grimmory-changed", ());
        }
    }
    Ok(ids)
}

/// Pages of one order until a page holds nothing new. `stop` says whether a book is already known.
async fn fetch_until(app: &AppHandle, sort: &str, gen: i64, changed: &mut Vec<i64>, stop: impl Fn(&Value) -> bool) -> GRes<()> {
    for n in 0..40 {
        let v = page(app, n, sort).await?;
        let items = content(&v);
        let fresh: Vec<Value> = items.iter().take_while(|b| !stop(b)).cloned().collect();
        changed.extend(write_page(&mut conn_of(app), &fresh, gen).map_err(|e| GErr::Other(e.to_string()))?);
        if fresh.len() < items.len() || !v.get("hasNext").and_then(|x| x.as_bool()).unwrap_or(false) {
            break;
        }
    }
    Ok(())
}

async fn all_ids(app: &AppHandle, query: &[(&str, String)]) -> GRes<Vec<i64>> {
    let q: Vec<(String, String)> = query.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
    let v = json(app, move |c, base, tok| c.get(format!("{base}/api/v1/app/books/ids")).bearer_auth(tok).query(&q)).await?;
    Ok(v.as_array().map(|a| a.iter().filter_map(|x| x.as_i64()).collect()).unwrap_or_default())
}

/// Libraries, shelves and magic shelves, with the books on each shelf.
async fn shelves(app: &AppHandle) -> GRes<()> {
    // the app API's library list can fail on a server (500 on his); the web app's has the same ids and names
    let libs = match json(app, |c, base, tok| c.get(format!("{base}/api/v1/app/libraries")).bearer_auth(tok)).await {
        Ok(v) => v,
        Err(_) => json(app, |c, base, tok| c.get(format!("{base}/api/v1/libraries")).bearer_auth(tok))
            .await
            .unwrap_or(Value::Array(vec![])),
    };
    let shelves = json(app, |c, base, tok| c.get(format!("{base}/api/v1/app/shelves")).bearer_auth(tok))
        .await
        .unwrap_or(Value::Array(vec![]));
    let magic = json(app, |c, base, tok| c.get(format!("{base}/api/v1/app/shelves/magic")).bearer_auth(tok))
        .await
        .unwrap_or(Value::Array(vec![]));
    let mut members: Vec<(String, i64, Vec<i64>)> = vec![];
    for (kind, list, key) in [("shelf", &shelves, "shelfId"), ("magic", &magic, "magicShelfId")] {
        for sh in list.as_array().into_iter().flatten() {
            let Some(id) = i(sh, "id") else { continue };
            let ids = all_ids(app, &[(key, id.to_string())]).await.unwrap_or_default();
            members.push((kind.to_string(), id, ids));
        }
    }
    let mut conn = conn_of(app);
    let tx = conn.transaction().map_err(|e| GErr::Other(e.to_string()))?;
    let w = || -> rusqlite::Result<()> {
        tx.execute("DELETE FROM glibraries", [])?;
        for l in libs.as_array().into_iter().flatten() {
            if let Some(id) = i(l, "id") {
                tx.execute(
                    "INSERT INTO glibraries (id, name, icon, book_count) VALUES (?1, ?2, ?3, ?4)",
                    params![id, s(l, "name").unwrap_or_else(|| format!("Library {id}")), s(l, "icon"), i(l, "bookCount")],
                )?;
            }
        }
        tx.execute("DELETE FROM gshelves", [])?;
        tx.execute("DELETE FROM gshelf_books", [])?;
        for (kind, list) in [("shelf", &shelves), ("magic", &magic)] {
            for sh in list.as_array().into_iter().flatten() {
                if let Some(id) = i(sh, "id") {
                    tx.execute(
                        "INSERT OR REPLACE INTO gshelves (kind, id, name, icon, book_count) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![kind, id, s(sh, "name").unwrap_or_else(|| format!("Shelf {id}")), s(sh, "icon"), i(sh, "bookCount")],
                    )?;
                }
            }
        }
        for (kind, id, ids) in &members {
            for b in ids {
                tx.execute("INSERT OR IGNORE INTO gshelf_books (kind, shelf_id, book_id) VALUES (?1, ?2, ?3)", params![kind, id, b])?;
            }
        }
        Ok(())
    };
    w().map_err(|e| GErr::Other(e.to_string()))?;
    tx.commit().map_err(|e| GErr::Other(e.to_string()))?;
    Ok(())
}

/// Drops books Grimmory no longer has, unless that would be more than a third of the library at once
/// (a disk not mounted when Grimmory scanned): then nothing goes.
fn drop_missing(conn: &Connection, keep: &HashSet<i64>) -> rusqlite::Result<usize> {
    let have: Vec<i64> = {
        let mut st = conn.prepare("SELECT id FROM gbooks")?;
        let rows = st.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let gone: Vec<i64> = have.iter().copied().filter(|id| !keep.contains(id)).collect();
    if gone.is_empty() {
        return Ok(0);
    }
    if have.len() >= 30 && gone.len() * 3 > have.len() {
        eprintln!("katana: Grimmory would drop {} of {} books at once; kept them", gone.len(), have.len());
        return Ok(0);
    }
    for id in &gone {
        conn.execute("DELETE FROM gbooks WHERE id = ?1", [id])?;
    }
    Ok(gone.len())
}

/// Syncs the library. `full`: every page (first sign-in, Sync now, once a day); otherwise only changes.
pub async fn sync(app: &AppHandle, full: bool) -> GRes<()> {
    let gr = g(app);
    let Ok(_one) = gr.sync_lock.try_lock() else { return Ok(()) };
    if !gr.signed_in() {
        return Err(GErr::SignedOut);
    }
    update_status(app, |s| {
        s.syncing = true;
        s.sync_done = 0;
        s.sync_total = 0;
    });
    let r = run(app, full).await;
    let now = db::now();
    match &r {
        Ok(()) => {
            set(app, K_LAST_SYNC, &now.to_string());
            update_status(app, |s| {
                s.syncing = false;
                s.last_sync = Some(now);
                s.last_error = None;
            });
        }
        Err(e) => {
            let msg = e.to_string();
            update_status(app, |s| {
                s.syncing = false;
                s.last_error = Some(msg);
            });
        }
    }
    let _ = app.emit("grimmory-changed", ());
    r
}

async fn run(app: &AppHandle, full: bool) -> GRes<()> {
    let gen = db::now();
    let (count, mark) = {
        let conn = conn_of(app);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM gbooks", [], |r| r.get(0)).unwrap_or(0);
        let mark: Option<i64> = conn.query_row("SELECT MAX(last_read) FROM gbooks", [], |r| r.get(0)).ok().flatten();
        (count, mark)
    };
    let last_full = setting(app, K_LAST_FULL).and_then(|s| s.parse::<i64>().ok());
    // rows written by an older Katana Desk are written again once (their progress unit changed in 0.2)
    let stale = setting(app, K_SHAPE).as_deref() != Some("2");
    if stale {
        let _ = conn_of(app).execute("UPDATE gbooks SET sig = NULL", []);
        set(app, K_SHAPE, "2");
    }
    let full = full || stale || count == 0 || last_full.map_or(true, |t| gen - t > FULL_EVERY_MS);
    let mark = setting(app, K_READ_MARK).and_then(|s| s.parse::<i64>().ok()).or(mark);
    let before = read_marks(app);
    // statuses set here while Grimmory was away go up first, so what comes down agrees with them
    super::status_sync::push(app).await;
    let statuses_before = super::status_sync::stored(app);

    let mut changed: Vec<i64> = vec![];
    if full {
        let ids = fetch_all(app, gen, &mut changed).await?;
        let all = fill_gaps(app, gen, &ids, &mut changed).await?;
        drop_missing(&conn_of(app), &all).map_err(|e| GErr::Other(e.to_string()))?;
        set(app, K_LAST_FULL, &gen.to_string());
    } else {
        // new books, newest first, until one we know
        let known: HashSet<i64> = {
            let conn = conn_of(app);
            let mut st = conn.prepare("SELECT id FROM gbooks").map_err(|e| GErr::Other(e.to_string()))?;
            let rows = st.query_map([], |r| r.get(0)).map_err(|e| GErr::Other(e.to_string()))?;
            rows.flatten().collect()
        };
        fetch_until(app, "addedOn", gen, &mut changed, |b| i(b, "id").map_or(false, |id| known.contains(&id))).await?;
        // reading places that moved, most recent first, until the last one already seen
        if let Some(mark) = mark {
            fetch_until(app, "lastReadTime", gen, &mut changed, |b| t(b, "lastReadTime").map_or(true, |lr| lr <= mark)).await?;
        } else {
            fetch_until(app, "lastReadTime", gen, &mut changed, |b| t(b, "lastReadTime").is_none()).await?;
        }
        // books the pages didn't bring, and books that went away
        let have: HashSet<i64> = known.iter().copied().chain(changed.iter().copied()).collect();
        let all = fill_gaps(app, gen, &have, &mut changed).await?;
        if !all.is_empty() {
            drop_missing(&conn_of(app), &all).map_err(|e| GErr::Other(e.to_string()))?;
        }
    }
    exact_progress(app, changed).await;
    // statuses changed on Grimmory's site or by a phone, which may not have moved a last-read time
    if let Err(e) = super::status_sync::pull(app).await {
        eprintln!("katana: Grimmory statuses: {e}");
    }
    let _ = app.emit("grimmory-changed", ());
    if let Err(e) = shelves(app).await {
        eprintln!("katana: Grimmory shelves: {e}");
    }
    let newest: Option<i64> = conn_of(app).query_row("SELECT MAX(last_read) FROM gbooks", [], |r| r.get(0)).ok().flatten();
    if let Some(n) = newest {
        set(app, K_READ_MARK, &n.to_string());
    }
    // books on this PC whose place moved on Grimmory: work out what to do now (offers wait for the book)
    let after = read_marks(app);
    let mut moved: Vec<i64> = after.iter().filter(|(id, lr)| before.get(id) != Some(lr)).map(|(id, _)| *id).collect();
    // the books being read here are looked at every time: a book reset or marked unread on Grimmory may
    // not change its last-read time, and it should leave Continue reading here too
    let reading: Vec<i64> = {
        let conn = conn_of(app);
        let mut st = conn
            .prepare(
                "SELECT DISTINCT grimmory_id FROM books WHERE grimmory_id IS NOT NULL AND missing = 0
                   AND fraction > 0.004 AND fraction < 0.995 ORDER BY opened_at DESC LIMIT 30",
            )
            .map_err(|e| GErr::Other(e.to_string()))?;
        let rows = st.query_map([], |r| r.get(0)).map_err(|e| GErr::Other(e.to_string()))?;
        rows.flatten().collect()
    };
    for gid in reading.into_iter().chain(super::status_sync::follow(app, &statuses_before)) {
        if !moved.contains(&gid) {
            moved.push(gid);
        }
    }
    for gid in moved {
        let _ = super::sync::pull_linked(app, gid).await;
    }
    // highlights and bookmarks that changed on Grimmory, for the books on this PC
    super::marks_sync::after_library_sync(app).await;
    emit_status(app);
    Ok(())
}

/// Last-read times of the Grimmory books that have a copy on this PC.
fn read_marks(app: &AppHandle) -> std::collections::HashMap<i64, Option<i64>> {
    let conn = conn_of(app);
    let mut st = match conn.prepare(
        "SELECT g.id, g.last_read FROM gbooks g WHERE EXISTS (SELECT 1 FROM books b WHERE b.grimmory_id = g.id AND b.missing = 0)",
    ) {
        Ok(st) => st,
        Err(_) => return Default::default(),
    };
    let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?)));
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

/// Another server: forget the last one's books (downloaded files stay on disk and in Local's database).
pub fn forget(app: &AppHandle) {
    let conn = conn_of(app);
    let _ = conn.execute_batch(
        "DELETE FROM gbooks; DELETE FROM glibraries; DELETE FROM gshelves; DELETE FROM gshelf_books; DELETE FROM gmatch;
         UPDATE books SET grimmory_id = NULL, server_place = NULL, place_state = 'clean' WHERE source = 'local';",
    );
    let _ = db::set_setting(&conn, K_LAST_FULL, "");
    let _ = db::set_setting(&conn, K_READ_MARK, "");
    // statuses set here for the last server's books
    let _ = db::set_setting(&conn, "grimmory.statusWaiting", "{}");
}

pub fn gbook(conn: &Connection, id: i64) -> rusqlite::Result<Option<GBook>> {
    conn.query_row(&format!("SELECT {GCOLS} FROM gbooks g WHERE g.id = ?1"), [id], row_gbook).optional()
}

const GCOLS: &str = "g.id, g.library_id, g.title, g.authors, g.series, g.series_number, g.file_type, g.file_name, g.size_kb,
    g.added_on, g.last_read, g.progress, g.read_status, g.cover_v, g.page_count, g.language, g.publisher, g.categories,
    g.tags, g.published,
    (SELECT b.id FROM books b WHERE b.grimmory_id = g.id AND b.missing = 0 ORDER BY b.source = 'grimmory' DESC LIMIT 1)";

fn row_gbook(r: &rusqlite::Row) -> rusqlite::Result<GBook> {
    Ok(GBook {
        id: r.get(0)?,
        library_id: r.get(1)?,
        title: r.get(2)?,
        authors: r.get(3)?,
        series: r.get(4)?,
        series_number: r.get(5)?,
        file_type: r.get(6)?,
        file_name: r.get(7)?,
        size_kb: r.get(8)?,
        added_on: r.get(9)?,
        last_read: r.get(10)?,
        progress: r.get(11)?,
        read_status: r.get(12)?,
        cover_v: r.get(13)?,
        page_count: r.get(14)?,
        language: r.get(15)?,
        publisher: r.get(16)?,
        categories: r.get(17)?,
        tags: r.get(18)?,
        published: r.get(19)?,
        local_id: r.get(20)?,
    })
}

#[tauri::command]
pub fn grimmory_catalog(app: AppHandle) -> Result<Catalog, String> {
    let conn = conn_of(&app);
    let e = |e: rusqlite::Error| e.to_string();
    let books = {
        let mut st = conn.prepare(&format!("SELECT {GCOLS} FROM gbooks g ORDER BY g.added_on DESC")).map_err(e)?;
        let rows = st.query_map([], row_gbook).map_err(e)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?
    };
    let libraries = {
        let mut st = conn.prepare("SELECT id, name, icon, book_count FROM glibraries ORDER BY name COLLATE NOCASE").map_err(e)?;
        let rows = st
            .query_map([], |r| Ok(GLibrary { id: r.get(0)?, name: r.get(1)?, icon: r.get(2)?, book_count: r.get(3)? }))
            .map_err(e)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?
    };
    let mut shelves = {
        let mut st = conn
            .prepare("SELECT kind, id, name, icon, book_count FROM gshelves ORDER BY kind DESC, name COLLATE NOCASE")
            .map_err(e)?;
        let rows = st
            .query_map([], |r| {
                Ok(Shelf { kind: r.get(0)?, id: r.get(1)?, name: r.get(2)?, icon: r.get(3)?, book_count: r.get(4)?, book_ids: vec![] })
            })
            .map_err(e)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e)?
    };
    {
        let mut st = conn.prepare("SELECT book_id FROM gshelf_books WHERE kind = ?1 AND shelf_id = ?2").map_err(e)?;
        for sh in shelves.iter_mut() {
            let rows = st.query_map(params![sh.kind, sh.id], |r| r.get(0)).map_err(e)?;
            sh.book_ids = rows.flatten().collect();
        }
    }
    Ok(Catalog { books, libraries, shelves })
}

#[tauri::command]
pub async fn grimmory_sync(app: AppHandle, full: bool) -> Result<(), String> {
    sync(&app, full).await.map_err(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let dir = std::env::temp_dir().join(format!("katana-cat-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join(format!("{}.db", db::now()));
        let d = db::Db::open(&p).unwrap();
        d.0.into_inner().unwrap()
    }

    #[test]
    fn unchanged_rows_are_not_rewritten_and_missing_ones_are_guarded() {
        let mut c = mem();
        let page: Vec<Value> = (1..=40)
            .map(|n| serde_json::json!({"id": n, "title": format!("T{n}"), "authors": ["A"], "readProgress": 50.0,
                "lastReadTime": "2026-11-20T09:00:00Z", "primaryFileType": "EPUB", "fileSizeKb": 100}))
            .collect();
        assert_eq!(write_page(&mut c, &page, 1).unwrap().len(), 40);
        assert_eq!(write_page(&mut c, &page, 2).unwrap().len(), 0);
        let p: f64 = c.query_row("SELECT progress FROM gbooks WHERE id = 3", [], |r| r.get(0)).unwrap();
        assert!((p - 0.5).abs() < 1e-9);
        // 30 of 40 gone at once: kept
        let keep: HashSet<i64> = (1..=10).collect();
        assert_eq!(drop_missing(&c, &keep).unwrap(), 0);
        // 2 gone: dropped
        let keep: HashSet<i64> = (1..=38).collect();
        assert_eq!(drop_missing(&c, &keep).unwrap(), 2);
    }
}
