//! Local: the folders you add, scanned when Katana Desk starts and watched while it's open.
//! Files are only ever read. Nothing on disk is moved, renamed or deleted.

use crate::db::{self, Db, NewBook};
use crate::meta;
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use rayon::prelude::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanState {
    pub scanning: bool,
    pub last_scan: Option<i64>,
    /// files looked at and files found in this scan, for "Checking folders… 1,240 of 6,216"
    pub done: usize,
    pub total: usize,
}

pub struct Library {
    pub db: Db,
    pub covers_dir: PathBuf,
    scan_lock: Mutex<()>,
    pub state: Mutex<ScanState>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl Library {
    pub fn new(db: Db, covers_dir: PathBuf) -> Library {
        Library {
            db,
            covers_dir,
            scan_lock: Mutex::new(()),
            state: Mutex::new(ScanState::default()),
            watcher: Mutex::new(None),
        }
    }
}

fn lib(app: &AppHandle) -> tauri::State<'_, Library> {
    app.state::<Library>()
}

fn mtime_of(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn set_scanning(app: &AppHandle, scanning: bool) {
    let st = {
        let l = lib(app);
        let mut s = l.state.lock().unwrap();
        s.scanning = scanning;
        s.done = 0;
        s.total = 0;
        if !scanning {
            s.last_scan = Some(db::now());
        }
        s.clone()
    };
    let _ = app.emit("scan-state", st);
}

/// Lets the web view load covers and book files from these places (Tauri's asset protocol).
pub fn allow(app: &AppHandle, path: &Path, dir: bool) {
    let scope = app.asset_protocol_scope();
    let _ = if dir { scope.allow_directory(path, true) } else { scope.allow_file(path) };
}

/// Reads one file into the library (title, author, cover, partial MD5) unless it is already known and unchanged.
/// Returns true when something changed.
fn index_file(app: &AppHandle, path: &Path, folder_id: Option<i64>, rel_dir: &str, loose: bool) -> bool {
    let Some(format) = meta::format_of(path) else { return false };
    let Ok(md) = std::fs::metadata(path) else { return false };
    let size = md.len() as i64;
    let mtime = mtime_of(&md);
    let path_s = path.to_string_lossy().to_string();
    let l = lib(app);
    {
        let conn = l.db.0.lock().unwrap();
        if let Ok(Some(k)) = db::known(&conn, &path_s) {
            if k.size == size && k.mtime == mtime {
                if k.missing {
                    let _ = db::touch_found(&conn, k.id, folder_id, rel_dir, loose);
                    return true;
                }
                return false;
            }
        }
    }
    // the slow part runs without holding the database
    let m = meta::read(path, &format);
    let hash = meta::partial_md5(path);
    let title = m.title.clone().unwrap_or_else(|| meta::title_from_name(path));
    let id = {
        let conn = l.db.0.lock().unwrap();
        match db::upsert_book(
            &conn,
            &NewBook {
                path: &path_s,
                folder_id,
                rel_dir,
                format: &format,
                title: &title,
                author: m.author.as_deref(),
                size,
                mtime,
                hash: hash.as_deref(),
            },
            loose,
        ) {
            Ok(id) => id,
            Err(e) => {
                eprintln!("katana: could not add {path_s}: {e}");
                return false;
            }
        }
    };
    let cover_path = l.covers_dir.join(format!("{id}.jpg"));
    let cover = m.cover.and_then(|bytes| meta::save_cover(&bytes, &cover_path)).map(|_| cover_path.to_string_lossy().to_string());
    let conn = l.db.0.lock().unwrap();
    let _ = db::set_cover(&conn, id, cover.as_deref());
    true
}

fn is_hidden(e: &walkdir::DirEntry) -> bool {
    e.depth() > 0
        && e.file_name()
            .to_str()
            .map(|s| s.starts_with('.') || s.starts_with('$') || s == "System Volume Information")
            .unwrap_or(false)
}

fn scan_folder(app: &AppHandle, folder: &db::Folder) {
    let root = PathBuf::from(&folder.path);
    if !root.is_dir() {
        // an unplugged drive: keep everything as it is until it comes back
        return;
    }
    let files: Vec<(PathBuf, String)> = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e))
        .flatten()
        .filter(|e| e.file_type().is_file() && meta::format_of(e.path()).is_some())
        .map(|e| {
            let p = e.into_path();
            let rel_dir = p
                .parent()
                .and_then(|d| d.strip_prefix(&root).ok())
                .map(|d| d.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("/"))
                .unwrap_or_default();
            (p, rel_dir)
        })
        .collect();
    let seen: HashSet<String> = files.iter().map(|(p, _)| p.to_string_lossy().to_string()).collect();
    {
        let l = lib(app);
        l.state.lock().unwrap().total += files.len();
    }

    // read new and changed books on every core; show them as they arrive on a first big scan
    let changed = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let last_emit = Mutex::new(Instant::now());
    files.par_iter().for_each(|(p, rel_dir)| {
        if index_file(app, p, Some(folder.id), rel_dir, false) {
            changed.fetch_add(1, Ordering::Relaxed);
        }
        done.fetch_add(1, Ordering::Relaxed);
        let mut t = last_emit.lock().unwrap();
        if t.elapsed() > Duration::from_millis(700) {
            *t = Instant::now();
            drop(t);
            let st = {
                let l = lib(app);
                let mut s = l.state.lock().unwrap();
                s.done += done.swap(0, Ordering::Relaxed);
                s.clone()
            };
            let _ = app.emit("scan-state", st);
            if changed.load(Ordering::Relaxed) > 0 {
                let _ = app.emit("library-changed", ());
            }
        }
    });
    {
        let l = lib(app);
        l.state.lock().unwrap().done += done.load(Ordering::Relaxed);
    }

    let l = lib(app);
    let conn = l.db.0.lock().unwrap();
    if let Ok(known) = db::folder_paths(&conn, folder.id) {
        for (id, path) in known {
            if !seen.contains(&path) {
                let _ = db::mark_missing(&conn, id);
                changed.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    if changed.load(Ordering::Relaxed) > 0 {
        let _ = app.emit("library-changed", ());
    }
}

fn check_loose(app: &AppHandle) {
    let l = lib(app);
    let conn = l.db.0.lock().unwrap();
    let mut changed = false;
    for (id, path) in db::loose_paths(&conn).unwrap_or_default() {
        if !Path::new(&path).exists() {
            let _ = db::mark_missing(&conn, id);
            changed = true;
        }
    }
    if changed {
        let _ = app.emit("library-changed", ());
    }
}

/// Scans every folder (or only the ones given) on a background thread. One scan at a time.
pub fn scan_in_background(app: AppHandle, only: Option<Vec<i64>>) {
    std::thread::spawn(move || {
        let l = lib(&app);
        let _guard = l.scan_lock.lock().unwrap();
        set_scanning(&app, true);
        let folders = {
            let conn = l.db.0.lock().unwrap();
            db::folders(&conn).unwrap_or_default()
        };
        for f in folders.iter().filter(|f| only.as_ref().map_or(true, |o| o.contains(&f.id))) {
            scan_folder(&app, f);
        }
        check_loose(&app);
        set_scanning(&app, false);
        let _ = app.emit("library-changed", ());
    });
}

/// Folders and files dropped on the window or chosen with Add a folder / Add books.
/// A folder becomes a watched Local folder. A file inside one is already there; any other file is
/// added where it is (never copied).
pub fn add_paths(app: &AppHandle, paths: Vec<String>) {
    let l = lib(app);
    let mut new_folders = Vec::new();
    let mut files = Vec::new();
    for p in paths {
        let pb = PathBuf::from(&p);
        if pb.is_dir() {
            let id = {
                let conn = l.db.0.lock().unwrap();
                db::add_folder(&conn, &p)
            };
            if let Ok(id) = id {
                allow(app, &pb, true);
                watch(app, &pb);
                new_folders.push(id);
            }
        } else if pb.is_file() && meta::format_of(&pb).is_some() {
            files.push(pb);
        }
    }
    let folders = {
        let conn = l.db.0.lock().unwrap();
        db::folders(&conn).unwrap_or_default()
    };
    let mut rescan = new_folders;
    for f in files {
        if let Some(folder) = folders.iter().find(|fo| f.starts_with(&fo.path)) {
            rescan.push(folder.id);
        } else {
            allow(app, &f, false);
            index_file(app, &f, None, "", true);
        }
    }
    let _ = app.emit("library-changed", ());
    if !rescan.is_empty() {
        scan_in_background(app.clone(), Some(rescan));
    }
}

pub fn watch(app: &AppHandle, path: &Path) {
    let l = lib(app);
    let mut g = l.watcher.lock().unwrap();
    if let Some(w) = g.as_mut() {
        if let Err(e) = w.watch(path, RecursiveMode::Recursive) {
            eprintln!("katana: can't watch {}: {e}", path.display());
        }
    }
}

pub fn unwatch(app: &AppHandle, path: &Path) {
    let l = lib(app);
    let mut g = l.watcher.lock().unwrap();
    if let Some(w) = g.as_mut() {
        let _ = w.unwatch(path);
    }
}

/// Starts the folder watcher. Changes are gathered until the folders have been quiet for 1.5 s,
/// then only the folders that changed are scanned again.
pub fn start_watcher(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("katana: no folder watcher: {e}");
            return;
        }
    };
    *lib(app).watcher.lock().unwrap() = Some(watcher);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        loop {
            let timeout = if pending.is_empty() { Duration::from_secs(3600) } else { Duration::from_millis(1500) };
            match rx.recv_timeout(timeout) {
                Ok(Ok(ev)) => {
                    use notify::EventKind::*;
                    if matches!(ev.kind, Create(_) | Modify(_) | Remove(_) | Any) {
                        pending.extend(ev.paths);
                    }
                }
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if pending.is_empty() {
                        continue;
                    }
                    let folders = {
                        let l = lib(&app2);
                        let conn = l.db.0.lock().unwrap();
                        db::folders(&conn).unwrap_or_default()
                    };
                    let ids: Vec<i64> = folders
                        .iter()
                        .filter(|f| pending.iter().any(|p| p.starts_with(&f.path)))
                        .map(|f| f.id)
                        .collect();
                    pending.clear();
                    if !ids.is_empty() {
                        scan_in_background(app2.clone(), Some(ids));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}
