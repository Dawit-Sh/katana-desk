//! The library on this PC: folders, books, reading places and reading days, in SQLite.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

const SCHEMA_VERSION: i32 = 3;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub added_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: i64,
    pub path: String,
    pub folder_id: Option<i64>,
    /// Folders between the added folder and the file, joined with "/" ("" when the file sits in the folder itself).
    pub rel_dir: String,
    pub format: String,
    pub title: String,
    pub author: Option<String>,
    pub size: i64,
    pub cover: Option<String>,
    pub added_at: i64,
    pub opened_at: Option<i64>,
    pub location: Option<String>,
    pub fraction: Option<f64>,
    pub chapter: Option<String>,
    /// "local" (from a Local folder or added one by one) or "grimmory" (downloaded from Grimmory)
    pub source: String,
    /// The Grimmory book this file is (a download, or a Local copy matched by partial MD5)
    pub grimmory_id: Option<i64>,
    pub place_state: String,
    pub synced_at: Option<i64>,
}

/// What the scanner knows about a file before it reads it.
pub struct Known {
    pub id: i64,
    pub size: i64,
    pub mtime: i64,
    pub missing: bool,
}

pub struct NewBook<'a> {
    pub path: &'a str,
    pub folder_id: Option<i64>,
    pub rel_dir: &'a str,
    pub format: &'a str,
    pub title: &'a str,
    pub author: Option<&'a str>,
    pub size: i64,
    pub mtime: i64,
    pub hash: Option<&'a str>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS folders (
                    id INTEGER PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE,
                    added_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS books (
                    id INTEGER PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE,
                    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
                    rel_dir TEXT NOT NULL DEFAULT '',
                    format TEXT NOT NULL,
                    title TEXT NOT NULL,
                    author TEXT,
                    size INTEGER NOT NULL DEFAULT 0,
                    mtime INTEGER NOT NULL DEFAULT 0,
                    hash TEXT,
                    cover TEXT,
                    added_at INTEGER NOT NULL,
                    missing INTEGER NOT NULL DEFAULT 0,
                    loose INTEGER NOT NULL DEFAULT 0,
                    opened_at INTEGER,
                    location TEXT,
                    fraction REAL,
                    chapter TEXT
                );
                CREATE INDEX IF NOT EXISTS books_folder ON books(folder_id);
                CREATE INDEX IF NOT EXISTS books_hash ON books(hash);
                CREATE TABLE IF NOT EXISTS reading_days (
                    day TEXT PRIMARY KEY,
                    seconds INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                ",
            )?;
        }
        if version < 2 {
            // Grimmory (milestone 2). Additive only: nothing in version 1 changes meaning.
            conn.execute_batch(
                "
                ALTER TABLE books ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
                ALTER TABLE books ADD COLUMN grimmory_id INTEGER;
                ALTER TABLE books ADD COLUMN place_at INTEGER;
                ALTER TABLE books ADD COLUMN place_state TEXT NOT NULL DEFAULT 'clean';
                ALTER TABLE books ADD COLUMN server_place TEXT;
                ALTER TABLE books ADD COLUMN synced_at INTEGER;
                ALTER TABLE books ADD COLUMN href TEXT;
                CREATE INDEX IF NOT EXISTS books_grimmory ON books(grimmory_id);
                CREATE TABLE IF NOT EXISTS gbooks (
                    id INTEGER PRIMARY KEY,
                    library_id INTEGER,
                    title TEXT NOT NULL,
                    authors TEXT,
                    series TEXT,
                    series_number REAL,
                    file_id INTEGER,
                    file_type TEXT,
                    file_name TEXT,
                    size_kb INTEGER,
                    added_on INTEGER,
                    last_read INTEGER,
                    progress REAL,
                    read_status TEXT,
                    cover_v INTEGER,
                    page_count INTEGER,
                    language TEXT,
                    publisher TEXT,
                    categories TEXT,
                    tags TEXT,
                    published TEXT,
                    rating INTEGER,
                    sig TEXT,
                    seen INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS glibraries (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    icon TEXT,
                    book_count INTEGER
                );
                CREATE TABLE IF NOT EXISTS gshelves (
                    kind TEXT NOT NULL,
                    id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    icon TEXT,
                    book_count INTEGER,
                    PRIMARY KEY (kind, id)
                );
                CREATE TABLE IF NOT EXISTS gshelf_books (
                    kind TEXT NOT NULL,
                    shelf_id INTEGER NOT NULL,
                    book_id INTEGER NOT NULL,
                    PRIMARY KEY (kind, shelf_id, book_id)
                );
                CREATE TABLE IF NOT EXISTS gdownloads (
                    book_id INTEGER PRIMARY KEY,
                    state TEXT NOT NULL,
                    done INTEGER NOT NULL DEFAULT 0,
                    total INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    open_after INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS gmatch (
                    local_id INTEGER NOT NULL,
                    grimmory_id INTEGER NOT NULL,
                    local_hash TEXT NOT NULL,
                    size_kb INTEGER,
                    result TEXT NOT NULL,
                    checked_at INTEGER NOT NULL,
                    PRIMARY KEY (local_id, grimmory_id)
                );
                ",
            )?;
        }
        if version < 3 {
            // bookmarks and per-book reading settings (milestone 3), additive only
            conn.execute_batch(crate::marks::SCHEMA_V3)?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Db(Mutex::new(conn)))
    }
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

pub fn folders(conn: &Connection) -> rusqlite::Result<Vec<Folder>> {
    let mut st = conn.prepare("SELECT id, path, added_at FROM folders ORDER BY added_at")?;
    let rows = st.query_map([], |r| {
        let path: String = r.get(1)?;
        Ok(Folder { id: r.get(0)?, name: folder_name(&path), path, added_at: r.get(2)? })
    })?;
    rows.collect()
}

pub fn add_folder(conn: &Connection, path: &str) -> rusqlite::Result<i64> {
    if let Some(id) = conn
        .query_row("SELECT id FROM folders WHERE path = ?1", [path], |r| r.get(0))
        .optional()?
    {
        return Ok(id);
    }
    conn.execute("INSERT INTO folders (path, added_at) VALUES (?1, ?2)", params![path, now()])?;
    Ok(conn.last_insert_rowid())
}

/// Forgets a folder. Its books keep their reading places (they come back if the folder is added again),
/// but they leave the library. The files on disk are never touched.
pub fn remove_folder(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE books SET missing = 1 WHERE folder_id = ?1 AND loose = 0", [id])?;
    conn.execute("DELETE FROM folders WHERE id = ?1", [id])?;
    Ok(())
}

const BOOK_COLS: &str = "id, path, folder_id, rel_dir, format, title, author, size, cover, added_at, opened_at, location, fraction, chapter, source, grimmory_id, place_state, synced_at";

fn row_book(r: &rusqlite::Row) -> rusqlite::Result<Book> {
    Ok(Book {
        id: r.get(0)?,
        path: r.get(1)?,
        folder_id: r.get(2)?,
        rel_dir: r.get(3)?,
        format: r.get(4)?,
        title: r.get(5)?,
        author: r.get(6)?,
        size: r.get(7)?,
        cover: r.get(8)?,
        added_at: r.get(9)?,
        opened_at: r.get(10)?,
        location: r.get(11)?,
        fraction: r.get(12)?,
        chapter: r.get(13)?,
        source: r.get(14)?,
        grimmory_id: r.get(15)?,
        place_state: r.get(16)?,
        synced_at: r.get(17)?,
    })
}

pub fn books(conn: &Connection) -> rusqlite::Result<Vec<Book>> {
    let mut st = conn.prepare(&format!(
        "SELECT {BOOK_COLS} FROM books WHERE missing = 0 ORDER BY title COLLATE NOCASE"
    ))?;
    let rows = st.query_map([], row_book)?;
    rows.collect()
}

pub fn book(conn: &Connection, id: i64) -> rusqlite::Result<Option<Book>> {
    conn.query_row(&format!("SELECT {BOOK_COLS} FROM books WHERE id = ?1"), [id], row_book)
        .optional()
}

pub fn known(conn: &Connection, path: &str) -> rusqlite::Result<Option<Known>> {
    conn.query_row(
        "SELECT id, size, mtime, missing FROM books WHERE path = ?1",
        [path],
        |r| Ok(Known { id: r.get(0)?, size: r.get(1)?, mtime: r.get(2)?, missing: r.get::<_, i64>(3)? != 0 }),
    )
    .optional()
}

/// Paths of every book the library thinks lives under a folder, to find the ones that went away.
pub fn folder_paths(conn: &Connection, folder_id: i64) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut st = conn.prepare("SELECT id, path FROM books WHERE folder_id = ?1 AND missing = 0 AND loose = 0")?;
    let rows = st.query_map([folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

pub fn mark_missing(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE books SET missing = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn touch_found(conn: &Connection, id: i64, folder_id: Option<i64>, rel_dir: &str, loose: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE books SET missing = 0, folder_id = ?2, rel_dir = ?3, loose = ?4 WHERE id = ?1",
        params![id, folder_id, rel_dir, loose as i64],
    )?;
    Ok(())
}

/// Adds a file, or refreshes it when it changed. A file that moved (same partial MD5 as a book that
/// went missing) keeps its reading place.
pub fn upsert_book(conn: &Connection, b: &NewBook, loose: bool) -> rusqlite::Result<i64> {
    if let Some(k) = known(conn, b.path)? {
        conn.execute(
            "UPDATE books SET folder_id = ?2, rel_dir = ?3, format = ?4, title = ?5, author = ?6,
                size = ?7, mtime = ?8, hash = ?9, missing = 0, loose = ?10 WHERE id = ?1",
            params![k.id, b.folder_id, b.rel_dir, b.format, b.title, b.author, b.size, b.mtime, b.hash, loose as i64],
        )?;
        return Ok(k.id);
    }
    let moved: Option<(i64, Option<String>, Option<f64>, Option<String>, Option<i64>)> = match b.hash {
        Some(h) => conn
            .query_row(
                "SELECT id, location, fraction, chapter, opened_at FROM books WHERE hash = ?1 AND missing = 1 LIMIT 1",
                [h],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?,
        None => None,
    };
    conn.execute(
        "INSERT INTO books (path, folder_id, rel_dir, format, title, author, size, mtime, hash, added_at, loose)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![b.path, b.folder_id, b.rel_dir, b.format, b.title, b.author, b.size, b.mtime, b.hash, now(), loose as i64],
    )?;
    let id = conn.last_insert_rowid();
    if let Some((old, location, fraction, chapter, opened_at)) = moved {
        conn.execute(
            "UPDATE books SET location = ?2, fraction = ?3, chapter = ?4, opened_at = ?5 WHERE id = ?1",
            params![id, location, fraction, chapter, opened_at],
        )?;
        // the old row stays as it was (missing), never deleted
        conn.execute("UPDATE books SET hash = NULL WHERE id = ?1", [old])?;
    }
    Ok(id)
}

pub fn set_cover(conn: &Connection, id: i64, cover: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE books SET cover = ?2 WHERE id = ?1", params![id, cover])?;
    Ok(())
}

/// Saves the reading place. A book linked to Grimmory is marked waiting to go up, unless the place
/// didn't move (opening a book saves where it already was).
pub fn save_progress(
    conn: &Connection,
    id: i64,
    location: &str,
    fraction: f64,
    chapter: Option<&str>,
    href: Option<&str>,
    turned: bool,
) -> rusqlite::Result<bool> {
    let old: Option<(Option<String>, Option<f64>)> = conn
        .query_row("SELECT location, fraction FROM books WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    // the first place after opening (where the book was put) isn't reading: only a turned page is
    let moved = turned
        && match &old {
            Some((Some(l), f)) => l != location || (f.unwrap_or(0.0) - fraction).abs() > 1e-6,
            _ => true,
        };
    let t = now();
    if moved {
        conn.execute(
            "UPDATE books SET location = ?2, fraction = ?3, chapter = ?4, opened_at = ?5, href = ?6, place_at = ?5,
                place_state = CASE WHEN grimmory_id IS NULL THEN place_state ELSE 'pending' END
             WHERE id = ?1",
            params![id, location, fraction, chapter, t, href],
        )?;
    } else {
        conn.execute(
            "UPDATE books SET location = ?2, fraction = ?3, chapter = ?4, opened_at = ?5, href = COALESCE(?6, href) WHERE id = ?1",
            params![id, location, fraction, chapter, t, href],
        )?;
    }
    Ok(moved)
}

pub fn mark_opened(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE books SET opened_at = ?2 WHERE id = ?1", params![id, now()])?;
    Ok(())
}

pub fn add_reading(conn: &Connection, day: &str, seconds: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reading_days (day, seconds) VALUES (?1, ?2)
         ON CONFLICT(day) DO UPDATE SET seconds = seconds + excluded.seconds",
        params![day, seconds],
    )?;
    Ok(())
}

pub fn reading_days(conn: &Connection, since: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut st = conn.prepare("SELECT day, seconds FROM reading_days WHERE day >= ?1 ORDER BY day")?;
    let rows = st.query_map([since], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn loose_paths(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut st = conn.prepare("SELECT id, path FROM books WHERE loose = 1 AND missing = 0")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// A book downloaded from Grimmory. A new download of the same Grimmory book takes over the old row,
/// so its reading place stays.
#[allow(clippy::too_many_arguments)]
pub fn upsert_download(
    conn: &Connection,
    path: &str,
    format: &str,
    title: &str,
    author: Option<&str>,
    size: i64,
    mtime: i64,
    hash: Option<&str>,
    grimmory_id: i64,
) -> rusqlite::Result<i64> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM books WHERE path = ?1 OR (source = 'grimmory' AND grimmory_id = ?2) ORDER BY path = ?1 DESC LIMIT 1",
            params![path, grimmory_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE books SET path = ?2, format = ?3, title = ?4, author = ?5, size = ?6, mtime = ?7, hash = ?8,
                missing = 0, source = 'grimmory', grimmory_id = ?9, folder_id = NULL, loose = 0 WHERE id = ?1",
            params![id, path, format, title, author, size, mtime, hash, grimmory_id],
        )?;
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO books (path, format, title, author, size, mtime, hash, added_at, source, grimmory_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'grimmory', ?9)",
        params![path, format, title, author, size, mtime, hash, now(), grimmory_id],
    )?;
    Ok(conn.last_insert_rowid())
}


