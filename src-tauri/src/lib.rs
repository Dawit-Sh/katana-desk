// Katana Desk, the desktop version of Katana.
// SPDX-License-Identifier: GPL-3.0-or-later

mod db;
mod library;
mod meta;

use db::{Book, Folder};
use library::{Library, ScanState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

static MICA: AtomicBool = AtomicBool::new(false);

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryView {
    folders: Vec<Folder>,
    books: Vec<Book>,
    scan: ScanState,
}

#[tauri::command]
fn get_library(lib: State<Library>) -> Res<LibraryView> {
    let conn = lib.db.0.lock().unwrap();
    Ok(LibraryView {
        folders: db::folders(&conn).map_err(err)?,
        books: db::books(&conn).map_err(err)?,
        scan: lib.state.lock().unwrap().clone(),
    })
}

#[tauri::command]
fn get_book(lib: State<Library>, id: i64) -> Res<Option<Book>> {
    let conn = lib.db.0.lock().unwrap();
    db::book(&conn, id).map_err(err)
}

#[tauri::command]
async fn add_paths(app: AppHandle, paths: Vec<String>) -> Res<()> {
    // indexing loose files reads them, so keep it off the main thread
    tauri::async_runtime::spawn_blocking(move || library::add_paths(&app, paths)).await.map_err(err)
}

#[tauri::command]
fn remove_folder(app: AppHandle, lib: State<Library>, id: i64) -> Res<()> {
    let path = {
        let conn = lib.db.0.lock().unwrap();
        let path = db::folders(&conn).map_err(err)?.into_iter().find(|f| f.id == id).map(|f| f.path);
        db::remove_folder(&conn, id).map_err(err)?;
        path
    };
    if let Some(p) = path {
        library::unwatch(&app, &PathBuf::from(p));
    }
    use tauri::Emitter;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn scan_now(app: AppHandle) {
    library::scan_in_background(app, None);
}

#[tauri::command]
fn save_progress(lib: State<Library>, id: i64, location: String, fraction: f64, chapter: Option<String>) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    db::save_progress(&conn, id, &location, fraction, chapter.as_deref()).map_err(err)
}

#[tauri::command]
fn mark_opened(lib: State<Library>, id: i64) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    db::mark_opened(&conn, id).map_err(err)
}

/// Adds reading time to today (local date), for the reading card and the Journal.
#[tauri::command]
fn add_reading(lib: State<Library>, seconds: i64) -> Res<()> {
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let conn = lib.db.0.lock().unwrap();
    db::add_reading(&conn, &day, seconds.clamp(0, 600)).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadingDays {
    today: String,
    days: Vec<(String, i64)>,
}

#[tauri::command]
fn reading_days(lib: State<Library>) -> Res<ReadingDays> {
    let now = chrono::Local::now();
    let since = (now - chrono::Duration::days(400)).format("%Y-%m-%d").to_string();
    let conn = lib.db.0.lock().unwrap();
    Ok(ReadingDays { today: now.format("%Y-%m-%d").to_string(), days: db::reading_days(&conn, &since).map_err(err)? })
}

#[tauri::command]
fn get_setting(lib: State<Library>, key: String) -> Res<Option<String>> {
    let conn = lib.db.0.lock().unwrap();
    db::get_setting(&conn, &key).map_err(err)
}

#[tauri::command]
fn set_setting(lib: State<Library>, key: String, value: String) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    db::set_setting(&conn, &key, &value).map_err(err)
}

/// Opens File Explorer with the book's file selected.
#[tauri::command]
fn reveal(path: String) -> Res<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn has_mica() -> bool {
    MICA.load(Ordering::Relaxed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_decorum::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // KATANA_DATA_DIR: a separate library for test runs
            let data = match std::env::var("KATANA_DATA_DIR") {
                Ok(d) => PathBuf::from(d),
                Err(_) => app.path().app_data_dir()?,
            };
            let covers = data.join("covers");
            std::fs::create_dir_all(&covers)?;
            let db = db::Db::open(&data.join("katana.db"))?;
            let folders = db::folders(&db.0.lock().unwrap()).unwrap_or_default();
            let loose = db::loose_paths(&db.0.lock().unwrap()).unwrap_or_default();
            app.manage(Library::new(db, covers.clone()));

            library::allow(&handle, &covers, true);
            library::start_watcher(&handle);
            for f in &folders {
                let p = PathBuf::from(&f.path);
                library::allow(&handle, &p, true);
                library::watch(&handle, &p);
            }
            for (_, p) in &loose {
                library::allow(&handle, &PathBuf::from(p), false);
            }
            library::scan_in_background(handle.clone(), None);

            if let Some(win) = app.get_webview_window("main") {
                // KATANA_QUIET=1: for test runs, the window opens off-screen, out of the taskbar and never takes focus
                if std::env::var("KATANA_QUIET").is_ok() {
                    let _ = win.set_position(tauri::PhysicalPosition::new(-4000, -4000));
                    let _ = win.set_skip_taskbar(true);
                    let _ = win.set_focusable(false);
                }
                // Mica behind the title bar and the sidebar (Windows 11)
                #[cfg(windows)]
                {
                    use tauri::window::{Effect, EffectsBuilder};
                    if win.set_effects(EffectsBuilder::new().effect(Effect::Mica).build()).is_ok() {
                        MICA.store(true, Ordering::Relaxed);
                    }
                }
                // The page shows the window once it has drawn (no white flash). If it never says so, show it anyway.
                let w = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            get_book,
            add_paths,
            remove_folder,
            scan_now,
            save_progress,
            mark_opened,
            add_reading,
            reading_days,
            get_setting,
            set_setting,
            reveal,
            has_mica
        ])
        .run(tauri::generate_context!())
        .expect("error while running Katana Desk");
}
