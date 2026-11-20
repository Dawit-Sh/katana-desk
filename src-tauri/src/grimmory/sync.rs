//! The reading place, both ways. A book on this PC that is a Grimmory book (downloaded, or a Local copy
//! of the same file) sends its place up about 4 seconds after the last page turn and when it closes, and
//! takes Grimmory's place when it opens, so the Fire picks up where the PC left off and back.
//! The rules are in `place.rs`; going backwards is always asked first.

use super::place::{decide, parse_time, Decision, LocalPlace, Seen, ServerPlace, ServerTime};
use super::{conn_of, g, json, send, update_status, GErr, GRes};
use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Server places behind this PC's, waiting for an answer (book id -> place). Worked out again on every
/// pull, so a restart loses nothing.
fn offers() -> &'static Mutex<HashMap<i64, ServerPlace>> {
    static O: OnceLock<Mutex<HashMap<i64, ServerPlace>>> = OnceLock::new();
    O.get_or_init(Default::default)
}
fn timers() -> &'static Mutex<HashMap<i64, u64>> {
    static T: OnceLock<Mutex<HashMap<i64, u64>>> = OnceLock::new();
    T.get_or_init(Default::default)
}
fn open_book() -> &'static Mutex<Option<i64>> {
    static B: OnceLock<Mutex<Option<i64>>> = OnceLock::new();
    B.get_or_init(Default::default)
}

struct Linked {
    gid: i64,
    format: String,
    local: LocalPlace,
    seen: Option<Seen>,
    href: Option<String>,
}

/// Formats whose CFIs mean the same in Grimmory's web reader (foliate-js on both sides). MOBI, AZW3
/// and FB2 go by how far through, as on Android, so a place from any device can be used.
fn uses_cfi(format: &str) -> bool {
    format == "epub"
}

fn linked(app: &AppHandle, id: i64) -> Option<Linked> {
    let conn = conn_of(app);
    conn.query_row(
        "SELECT grimmory_id, format, location, fraction, place_state, place_at, server_place, href FROM books WHERE id = ?1",
        [id],
        |r| {
            let gid: Option<i64> = r.get(0)?;
            let seen: Option<String> = r.get(6)?;
            Ok(gid.map(|gid| Linked {
                gid,
                format: r.get(1).unwrap_or_default(),
                local: LocalPlace {
                    cfi: r.get(2).ok().flatten(),
                    fraction: r.get(3).ok().flatten(),
                    pending: r.get::<_, String>(4).map(|s| s == "pending").unwrap_or(false),
                    at: r.get(5).ok().flatten(),
                },
                seen: seen.and_then(|s| serde_json::from_str(&s).ok()),
                href: r.get(7).ok().flatten(),
            }))
        },
    )
    .ok()
    .flatten()
}

/// Grimmory's place for a book, in the shape the reader uses.
pub async fn server_place(app: &AppHandle, gid: i64, format: &str, timeout: Option<Duration>) -> GRes<Option<ServerPlace>> {
    let v = json(app, move |c, base, tok| {
        let r = c.get(format!("{base}/api/v1/app/books/{gid}/progress")).bearer_auth(tok);
        match timeout {
            Some(t) => r.timeout(t),
            None => r,
        }
    })
    .await?;
    let key = if format == "cbz" { "cbxProgress" } else if format == "pdf" { "pdfProgress" } else { "epubProgress" };
    let p = v.get(key).filter(|x| x.is_object());
    let pct = p.and_then(|p| p.get("percentage")).and_then(|x| x.as_f64()).map(|x| (x / 100.0).clamp(0.0, 1.0));
    let cfi = p
        .and_then(|p| p.get("cfi"))
        .and_then(|x| x.as_str())
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty() && x != "0" && x.starts_with("epubcfi("))
        .filter(|_| uses_cfi(format));
    let href = p.and_then(|p| p.get("href")).and_then(|x| x.as_str()).map(String::from);
    let page = p.and_then(|p| p.get("page")).and_then(|x| x.as_i64());
    if cfi.is_none() && pct.unwrap_or(0.0) <= 0.0 && page.is_none() {
        return Ok(None);
    }
    let time = p.and_then(|p| p.get("updatedAt")).and_then(parse_time).or_else(|| v.get("lastReadTime").and_then(parse_time));
    let now = db::now();
    Ok(Some(ServerPlace {
        cfi,
        href,
        fraction: pct,
        page,
        at: time.and_then(|t| t.trusted(now)),
        zoneless: matches!(time, Some(ServerTime::Zoneless)),
    }))
}

fn seen_json(s: &Seen) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// Takes Grimmory's place here. `use_cfi`: its CFI; otherwise how far through (the reader goes there).
fn apply(app: &AppHandle, id: i64, p: &ServerPlace, use_cfi: bool) {
    let conn = conn_of(app);
    let location = if use_cfi { p.cfi.clone() } else { None };
    let _ = conn.execute(
        "UPDATE books SET location = ?2, fraction = ?3, place_state = 'clean', server_place = ?4, synced_at = ?5,
            place_at = ?5 WHERE id = ?1",
        params![id, location, p.fraction, seen_json(&Seen::of(p)), db::now()],
    );
}

fn note_seen(app: &AppHandle, id: i64, p: Option<&ServerPlace>) {
    let conn = conn_of(app);
    let _ = conn.execute(
        "UPDATE books SET server_place = ?2, synced_at = ?3 WHERE id = ?1",
        params![id, p.map(|p| seen_json(&Seen::of(p))), db::now()],
    );
}

/// Sends this PC's place up.
async fn post(app: &AppHandle, id: i64, l: &Linked) -> GRes<()> {
    let file_id: Option<i64> = conn_of(app).query_row("SELECT file_id FROM gbooks WHERE id = ?1", [l.gid], |r| r.get(0)).optional().ok().flatten().flatten();
    let pct = (l.local.fraction.unwrap_or(0.0).clamp(0.0, 1.0) * 100.0) as f32;
    let comic = l.format == "cbz";
    // comics: Grimmory keeps the page (1-based); the reader keeps how far through
    let page = comic.then(|| {
        let total: Option<i64> = conn_of(app).query_row("SELECT page_count FROM gbooks WHERE id = ?1", [l.gid], |r| r.get(0)).ok().flatten();
        total.map(|t| ((l.local.fraction.unwrap_or(0.0) * t as f64).floor() as i64 + 1).clamp(1, t.max(1)))
    }).flatten();
    let position = if comic { page.map(|p| p.to_string()) } else { l.local.cfi.clone() };
    let href = if comic { None } else { l.href.clone() };
    let body = match file_id {
        Some(fid) => serde_json::json!({
            "bookId": l.gid,
            "fileProgress": { "bookFileId": fid, "positionData": position, "positionHref": href, "progressPercent": pct }
        }),
        None if comic => serde_json::json!({ "bookId": l.gid, "cbxProgress": { "page": page, "percentage": pct } }),
        None => serde_json::json!({ "bookId": l.gid, "epubProgress": { "cfi": position, "href": href, "percentage": pct } }),
    };
    let resp = send(app, move |c, base, tok| c.post(format!("{base}/api/v1/books/progress")).bearer_auth(tok).json(&body)).await?;
    if !resp.status().is_success() {
        let st = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(GErr::Server(st, super::server_message(&text)));
    }
    let sent = ServerPlace {
        cfi: if uses_cfi(&l.format) { l.local.cfi.clone() } else { None },
        fraction: Some(pct as f64 / 100.0),
        ..Default::default()
    };
    let now = db::now();
    {
        let conn = conn_of(app);
        // a page turned while this was on its way stays waiting
        let _ = conn.execute(
            "UPDATE books SET place_state = CASE WHEN place_at IS ?2 THEN 'clean' ELSE place_state END,
                server_place = ?3, synced_at = ?4 WHERE id = ?1",
            params![id, l.local.at, seen_json(&Seen::of(&sent)), now],
        );
        let _ = conn.execute("UPDATE gbooks SET progress = ?2, last_read = ?3 WHERE id = ?1", params![l.gid, sent.fraction, now]);
    }
    Ok(())
}

/// Works out one book's place with Grimmory and does what the rules say.
async fn reconcile(app: &AppHandle, id: i64, timeout: Option<Duration>) -> GRes<Option<Decision>> {
    let Some(l) = linked(app, id) else { return Ok(None) };
    if offers().lock().unwrap().contains_key(&id) && l.local.pending {
        // waiting for an answer: this PC's place doesn't go over Grimmory's meanwhile
        return Ok(None);
    }
    let server = server_place(app, l.gid, &l.format, timeout).await?;
    let d = decide(Some(&l.local), server.as_ref(), l.seen.as_ref(), db::now());
    let is_open = *open_book().lock().unwrap() == Some(id);
    match &d {
        Decision::Keep => {
            offers().lock().unwrap().remove(&id);
            note_seen(app, id, server.as_ref());
        }
        Decision::Push => {
            offers().lock().unwrap().remove(&id);
            post(app, id, &l).await?;
        }
        Decision::Apply { use_cfi } if !is_open => {
            offers().lock().unwrap().remove(&id);
            apply(app, id, server.as_ref().unwrap(), *use_cfi);
        }
        Decision::Apply { .. } | Decision::Offer { .. } => {
            // an open book never moves under the reader: it asks
            offers().lock().unwrap().insert(id, server.clone().unwrap());
            if is_open {
                let _ = app.emit("grimmory-offer", id);
            }
        }
    }
    count_waiting(app);
    Ok(Some(d))
}

/// Pushes one book's waiting place (after a page turn, at close, when Grimmory is back).
pub async fn push_book(app: &AppHandle, id: i64) {
    if let Err(e) = reconcile(app, id, None).await {
        eprintln!("katana: place of book {id} waits: {e}");
    }
}

pub async fn push_all(app: &AppHandle) {
    if !g(app).signed_in() {
        return;
    }
    let ids: Vec<i64> = {
        let conn = conn_of(app);
        let mut st = match conn.prepare("SELECT id FROM books WHERE place_state = 'pending' AND grimmory_id IS NOT NULL AND missing = 0") {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows = st.query_map([], |r| r.get(0));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    };
    for id in ids {
        if reconcile(app, id, None).await.is_err() {
            break;
        }
    }
    count_waiting(app);
}

/// Every book on this PC that is Grimmory book `gid`, after its place moved on Grimmory.
pub async fn pull_linked(app: &AppHandle, gid: i64) -> GRes<()> {
    let ids: Vec<i64> = {
        let conn = conn_of(app);
        let mut st = conn
            .prepare("SELECT id FROM books WHERE grimmory_id = ?1 AND missing = 0")
            .map_err(|e| GErr::Other(e.to_string()))?;
        let rows = st.query_map([gid], |r| r.get(0)).map_err(|e| GErr::Other(e.to_string()))?;
        rows.flatten().collect()
    };
    for id in ids {
        reconcile(app, id, None).await?;
    }
    Ok(())
}

pub fn count_waiting(app: &AppHandle) {
    let n: i64 = conn_of(app)
        .query_row("SELECT COUNT(*) FROM books WHERE place_state = 'pending' AND grimmory_id IS NOT NULL AND missing = 0", [], |r| r.get(0))
        .unwrap_or(0);
    update_status(app, |s| s.waiting = n as usize);
}

/// After a page turn: the place goes up about 4 seconds after the last one.
pub fn schedule_push(app: &AppHandle, id: i64) {
    let n = {
        let mut t = timers().lock().unwrap();
        let n = t.entry(id).or_insert(0);
        *n += 1;
        *n
    };
    count_waiting(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if timers().lock().unwrap().get(&id) == Some(&n) && g(&app).signed_in() {
            push_book(&app, id).await;
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub fraction: Option<f64>,
    pub at: Option<i64>,
    pub page: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPlace {
    /// where to open: a CFI, or how far through when there's no CFI
    pub location: Option<String>,
    pub fraction: Option<f64>,
    /// Grimmory's place is behind this one: ask before going there
    pub offer: Option<Offer>,
    /// linked to a Grimmory book
    pub grimmory_id: Option<i64>,
}

fn place_of(app: &AppHandle, id: i64) -> (Option<String>, Option<f64>, Option<i64>) {
    conn_of(app)
        .query_row("SELECT location, fraction, grimmory_id FROM books WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap_or((None, None, None))
}

fn offer_of(id: i64) -> Option<Offer> {
    offers().lock().unwrap().get(&id).map(|p| Offer { fraction: p.fraction, at: p.at, page: p.page })
}

/// A book opens: a Local copy is matched to Grimmory first if it can be, then Grimmory's place is
/// taken, offered or left, within about 4 seconds (offline, the book opens where it was here).
#[tauri::command]
pub async fn grimmory_open_place(app: AppHandle, id: i64) -> OpenPlace {
    *open_book().lock().unwrap() = None;
    let signed = g(&app).signed_in();
    if signed {
        let local_unlinked: bool = conn_of(&app)
            .query_row("SELECT source = 'local' AND grimmory_id IS NULL FROM books WHERE id = ?1", [id], |r| r.get(0))
            .unwrap_or(false);
        if local_unlinked {
            let _ = tokio::time::timeout(Duration::from_secs(5), super::matching::link(&app, id)).await;
        }
        let _ = reconcile(&app, id, Some(Duration::from_secs(4))).await;
    }
    *open_book().lock().unwrap() = Some(id);
    let (location, fraction, gid) = place_of(&app, id);
    OpenPlace { location, fraction, offer: offer_of(id), grimmory_id: gid }
}

/// The reader asks for an offer that came in while the book was open.
#[tauri::command]
pub fn grimmory_offer(id: i64) -> Option<Offer> {
    offer_of(id)
}

/// His answer: go to Grimmory's place, or stay (this PC's place then goes up).
#[tauri::command]
pub async fn grimmory_answer(app: AppHandle, id: i64, go: bool) -> OpenPlace {
    let offered = offers().lock().unwrap().remove(&id);
    if let Some(p) = offered {
        if go {
            let use_cfi = p.cfi.is_some()
                && linked(&app, id).and_then(|l| l.seen).map_or(true, |s| s.cfi != p.cfi);
            apply(&app, id, &p, use_cfi);
        } else {
            {
                let conn = conn_of(&app);
                let _ = conn.execute(
                    "UPDATE books SET place_state = 'pending', place_at = ?2, server_place = ?3 WHERE id = ?1",
                    params![id, db::now(), seen_json(&Seen::of(&p))],
                );
            }
            push_book(&app, id).await;
        }
    }
    let (location, fraction, gid) = place_of(&app, id);
    OpenPlace { location, fraction, offer: None, grimmory_id: gid }
}

/// The book closed: its place goes up now.
#[tauri::command]
pub async fn grimmory_closed(app: AppHandle, id: i64) {
    {
        let mut o = open_book().lock().unwrap();
        if *o == Some(id) {
            *o = None;
        }
    }
    timers().lock().unwrap().remove(&id);
    let pending = linked(&app, id).map_or(false, |l| l.local.pending);
    if pending && g(&app).signed_in() {
        push_book(&app, id).await;
    }
}

/// When a book was last in step with Grimmory, for the "Synced 2 min ago" pill.
#[tauri::command]
pub fn grimmory_book_sync(app: AppHandle, id: i64) -> (Option<i64>, String) {
    conn_of(&app)
        .query_row("SELECT synced_at, place_state FROM books WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((None, "clean".into()))
}


