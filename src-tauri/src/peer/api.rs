//! The requests a phone sends: pairing and matching (`/katana-sync/v1/...`), and Grimmory's own
//! `/api/v1/...` shapes for this PC's books, field for field as Katana's Grimmory client reads and writes
//! them (`GrimmoryDtos.kt`, `GrimmoryAnnotationsApi.kt`, `GrimmoryBookmarksApi.kt` on Android). Book ids
//! are this PC's; mark ids are this PC's rows. Times go out as UTC instants (`...Z`).

use super::pair::{self, Try};
use super::place::{self as pp, DeskPlace, PeerPlace};
use super::session::{Kind, PhoneSide};
use super::{changed, desk_id, desk_name, peer, PROTOCOL};
use crate::db;
use crate::grimmory::place::{Decision, ServerPlace, PENDING_MARGIN_MS};
use crate::grimmory::{conn_of, marks_sync, sync};
use crate::{highlights, marks};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::io::Read;
use tauri::{AppHandle, Emitter};

const BODY_LIMIT: u64 = 4 << 20;

pub enum Body {
    Json(Value),
    File(super::books::FileAnswer),
}

pub struct Reply {
    pub status: u16,
    pub body: Option<Body>,
}

fn ok(v: Value) -> Reply {
    Reply { status: 200, body: Some(Body::Json(v)) }
}
fn done() -> Reply {
    Reply { status: 200, body: None }
}
fn fail(status: u16, message: &str) -> Reply {
    Reply { status, body: Some(Body::Json(json!({ "status": status, "message": message }))) }
}
/// A refusal with a word the phone acts on (`reason`), besides the words for people.
fn refuse(status: u16, reason: &str, message: &str) -> Reply {
    Reply { status, body: Some(Body::Json(json!({ "status": status, "reason": reason, "message": message }))) }
}

/// What a request carries besides its method and path.
pub struct Ask<'a> {
    pub auth: Option<&'a str>,
    pub body: &'a str,
    pub range: Option<&'a str>,
    pub if_range: Option<&'a str>,
    /// The caller's own address, when it's another machine on the network
    pub from: Option<std::net::Ipv4Addr>,
}

fn header(req: &tiny_http::Request, name: &'static str) -> Option<String> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string())
}

pub fn handle(app: &AppHandle, mut req: tiny_http::Request) {
    let method = req.method().as_str().to_ascii_uppercase();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let (auth, range, if_range) = (header(&req, "Authorization"), header(&req, "Range"), header(&req, "If-Range"));
    let from = match req.remote_addr().map(|a| a.ip()) {
        Some(std::net::IpAddr::V4(ip)) if !ip.is_loopback() => Some(ip),
        _ => None,
    };
    let mut body = String::new();
    let _ = req.as_reader().take(BODY_LIMIT).read_to_string(&mut body);
    let ask = Ask { auth: auth.as_deref(), body: &body, range: range.as_deref(), if_range: if_range.as_deref(), from };
    let reply = route(app, &method, &path, &ask);
    let status = tiny_http::StatusCode(reply.status);
    let _ = match reply.body {
        Some(Body::Json(v)) => {
            let json_type = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap();
            req.respond(tiny_http::Response::from_data(v.to_string().into_bytes()).with_header(json_type).with_status_code(status))
        }
        Some(Body::File(f)) => {
            let headers = f.headers.iter().filter_map(|(k, v)| tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()).ok()).collect();
            req.respond(tiny_http::Response::new(status, headers, f.reader, Some(f.len as usize), None))
        }
        None => req.respond(tiny_http::Response::from_data(Vec::new()).with_status_code(status)),
    };
}

fn route(app: &AppHandle, method: &str, path: &str, ask: &Ask) -> Reply {
    let segs: Vec<&str> = path.trim_matches('/').split('/').collect();
    let v: Value = serde_json::from_str(ask.body).unwrap_or(Value::Null);
    if let Some(ip) = ask.from {
        // the network phones reach this PC on (for the address the pairing screen shows)
        *peer(app).phone_ip.lock().unwrap() = Some(ip);
    }
    match (method, segs.as_slice()) {
        ("GET", ["katana-sync", "v1", "hello"]) => return hello(app),
        ("POST", ["katana-sync", "v1", "pair"]) => return pair_device(app, &v),
        _ => {}
    }
    let token = ask
        .auth
        .map(str::trim)
        .and_then(|a| a.strip_prefix("Bearer ").or_else(|| a.strip_prefix("bearer ")))
        .map(str::trim)
        .unwrap_or("");
    let device = if token.is_empty() { None } else { pair::device_for(&conn_of(app), token, db::now()) };
    let Some(device) = device else { return fail(401, "Not paired with this PC") };
    if let ("POST", ["katana-sync", "v1", "sync"]) = (method, segs.as_slice()) {
        return sync_said(app, &device, &v);
    }
    let reply = route_paired(app, method, &segs, &v, ask, &device);
    if (200..300).contains(&reply.status) {
        super::touched(app, &device, Kind::of(method, &segs));
    }
    reply
}

fn route_paired(app: &AppHandle, method: &str, segs: &[&str], v: &Value, ask: &Ask, device: &pair::Device) -> Reply {
    let num = |s: &str| s.parse::<i64>().ok();
    match (method, segs) {
        ("POST", ["katana-sync", "v1", "match"]) => match_books(app, v),
        ("GET", ["katana-sync", "v1", "reading"]) => ok(super::books::reading_json(&conn_of(app), sync::open_book_id())),
        ("GET", ["api", "v1", "books", id, "content"]) => num(id).map_or_else(|| fail(404, "No such book"), |id| content(app, id, ask)),
        ("POST", ["api", "v1", "books", "progress"]) => progress(app, v, device),
        ("POST", ["api", "v1", "books", "status"]) => set_status(app, v),
        ("POST", ["api", "v1", "books", "reset-progress"]) => reset(app, v),
        ("GET", ["api", "v1", "books", id]) => num(id).map_or_else(|| fail(404, "No such book"), |id| get_book(app, id)),
        ("GET", ["api", "v1", "annotations", "book", id]) => num(id).map_or_else(|| fail(404, "No such book"), |id| list_highlights(app, id)),
        ("POST", ["api", "v1", "annotations"]) => add_highlight(app, v),
        ("PUT", ["api", "v1", "annotations", id]) => num(id).map_or_else(|| fail(404, "No such highlight"), |id| change_highlight(app, id, v)),
        ("DELETE", ["api", "v1", "annotations", id]) => num(id).map_or_else(|| fail(404, "No such highlight"), |id| remove_highlight(app, id)),
        ("GET", ["api", "v1", "bookmarks", "book", id]) => num(id).map_or_else(|| fail(404, "No such book"), |id| list_bookmarks(app, id)),
        ("POST", ["api", "v1", "bookmarks"]) => add_bookmark(app, v),
        ("PUT", ["api", "v1", "bookmarks", id]) => num(id).map_or_else(|| fail(404, "No such bookmark"), |id| change_bookmark(app, id, v)),
        ("DELETE", ["api", "v1", "bookmarks", id]) => num(id).map_or_else(|| fail(404, "No such bookmark"), |id| remove_bookmark(app, id)),
        _ => fail(404, "Not found"),
    }
}

/// A book's file, for a phone that doesn't have it (Grimmory's `.../content`, ranges and all).
fn content(app: &AppHandle, id: i64, ask: &Ask) -> Reply {
    let row: Option<(String, String, bool)> = conn_of(app)
        .query_row("SELECT path, format, missing <> 0 FROM books WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .ok()
        .flatten();
    let Some((path, format, missing)) = row else { return fail(404, "No such book") };
    if missing {
        return fail(404, "That book's file isn't on this PC");
    }
    match super::books::file_answer(&path, &format.to_ascii_lowercase(), ask.range, ask.if_range) {
        Ok(f) => Reply { status: f.status, body: Some(Body::File(f)) },
        Err(status) => fail(status, "That book's file can't be read"),
    }
}

/// Katana says its sync starts (`{"phase":"start"}`) or ended (`{"phase":"end", "books", "changed", "problem"}`).
fn sync_said(app: &AppHandle, device: &pair::Device, v: &Value) -> Reply {
    match text(v, "phase").as_deref() {
        Some("start") => super::sync_started(app, device),
        Some("end") => super::sync_ended(app, device, serde_json::from_value::<PhoneSide>(v.clone()).unwrap_or_default()),
        _ => return fail(400, "phase is start or end"),
    }
    done()
}

// ---- pairing and matching ----

/// Asked without a pairing: who this is. Only Katana Desk answers `"app": "katana-desk"` with its id, so a
/// phone lists real desks only, not any computer with the port open.
fn hello(app: &AppHandle) -> Reply {
    let pairing = peer(app).pairing.lock().unwrap().current(db::now()).is_some();
    ok(json!({
        "app": "katana-desk",
        "protocol": PROTOCOL,
        "deskId": desk_id(app),
        "name": desk_name(),
        "version": env!("CARGO_PKG_VERSION"),
        // a code is showing on this PC's screen now
        "pairing": pairing,
    }))
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn pair_device(app: &AppHandle, v: &Value) -> Reply {
    let (Some(code), Some(device_id)) = (text(v, "code"), text(v, "deviceId")) else {
        return fail(400, "code and deviceId are needed");
    };
    let name = text(v, "deviceName").unwrap_or_else(|| "Katana".into());
    let now = db::now();
    let tried = peer(app).pairing.lock().unwrap().check(&code, now);
    match tried {
        Try::Locked => refuse(429, tried.reason(), "Too many wrong codes: try again in a minute"),
        Try::Wrong => refuse(403, tried.reason(), "That code isn't the one on this PC's screen"),
        Try::Expired => refuse(403, tried.reason(), "That code ran out: make a new one on this PC"),
        Try::Closed => refuse(403, tried.reason(), "No code is showing on this PC: Pair a device makes one"),
        Try::Ok => {
            let token = pair::new_token();
            if let Err(e) = pair::add_device(&conn_of(app), &device_id, &name, &token, now) {
                return fail(500, &e.to_string());
            }
            changed(app);
            ok(json!({ "token": token, "deskId": desk_id(app), "name": desk_name() }))
        }
    }
}

/// The same file = the same format, the exact size and KOReader's partial MD5.
fn match_books(app: &AppHandle, v: &Value) -> Reply {
    let conn = conn_of(app);
    let mut out = vec![];
    for b in v.get("books").and_then(|x| x.as_array()).into_iter().flatten() {
        let (Some(md5), Some(size), Some(format)) = (text(b, "md5"), b.get("size").and_then(|x| x.as_i64()), text(b, "format")) else {
            continue;
        };
        if let Some(id) = match_one(&conn, &md5, size, &format) {
            out.push(json!({ "key": b.get("key").cloned().unwrap_or(Value::Null), "bookId": id }));
        }
    }
    ok(json!({ "books": out }))
}

/// The book on this PC that is this file: the same format, the exact size and KOReader's partial MD5
/// (`books.hash`). A Local copy first when there are two.
pub fn match_one(conn: &rusqlite::Connection, md5: &str, size: i64, format: &str) -> Option<i64> {
    conn.query_row(
        "SELECT id FROM books WHERE lower(hash) = lower(?1) AND size = ?2 AND lower(format) = lower(?3) AND missing = 0
         ORDER BY (source = 'local') DESC, id LIMIT 1",
        params![md5, size, format],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

// ---- books ----

pub fn iso(ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn is_comic(format: &str) -> bool {
    matches!(format, "cbz" | "cbr")
}

fn paged(format: &str) -> bool {
    format == "pdf" || is_comic(format)
}

pub fn book_type(format: &str) -> String {
    if is_comic(format) {
        "CBX".into()
    } else {
        format.to_ascii_uppercase()
    }
}

struct BookRow {
    id: i64,
    path: String,
    format: String,
    title: String,
    author: Option<String>,
    size: i64,
    grimmory_id: Option<i64>,
    read_status: Option<String>,
    finished_at: Option<i64>,
    desk: DeskPlace,
    peer: Option<PeerPlace>,
}

fn book_row(app: &AppHandle, id: i64) -> Option<BookRow> {
    conn_of(app)
        .query_row(
            "SELECT b.id, b.path, b.format, b.title, b.author, b.size, b.grimmory_id,
                CASE WHEN b.grimmory_id IS NULL THEN b.read_status ELSE COALESCE(g.read_status, b.read_status) END,
                b.finished_at, b.location, b.fraction, b.href, b.place_at, b.peer_served_at, b.peer_synced_at, b.peer_place
             FROM books b LEFT JOIN gbooks g ON g.id = b.grimmory_id WHERE b.id = ?1",
            [id],
            |r| {
                let peer: Option<String> = r.get(15)?;
                Ok(BookRow {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    format: r.get::<_, String>(2)?.to_ascii_lowercase(),
                    title: r.get(3)?,
                    author: r.get(4)?,
                    size: r.get(5)?,
                    grimmory_id: r.get(6)?,
                    read_status: r.get(7)?,
                    finished_at: r.get(8)?,
                    desk: DeskPlace {
                        location: r.get(9)?,
                        fraction: r.get(10)?,
                        href: r.get(11)?,
                        place_at: r.get(12)?,
                        served_at: r.get(13)?,
                        synced_at: r.get(14)?,
                    },
                    peer: peer.and_then(|s| serde_json::from_str(&s).ok()),
                })
            },
        )
        .optional()
        .ok()
        .flatten()
}

/// The place as Grimmory's book answer carries it: `epubProgress`, `pdfProgress` or `cbxProgress`
/// (percentages from 0 to 100, pages from 1). MOBI, AZW3 and FB2 go by how far through only.
pub fn progress_json(format: &str, s: &pp::Served) -> (&'static str, Value) {
    let pct = s.fraction.map(|f| (f.clamp(0.0, 1.0) * 100.0) as f32);
    if paged(format) {
        let page = s.page.or_else(|| s.cfi.as_deref().and_then(|c| c.parse::<i64>().ok())).filter(|n| *n >= 1);
        (if is_comic(format) { "cbxProgress" } else { "pdfProgress" }, json!({ "page": page, "percentage": pct }))
    } else if format == "epub" {
        let cfi = s.cfi.as_deref().filter(|c| c.starts_with("epubcfi("));
        ("epubProgress", json!({ "cfi": cfi, "href": s.href, "percentage": pct }))
    } else {
        ("epubProgress", json!({ "percentage": pct }))
    }
}

fn status_of(b: &BookRow, has_place: bool) -> String {
    match b.read_status.as_deref() {
        Some("UNREAD") | None if has_place => "READING".into(),
        Some(s) => s.into(),
        None => "UNREAD".into(),
    }
}

/// The book's last read time: its place's, or the day it was finished when that's later.
pub fn last_read(place_at: Option<i64>, finished_at: Option<i64>) -> Option<i64> {
    match (place_at, finished_at) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// A progress request's `dateFinished`: `Some(Some(ms))` finished then (a time more than a day ahead,
/// or one that can't be read, counts as now), `Some(None)` no longer finished (null), `None` not said.
pub fn finished_in(v: &Value, now: i64) -> Option<Option<i64>> {
    match v.get("dateFinished")? {
        Value::Null => Some(None),
        x => {
            let t = crate::grimmory::place::parse_time(x).and_then(|t| t.trusted(now)).unwrap_or(now);
            Some(Some(t))
        }
    }
}

fn get_book(app: &AppHandle, id: i64) -> Reply {
    let Some(b) = book_row(app, id) else { return fail(404, "No such book") };
    let served = pp::served(&b.desk, b.peer.as_ref());
    let status = status_of(&b, served.is_some());
    let kb = (b.size + 1023) / 1024;
    let file_name = std::path::Path::new(&b.path).file_name().map(|n| n.to_string_lossy().to_string());
    let authors: Vec<String> = b
        .author
        .as_deref()
        .map(|a| a.split([';', '&']).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    let mut v = json!({
        "id": b.id,
        // Katana drops a book answer without a library (`toCatalogEntry`): this PC's books are one library
        "libraryId": 1,
        "libraryName": "Katana Desk",
        "bookType": book_type(&b.format),
        "title": b.title,
        "fileSizeKb": kb,
        "readStatus": status,
        "lastReadTime": last_read(served.as_ref().and_then(|s| s.at), if status == "READ" { b.finished_at } else { None }).and_then(iso),
        "metadata": { "title": b.title, "authors": authors },
        "primaryFile": {
            "id": b.id,
            "bookId": b.id,
            "fileName": file_name,
            "bookType": book_type(&b.format),
            "extension": b.format,
            "fileSizeKb": kb,
        },
    });
    if status == "READ" {
        if let Some(f) = b.finished_at {
            v["dateFinished"] = json!(iso(f));
        }
    }
    if let Some(s) = &served {
        let (key, p) = progress_json(&b.format, s);
        v[key] = p;
    }
    ok(v)
}

fn num_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

/// A place in a progress request (Katana's `GrimmoryReadProgressRequestDto`: `fileProgress`, or the
/// older `epubProgress` / `pdfProgress` / `cbxProgress`), stamped `now`. `None`: no place in it.
pub fn incoming_place(format: &str, v: &Value, now: i64) -> Option<PeerPlace> {
    let (pos, href, pct, page) = if let Some(fp) = v.get("fileProgress").filter(|x| x.is_object()) {
        (text(fp, "positionData"), text(fp, "positionHref"), num_of(fp, "progressPercent"), None)
    } else {
        let p = ["epubProgress", "pdfProgress", "cbxProgress"].iter().find_map(|k| v.get(*k).filter(|x| x.is_object()))?;
        (text(p, "cfi"), text(p, "href"), num_of(p, "percentage"), p.get("page").and_then(|x| x.as_i64()))
    };
    let fraction = pct.map(|x| (x / 100.0).clamp(0.0, 1.0));
    let (cfi, page) = if paged(format) {
        let n = page.or_else(|| pos.as_deref().and_then(|s| s.parse::<i64>().ok())).filter(|n| *n >= 1);
        (n.map(|n| n.to_string()), n)
    } else if format == "epub" {
        (pos.filter(|c| c.starts_with("epubcfi(")), None)
    } else {
        (None, None)
    };
    let p = PeerPlace { cfi, href: if paged(format) { None } else { href }, fraction, page, at: now, device: None };
    p.has_place().then_some(p)
}

fn progress(app: &AppHandle, v: &Value, device: &pair::Device) -> Reply {
    let Some(id) = v.get("bookId").and_then(|x| x.as_i64()) else { return fail(400, "bookId is needed") };
    let Some(b) = book_row(app, id) else { return fail(404, "No such book") };
    let now = db::now();
    let Some(mut incoming) = incoming_place(&b.format, v, now) else { return done() };
    incoming.device = Some(device.name.clone());
    // the phone's newer place: a question about its earlier one is moot
    sync::drop_peer_offer(app, id);
    let d = pp::weigh(&b.desk, &incoming, b.peer.as_ref(), now);
    {
        let conn = conn_of(app);
        let _ = conn.execute(
            "UPDATE books SET peer_place = ?2, peer_synced_at = ?3 WHERE id = ?1",
            params![id, serde_json::to_string(&incoming).ok(), now],
        );
        if b.grimmory_id.is_none() {
            // a Local book read on a phone is being read
            let _ = conn.execute("UPDATE books SET read_status = 'READING' WHERE id = ?1 AND (read_status IS NULL OR read_status = 'UNREAD')", [id]);
        }
    }
    // finished on the phone (its dateFinished, or the end reached): Read here, with the day; a null
    // dateFinished (read again) makes it unfinished
    let finished = finished_in(v, now).or_else(|| (incoming.fraction.unwrap_or(0.0) >= 0.995).then_some(Some(now)));
    match finished {
        Some(Some(t)) => {
            let conn = conn_of(app);
            let was_read = b.read_status.as_deref() == Some("READ");
            let _ = conn.execute(
                "UPDATE books SET finished_at = CASE WHEN ?3 THEN COALESCE(finished_at, ?2) ELSE ?2 END WHERE id = ?1",
                params![id, t, was_read],
            );
            match b.grimmory_id {
                None => {
                    let _ = conn.execute("UPDATE books SET read_status = 'READ' WHERE id = ?1", [id]);
                }
                Some(gid) => {
                    let _ = conn.execute("UPDATE gbooks SET read_status = 'READ' WHERE id = ?1", [gid]);
                }
            }
            drop(conn);
            if let Some(gid) = b.grimmory_id.filter(|_| !was_read && crate::grimmory::g(app).signed_in()) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = sync::grimmory_set_status(app, gid, "READ".into()).await;
                });
            }
        }
        Some(None) => {
            let conn = conn_of(app);
            let _ = conn.execute("UPDATE books SET finished_at = NULL WHERE id = ?1", [id]);
            if b.grimmory_id.is_none() {
                let _ = conn.execute("UPDATE books SET read_status = 'READING' WHERE id = ?1 AND read_status = 'READ'", [id]);
            }
        }
        None => {}
    }
    let open = sync::is_open(id);
    match d {
        Decision::Keep | Decision::Clear => {}
        Decision::Push => {
            // this PC's place keeps its ground: it's what phones see
            let _ = conn_of(app).execute("UPDATE books SET peer_served_at = ?2 WHERE id = ?1", params![id, now]);
        }
        Decision::Apply { .. } if !open => take_place(app, id, &incoming.server()),
        // an open book never moves under the reader, and going back is asked: the reader asks
        Decision::Apply { .. } | Decision::Offer { .. } => sync::offer_from_peer(app, id, incoming.server(), &device.name),
    }
    let _ = app.emit("library-changed", ());
    done()
}

/// A book opens here: a phone's place that came in while it was closed and still waits (a restart loses
/// the question) is asked about again; a book with no place here simply takes it.
pub fn offer_if_waiting(app: &AppHandle, id: i64) {
    let Some(b) = book_row(app, id) else { return };
    let Some(p) = b.peer.as_ref().filter(|p| p.has_place()) else { return };
    if !b.desk.has_place() && pp::served(&b.desk, Some(p)).map_or(false, |s| s.from_peer) {
        take_place(app, id, &p.server());
    } else if pp::waiting(&b.desk, p) {
        sync::offer_from_peer(app, id, p.server(), p.device.as_deref().unwrap_or("Katana"));
    }
}

/// This PC takes a phone's place (a book linked to Grimmory then sends it up by its own sync).
pub fn take_place(app: &AppHandle, id: i64, p: &ServerPlace) {
    let now = db::now();
    let (format, linked): (String, bool) = match conn_of(app)
        .query_row("SELECT format, grimmory_id IS NOT NULL FROM books WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
    {
        Ok(x) => x,
        Err(_) => return,
    };
    let format = format.to_ascii_lowercase();
    let location = if paged(&format) {
        p.page.map(|n| n.to_string()).or_else(|| p.cfi.clone())
    } else if format == "epub" {
        p.cfi.clone()
    } else {
        // MOBI, AZW3, FB2: how far through (the reader goes there)
        None
    };
    let _ = conn_of(app).execute(
        "UPDATE books SET location = ?2, fraction = ?3, href = ?4, place_at = ?5, peer_synced_at = ?5, opened_at = ?5,
            place_state = CASE WHEN grimmory_id IS NULL THEN place_state ELSE 'pending' END,
            finished_at = CASE WHEN ?3 >= 0.995 THEN COALESCE(finished_at, ?5) ELSE finished_at END
         WHERE id = ?1",
        params![id, location, p.fraction, if paged(&format) { None } else { p.href.clone() }, now],
    );
    if linked {
        sync::schedule_push(app, id);
    }
    let _ = app.emit("library-changed", ());
}

fn ids_in(v: &Value) -> Vec<i64> {
    v.as_array().into_iter().flatten().filter_map(|x| x.as_i64()).collect()
}

fn set_status(app: &AppHandle, v: &Value) -> Reply {
    let Some(status) = text(v, "status") else { return fail(400, "status is needed") };
    if !sync::STATUSES.contains(&status.as_str()) {
        return fail(400, &format!("{status} isn't a reading status"));
    }
    let mut out = vec![];
    for id in ids_in(v.get("bookIds").unwrap_or(&Value::Null)) {
        let Some(b) = book_row(app, id) else { continue };
        {
            let conn = conn_of(app);
            match b.grimmory_id {
                Some(gid) => {
                    let _ = conn.execute("UPDATE gbooks SET read_status = ?2 WHERE id = ?1", params![gid, status]);
                    if status == "READ" {
                        let _ = crate::reads::mark_finished(&conn, id, b.read_status.as_deref() == Some("READ"));
                    }
                }
                None => {
                    let _ = crate::reads::set_local_status(&conn, id, &status);
                }
            }
        }
        if status == "UNREAD" {
            sync::clear(app, id);
        }
        if let Some(gid) = b.grimmory_id.filter(|_| crate::grimmory::g(app).signed_in()) {
            let (app, status) = (app.clone(), status.clone());
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sync::grimmory_set_status(app, gid, status).await {
                    eprintln!("katana: a phone's status for Grimmory book {gid} waits: {e}");
                }
            });
        }
        out.push(json!({ "bookId": id, "readStatus": status }));
    }
    let _ = app.emit("library-changed", ());
    ok(Value::Array(out))
}

fn reset(app: &AppHandle, v: &Value) -> Reply {
    let now = db::now();
    let mut out = vec![];
    for id in ids_in(v) {
        let Some(b) = book_row(app, id) else { continue };
        // read here a moment ago, or open here: whoever reads on decides (as with a reset on Grimmory)
        // (a place taken from a phone isn't a read here)
        let read_here = b.desk.local(now).pending;
        let fresh = sync::is_open(id) || (read_here && b.desk.place_at.map_or(false, |a| a > now - PENDING_MARGIN_MS));
        if fresh {
            let _ = conn_of(app).execute(
                "UPDATE books SET peer_place = NULL, peer_served_at = ?2, peer_synced_at = ?2 WHERE id = ?1",
                params![id, now],
            );
        } else {
            sync::clear(app, id);
            match b.grimmory_id {
                Some(gid) => {
                    let _ = conn_of(app).execute("UPDATE gbooks SET read_status = 'UNREAD', progress = NULL WHERE id = ?1", [gid]);
                    if crate::grimmory::g(app).signed_in() {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = sync::grimmory_reset_progress(app, gid).await {
                                eprintln!("katana: a phone's reset for Grimmory book {gid} waits: {e}");
                            }
                        });
                    }
                }
                None => {
                    let _ = conn_of(app).execute("UPDATE books SET read_status = 'UNREAD' WHERE id = ?1", [id]);
                }
            }
        }
        out.push(json!({ "bookId": id, "readStatus": if fresh { status_of(&b, true) } else { "UNREAD".into() } }));
    }
    let _ = app.emit("library-changed", ());
    ok(Value::Array(out))
}

// ---- highlights ----

fn hl_json(h: &highlights::Highlight) -> Value {
    json!({
        "id": h.id,
        "bookId": h.book_id,
        "cfi": h.cfi,
        "text": h.text,
        "color": marks_sync::color_hex(&h.color),
        "style": h.style,
        "note": h.note,
        "chapterTitle": h.chapter,
        "createdAt": iso(h.created_at),
        "updatedAt": iso(h.updated_at),
    })
}

fn book_exists(app: &AppHandle, id: i64) -> bool {
    conn_of(app).query_row("SELECT 1 FROM books WHERE id = ?1", [id], |_| Ok(())).is_ok()
}

fn marks_changed(app: &AppHandle, book_id: i64) {
    marks_sync::schedule(app, book_id);
    let _ = app.emit("marks-changed", book_id);
}

/// A book's highlights (EPUB places only, as on Grimmory); removed ones are gone.
fn list_highlights(app: &AppHandle, book_id: i64) -> Reply {
    if !book_exists(app, book_id) {
        return fail(404, "No such book");
    }
    let list = highlights::list(&conn_of(app), book_id).unwrap_or_default();
    ok(Value::Array(list.iter().filter(|h| h.cfi.starts_with("epubcfi(")).map(hl_json).collect()))
}

fn live_mark(app: &AppHandle, table: &str, id: i64) -> Option<i64> {
    let table = if table == "highlights" { "highlights" } else { "bookmarks" };
    conn_of(app)
        .query_row(&format!("SELECT book_id FROM {table} WHERE id = ?1 AND deleted_at IS NULL"), [id], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

fn add_highlight(app: &AppHandle, v: &Value) -> Reply {
    let Some(book_id) = v.get("bookId").and_then(|x| x.as_i64()) else { return fail(400, "bookId is needed") };
    let Some(cfi) = text(v, "cfi") else { return fail(400, "cfi is needed") };
    if !book_exists(app, book_id) {
        return fail(404, "No such book");
    }
    let saved = {
        let conn = conn_of(app);
        let there: bool = conn
            .query_row("SELECT 1 FROM highlights WHERE book_id = ?1 AND cfi = ?2 AND deleted_at IS NULL", params![book_id, cfi], |_| Ok(()))
            .is_ok();
        if there {
            return fail(409, "This book already has a highlight there");
        }
        let words = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
        let note = text(v, "note");
        let chapter = text(v, "chapterTitle");
        highlights::add(
            &conn,
            &highlights::NewHighlight {
                book_id,
                cfi: &cfi,
                text: words,
                chapter: chapter.as_deref(),
                fraction: None,
                page_label: None,
                color: marks_sync::color_name(v.get("color").and_then(|x| x.as_str())),
                style: marks_sync::style_name(v.get("style").and_then(|x| x.as_str())),
                note: note.as_deref(),
            },
        )
    };
    match saved {
        Ok(h) => {
            marks_changed(app, book_id);
            ok(hl_json(&h))
        }
        Err(e) => fail(500, &e.to_string()),
    }
}

fn change_highlight(app: &AppHandle, id: i64, v: &Value) -> Reply {
    let Some(book_id) = live_mark(app, "highlights", id) else { return fail(404, "No such highlight") };
    let saved = {
        let conn = conn_of(app);
        let old = highlights::get(&conn, id).ok().flatten();
        let color = v.get("color").and_then(|x| x.as_str()).map(|c| marks_sync::color_name(Some(c))).or(old.as_ref().map(|h| h.color.as_str())).unwrap_or("yellow").to_string();
        let style = v.get("style").and_then(|x| x.as_str()).map(|s| marks_sync::style_name(Some(s))).or(old.as_ref().map(|h| h.style.as_str())).unwrap_or("highlight").to_string();
        // an empty note removes it; a missing one stays as it is
        let note = match v.get("note") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => old.as_ref().and_then(|h| h.note.clone()),
        };
        highlights::update(&conn, id, &color, &style, note.as_deref()).and_then(|_| highlights::get(&conn, id))
    };
    match saved {
        Ok(Some(h)) => {
            marks_changed(app, book_id);
            ok(hl_json(&h))
        }
        Ok(None) => fail(404, "No such highlight"),
        Err(e) => fail(500, &e.to_string()),
    }
}

fn remove_highlight(app: &AppHandle, id: i64) -> Reply {
    let Some(book_id) = live_mark(app, "highlights", id) else { return fail(404, "No such highlight") };
    let _ = highlights::remove(&conn_of(app), id);
    marks_changed(app, book_id);
    Reply { status: 204, body: None }
}

// ---- bookmarks ----

/// A bookmark's place here (`page:12` for a PDF's or comic's page) as Grimmory keeps it: a PDF's page
/// in `pageNumber`, a comic's page in `cfi`, an EPUB's CFI.
pub fn bm_place_out(format: &str, cfi: &str) -> (Option<String>, Option<i64>) {
    match cfi.strip_prefix("page:").and_then(|s| s.parse::<i64>().ok()) {
        Some(n) if format == "pdf" => (None, Some(n)),
        Some(n) => (Some(n.to_string()), None),
        None => (Some(cfi.to_string()), None),
    }
}

pub fn bm_place_in(format: &str, cfi: Option<&str>, page: Option<i64>) -> Option<String> {
    if let Some(n) = page.filter(|n| *n >= 1) {
        return Some(format!("page:{n}"));
    }
    let c = cfi.map(str::trim).filter(|c| !c.is_empty())?;
    match c.parse::<i64>() {
        Ok(n) if paged(format) && n >= 1 => Some(format!("page:{n}")),
        _ => Some(c.to_string()),
    }
}

fn format_of(app: &AppHandle, book_id: i64) -> Option<String> {
    conn_of(app)
        .query_row("SELECT format FROM books WHERE id = ?1", [book_id], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
        .map(|f| f.to_ascii_lowercase())
}

fn bm_json(format: &str, b: &marks::Bookmark) -> Value {
    let (cfi, page) = bm_place_out(format, &b.cfi);
    json!({
        "id": b.id,
        "bookId": b.book_id,
        "cfi": cfi,
        "pageNumber": page,
        "title": b.title,
        "notes": b.note,
        "createdAt": iso(b.created_at),
        "updatedAt": iso(b.updated_at),
    })
}

fn list_bookmarks(app: &AppHandle, book_id: i64) -> Reply {
    let Some(format) = format_of(app, book_id) else { return fail(404, "No such book") };
    let list = marks::list(&conn_of(app), book_id).unwrap_or_default();
    ok(Value::Array(list.iter().map(|b| bm_json(&format, b)).collect()))
}

fn bookmark(app: &AppHandle, book_id: i64, id: i64) -> Option<marks::Bookmark> {
    marks::list(&conn_of(app), book_id).ok()?.into_iter().find(|b| b.id == id)
}

fn add_bookmark(app: &AppHandle, v: &Value) -> Reply {
    let Some(book_id) = v.get("bookId").and_then(|x| x.as_i64()) else { return fail(400, "bookId is needed") };
    let Some(format) = format_of(app, book_id) else { return fail(404, "No such book") };
    let page = v.get("pageNumber").and_then(|x| x.as_i64());
    let Some(place) = bm_place_in(&format, v.get("cfi").and_then(|x| x.as_str()), page) else {
        return fail(400, "cfi or pageNumber is needed");
    };
    let saved = {
        let conn = conn_of(app);
        let there = conn
            .query_row("SELECT 1 FROM bookmarks WHERE book_id = ?1 AND cfi = ?2 AND deleted_at IS NULL", params![book_id, place], |_| Ok(()))
            .is_ok();
        if there {
            return fail(409, "This book already has a bookmark there");
        }
        let label = place.strip_prefix("page:").map(String::from);
        let added = marks::add(
            &conn,
            &marks::NewMark { book_id, cfi: &place, fraction: None, page_label: label.as_deref(), chapter: None, excerpt: None },
        );
        match (added, text(v, "title")) {
            (Ok(b), Some(title)) => marks::update(&conn, b.id, Some(&title), None).map(|_| b.id),
            (Ok(b), None) => Ok(b.id),
            (Err(e), _) => Err(e),
        }
    };
    match saved.ok().and_then(|id| bookmark(app, book_id, id)) {
        Some(b) => {
            marks_changed(app, book_id);
            ok(bm_json(&format, &b))
        }
        None => fail(500, "The bookmark couldn't be saved"),
    }
}

fn change_bookmark(app: &AppHandle, id: i64, v: &Value) -> Reply {
    let Some(book_id) = live_mark(app, "bookmarks", id) else { return fail(404, "No such bookmark") };
    let format = format_of(app, book_id).unwrap_or_default();
    let Some(old) = bookmark(app, book_id, id) else { return fail(404, "No such bookmark") };
    // an empty one clears it; a missing one stays as it is
    let title = match v.get("title") {
        Some(Value::String(s)) => Some(s.clone()),
        _ => old.title.clone(),
    };
    let notes = match v.get("notes") {
        Some(Value::String(s)) => Some(s.clone()),
        _ => old.note.clone(),
    };
    let _ = marks::update(&conn_of(app), id, title.as_deref(), notes.as_deref());
    match bookmark(app, book_id, id) {
        Some(b) => {
            marks_changed(app, book_id);
            ok(bm_json(&format, &b))
        }
        None => fail(404, "No such bookmark"),
    }
}

fn remove_bookmark(app: &AppHandle, id: i64) -> Reply {
    let Some(book_id) = live_mark(app, "bookmarks", id) else { return fail(404, "No such bookmark") };
    let _ = marks::remove(&conn_of(app), id);
    marks_changed(app, book_id);
    Reply { status: 204, body: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn progress_requests_read_as_katana_sends_them() {
        let v = json!({ "bookId": 4, "fileProgress": { "bookFileId": 4, "positionData": "epubcfi(/6/8!/4/2)", "positionHref": "ch2.xhtml", "progressPercent": 41.5 } });
        let p = incoming_place("epub", &v, NOW).unwrap();
        assert_eq!(p.cfi.as_deref(), Some("epubcfi(/6/8!/4/2)"));
        assert_eq!(p.href.as_deref(), Some("ch2.xhtml"));
        assert!((p.fraction.unwrap() - 0.415).abs() < 1e-9);
        assert_eq!(p.at, NOW);
        // a PDF's page, the older shape
        let v = json!({ "bookId": 4, "pdfProgress": { "page": 12, "percentage": 10.0 } });
        let p = incoming_place("pdf", &v, NOW).unwrap();
        assert_eq!((p.cfi.as_deref(), p.page), (Some("12"), Some(12)));
        // a comic's page in fileProgress
        let v = json!({ "bookId": 4, "fileProgress": { "bookFileId": 4, "positionData": "7", "progressPercent": 30.0 } });
        assert_eq!(incoming_place("cbz", &v, NOW).unwrap().page, Some(7));
        // MOBI: how far through only
        let v = json!({ "bookId": 4, "epubProgress": { "cfi": "epubcfi(/6/2)", "percentage": 50.0 } });
        let p = incoming_place("mobi", &v, NOW).unwrap();
        assert_eq!((p.cfi, p.fraction), (None, Some(0.5)));
        // nothing in it
        assert!(incoming_place("epub", &json!({ "bookId": 4 }), NOW).is_none());
    }

    #[test]
    fn places_go_out_in_grimmorys_shapes() {
        let s = pp::Served { cfi: Some("epubcfi(/6/4)".into()), href: Some("c.xhtml".into()), fraction: Some(0.25), page: None, at: Some(NOW), from_peer: false };
        let (k, v) = progress_json("epub", &s);
        assert_eq!(k, "epubProgress");
        assert_eq!(v["cfi"], "epubcfi(/6/4)");
        assert_eq!(v["percentage"], 25.0);
        let s = pp::Served { cfi: Some("12".into()), href: None, fraction: Some(0.1), page: Some(12), at: Some(NOW), from_peer: false };
        assert_eq!(progress_json("pdf", &s).0, "pdfProgress");
        assert_eq!(progress_json("pdf", &s).1["page"], 12);
        assert_eq!(progress_json("cbr", &s).0, "cbxProgress");
        assert_eq!(iso(1_795_168_190_000).as_deref(), Some("2026-11-20T09:49:50.000Z"));
    }

    #[test]
    fn a_book_matches_by_format_size_and_partial_md5() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, hash TEXT, size INTEGER, format TEXT, missing INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'local');
             INSERT INTO books (id, hash, size, format, source) VALUES (3, 'abcdef0123', 1000, 'epub', 'grimmory');
             INSERT INTO books (id, hash, size, format) VALUES (7, 'abcdef0123', 1000, 'epub');
             INSERT INTO books (id, hash, size, format) VALUES (8, '99', 500, 'pdf');
             INSERT INTO books (id, hash, size, format, missing) VALUES (9, '77', 500, 'pdf', 1);",
        )
        .unwrap();
        // the Local copy first; any case of the hash and format
        assert_eq!(match_one(&conn, "ABCDEF0123", 1000, "EPUB"), Some(7));
        // a byte off, another format, another hash: not the same file
        assert_eq!(match_one(&conn, "abcdef0123", 1001, "EPUB"), None);
        assert_eq!(match_one(&conn, "abcdef0123", 1000, "PDF"), None);
        assert_eq!(match_one(&conn, "abcdef0124", 1000, "EPUB"), None);
        assert_eq!(match_one(&conn, "99", 500, "pdf"), Some(8));
        // a file that went missing isn't there to sync
        assert_eq!(match_one(&conn, "77", 500, "pdf"), None);
    }

    #[test]
    fn finished_books_carry_their_day() {
        assert_eq!(finished_in(&json!({ "dateFinished": "2026-11-20T09:49:50Z" }), NOW), Some(Some(1_795_168_190_000)));
        assert_eq!(finished_in(&json!({ "dateFinished": null }), NOW), Some(None));
        assert_eq!(finished_in(&json!({ "bookId": 2 }), NOW), None);
        // a day a week ahead counts as now
        assert_eq!(finished_in(&json!({ "dateFinished": "2027-06-01T00:00:00Z" }), 1_795_168_190_000), Some(Some(1_795_168_190_000)));
        assert_eq!(last_read(None, Some(5)), Some(5));
        assert_eq!(last_read(Some(9), Some(5)), Some(9));
        assert_eq!(last_read(None, None), None);
    }

    #[test]
    fn a_status_of_read_sets_the_finished_day_once() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, read_status TEXT, finished_at INTEGER);
             INSERT INTO books (id) VALUES (2);",
        )
        .unwrap();
        crate::reads::set_local_status(&conn, 2, "READ").unwrap();
        let first: Option<i64> = conn.query_row("SELECT finished_at FROM books WHERE id = 2", [], |r| r.get(0)).unwrap();
        assert!(first.is_some());
        // Read again: the day stays
        conn.execute("UPDATE books SET finished_at = 5 WHERE id = 2", []).unwrap();
        crate::reads::set_local_status(&conn, 2, "READ").unwrap();
        let again: i64 = conn.query_row("SELECT finished_at FROM books WHERE id = 2", [], |r| r.get(0)).unwrap();
        assert_eq!(again, 5);
        // Reading, then Read: a new day
        crate::reads::set_local_status(&conn, 2, "READING").unwrap();
        crate::reads::set_local_status(&conn, 2, "READ").unwrap();
        let later: i64 = conn.query_row("SELECT finished_at FROM books WHERE id = 2", [], |r| r.get(0)).unwrap();
        assert!(later > 5);
    }

    #[test]
    fn bookmark_places_map_both_ways() {
        assert_eq!(bm_place_out("pdf", "page:12"), (None, Some(12)));
        assert_eq!(bm_place_out("cbz", "page:3"), (Some("3".into()), None));
        assert_eq!(bm_place_out("epub", "epubcfi(/6/4)"), (Some("epubcfi(/6/4)".into()), None));
        assert_eq!(bm_place_in("pdf", None, Some(12)).as_deref(), Some("page:12"));
        assert_eq!(bm_place_in("cbz", Some("3"), None).as_deref(), Some("page:3"));
        assert_eq!(bm_place_in("epub", Some("epubcfi(/6/4)"), None).as_deref(), Some("epubcfi(/6/4)"));
        assert_eq!(bm_place_in("epub", None, None), None);
    }
}
