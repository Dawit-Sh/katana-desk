// Katana Desk, the desktop version of Katana.
// SPDX-License-Identifier: GPL-3.0-or-later

mod db;
mod grimmory;
mod highlights;
mod library;
mod marks;
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

/// Saves the reading place. `turned`: a page was turned since the book opened (only then is it reading,
/// and a Grimmory book's place goes up a few seconds later).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn save_progress(
    app: AppHandle,
    lib: State<Library>,
    id: i64,
    location: String,
    fraction: f64,
    chapter: Option<String>,
    href: Option<String>,
    turned: Option<bool>,
) -> Res<()> {
    let (moved, linked) = {
        let conn = lib.db.0.lock().unwrap();
        let moved = db::save_progress(&conn, id, &location, fraction, chapter.as_deref(), href.as_deref(), turned.unwrap_or(true))
            .map_err(err)?;
        let linked = db::book(&conn, id).map_err(err)?.and_then(|b| b.grimmory_id).is_some();
        (moved, linked)
    };
    if moved && linked {
        grimmory::sync::schedule_push(&app, id);
    }
    Ok(())
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
fn bookmarks(lib: State<Library>, book_id: i64) -> Res<Vec<marks::Bookmark>> {
    let conn = lib.db.0.lock().unwrap();
    marks::list(&conn, book_id).map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_bookmark(
    app: AppHandle,
    lib: State<Library>,
    book_id: i64,
    cfi: String,
    fraction: Option<f64>,
    page_label: Option<String>,
    chapter: Option<String>,
    excerpt: Option<String>,
) -> Res<marks::Bookmark> {
    let conn = lib.db.0.lock().unwrap();
    let m = marks::NewMark {
        book_id,
        cfi: &cfi,
        fraction,
        page_label: page_label.as_deref(),
        chapter: chapter.as_deref(),
        excerpt: excerpt.as_deref(),
    };
    let b = marks::add(&conn, &m).map_err(err)?;
    drop(conn);
    grimmory::marks_sync::schedule(&app, book_id);
    Ok(b)
}

#[tauri::command]
fn remove_bookmark(app: AppHandle, lib: State<Library>, id: i64) -> Res<()> {
    let book = {
        let conn = lib.db.0.lock().unwrap();
        let book = marks::book_of(&conn, "bookmarks", id);
        marks::remove(&conn, id).map_err(err)?;
        book
    };
    if let Some(b) = book {
        grimmory::marks_sync::schedule(&app, b);
    }
    Ok(())
}

#[tauri::command]
fn update_bookmark(app: AppHandle, lib: State<Library>, id: i64, title: Option<String>, note: Option<String>) -> Res<()> {
    let book = {
        let conn = lib.db.0.lock().unwrap();
        marks::update(&conn, id, title.as_deref(), note.as_deref()).map_err(err)?;
        marks::book_of(&conn, "bookmarks", id)
    };
    if let Some(b) = book {
        grimmory::marks_sync::schedule(&app, b);
    }
    Ok(())
}

// ---------- highlights (milestone 4) ----------

#[tauri::command]
fn highlights(lib: State<Library>, book_id: i64) -> Res<Vec<highlights::Highlight>> {
    let conn = lib.db.0.lock().unwrap();
    highlights::list(&conn, book_id).map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_highlight(
    app: AppHandle,
    lib: State<Library>,
    book_id: i64,
    cfi: String,
    text: String,
    chapter: Option<String>,
    fraction: Option<f64>,
    page_label: Option<String>,
    color: String,
    style: String,
    note: Option<String>,
) -> Res<highlights::Highlight> {
    let h = {
        let conn = lib.db.0.lock().unwrap();
        let n = highlights::NewHighlight {
            book_id,
            cfi: &cfi,
            text: &text,
            chapter: chapter.as_deref(),
            fraction,
            page_label: page_label.as_deref(),
            color: &color,
            style: &style,
            note: note.as_deref(),
        };
        highlights::add(&conn, &n).map_err(err)?
    };
    grimmory::marks_sync::schedule(&app, book_id);
    Ok(h)
}

#[tauri::command]
fn update_highlight(app: AppHandle, lib: State<Library>, id: i64, color: String, style: String, note: Option<String>) -> Res<Option<highlights::Highlight>> {
    let h = {
        let conn = lib.db.0.lock().unwrap();
        highlights::update(&conn, id, &color, &style, note.as_deref()).map_err(err)?;
        highlights::get(&conn, id).map_err(err)?
    };
    if let Some(h) = &h {
        grimmory::marks_sync::schedule(&app, h.book_id);
    }
    Ok(h)
}

#[tauri::command]
fn remove_highlight(app: AppHandle, lib: State<Library>, id: i64) -> Res<()> {
    let book = {
        let conn = lib.db.0.lock().unwrap();
        let book = marks::book_of(&conn, "highlights", id);
        highlights::remove(&conn, id).map_err(err)?;
        book
    };
    if let Some(b) = book {
        grimmory::marks_sync::schedule(&app, b);
    }
    Ok(())
}

/// Undo: a highlight just removed comes back.
#[tauri::command]
fn restore_highlight(app: AppHandle, lib: State<Library>, h: highlights::Highlight) -> Res<highlights::Highlight> {
    let back = {
        let conn = lib.db.0.lock().unwrap();
        highlights::restore(&conn, &h).map_err(err)?
    };
    grimmory::marks_sync::schedule(&app, back.book_id);
    Ok(back)
}

/// Where marks sit in the book, worked out by the reader for the ones that came from Grimmory.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkPlace {
    kind: String,
    id: i64,
    fraction: Option<f64>,
    page_label: Option<String>,
    chapter: Option<String>,
    excerpt: Option<String>,
}

#[tauri::command]
fn place_marks(lib: State<Library>, places: Vec<MarkPlace>) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    for p in places {
        if p.kind == "highlight" {
            highlights::set_place(&conn, p.id, p.fraction, p.page_label.as_deref(), p.chapter.as_deref()).map_err(err)?;
        } else {
            marks::set_place(&conn, p.id, p.fraction, p.page_label.as_deref(), p.chapter.as_deref(), p.excerpt.as_deref()).map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn marked_books(lib: State<Library>) -> Res<Vec<highlights::MarkedBook>> {
    let conn = lib.db.0.lock().unwrap();
    highlights::marked_books(&conn).map_err(err)
}

/// The books whose marks (or title) hold these words, for the Bookmarks page's search.
#[tauri::command]
fn search_marks(lib: State<Library>, q: String) -> Res<Vec<i64>> {
    let conn = lib.db.0.lock().unwrap();
    highlights::search_all(&conn, q.trim()).map_err(err)
}

/// A file name for a book's Markdown export.
#[tauri::command]
fn export_name(lib: State<Library>, book_id: i64) -> Res<String> {
    let conn = lib.db.0.lock().unwrap();
    let title = db::book(&conn, book_id).map_err(err)?.map(|b| b.title).unwrap_or_default();
    Ok(highlights::file_name(&title, &chrono::Local::now().format("%Y-%m-%d").to_string()))
}

/// Writes a book's bookmarks, highlights and notes as Markdown to `path`.
#[tauri::command]
fn export_marks(lib: State<Library>, book_id: i64, path: String) -> Res<()> {
    let md = {
        let conn = lib.db.0.lock().unwrap();
        let b = db::book(&conn, book_id).map_err(err)?.ok_or("The book isn't in the library any more.")?;
        let bm = marks::list(&conn, book_id).map_err(err)?;
        let hl = highlights::list(&conn, book_id).map_err(err)?;
        highlights::markdown(&b.title, b.author.as_deref(), &bm, &hl, &chrono::Local::now().format("%-d %B %Y").to_string())
    };
    std::fs::write(&path, md).map_err(|e| format!("The file couldn't be written: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReaderPrefs {
    /// this book's own settings (JSON), when it has any
    book: Option<String>,
    /// the default for books without their own ("Save as default")
    default: Option<String>,
}

#[tauri::command]
fn reader_prefs(lib: State<Library>, book_id: i64) -> Res<ReaderPrefs> {
    let conn = lib.db.0.lock().unwrap();
    Ok(ReaderPrefs {
        book: marks::book_prefs(&conn, book_id).map_err(err)?,
        default: db::get_setting(&conn, "reader.defaults").map_err(err)?,
    })
}

#[tauri::command]
fn set_book_prefs(lib: State<Library>, book_id: i64, prefs: Option<String>) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    marks::set_book_prefs(&conn, book_id, prefs.as_deref()).map_err(err)
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
        .register_asynchronous_uri_scheme_protocol("kcover", grimmory::covers::handle)
        .setup(|app| {
            let handle = app.handle().clone();
            // KATANA_DATA_DIR: a separate library for test runs
            let data = match std::env::var("KATANA_DATA_DIR") {
                Ok(d) => PathBuf::from(d),
                Err(_) => app.path().app_data_dir()?,
            };
            let covers = data.join("covers");
            std::fs::create_dir_all(&covers)?;
            let db = std::sync::Arc::new(db::Db::open(&data.join("katana.db"))?);
            let folders = db::folders(&db.0.lock().unwrap()).unwrap_or_default();
            let loose = db::loose_paths(&db.0.lock().unwrap()).unwrap_or_default();
            app.manage(Library::new(db.clone(), covers.clone()));
            let gdir = data.join("grimmory");
            std::fs::create_dir_all(gdir.join("books"))?;
            app.manage(grimmory::Grimmory::new(db.clone(), gdir.clone()));

            library::allow(&handle, &covers, true);
            // downloaded Grimmory books are read from here
            library::allow(&handle, &gdir.join("books"), true);
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
            grimmory::start(&handle);

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
            has_mica,
            bookmarks,
            add_bookmark,
            remove_bookmark,
            update_bookmark,
            highlights,
            add_highlight,
            update_highlight,
            remove_highlight,
            restore_highlight,
            place_marks,
            marked_books,
            search_marks,
            export_name,
            export_marks,
            grimmory::marks_sync::marks_sync_book,
            grimmory::marks_sync::marks_lost,
            grimmory::marks_sync::marks_lost_answer,
            grimmory::marks_sync::marks_sync_state,
            reader_prefs,
            set_book_prefs,
            grimmory::grimmory_status,
            grimmory::grimmory_sign_in,
            grimmory::grimmory_sign_out,
            grimmory::grimmory_set_url,
            grimmory::grimmory_check,
            grimmory::catalog::grimmory_catalog,
            grimmory::catalog::grimmory_sync,
            grimmory::downloads::grimmory_downloads,
            grimmory::downloads::grimmory_download,
            grimmory::downloads::grimmory_pause,
            grimmory::downloads::grimmory_resume,
            grimmory::downloads::grimmory_cancel,
            grimmory::sync::grimmory_open_place,
            grimmory::sync::grimmory_offer,
            grimmory::sync::grimmory_answer,
            grimmory::sync::grimmory_closed,
            grimmory::sync::grimmory_book_sync,
            grimmory::matching::grimmory_match
        ])
        .run(tauri::generate_context!())
        .expect("error while running Katana Desk");
}
