// Katana Desk, the desktop version of Katana.
// SPDX-License-Identifier: GPL-3.0-or-later

mod covers;
mod db;
mod dict;
mod grimmory;
mod highlights;
mod journal;
mod library;
mod lists;
mod marks;
mod meta;
mod pages;
mod resumable;
mod search;
mod words;

use db::{Book, Folder};
use library::{Library, ScanState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

static MICA: AtomicBool = AtomicBool::new(false);

pub(crate) type Res<T> = Result<T, String>;

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
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

/// Adds reading time to today (local date and hour), for the reading card and the Journal: the book read
/// and the pages turned in that time.
#[tauri::command]
fn add_reading(lib: State<Library>, seconds: i64, book_id: Option<i64>, pages: Option<i64>) -> Res<()> {
    use chrono::Timelike;
    let now = chrono::Local::now();
    let day = now.format("%Y-%m-%d").to_string();
    let conn = lib.db.0.lock().unwrap();
    db::add_reading(&conn, &day, now.hour(), book_id, seconds.clamp(0, 600), pages.unwrap_or(0).clamp(0, 200)).map_err(err)
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
    // Linux: no file manager is sure to select a file, so the folder that holds it opens
    #[cfg(target_os = "linux")]
    {
        let p = std::path::Path::new(&path);
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(err)?;
    }
    Ok(())
}

/// How this copy was installed, for Settings › About's updates: Windows and the AppImage replace
/// themselves; a .deb or .rpm install is updated by hand (or by the package manager).
#[tauri::command]
fn install_kind() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "package"
    }
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
        let h = highlights::get(&conn, id).map_err(err)?;
        // a highlight edited counts as going back to it, for the Journal
        if let Some(h) = &h {
            let _ = words::log(&conn, "edit", Some(&h.uuid), Some(h.book_id), None, &today());
        }
        h
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

// ---------- My words, review cards, the learning numbers (milestone 5) ----------

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[tauri::command]
fn words_list(lib: State<Library>, book_id: Option<i64>) -> Res<Vec<words::Word>> {
    let conn = lib.db.0.lock().unwrap();
    words::list(&conn, book_id).map_err(err)
}

#[tauri::command]
fn word_find(lib: State<Library>, word: String) -> Res<Option<words::Word>> {
    let conn = lib.db.0.lock().unwrap();
    words::find(&conn, &word).map_err(err)
}

/// Saves a word to My words, with its meaning from the built-in dictionary when the card didn't have one.
#[tauri::command]
async fn word_save(app: AppHandle, w: words::NewWord) -> Res<words::Word> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut w = w;
        if w.meaning.is_none() {
            let look = if w.headword.is_empty() { w.word.clone() } else { w.headword.clone() };
            if let Some((h, pos, m)) = dict::meaning_of(&app, &look) {
                if w.headword.is_empty() {
                    w.headword = h;
                }
                w.meaning = Some(m);
                w.pos = w.pos.or(pos);
            }
        }
        let lib = app.state::<Library>();
        let conn = lib.db.0.lock().unwrap();
        words::save(&conn, &w).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn word_remove(lib: State<Library>, id: i64) -> Res<Option<words::Word>> {
    let conn = lib.db.0.lock().unwrap();
    words::remove(&conn, id).map_err(err)
}

#[tauri::command]
fn word_restore(lib: State<Library>, w: words::Word) -> Res<words::Word> {
    let conn = lib.db.0.lock().unwrap();
    words::restore(&conn, &w).map_err(err)
}

#[tauri::command]
fn word_note(lib: State<Library>, id: i64, note: Option<String>) -> Res<()> {
    let conn = lib.db.0.lock().unwrap();
    words::set_note(&conn, id, note.as_deref()).map_err(err)
}

/// Words saved before a dictionary was here get their meaning now. Returns how many got one.
#[tauri::command]
async fn words_fill_meanings(app: AppHandle) -> Res<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let lib = app.state::<Library>();
        let todo = words::without_meaning(&lib.db.0.lock().unwrap()).map_err(err)?;
        let mut n = 0;
        for (id, hw) in todo {
            if let Some((_, pos, m)) = dict::meaning_of(&app, &hw) {
                words::set_meaning(&lib.db.0.lock().unwrap(), id, &m, pos.as_deref()).map_err(err)?;
                n += 1;
            }
        }
        Ok(n)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn review_due(lib: State<Library>, book_id: Option<i64>, all: bool) -> Res<Vec<words::Word>> {
    let conn = lib.db.0.lock().unwrap();
    words::due(&conn, book_id, all).map_err(err)
}

#[tauri::command]
fn review_answer(lib: State<Library>, id: i64, known: bool, first: bool) -> Res<Option<words::Word>> {
    let conn = lib.db.0.lock().unwrap();
    words::answer(&conn, id, known, first, &today()).map_err(err)
}

/// A learning event from the screens: a mark or word gone back to ("revisit"), a word looked up ("lookup").
#[tauri::command]
fn learning_log(lib: State<Library>, kind: String, mark: Option<String>, book_id: Option<i64>, detail: Option<String>) -> Res<()> {
    if !matches!(kind.as_str(), "revisit" | "lookup") {
        return Err("Unknown kind".into());
    }
    let conn = lib.db.0.lock().unwrap();
    words::log(&conn, &kind, mark.as_deref(), book_id, detail.as_deref(), &today()).map_err(err)
}

#[tauri::command]
fn learning_stats(lib: State<Library>) -> Res<words::Learning> {
    let conn = lib.db.0.lock().unwrap();
    words::stats(&conn, chrono::Local::now().date_naive()).map_err(err)
}

#[tauri::command]
fn words_export(lib: State<Library>, path: String, book_id: Option<i64>) -> Res<usize> {
    let (md, n) = {
        let conn = lib.db.0.lock().unwrap();
        let list = words::list(&conn, book_id).map_err(err)?;
        (words::markdown(&list, &chrono::Local::now().format("%-d %B %Y").to_string()), list.len())
    };
    std::fs::write(&path, md).map_err(|e| format!("The file couldn't be written: {e}"))?;
    Ok(n)
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

// ---------- milestone 7: Journal, search everything, a second window, backups ----------

#[tauri::command]
fn journal_stats(lib: State<Library>, period: String) -> Res<journal::Journal> {
    let conn = lib.db.0.lock().unwrap();
    journal::stats(&conn, chrono::Local::now().date_naive(), &period).map_err(err)
}

/// Writes the year's Journal as Markdown to `path`.
#[tauri::command]
fn journal_export(lib: State<Library>, path: String) -> Res<()> {
    let md = {
        let conn = lib.db.0.lock().unwrap();
        let j = journal::stats(&conn, chrono::Local::now().date_naive(), "year").map_err(err)?;
        journal::markdown(&j, &chrono::Local::now().format("%-d %B %Y").to_string())
    };
    std::fs::write(&path, md).map_err(|e| format!("The file couldn't be written: {e}"))
}

#[tauri::command]
fn search_everything(lib: State<Library>, q: String) -> Res<search::Found> {
    let conn = lib.db.0.lock().unwrap();
    search::search(&conn, &q).map_err(err)
}

/// Percent-encodes everything but letters, digits and `-_.~` (for a place in a window's address).
fn url_part(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Mica behind a window's bar and sidebar (Windows 11 only); off when glass is switched off in Settings.
fn glass(w: &tauri::WebviewWindow, on: bool) -> bool {
    #[cfg(windows)]
    {
        use tauri::window::{Effect, EffectsBuilder};
        if on {
            return w.set_effects(EffectsBuilder::new().effect(Effect::Mica).build()).is_ok();
        }
        let _ = w.set_effects(None::<tauri::utils::config::WindowEffectsConfig>);
    }
    #[cfg(not(windows))]
    let _ = (w, on);
    false
}

/// Ctrl+click: a book (or a place in it) in a window of its own. One window is the default.
#[tauri::command]
async fn open_book_window(app: AppHandle, book_id: i64, at: Option<String>, title: Option<String>) -> Res<()> {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let mut url = format!("index.html?book={book_id}");
    if let Some(a) = at.filter(|a| !a.is_empty()) {
        url.push_str(&format!("&at={}", url_part(&a)));
    }
    let w = tauri::WebviewWindowBuilder::new(&app, format!("book-{book_id}-{n}"), tauri::WebviewUrl::App(url.into()))
        .title(title.map(|t| format!("{t} · Katana Desk")).unwrap_or_else(|| "Katana Desk".into()))
        .inner_size(1100.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .visible(false)
        .build()
        .map_err(err)?;
    if std::env::var("KATANA_QUIET").is_ok() {
        let _ = w.set_position(tauri::PhysicalPosition::new(-4000, -4000));
        let _ = w.set_skip_taskbar(true);
        let _ = w.set_focusable(false);
    }
    if MICA.load(Ordering::Relaxed) {
        glass(&w, true);
    }
    // shown by the page once drawn; if it never says so, shown anyway
    let w2 = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if !w2.is_visible().unwrap_or(true) {
            let _ = w2.show();
        }
    });
    Ok(())
}

/// Settings › Appearance › Glass: Mica on or off in every window.
#[tauri::command]
fn set_glass(app: AppHandle, lib: State<Library>, on: bool) -> Res<bool> {
    db::set_setting(&lib.db.0.lock().unwrap(), "app.glass", if on { "1" } else { "0" }).map_err(err)?;
    let mut ok = false;
    for w in app.webview_windows().values() {
        ok = glass(w, on) || ok;
    }
    MICA.store(on && ok, Ordering::Relaxed);
    Ok(on && ok)
}

/// A copy of the whole library database (places, marks, words, the Journal, lists, settings) at `path`.
#[tauri::command]
fn backup_library(lib: State<Library>, path: String) -> Res<()> {
    let _ = std::fs::remove_file(&path);
    let conn = lib.db.0.lock().unwrap();
    conn.execute("VACUUM INTO ?1", [&path]).map(|_| ()).map_err(|e| format!("The copy couldn't be written: {e}"))
}

/// Every book's marks as Markdown files in `dir`, one per book. Returns how many files.
#[tauri::command]
fn export_all_marks(lib: State<Library>, dir: String) -> Res<usize> {
    let conn = lib.db.0.lock().unwrap();
    let date = chrono::Local::now();
    let mut n = 0;
    for mb in highlights::marked_books(&conn).map_err(err)? {
        let Some(b) = db::book(&conn, mb.id).map_err(err)? else { continue };
        let bm = marks::list(&conn, b.id).map_err(err)?;
        let hl = highlights::list(&conn, b.id).map_err(err)?;
        if bm.is_empty() && hl.is_empty() {
            continue;
        }
        let md = highlights::markdown(&b.title, b.author.as_deref(), &bm, &hl, &date.format("%-d %B %Y").to_string());
        let name = highlights::file_name(&b.title, &date.format("%Y-%m-%d").to_string());
        std::fs::write(std::path::Path::new(&dir).join(name), md).map_err(|e| format!("A file couldn't be written: {e}"))?;
        n += 1;
    }
    Ok(n)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_decorum::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("kcover", grimmory::covers::handle)
        .register_asynchronous_uri_scheme_protocol("kpage", pages::handle)
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
            app.manage(dict::Dicts::new(db.clone(), data.join("dictionaries")));

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
            dict::start(&handle);

            if let Some(win) = app.get_webview_window("main") {
                // KATANA_QUIET=1: for test runs, the window opens off-screen, out of the taskbar and never takes focus
                if std::env::var("KATANA_QUIET").is_ok() {
                    let _ = win.set_position(tauri::PhysicalPosition::new(-4000, -4000));
                    let _ = win.set_skip_taskbar(true);
                    let _ = win.set_focusable(false);
                }
                // Mica behind the title bar and the sidebar (Windows 11), unless switched off in Settings
                let glass_on = db::get_setting(&db.0.lock().unwrap(), "app.glass").ok().flatten().as_deref() != Some("0");
                if glass_on && glass(&win, true) {
                    MICA.store(true, Ordering::Relaxed);
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
            install_kind,
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
            words_list,
            word_find,
            word_save,
            word_remove,
            word_restore,
            word_note,
            words_fill_meanings,
            review_due,
            review_answer,
            learning_log,
            learning_stats,
            words_export,
            dict::dict_lookup,
            dict::dict_status,
            dict::dict_refresh,
            dict::dict_download,
            dict::dict_pause,
            dict::dict_cancel,
            dict::dict_remove,
            dict::dict_set_url,
            dict::stardict_add,
            dict::stardict_remove,
            dict::open_url,
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
            grimmory::sync::grimmory_keep_up,
            grimmory::sync::grimmory_set_status,
            grimmory::sync::grimmory_reset_progress,
            grimmory::sync::book_reset_place,
            grimmory::pdf_annots::pdf_annots,
            grimmory::pdf_annots::pdf_annot_add,
            grimmory::pdf_annots::pdf_annot_remove,
            grimmory::pdf_annots::highlight_rects,
            grimmory::pdf_annots::pdf_annots_sync,
            grimmory::sync::grimmory_closed,
            grimmory::sync::grimmory_book_sync,
            grimmory::matching::grimmory_match,
            pages::page_book,
            pages::djvu_text,
            pages::page_book_closed,
            pages::pdf_cover,
            pages::pdf_covers_todo,
            journal_stats,
            journal_export,
            search_everything,
            open_book_window,
            set_glass,
            backup_library,
            export_all_marks,
            covers::covers_custom,
            covers::cover_save,
            covers::cover_reset,
            covers::cover_source,
            covers::cover_file,
            covers::openlibrary_search,
            covers::openlibrary_cover,
            lists::lists,
            lists::list_create,
            lists::list_rename,
            lists::list_delete,
            lists::list_restore,
            lists::list_add,
            lists::list_remove
        ])
        .run(context())
        .expect("error while running Katana Desk");
}

/// The app's context. For update tests, KATANA_UPDATE_URL points the updater at another latest.json
/// (plain http allowed, for a local server; the installer runs quietly); normal runs use the GitHub
/// releases from tauri.conf.json.
fn context() -> tauri::Context<tauri::Wry> {
    let mut ctx = tauri::generate_context!();
    if let Ok(url) = std::env::var("KATANA_UPDATE_URL") {
        if let Some(up) = ctx.config_mut().plugins.0.get_mut("updater").and_then(|v| v.as_object_mut()) {
            up.insert("endpoints".into(), serde_json::json!([url]));
            up.insert("dangerousInsecureTransportProtocol".into(), serde_json::json!(true));
            // tests stay off the screen: no installer window
            up.insert("windows".into(), serde_json::json!({ "installMode": "quiet" }));
        }
    }
    ctx
}
