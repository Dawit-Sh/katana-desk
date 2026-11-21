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
/// Offers that came from a phone on this Wi-Fi (`peer`), not from Grimmory.
fn peer_offers() -> &'static Mutex<std::collections::HashSet<i64>> {
    static P: OnceLock<Mutex<std::collections::HashSet<i64>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// The book open in the reader here.
pub fn is_open(id: i64) -> bool {
    *open_book().lock().unwrap() == Some(id)
}

/// A phone's place that wins but sits behind this PC's, or for a book open here: the reader asks, as it
/// does for Grimmory's (its answer goes to `peer::answer`).
pub fn offer_from_peer(app: &AppHandle, id: i64, p: ServerPlace) {
    offers().lock().unwrap().insert(id, p);
    peer_offers().lock().unwrap().insert(id);
    if is_open(id) {
        let _ = app.emit("grimmory-offer", id);
    }
}

struct Linked {
    gid: i64,
    format: String,
    local: LocalPlace,
    seen: Option<Seen>,
    href: Option<String>,
}

/// Formats whose exact place means the same in Grimmory's web reader: an EPUB's CFI (foliate-js on both
/// sides), a PDF's or a comic's page (kept in the `cfi` slot as the page number, from 1). MOBI, AZW3 and
/// FB2 go by how far through, as on Android, so a place from any device can be used.
fn uses_cfi(format: &str) -> bool {
    format == "epub" || by_page(format)
}

/// PDFs and comics: Grimmory keeps their place as a page (from 1).
pub fn by_page(format: &str) -> bool {
    matches!(format, "pdf" | "cbz" | "cbr")
}

fn is_comic(format: &str) -> bool {
    matches!(format, "cbz" | "cbr")
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
    Ok(place_from(&v, format, db::now()))
}

/// Reads a `/progress` answer. Grimmory keeps two kinds of place: its readers' (EPUB CFI, PDF or comic
/// page, a percentage from 0 to 100) and KOReader's (a fraction from 0 to 1). Every reader push is also
/// mirrored into the KOReader record under the device name "Grimmory", so that record only wins when
/// there's no reader place, or when a real KOReader device wrote it last (its sync time is the book's
/// last read time).
pub fn place_from(v: &serde_json::Value, format: &str, now: i64) -> Option<ServerPlace> {
    // marked unread on Grimmory: no place, whatever percentage it still keeps
    if v.get("readStatus").and_then(|x| x.as_str()) == Some("UNREAD") {
        return None;
    }
    let key = if is_comic(format) { "cbxProgress" } else if format == "pdf" { "pdfProgress" } else { "epubProgress" };
    let p = v.get(key).filter(|x| x.is_object());
    let last = v.get("lastReadTime").and_then(parse_time);
    if let Some(ko) = v.get("koreaderProgress").filter(|x| x.is_object()) {
        let ko_time = ko.get("lastSyncTime").and_then(parse_time);
        let mirror = ko.get("device").and_then(|x| x.as_str()) == Some("Grimmory");
        let reader_place = p.map_or(false, |p| {
            p.get("cfi").and_then(|x| x.as_str()).map_or(false, |c| c.starts_with("epubcfi("))
                || p.get("percentage").and_then(|x| x.as_f64()).unwrap_or(0.0) > 0.0
                || p.get("page").and_then(|x| x.as_i64()).is_some()
        });
        let ko_latest = !reader_place
            || (!mirror
                && matches!((ko_time, last), (Some(ServerTime::Zoned(a)), Some(ServerTime::Zoned(b))) if (a - b).abs() <= 5_000));
        let frac = ko.get("percentage").and_then(|x| x.as_f64()).map(|x| x.clamp(0.0, 1.0));
        if ko_latest && frac.unwrap_or(0.0) > 0.0 {
            let time = ko_time.or(last);
            return Some(ServerPlace {
                cfi: None,
                href: None,
                fraction: frac,
                page: None,
                at: time.and_then(|t| t.trusted(now)),
                zoneless: matches!(time, Some(ServerTime::Zoneless)),
            });
        }
    }
    let pct = p.and_then(|p| p.get("percentage")).and_then(|x| x.as_f64()).map(|x| (x / 100.0).clamp(0.0, 1.0));
    let page = p.and_then(|p| p.get("page")).and_then(|x| x.as_i64()).filter(|n| *n >= 1);
    let cfi = if by_page(format) {
        page.map(|n| n.to_string())
    } else {
        p.and_then(|p| p.get("cfi"))
            .and_then(|x| x.as_str())
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty() && x != "0" && x.starts_with("epubcfi("))
            .filter(|_| uses_cfi(format))
    };
    let href = p.and_then(|p| p.get("href")).and_then(|x| x.as_str()).map(String::from);
    if cfi.is_none() && pct.unwrap_or(0.0) <= 0.0 && page.is_none() {
        return None;
    }
    let time = p.and_then(|p| p.get("updatedAt")).and_then(parse_time).or(last);
    Some(ServerPlace {
        cfi,
        href,
        fraction: pct,
        page,
        at: time.and_then(|t| t.trusted(now)),
        zoneless: matches!(time, Some(ServerTime::Zoneless)),
    })
}

#[cfg(test)]
mod tests {
    use super::place_from;
    use serde_json::json;

    #[test]
    fn marked_unread_has_no_place() {
        let v = json!({"readProgress":0.5,"readStatus":"UNREAD","pdfProgress":{"page":34,"percentage":50.0,"updatedAt":"2026-11-20T16:20:28Z"}});
        assert_eq!(place_from(&v, "pdf", 1_795_182_400_000), None);
        assert_eq!(place_from(&json!({}), "epub", 1_795_182_400_000), None);
    }

    #[test]
    fn pdf_and_comic_places_are_pages() {
        // Aborting the Human Race and Dio on his Grimmory, after a page turn from this PC
        let now = 1_795_182_400_000;
        let v = json!({"readProgress":0.692,"lastReadTime":"2026-11-20T13:46:31Z",
            "pdfProgress":{"page":9,"percentage":69.2,"updatedAt":"2026-11-20T13:46:31Z"},
            "koreaderProgress":{"percentage":0.692,"device":"Grimmory","deviceId":"Grimmory","lastSyncTime":"2026-11-20T13:46:31Z"}});
        let p = place_from(&v, "pdf", now).unwrap();
        assert_eq!((p.cfi.as_deref(), p.page), (Some("9"), Some(9)));
        assert!((p.fraction.unwrap() - 0.692).abs() < 1e-6);
        let v = json!({"cbxProgress":{"page":6,"percentage":5.0,"updatedAt":"2026-11-20T13:48:45Z"}});
        assert_eq!(place_from(&v, "cbr", now).unwrap().cfi.as_deref(), Some("6"));
        // an EPUB's place on a PDF is left alone; a page is never read as a CFI
        let v = json!({"epubProgress":{"cfi":"epubcfi(/6/4!/4/2/1:0)","percentage":10.0}});
        assert_eq!(place_from(&v, "pdf", now), None);
        let v = json!({"epubProgress":{"cfi":"epubcfi(/6/4!/4/2/1:0)","percentage":10.0}});
        assert_eq!(place_from(&v, "epub", now).unwrap().cfi.as_deref(), Some("epubcfi(/6/4!/4/2/1:0)"));
    }

    #[test]
    fn koreader_place_wins_when_it_was_written_last() {
        // The Hole on his Grimmory: only KOReader's fraction
        let v = json!({"readProgress":0.0769231,"lastReadTime":"2026-11-20T09:34:13Z",
            "koreaderProgress":{"percentage":0.0769231,"lastSyncTime":"2026-11-20T09:34:13Z"}});
        let p = place_from(&v, "epub", 1_800_000_000_000).unwrap();
        assert!((p.fraction.unwrap() - 0.0769231).abs() < 1e-6);
        assert!(p.cfi.is_none());
    }

    #[test]
    fn grimmorys_own_mirror_never_hides_the_cfi() {
        // what his Grimmory answered right after a Katana Desk push
        let v = json!({"readProgress":0.05,"lastReadTime":"2026-11-20T10:44:59Z",
            "epubProgress":{"cfi":"epubcfi(/6/8!/4/2/1:0)","href":null,"percentage":5.0,"updatedAt":"2026-11-20T10:44:59Z"},
            "koreaderProgress":{"percentage":0.05,"device":"Grimmory","deviceId":"Grimmory","lastSyncTime":"2026-11-20T10:44:59Z"}});
        let p = place_from(&v, "epub", 1_800_000_000_000).unwrap();
        assert_eq!(p.cfi.as_deref(), Some("epubcfi(/6/8!/4/2/1:0)"));
        assert!((p.fraction.unwrap() - 0.05).abs() < 1e-9);
        // a real KOReader device that synced last wins
        let v2 = json!({"lastReadTime":"2026-11-20T11:00:00Z",
            "epubProgress":{"cfi":"epubcfi(/6/8!/4/2/1:0)","percentage":5.0,"updatedAt":"2026-11-20T11:00:00Z"},
            "koreaderProgress":{"percentage":0.3,"device":"Kindle","lastSyncTime":"2026-11-20T11:00:00Z"}});
        let p2 = place_from(&v2, "epub", 1_800_000_000_000).unwrap();
        assert!(p2.cfi.is_none());
        assert!((p2.fraction.unwrap() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn web_reader_place_is_a_percentage() {
        let v = json!({"lastReadTime":"2026-11-16T18:55:18Z","epubProgress":{"cfi":"epubcfi(/6/12!/4/2,/2[pre],/4/1:884)",
            "href":"OEBPS/text/x.xhtml","percentage":0.60133,"updatedAt":"2026-11-16T18:55:18Z"},
            "koreaderProgress":{"percentage":0.5,"lastSyncTime":"2026-11-10T10:00:00Z"}});
        let p = place_from(&v, "epub", 1_800_000_000_000).unwrap();
        assert!((p.fraction.unwrap() - 0.0060133).abs() < 1e-7);
        assert!(p.cfi.is_some());
        assert!(p.at.is_some());
    }
}

fn seen_json(s: &Seen) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// Takes Grimmory's place here. `use_cfi`: its CFI; otherwise how far through (the reader goes there).
fn apply(app: &AppHandle, id: i64, p: &ServerPlace, use_cfi: bool) {
    let conn = conn_of(app);
    // a page (PDFs, comics) is always exact; a CFI only when it's fresh
    let page = p.cfi.as_deref().map_or(false, |c| c.parse::<i64>().is_ok());
    let location = if use_cfi || page { p.cfi.clone() } else { None };
    let _ = conn.execute(
        "UPDATE books SET location = ?2, fraction = ?3, place_state = 'clean', server_place = ?4, synced_at = ?5,
            place_at = ?5 WHERE id = ?1",
        params![id, location, p.fraction, seen_json(&Seen::of(p)), db::now()],
    );
}

/// Unread here too: no place, not in Continue reading, not finished.
pub fn clear(app: &AppHandle, id: i64) {
    if peer_offers().lock().unwrap().remove(&id) {
        offers().lock().unwrap().remove(&id);
    }
    {
        let conn = conn_of(app);
        let _ = conn.execute(
            "UPDATE books SET location = NULL, fraction = NULL, chapter = NULL, opened_at = NULL, finished_at = NULL,
                place_state = 'clean', server_place = NULL, synced_at = ?2, place_at = NULL,
                peer_place = NULL, peer_served_at = NULL, peer_synced_at = ?2 WHERE id = ?1",
            params![id, db::now()],
        );
        let _ = conn.execute(
            "UPDATE gbooks SET progress = NULL WHERE id = (SELECT grimmory_id FROM books WHERE id = ?1)",
            [id],
        );
    }
    let _ = app.emit("library-changed", ());
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
    let paged = by_page(&l.format);
    // PDFs and comics: Grimmory keeps the page (from 1). The page view saves it as the place; an older
    // place (a comic read in foliate-js) goes by how far through.
    let page = paged
        .then(|| {
            l.local.cfi.as_deref().and_then(|c| c.parse::<i64>().ok()).filter(|n| *n >= 1).or_else(|| {
                let total: Option<i64> = conn_of(app).query_row("SELECT page_count FROM gbooks WHERE id = ?1", [l.gid], |r| r.get(0)).ok().flatten();
                total.map(|t| ((l.local.fraction.unwrap_or(0.0) * t as f64).ceil() as i64).clamp(1, t.max(1)))
            })
        })
        .flatten();
    let position = if paged { page.map(|p| p.to_string()) } else { l.local.cfi.clone() };
    let href = if paged { None } else { l.href.clone() };
    let body = match file_id {
        Some(fid) => serde_json::json!({
            "bookId": l.gid,
            "fileProgress": { "bookFileId": fid, "positionData": position, "positionHref": href, "progressPercent": pct }
        }),
        None if is_comic(&l.format) => serde_json::json!({ "bookId": l.gid, "cbxProgress": { "page": page, "percentage": pct } }),
        None if paged => serde_json::json!({ "bookId": l.gid, "pdfProgress": { "page": page, "percentage": pct } }),
        None => serde_json::json!({ "bookId": l.gid, "epubProgress": { "cfi": position, "href": href, "percentage": pct } }),
    };
    let resp = send(app, move |c, base, tok| c.post(format!("{base}/api/v1/books/progress")).bearer_auth(tok).json(&body)).await?;
    if !resp.status().is_success() {
        let st = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(GErr::Server(st, super::server_message(&text)));
    }
    let sent = ServerPlace {
        cfi: if paged { position.clone() } else if uses_cfi(&l.format) { l.local.cfi.clone() } else { None },
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
    if peer_offers().lock().unwrap().contains(&id) {
        // a phone's place is waiting for an answer here; Grimmory's is weighed after it
        return Ok(None);
    }
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
        Decision::Clear if !is_open => {
            offers().lock().unwrap().remove(&id);
            clear(app, id);
        }
        Decision::Clear => {
            // open here: whoever reads on decides; a page turned here goes up
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
    let from_peer = peer_offers().lock().unwrap().remove(&id);
    if let (Some(p), true) = (&offered, from_peer) {
        crate::peer::answer(&app, id, p, go);
    } else if let Some(p) = offered {
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

/// While a book is open: a quick look at Grimmory's place for it (every 30 s, and when the window comes
/// back to the front), so a page read in Grimmory's own reader or on the Fire shows up here. `follow`:
/// the window just came back, so when nothing was read here since the last sync, the book moves to
/// Grimmory's newer place by itself (returned, for "Back to p. N"); otherwise it asks, as at the start.
#[tauri::command]
pub async fn grimmory_keep_up(app: AppHandle, id: i64, follow: bool) -> Option<OpenPlace> {
    if !g(&app).signed_in() || *open_book().lock().unwrap() != Some(id) || peer_offers().lock().unwrap().contains(&id) {
        return None;
    }
    let pending = linked(&app, id)?.local.pending;
    let _ = reconcile(&app, id, Some(Duration::from_secs(6))).await;
    if !follow || pending {
        return None;
    }
    let p = offers().lock().unwrap().remove(&id)?;
    let use_cfi = p.cfi.is_some() && linked(&app, id).and_then(|l| l.seen).map_or(true, |s| s.cfi != p.cfi);
    apply(&app, id, &p, use_cfi);
    let (location, fraction, gid) = place_of(&app, id);
    Some(OpenPlace { location, fraction, offer: None, grimmory_id: gid })
}

/// Grimmory's reading statuses, as its web app sets them.
pub const STATUSES: [&str; 8] = ["UNREAD", "READING", "RE_READING", "READ", "PARTIALLY_READ", "PAUSED", "WONT_READ", "ABANDONED"];

fn local_ids(app: &AppHandle, gid: i64) -> Vec<i64> {
    let conn = conn_of(app);
    let mut st = match conn.prepare("SELECT id FROM books WHERE grimmory_id = ?1") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = st.query_map([gid], |r| r.get(0));
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

/// The status Grimmory answered with (its first `readStatus`), or the one asked for.
async fn status_answer(resp: reqwest::Response, asked: &str) -> GRes<String> {
    let st = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&st) {
        return Err(GErr::Server(st, super::server_message(&text)));
    }
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Ok(v.get(0).and_then(|r| r.get("readStatus")).and_then(|s| s.as_str()).unwrap_or(asked).to_string())
}

/// Sets a book's reading status on Grimmory (Unread, Reading, Re-reading, Read, Partially read, Paused,
/// Won't read, Abandoned), as its web app does. Unread clears the place here too, as one set there would.
#[tauri::command]
pub async fn grimmory_set_status(app: AppHandle, gid: i64, status: String) -> Result<String, String> {
    if !STATUSES.contains(&status.as_str()) {
        return Err(format!("{status} isn't a reading status"));
    }
    let body = serde_json::json!({ "bookIds": [gid], "status": status });
    let resp = send(&app, move |c, base, tok| c.post(format!("{base}/api/v1/books/status")).bearer_auth(tok).json(&body))
        .await
        .map_err(String::from)?;
    let now_status = status_answer(resp, &status).await.map_err(String::from)?;
    let _ = conn_of(&app).execute("UPDATE gbooks SET read_status = ?2 WHERE id = ?1", params![gid, now_status]);
    if now_status == "UNREAD" {
        for id in local_ids(&app, gid) {
            clear(&app, id);
        }
    }
    let _ = app.emit("library-changed", ());
    Ok(now_status)
}

/// Resets a book's progress on Grimmory (its readers' place and the KOReader one, as the web app's
/// Reset progress does) and here: no place, not finished, out of Continue reading. Marks stay.
#[tauri::command]
pub async fn grimmory_reset_progress(app: AppHandle, gid: i64) -> Result<String, String> {
    let mut status = "UNREAD".to_string();
    for kind in ["BOOKLORE", "KOREADER"] {
        let resp = send(&app, move |c, base, tok| {
            c.post(format!("{base}/api/v1/books/reset-progress?type={kind}")).bearer_auth(tok).json(&serde_json::json!([gid]))
        })
        .await
        .map_err(String::from)?;
        let s = status_answer(resp, "UNREAD").await.map_err(String::from)?;
        if kind == "BOOKLORE" {
            status = s;
        }
    }
    let _ = conn_of(&app).execute(
        "UPDATE gbooks SET progress = NULL, last_read = NULL, read_status = ?2 WHERE id = ?1",
        params![gid, status],
    );
    for id in local_ids(&app, gid) {
        clear(&app, id);
    }
    let _ = app.emit("library-changed", ());
    Ok(status)
}

/// A book that's only on this PC: its place goes, so it's unread here.
#[tauri::command]
pub fn book_reset_place(app: AppHandle, id: i64) {
    clear(&app, id);
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


