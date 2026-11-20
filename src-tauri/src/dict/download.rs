//! The built-in dictionaries come down on first use, from a list (`katana-dictionaries.json`) at a URL
//! that can be changed (Settings › Dictionaries, the setting `dict.url`, or `KATANA_DICT_URL` for
//! tests). Each file is gzipped for the trip, goes on where it stopped (`crate::resumable`, the rules
//! of milestone 2's Grimmory downloads), is checked against its SHA-256 twice (packed and unpacked)
//! and only then takes its place in `<app data>/dictionaries/`.

use super::{dicts, emit_status};
use crate::resumable::{self, Begin, Part, Streamed};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Where the list lives until milestone 8 publishes it with the app (a GitHub release asset).
pub const DEFAULT_URL: &str = "https://github.com/Dawit-Sh/katana-desk/releases/download/dictionaries-1/katana-dictionaries.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub edition: String,
    pub format: i64,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub url: String,
    #[serde(default)]
    pub gzip: bool,
    pub download_size: u64,
    pub download_sha256: String,
    #[serde(default)]
    pub entries: u64,
    pub licence: String,
    pub licence_url: String,
    pub credit: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub format: i64,
    pub dictionaries: Vec<Item>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    /// queued, running, paused, waiting, unpacking, failed, done
    pub state: String,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}
fn progress() -> &'static Mutex<HashMap<String, Progress>> {
    static P: OnceLock<Mutex<HashMap<String, Progress>>> = OnceLock::new();
    P.get_or_init(Default::default)
}
fn retries() -> &'static Mutex<HashMap<String, u32>> {
    static R: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

pub fn state_of(id: &str) -> Option<Progress> {
    progress().lock().unwrap().get(id).cloned()
}

fn put(app: &AppHandle, id: &str, state: &str, done: u64, total: u64, error: Option<String>) {
    let p = Progress { id: id.into(), state: state.into(), done, total, error };
    progress().lock().unwrap().insert(id.into(), p.clone());
    let _ = app.emit("dict-download", p);
    if matches!(state, "done" | "failed" | "paused") {
        emit_status(app);
    }
}

pub fn url(app: &AppHandle) -> String {
    std::env::var("KATANA_DICT_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| super::setting(app, "dict.url"))
        .unwrap_or_else(|| DEFAULT_URL.to_string())
}

fn manifest_path(app: &AppHandle) -> PathBuf {
    dicts(app).dir.join("manifest.json")
}
fn part_of(app: &AppHandle, item: &Item) -> Part {
    Part::new(dicts(app).dir.join("partial").join(format!("{}.part", item.file)))
}

/// The list last fetched, kept on this PC so Settings shows sizes offline.
pub fn cached(app: &AppHandle) -> Option<Manifest> {
    std::fs::read(manifest_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

/// Fetches the list (and keeps it); falls back to the one kept when the URL can't be reached.
pub async fn manifest(app: &AppHandle) -> Result<Manifest, String> {
    let u = url(app);
    let fetched = async {
        let r = dicts(app).http.get(&u).send().await.map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("The dictionary list answered {}.", r.status().as_u16()));
        }
        let mut m: Manifest = r.json().await.map_err(|e| format!("The dictionary list couldn't be read: {e}"))?;
        // file URLs may be relative to the list
        let base = reqwest::Url::parse(&u).map_err(|e| e.to_string())?;
        for it in &mut m.dictionaries {
            if let Ok(full) = base.join(&it.url) {
                it.url = full.to_string();
            }
        }
        Ok(m)
    }
    .await;
    match fetched {
        Ok(m) => {
            let _ = std::fs::create_dir_all(&dicts(app).dir);
            let _ = std::fs::write(manifest_path(app), serde_json::to_vec_pretty(&m).unwrap_or_default());
            Ok(m)
        }
        Err(e) => cached(app).ok_or(e),
    }
}

/// Bytes kept of a download that was paused (or cut off by closing the app).
pub fn kept(app: &AppHandle, item: &Item) -> u64 {
    let p = part_of(app, item);
    std::fs::metadata(&p.part).map(|m| m.len()).unwrap_or(0)
}

fn going(app: &AppHandle, id: &str, on: bool) {
    let mut ids: Vec<String> = super::setting(app, "dict.going").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    ids.retain(|x| x != id);
    if on {
        ids.push(id.into());
    }
    super::set_setting(app, "dict.going", &serde_json::to_string(&ids).unwrap_or_default());
}

/// Starts (or goes on with) a dictionary's download.
pub fn start(app: &AppHandle, id: &str) {
    if let Some(stop) = running().lock().unwrap().get(id) {
        stop.store(false, Ordering::SeqCst);
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    running().lock().unwrap().insert(id.into(), stop.clone());
    going(app, id, true);
    let prev = state_of(id).unwrap_or_default();
    put(app, id, "queued", prev.done, prev.total, None);
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let outcome = run(&app, &id, &stop).await;
        running().lock().unwrap().remove(&id);
        let p = state_of(&id).unwrap_or_default();
        match outcome {
            Ok(true) => {
                retries().lock().unwrap().remove(&id);
                going(&app, &id, false);
                super::forget_open(&app, &id);
                put(&app, &id, "done", p.total, p.total, None);
            }
            Ok(false) => {
                going(&app, &id, false);
                put(&app, &id, "paused", p.done, p.total, None);
            }
            Err(Fail::Wait(m)) => {
                put(&app, &id, "waiting", p.done, p.total, Some(m));
                // goes on by itself after 30 s, then 60, 90 ... up to 5 minutes
                let n = {
                    let mut r = retries().lock().unwrap();
                    let n = r.entry(id.clone()).or_insert(0);
                    *n += 1;
                    *n
                };
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs((30 * n as u64).min(300))).await;
                    if state_of(&id).map_or(false, |p| p.state == "waiting") {
                        start(&app2, &id);
                    }
                });
            }
            Err(Fail::Stop(m)) => {
                going(&app, &id, false);
                put(&app, &id, "failed", p.done, p.total, Some(m));
            }
        }
    });
}

enum Fail {
    /// the connection: try again by itself
    Wait(String),
    /// a real error: shown, Try again by hand
    Stop(String),
}

/// A request that never got through or broke off on the way (a body cut short reads as a decode
/// error): the same test Grimmory's downloads use.
fn is_connection(e: &reqwest::Error) -> bool {
    crate::grimmory::is_connection(e)
}

/// Ok(true) installed, Ok(false) paused.
async fn run(app: &AppHandle, id: &str, stop: &AtomicBool) -> Result<bool, Fail> {
    let m = manifest(app).await.map_err(Fail::Wait)?;
    let item = m.dictionaries.into_iter().find(|i| i.id == id).ok_or_else(|| Fail::Stop("This dictionary isn't on the list any more.".into()))?;
    if item.format != super::builtin::FORMAT {
        return Err(Fail::Stop("This dictionary needs a newer Katana Desk.".into()));
    }
    let p = part_of(app, &item);
    for _attempt in 0..3 {
        let (have, info) = p.kept();
        let total_hint = if info.total > 0 { info.total } else { item.download_size };
        if have > 0 && info.total > 0 && have >= info.total {
            return install(app, &item, &p, stop).await;
        }
        put(app, id, "running", have, total_hint, None);
        let req = p.ask(dicts(app).http.get(&item.url).header(reqwest::header::ACCEPT_ENCODING, "identity"), have, &info);
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) if is_connection(&e) => return Err(Fail::Wait("The dictionary server can't be reached.".into())),
            Err(e) => return Err(Fail::Stop(e.to_string())),
        };
        let (file, written, total) = match resumable::begin(&p, &resp, have, &info).await {
            Begin::Append(f, w, t) => (f, w, t),
            Begin::Fresh(f, t) => (f, 0, t),
            Begin::Restart => continue,
            Begin::WriteFailed(e) => return Err(Fail::Stop(format!("Couldn't write the dictionary on this PC: {e}"))),
            Begin::Status(s) => return Err(Fail::Stop(format!("The dictionary server answered {}.", s.as_u16()))),
        };
        let total = if total > 0 { total } else { item.download_size };
        let app2 = app.clone();
        let written = match resumable::stream(resp, file, written, total, stop, |w, t| put(&app2, id, "running", w, t, None)).await {
            Streamed::Ended(w) => w,
            Streamed::Stopped(w) => {
                put(app, id, "paused", w, total, None);
                return Ok(false);
            }
            Streamed::Broke(e) if is_connection(&e) => return Err(Fail::Wait("The connection broke off.".into())),
            Streamed::Broke(e) => return Err(Fail::Stop(e.to_string())),
            Streamed::WriteFailed(e) => return Err(Fail::Stop(format!("Couldn't write the dictionary on this PC: {e}"))),
        };
        if total > 0 && written < total {
            return Err(Fail::Wait("The connection broke off.".into()));
        }
        resumable::settle(&p, written, total);
        return install(app, &item, &p, stop).await;
    }
    Err(Fail::Stop("The server kept sending a different file. Try again in a moment.".into()))
}

fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha_of(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

/// Checks the packed file, unpacks it (checking it again) and puts it in place.
async fn install(app: &AppHandle, item: &Item, p: &Part, _stop: &AtomicBool) -> Result<bool, Fail> {
    put(app, &item.id, "unpacking", item.download_size, item.download_size, None);
    // an earlier edition that's open can't be replaced on Windows
    super::forget_open(app, &item.id);
    let dir = dicts(app).dir.clone();
    let item2 = item.clone();
    let part = p.part.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let packed = sha_of(&part).map_err(|e| e.to_string())?;
        if packed != item2.download_sha256 {
            return Err("bad".into());
        }
        let tmp = dir.join(format!("{}.tmp", item2.file));
        let mut out = std::fs::File::create(&tmp).map_err(|e| format!("Couldn't write the dictionary on this PC: {e}"))?;
        let src = std::fs::File::open(&part).map_err(|e| e.to_string())?;
        let mut reader: Box<dyn Read> = if item2.gzip { Box::new(flate2::read::GzDecoder::new(std::io::BufReader::new(src))) } else { Box::new(src) };
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("The dictionary couldn't be unpacked: {e}"))?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| format!("Couldn't write the dictionary on this PC: {e}"))?;
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        if hex(&h.finalize()) != item2.sha256 {
            let _ = std::fs::remove_file(&tmp);
            return Err("bad".into());
        }
        super::builtin::Builtin::open(&tmp)?;
        let dest = dir.join(&item2.file);
        // an earlier edition of the same dictionary makes way
        super::remove_files_of(&dir, &item2.id, &item2.file);
        std::fs::rename(&tmp, &dest).map_err(|e| format!("Couldn't keep the dictionary on this PC: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| Fail::Stop(e.to_string()))?;
    match res {
        Ok(()) => {
            p.discard();
            Ok(true)
        }
        Err(e) if e == "bad" => {
            // a file that doesn't match its list was damaged on the way: start over next time
            p.discard();
            Err(Fail::Stop("The download was damaged on the way. Try again.".into()))
        }
        Err(e) => Err(Fail::Stop(e)),
    }
}

pub fn pause(app: &AppHandle, id: &str) {
    if let Some(stop) = running().lock().unwrap().get(id) {
        stop.store(true, Ordering::SeqCst);
    }
    going(app, id, false);
    if let Some(p) = state_of(id) {
        if !matches!(p.state.as_str(), "done" | "failed" | "unpacking") {
            put(app, id, "paused", p.done, p.total, None);
        }
    }
}

/// Stops a download and throws its partial bytes away.
pub fn cancel(app: &AppHandle, id: &str) {
    pause(app, id);
    let item = cached(app).and_then(|m| m.dictionaries.into_iter().find(|i| i.id == id));
    let app2 = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        for _ in 0..50 {
            if !running().lock().unwrap().contains_key(&id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if let Some(it) = item {
            part_of(&app2, &it).discard();
        }
        progress().lock().unwrap().remove(&id);
        emit_status(&app2);
    });
}

/// At start: downloads that were going when the app closed go on.
pub fn restore(app: &AppHandle) {
    let ids: Vec<String> = super::setting(app, "dict.going").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    for id in ids {
        start(app, &id);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hex_is_lowercase() {
        assert_eq!(super::hex(&[0, 15, 255]), "000fff");
    }
}
