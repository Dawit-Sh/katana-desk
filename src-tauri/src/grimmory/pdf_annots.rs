//! PDF highlights and drawings, both ways with Grimmory's own PDF reader.
//!
//! Grimmory keeps a PDF's annotations as one JSON blob per book (`/api/v1/pdf-annotations/book/{id}`,
//! GET answers `{"data": "<json>"}` or 204, PUT takes `{"data": "<json>"}` and replaces it all). The JSON
//! is EmbedPDF's: `{"format":"embedpdf","version":1,"annotations":[{"annotation":{...}}]}`, each
//! annotation with `type` (9 highlight, 10 underline, 11 squiggly, 12 strike-out, 15 ink, 3 free text,
//! ...), `id`, `pageIndex` (from 0), `rect` and, for marked-up text, `segmentRects`; ink has `inkList`
//! (`[{points:[{x,y}]}]`) and `strokeWidth`. Places are PDF points from the page's top-left corner.
//!
//! - Katana's own highlights (text offsets `page:12:340-388`, see `pagesrc.ts`) go up as text markup
//!   with the words' rectangles (worked out in the page view and kept in `highlights.rects`), their colour
//!   and note, and `custom.katana` (place, words, style, colour), so they come back as the same highlight.
//! - What's made elsewhere comes down as it is: ink (Grimmory's pen), highlights made in its reader, free
//!   text and shapes are kept here (`pdf_annots`) and drawn over the page. Katana's pen draws ink the
//!   same way. Anything Grimmory keeps that isn't drawn here stays in the blob untouched.
//! - Last change wins: a copy changed on one side since the last sync replaces the other; removed on one
//!   side is removed on the other unless changed on the other since. A server that suddenly lacks at
//!   least 3 and more than half of what it had isn't believed (Grimmory's reader, when open elsewhere,
//!   saves only what it loaded): those go back up.

use super::{conn_of, g, send, GErr, GRes};
use crate::db::now;
use crate::highlights;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter};

/// Schema 8: drawings and Grimmory's copies of PDF annotations; the words' rectangles of a PDF highlight.
pub const SCHEMA_V8: &str = "
CREATE TABLE IF NOT EXISTS pdf_annots (
    aid TEXT PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    kind TEXT NOT NULL,
    hl_uuid TEXT,
    data TEXT NOT NULL,
    seen TEXT,
    state TEXT NOT NULL DEFAULT 'local',
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pdf_annots_book ON pdf_annots(book_id);
ALTER TABLE highlights ADD COLUMN rects TEXT;
";

/// Grimmory's PDF reader colours, for Katana's five.
pub fn pdf_hex(name: &str) -> &'static str {
    match name {
        "green" => "#4CAF50",
        "blue" => "#2196F3",
        "pink" => "#E91E63",
        "orange" => "#FF5722",
        _ => "#FFEB3B",
    }
}

fn type_of_style(style: &str) -> i64 {
    match style {
        "underline" => 10,
        "squiggly" => 11,
        "strikethrough" => 12,
        _ => 9,
    }
}

fn style_of_type(t: i64) -> &'static str {
    match t {
        10 => "underline",
        11 => "squiggly",
        12 => "strikethrough",
        _ => "highlight",
    }
}

fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Value {
    json!({"origin": {"x": r2(x), "y": r2(y)}, "size": {"width": r2(w), "height": r2(h)}})
}

/// `page:12:340-388` → page index 11.
fn page_index(place: &str) -> Option<i64> {
    place.strip_prefix("page:")?.split(':').next()?.parse::<i64>().ok().map(|p| p - 1).filter(|p| *p >= 0)
}

/// A Katana highlight as Grimmory's PDF reader keeps it. `rects`: the words' boxes, [x, y, w, h] in points.
pub fn katana_item(h: &highlights::Highlight, rects: &[[f64; 4]]) -> Option<Value> {
    let page = page_index(&h.cfi)?;
    if rects.is_empty() {
        return None;
    }
    let (mut x1, mut y1, mut x2, mut y2) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for r in rects {
        x1 = x1.min(r[0]);
        y1 = y1.min(r[1]);
        x2 = x2.max(r[0] + r[2]);
        y2 = y2.max(r[1] + r[3]);
    }
    let t = type_of_style(&h.style);
    let hex = pdf_hex(&h.color);
    let mut a = json!({
        "type": t,
        "id": h.uuid,
        "pageIndex": page,
        "rect": rect(x1, y1, x2 - x1, y2 - y1),
        "segmentRects": rects.iter().map(|r| rect(r[0], r[1], r[2], r[3])).collect::<Vec<_>>(),
        "strokeColor": hex,
        "color": hex,
        "opacity": if t == 9 { 0.4 } else { 1.0 },
        "author": "Katana Desk",
        "custom": {"katana": {"place": h.cfi, "text": h.text, "style": h.style, "color": h.color}},
    });
    if let Some(n) = h.note.as_deref().filter(|n| !n.trim().is_empty()) {
        a["contents"] = json!(n);
    }
    Some(json!({ "annotation": a }))
}

fn ann(item: &Value) -> Option<&Map<String, Value>> {
    item.get("annotation")?.as_object()
}
fn aid_of(item: &Value) -> Option<String> {
    ann(item)?.get("id")?.as_str().map(String::from)
}
fn type_of(item: &Value) -> i64 {
    ann(item).and_then(|a| a.get("type")).and_then(|t| t.as_i64()).unwrap_or(0)
}
fn page_of(item: &Value) -> i64 {
    ann(item).and_then(|a| a.get("pageIndex")).and_then(|t| t.as_i64()).unwrap_or(0)
}
fn katana_of(item: &Value) -> Option<&Map<String, Value>> {
    ann(item)?.get("custom")?.get("katana")?.as_object()
}
fn colour_of(item: &Value) -> Option<&str> {
    let a = ann(item)?;
    a.get("strokeColor").or_else(|| a.get("color")).and_then(|c| c.as_str())
}
fn note_of(item: &Value) -> Option<String> {
    ann(item)?.get("contents")?.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// What a Katana highlight's copy says: its look and note. Grimmory's reader may add fields of its own
/// when it saves the blob again; only these count as a change.
fn gist(item: &Value) -> (i64, &'static str, Option<String>) {
    (type_of(item), super::marks_sync::color_name(colour_of(item)), note_of(item))
}

/// How a drawing is kept here: ink, a highlight made elsewhere ("mark"), or something else Grimmory has.
fn kind_of(item: &Value) -> &'static str {
    if katana_of(item).is_some() {
        return "katana";
    }
    match type_of(item) {
        15 => "ink",
        9..=12 => "mark",
        _ => "other",
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub aid: String,
    pub kind: String,
    pub hl_uuid: Option<String>,
    pub data: Value,
    pub seen: Option<Value>,
    pub state: String,
}

/// What a sync does: the new blob (when it changed) and the changes to make here.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub put: Option<Vec<Value>>,
    /// rows whose server copy is now `Value` (synced): inserted or updated
    pub take: Vec<(String, Value)>,
    /// rows (and their highlights) that went away on Grimmory
    pub drop: Vec<String>,
    /// rows that went up (their copy as sent)
    pub sent: Vec<(String, Value)>,
}

/// The merge, pure: Grimmory's items against the rows kept here.
pub fn plan(server: &[Value], rows: &[Row]) -> Plan {
    let mut out: Vec<Value> = server.to_vec();
    let at: HashMap<String, usize> = server.iter().enumerate().filter_map(|(i, s)| Some((aid_of(s)?, i))).collect();
    let mine: HashSet<&str> = rows.iter().map(|r| r.aid.as_str()).collect();
    let mut p = Plan::default();
    let mut changed = false;
    let mut removed: HashSet<usize> = HashSet::new();

    // a server that lost most of what it had isn't believed
    let had: Vec<&Row> = rows.iter().filter(|r| r.seen.is_some() && r.state != "deleted").collect();
    let gone = had.iter().filter(|r| !at.contains_key(&r.aid)).count();
    let disbelieve = gone >= 3 && gone * 2 > had.len();

    for r in rows {
        let s = at.get(&r.aid).map(|i| &server[*i]);
        match (r.state.as_str(), s) {
            ("deleted", Some(_)) => {
                removed.insert(at[&r.aid]);
                changed = true;
                p.drop.push(r.aid.clone());
            }
            ("deleted", None) => p.drop.push(r.aid.clone()),
            ("local", None) => {
                out.push(r.data.clone());
                changed = true;
                p.sent.push((r.aid.clone(), r.data.clone()));
            }
            (_, None) => {
                if r.state == "dirty" || disbelieve {
                    out.push(r.data.clone());
                    changed = true;
                    p.sent.push((r.aid.clone(), r.data.clone()));
                } else {
                    p.drop.push(r.aid.clone());
                }
            }
            (state, Some(s)) => {
                let server_changed = match (&r.seen, r.kind.as_str()) {
                    (None, _) => false,
                    (Some(seen), "katana") => gist(seen) != gist(s),
                    (Some(seen), _) => seen != s,
                };
                let local_changed = state == "dirty" || (state == "local" && r.kind == "katana" && gist(&r.data) != gist(s));
                if local_changed {
                    // ours, over whatever fields Grimmory's reader added
                    let mut merged = s.clone();
                    if let (Some(m), Some(o)) = (merged.get_mut("annotation").and_then(|a| a.as_object_mut()), ann(&r.data)) {
                        for (k, v) in o {
                            m.insert(k.clone(), v.clone());
                        }
                    }
                    out[at[&r.aid]] = merged.clone();
                    changed = true;
                    p.sent.push((r.aid.clone(), merged));
                } else if server_changed || r.seen.is_none() {
                    p.take.push((r.aid.clone(), s.clone()));
                }
            }
        }
    }
    // new on Grimmory
    for s in server {
        if let Some(id) = aid_of(s) {
            if !mine.contains(id.as_str()) {
                p.take.push((id, s.clone()));
            }
        }
    }
    if changed {
        let mut i = 0;
        out.retain(|_| {
            let keep = !removed.contains(&i);
            i += 1;
            keep
        });
        p.put = Some(out);
    }
    p
}

// ---------- kept here ----------

fn rows_of(conn: &Connection, book_id: i64) -> Vec<Row> {
    let mut st = match conn.prepare("SELECT aid, kind, hl_uuid, data, seen, state FROM pdf_annots WHERE book_id = ?1") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    let rows = st.query_map([book_id], |r| {
        Ok(Row {
            aid: r.get(0)?,
            kind: r.get(1)?,
            hl_uuid: r.get(2)?,
            data: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null),
            seen: r.get::<_, Option<String>>(4)?.and_then(|s| serde_json::from_str(&s).ok()),
            state: r.get(5)?,
        })
    });
    rows.map(|x| x.filter_map(Result::ok).collect()).unwrap_or_default()
}

fn parse_rects(s: Option<&str>) -> Vec<[f64; 4]> {
    s.and_then(|s| serde_json::from_str::<Vec<[f64; 4]>>(s).ok()).unwrap_or_default()
}

/// Brings the `katana` rows in step with the PDF highlights here: new ones, changed looks, removals.
fn refresh_katana(conn: &Connection, book_id: i64) {
    let hls: Vec<(highlights::Highlight, Option<String>)> = conn
        .prepare(&format!("SELECT {}, rects FROM highlights WHERE book_id = ?1 AND deleted_at IS NULL", highlights::COLS))
        .and_then(|mut st| {
            let rows = st.query_map([book_id], |r| Ok((highlights::row(r)?, r.get::<_, Option<String>>(15)?)))?;
            rows.collect()
        })
        .unwrap_or_default();
    let rows = rows_of(conn, book_id);
    let by_uuid: HashMap<&str, &Row> = rows.iter().filter_map(|r| Some((r.hl_uuid.as_deref()?, r))).collect();
    let mut alive: HashSet<String> = HashSet::new();
    for (h, rects) in &hls {
        let Some(item) = katana_item(h, &parse_rects(rects.as_deref())) else { continue };
        alive.insert(h.uuid.clone());
        match by_uuid.get(h.uuid.as_str()) {
            None => {
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO pdf_annots (aid, book_id, page, kind, hl_uuid, data, seen, state, updated_at)
                     VALUES (?1, ?2, ?3, 'katana', ?1, ?4, NULL, 'local', ?5)",
                    params![h.uuid, book_id, page_of(&item), item.to_string(), now()],
                );
            }
            Some(r) if gist(&r.data) != gist(&item) || r.data.get("annotation").and_then(|a| a.get("segmentRects")) != item.get("annotation").and_then(|a| a.get("segmentRects")) => {
                let state = if r.state == "synced" { "dirty" } else { r.state.as_str() };
                let _ = conn.execute(
                    "UPDATE pdf_annots SET data = ?2, state = ?3, updated_at = ?4 WHERE aid = ?1",
                    params![r.aid, item.to_string(), state, now()],
                );
            }
            Some(_) => {}
        }
    }
    for r in rows.iter().filter(|r| r.kind == "katana" && r.state != "deleted") {
        if r.hl_uuid.as_deref().map_or(true, |u| !alive.contains(u)) {
            // the highlight went here: Grimmory hears of it, or the row just goes
            let still_here: bool = r.hl_uuid.as_deref().map_or(false, |u| {
                conn.query_row("SELECT 1 FROM highlights WHERE uuid = ?1 AND deleted_at IS NULL", [u], |_| Ok(()))
                    .optional()
                    .ok()
                    .flatten()
                    .is_some()
            });
            if still_here {
                continue; // no rectangles yet
            }
            if r.seen.is_some() {
                let _ = conn.execute("UPDATE pdf_annots SET state = 'deleted', updated_at = ?2 WHERE aid = ?1", params![r.aid, now()]);
            } else {
                let _ = conn.execute("DELETE FROM pdf_annots WHERE aid = ?1", [&r.aid]);
            }
        }
    }
}

/// A copy from Grimmory, taken here: a Katana highlight's look and note, or a drawing as it is.
fn take(conn: &Connection, book_id: i64, aid: &str, s: &Value) {
    let kind = kind_of(s);
    let t = now();
    if kind == "katana" {
        let k = katana_of(s).cloned().unwrap_or_default();
        let place = k.get("place").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let (typ, colour, note) = gist(s);
        let style = style_of_type(typ);
        let exists: Option<i64> =
            conn.query_row("SELECT id FROM highlights WHERE uuid = ?1", [aid], |r| r.get(0)).optional().ok().flatten();
        let rects: Vec<[f64; 4]> = ann(s)
            .and_then(|a| a.get("segmentRects"))
            .and_then(|v| v.as_array())
            .map(|v| {
                v.iter()
                    .filter_map(|r| {
                        Some([
                            r.get("origin")?.get("x")?.as_f64()?,
                            r.get("origin")?.get("y")?.as_f64()?,
                            r.get("size")?.get("width")?.as_f64()?,
                            r.get("size")?.get("height")?.as_f64()?,
                        ])
                    })
                    .collect()
            })
            .unwrap_or_default();
        match exists {
            Some(id) => {
                let _ = conn.execute(
                    "UPDATE highlights SET color = ?2, style = ?3, note = ?4, updated_at = ?5, deleted_at = NULL WHERE id = ?1",
                    params![id, colour, style, note, t],
                );
            }
            None if !place.is_empty() => {
                let text = k.get("text").and_then(|x| x.as_str()).unwrap_or("");
                let _ = conn.execute(
                    "INSERT INTO highlights (uuid, book_id, cfi, text, color, style, note, created_at, updated_at, sync_state, rects)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'local', ?9)",
                    params![aid, book_id, place, text, colour, style, note, t, serde_json::to_string(&rects).unwrap_or_default()],
                );
            }
            None => {}
        }
        // our canonical copy, rebuilt from the highlight as it is now
        let item = conn
            .query_row(&format!("SELECT {}, rects FROM highlights WHERE uuid = ?1", highlights::COLS), [aid], |r| {
                Ok((highlights::row(r)?, r.get::<_, Option<String>>(15)?))
            })
            .ok()
            .and_then(|(h, rc)| katana_item(&h, &parse_rects(rc.as_deref())))
            .unwrap_or_else(|| s.clone());
        let _ = conn.execute(
            "INSERT OR REPLACE INTO pdf_annots (aid, book_id, page, kind, hl_uuid, data, seen, state, updated_at)
             VALUES (?1, ?2, ?3, 'katana', ?1, ?4, ?5, 'synced', ?6)",
            params![aid, book_id, page_of(s), item.to_string(), s.to_string(), t],
        );
    } else {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO pdf_annots (aid, book_id, page, kind, hl_uuid, data, seen, state, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5, 'synced', ?6)",
            params![aid, book_id, page_of(s), kind, s.to_string(), t],
        );
    }
}

fn drop_row(conn: &Connection, aid: &str) {
    let hl: Option<Option<String>> = conn.query_row("SELECT hl_uuid FROM pdf_annots WHERE aid = ?1", [aid], |r| r.get(0)).optional().ok().flatten();
    if let Some(Some(u)) = hl {
        let _ = conn.execute("DELETE FROM highlights WHERE uuid = ?1", [u]);
    }
    let _ = conn.execute("DELETE FROM pdf_annots WHERE aid = ?1", [aid]);
}

// ---------- the sync ----------

fn lock() -> &'static tokio::sync::Mutex<()> {
    static L: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn linked_pdf(app: &AppHandle, book_id: i64) -> Option<i64> {
    conn_of(app)
        .query_row("SELECT grimmory_id, format FROM books WHERE id = ?1 AND missing = 0", [book_id], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?))
        })
        .ok()
        .and_then(|(gid, f)| if f == "pdf" { gid } else { None })
}

/// Grimmory's annotations for a book: `None` when the blob is in a shape this PC doesn't merge (an old
/// pdf.js list), so it's left alone.
async fn fetch(app: &AppHandle, gid: i64) -> GRes<Option<Vec<Value>>> {
    let resp = send(app, move |c, base, tok| c.get(format!("{base}/api/v1/pdf-annotations/book/{gid}")).bearer_auth(tok)).await?;
    let st = resp.status().as_u16();
    if st == 204 || st == 404 {
        return Ok(Some(vec![]));
    }
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&st) {
        return Err(GErr::Server(st, super::server_message(&text)));
    }
    let outer: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let data = outer.get("data").and_then(|d| d.as_str()).unwrap_or("");
    if data.trim().is_empty() {
        return Ok(Some(vec![]));
    }
    let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
    if v.get("format").and_then(|f| f.as_str()) == Some("embedpdf") {
        return Ok(Some(v.get("annotations").and_then(|a| a.as_array()).cloned().unwrap_or_default()));
    }
    Ok(None)
}

async fn put(app: &AppHandle, gid: i64, items: &[Value]) -> GRes<()> {
    let data = json!({"format": "embedpdf", "version": 1, "annotations": items}).to_string();
    let body = json!({ "data": data });
    let resp = send(app, move |c, base, tok| c.put(format!("{base}/api/v1/pdf-annotations/book/{gid}")).bearer_auth(tok).json(&body)).await?;
    let st = resp.status().as_u16();
    if (200..300).contains(&st) {
        Ok(())
    } else {
        Err(GErr::Server(st, super::server_message(&resp.text().await.unwrap_or_default())))
    }
}

/// One round for a PDF: true when something here changed (the page view draws again).
pub async fn sync(app: &AppHandle, book_id: i64) -> GRes<bool> {
    let Some(gid) = linked_pdf(app, book_id) else { return Ok(false) };
    if !g(app).signed_in() {
        return Ok(false);
    }
    let _l = lock().lock().await;
    refresh_katana(&conn_of(app), book_id);
    let Some(server) = fetch(app, gid).await? else { return Ok(false) };
    let rows = rows_of(&conn_of(app), book_id);
    let p = plan(&server, &rows);
    if let Some(items) = &p.put {
        put(app, gid, items).await?;
    }
    let conn = conn_of(app);
    let mut here = false;
    for (aid, s) in &p.take {
        take(&conn, book_id, aid, s);
        here = true;
    }
    for aid in &p.drop {
        let was_deleted: bool = conn
            .query_row("SELECT state = 'deleted' FROM pdf_annots WHERE aid = ?1", [aid], |r| r.get(0))
            .unwrap_or(true);
        drop_row(&conn, aid);
        here |= !was_deleted;
    }
    for (aid, sent) in &p.sent {
        let _ = conn.execute("UPDATE pdf_annots SET seen = ?2, state = 'synced' WHERE aid = ?1", params![aid, sent.to_string()]);
    }
    Ok(here)
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annot {
    pub aid: String,
    pub page: i64,
    pub kind: String,
    pub data: Value,
}

/// The drawings of a PDF (Katana's own highlights are drawn from the highlights).
#[tauri::command]
pub fn pdf_annots(app: AppHandle, book_id: i64) -> Vec<Annot> {
    rows_of(&conn_of(&app), book_id)
        .into_iter()
        .filter(|r| r.kind != "katana" && r.state != "deleted")
        .map(|r| Annot { page: page_of(&r.data), aid: r.aid, kind: r.kind, data: r.data })
        .collect()
}

/// A stroke of Katana's pen: `data` is the annotation (`type` 15, `inkList`, colour, width), its `id` new.
#[tauri::command]
pub fn pdf_annot_add(app: AppHandle, book_id: i64, data: Value) -> Result<String, String> {
    let aid = aid_of(&json!({ "annotation": data })).ok_or("The drawing has no id")?;
    let item = json!({ "annotation": data });
    conn_of(&app)
        .execute(
            "INSERT OR REPLACE INTO pdf_annots (aid, book_id, page, kind, hl_uuid, data, seen, state, updated_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, 'local', ?6)",
            params![aid, book_id, page_of(&item), kind_of(&item), item.to_string(), now()],
        )
        .map_err(|e| e.to_string())?;
    Ok(aid)
}

/// Removes a drawing; Grimmory hears of it at the next sync.
#[tauri::command]
pub fn pdf_annot_remove(app: AppHandle, aid: String) {
    let conn = conn_of(&app);
    let seen: Option<bool> = conn.query_row("SELECT seen IS NOT NULL FROM pdf_annots WHERE aid = ?1", [&aid], |r| r.get(0)).optional().ok().flatten();
    match seen {
        Some(true) => {
            let _ = conn.execute("UPDATE pdf_annots SET state = 'deleted', updated_at = ?2 WHERE aid = ?1", params![aid, now()]);
        }
        Some(false) => {
            let _ = conn.execute("DELETE FROM pdf_annots WHERE aid = ?1", [&aid]);
        }
        None => {}
    }
}

/// The words' boxes of a PDF highlight, [x, y, w, h] in points from the page's top-left, from the page view.
#[tauri::command]
pub fn highlight_rects(app: AppHandle, id: i64, rects: Vec<[f64; 4]>) {
    let rects: Vec<[f64; 4]> = rects.into_iter().map(|r| [r2(r[0]), r2(r[1]), r2(r[2]), r2(r[3])]).collect();
    let _ = conn_of(&app).execute("UPDATE highlights SET rects = ?2 WHERE id = ?1", params![id, serde_json::to_string(&rects).unwrap_or_default()]);
}

/// One sync round for a PDF; tells the page view when something came down.
#[tauri::command]
pub async fn pdf_annots_sync(app: AppHandle, book_id: i64) -> bool {
    match sync(&app, book_id).await {
        Ok(changed) => {
            if changed {
                let _ = app.emit("marks-changed", book_id);
            }
            changed
        }
        Err(e) => {
            eprintln!("katana: PDF annotations of book {book_id} wait: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hl(color: &str, style: &str, note: Option<&str>) -> highlights::Highlight {
        highlights::Highlight {
            id: 1,
            uuid: "u1".into(),
            book_id: 1,
            cfi: "page:3:10-20".into(),
            text: "some words".into(),
            chapter: None,
            fraction: None,
            page_label: None,
            color: color.into(),
            style: style.into(),
            note: note.map(String::from),
            created_at: 0,
            updated_at: 0,
            remote_id: None,
            sync_state: "local".into(),
        }
    }

    fn row(aid: &str, kind: &str, data: Value, seen: Option<Value>, state: &str) -> Row {
        Row { aid: aid.into(), kind: kind.into(), hl_uuid: (kind == "katana").then(|| aid.to_string()), data, seen, state: state.into() }
    }

    fn ink(id: &str) -> Value {
        json!({"annotation": {"type": 15, "id": id, "pageIndex": 0, "inkList": [{"points": [{"x": 1, "y": 2}]}], "strokeColor": "#000000", "opacity": 1, "strokeWidth": 2, "rect": rect(0., 0., 1., 1.)}})
    }

    #[test]
    fn katana_highlight_shape() {
        let i = katana_item(&hl("pink", "underline", Some("a note")), &[[10.0, 20.0, 100.0, 12.0], [10.0, 34.0, 60.0, 12.0]]).unwrap();
        let a = ann(&i).unwrap();
        assert_eq!(a["type"], 10);
        assert_eq!(a["pageIndex"], 2);
        assert_eq!(a["strokeColor"], "#E91E63");
        assert_eq!(a["rect"], rect(10.0, 20.0, 100.0, 26.0));
        assert_eq!(a["contents"], "a note");
        assert_eq!(gist(&i), (10, "pink", Some("a note".into())));
        assert_eq!(kind_of(&i), "katana");
        // every colour comes back as itself
        for c in highlights::COLORS {
            let i = katana_item(&hl(c, "highlight", None), &[[0.0, 0.0, 1.0, 1.0]]).unwrap();
            assert_eq!(gist(&i).1, c);
        }
    }

    #[test]
    fn new_here_goes_up_new_there_comes_down() {
        let mine = katana_item(&hl("yellow", "highlight", None), &[[0.0, 0.0, 5.0, 5.0]]).unwrap();
        let p = plan(&[ink("i1")], &[row("u1", "katana", mine.clone(), None, "local")]);
        assert_eq!(p.put.as_ref().unwrap().len(), 2);
        assert_eq!(p.take, vec![("i1".to_string(), ink("i1"))]);
        assert_eq!(p.sent.len(), 1);
    }

    #[test]
    fn removals_both_ways() {
        // removed there: goes here
        let p = plan(&[], &[row("i1", "ink", ink("i1"), Some(ink("i1")), "synced")]);
        assert_eq!((p.put, p.drop), (None, vec!["i1".to_string()]));
        // removed here: goes there, the others stay as they were
        let p = plan(&[ink("i1"), ink("i2")], &[row("i1", "ink", ink("i1"), Some(ink("i1")), "deleted"), row("i2", "ink", ink("i2"), Some(ink("i2")), "synced")]);
        assert_eq!(p.put, Some(vec![ink("i2")]));
    }

    #[test]
    fn changed_there_and_changed_here() {
        let mine = katana_item(&hl("yellow", "highlight", None), &[[0.0, 0.0, 5.0, 5.0]]).unwrap();
        // the web reader made it pink and added fields of its own: pink comes here
        let mut there = mine.clone();
        there["annotation"]["strokeColor"] = json!("#E91E63");
        there["annotation"]["flags"] = json!(["print"]);
        let p = plan(&[there.clone()], &[row("u1", "katana", mine.clone(), Some(mine.clone()), "synced")]);
        assert_eq!(p.take, vec![("u1".to_string(), there.clone())]);
        assert!(p.put.is_none());
        // only its own fields changed there: nothing to do
        let mut fields = mine.clone();
        fields["annotation"]["flags"] = json!(["print"]);
        let p = plan(&[fields.clone()], &[row("u1", "katana", mine.clone(), Some(mine.clone()), "synced")]);
        assert_eq!(p, Plan::default());
        // changed here: ours goes up over theirs, their extra fields kept
        let mut blue = katana_item(&hl("blue", "highlight", None), &[[0.0, 0.0, 5.0, 5.0]]).unwrap();
        blue["annotation"]["id"] = json!("u1");
        let p = plan(&[fields.clone()], &[row("u1", "katana", blue, Some(mine), "dirty")]);
        let up = &p.put.unwrap()[0];
        assert_eq!(up["annotation"]["strokeColor"], "#2196F3");
        assert_eq!(up["annotation"]["flags"], json!(["print"]));
    }

    #[test]
    fn a_server_that_lost_most_is_not_believed() {
        let rows: Vec<Row> = (0..4).map(|i| row(&format!("i{i}"), "ink", ink(&format!("i{i}")), Some(ink(&format!("i{i}"))), "synced")).collect();
        let p = plan(&[ink("i0")], &rows);
        assert!(p.drop.is_empty());
        assert_eq!(p.put.unwrap().len(), 4);
    }
}
