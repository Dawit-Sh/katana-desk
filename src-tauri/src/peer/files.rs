//! Book files from a paired device (his ask, 2026-11-24: "Book files should also work from phone to PC"): a book
//! being read there and not on this PC comes up with `PUT /katana-sync/v1/books?name=<file name>` (the file as the
//! body) into `Documents\Katana Desk\From <device>` (a test run: `<KATANA_DATA_DIR>\from-devices\From <device>`),
//! which becomes a Local folder and is scanned, so the book shows in Local. The device's next sync finds it by its
//! file and links it, and its place, marks and status sync from then on.
use super::pair;
use crate::{db, grimmory::conn_of};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The biggest book a device may send.
const MAX_BOOK: u64 = 1 << 30;

pub fn is_upload(method: &str, path: &str) -> bool {
    method == "PUT" && path.trim_matches('/') == "katana-sync/v1/books"
}

/// Saves the book in the request's body; the answer's status and body.
pub fn receive(app: &AppHandle, req: &mut tiny_http::Request, url: &str, auth: Option<&str>) -> (u16, Value) {
    let token = auth
        .map(str::trim)
        .and_then(|a| a.strip_prefix("Bearer ").or_else(|| a.strip_prefix("bearer ")))
        .map(str::trim)
        .unwrap_or("");
    let device = if token.is_empty() { None } else { pair::device_for(&conn_of(app), token, db::now()) };
    let Some(device) = device else { return (401, json!({ "status": 401, "message": "Not paired with this PC" })) };
    let Some(name) = query_name(url).map(|n| safe_name(&n)).filter(|n| !n.is_empty()) else {
        return (400, json!({ "status": 400, "message": "No file name" }));
    };
    let dir = folder_for(app, &device.name);
    match save(req, &dir, &name) {
        Ok(()) => {}
        Err(e) => return (500, json!({ "status": 500, "message": e })),
    }
    let dir_text = dir.to_string_lossy().to_string();
    match db::add_folder(&conn_of(app), &dir_text) {
        Ok(id) => crate::library::scan_in_background(app.clone(), Some(vec![id])),
        Err(e) => return (500, json!({ "status": 500, "message": e.to_string() })),
    }
    (200, json!({ "saved": name, "folder": dir_text }))
}

/// Where a device's books land: one folder per device, named after it.
fn folder_for(app: &AppHandle, device: &str) -> PathBuf {
    let base = match std::env::var("KATANA_DATA_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d).join("from-devices"),
        _ => app.path().document_dir().map(|d| d.join("Katana Desk")).unwrap_or_else(|_| PathBuf::from("Katana Desk")),
    };
    let who = safe_name(device);
    base.join(format!("From {}", if who.is_empty() { "your device".to_string() } else { who }))
}

// The body into `<dir>\<name>` (through a .part file). The same file already there (same size) stays as it is.
fn save(req: &mut tiny_http::Request, dir: &std::path::Path, name: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = dir.join(name);
    let length = req.body_length().map(|l| l as u64);
    if length.is_some_and(|l| l > MAX_BOOK) {
        return Err("The book is too big".into());
    }
    if let (Ok(meta), Some(len)) = (std::fs::metadata(&target), length) {
        if meta.len() == len {
            let _ = std::io::copy(&mut req.as_reader().take(MAX_BOOK), &mut std::io::sink());
            return Ok(());
        }
    }
    let part = dir.join(format!("{name}.part"));
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let copied = std::io::copy(&mut req.as_reader().take(MAX_BOOK + 1), &mut out).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if copied == 0 || copied > MAX_BOOK || length.is_some_and(|l| l != copied) {
        let _ = std::fs::remove_file(&part);
        return Err("The book didn't come whole".into());
    }
    std::fs::rename(&part, &target).map_err(|e| e.to_string())
}

fn query_name(url: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|kv| kv.strip_prefix("name=")).map(percent_decode)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()).ok_or(()) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// A file or folder name that's safe on Windows: no path, no reserved characters.
fn safe_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().map(|c| if "<>:\"|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    cleaned.trim().trim_matches('.').chars().take(150).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sent_book_keeps_a_safe_name() {
        assert_eq!(query_name("/katana-sync/v1/books?name=The%20Hole%20-%20Oyamada.epub").as_deref(), Some("The Hole - Oyamada.epub"));
        assert_eq!(safe_name("..\\..\\Windows\\evil.epub"), "evil.epub");
        assert_eq!(safe_name("a:b?.pdf"), "a_b_.pdf");
        assert_eq!(query_name("/katana-sync/v1/books"), None);
    }
}
