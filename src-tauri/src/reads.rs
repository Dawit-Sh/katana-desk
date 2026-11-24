//! Reads: each time through a book is a read (1, 2, ...), and every highlight and bookmark belongs to the
//! read it was made in, so a second read's marks can be set beside the first's (the Bookmarks page's
//! Compare). Everything made before reads existed is read 1. A new mark goes to the book's current read,
//! the newest one, by a trigger, whichever way it's added (here, from Grimmory, from a PDF's annotations).
//! Reads stay on this PC; Grimmory has no such thing.

use crate::db::now;
use crate::library::Library;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

/// Schema 9: the reads of each book, and which read each mark belongs to. Additive only.
pub const SCHEMA_V9: &str = "
CREATE TABLE IF NOT EXISTS book_reads (
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, n)
);
ALTER TABLE highlights ADD COLUMN read_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN read_n INTEGER NOT NULL DEFAULT 0;
UPDATE highlights SET read_n = 1;
UPDATE bookmarks SET read_n = 1;
CREATE TRIGGER IF NOT EXISTS highlights_read AFTER INSERT ON highlights WHEN NEW.read_n = 0
BEGIN
    UPDATE highlights SET read_n = COALESCE((SELECT MAX(n) FROM book_reads WHERE book_id = NEW.book_id), 1) WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS bookmarks_read AFTER INSERT ON bookmarks WHEN NEW.read_n = 0
BEGIN
    UPDATE bookmarks SET read_n = COALESCE((SELECT MAX(n) FROM book_reads WHERE book_id = NEW.book_id), 1) WHERE id = NEW.id;
END;
";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub n: i64,
    pub started_at: Option<i64>,
    pub highlights: i64,
    pub bookmarks: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reads {
    /// the read new marks go to
    pub current: i64,
    pub reads: Vec<Read>,
    /// highlight id → read, bookmark id → read
    pub hl: HashMap<i64, i64>,
    pub bm: HashMap<i64, i64>,
}

pub fn current(conn: &Connection, book_id: i64) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(n), 1) FROM book_reads WHERE book_id = ?1", [book_id], |r| r.get(0)).unwrap_or(1)
}

pub fn reads(conn: &Connection, book_id: i64) -> rusqlite::Result<Reads> {
    let cur = current(conn, book_id);
    let started: HashMap<i64, i64> = conn
        .prepare("SELECT n, started_at FROM book_reads WHERE book_id = ?1")?
        .query_map([book_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .flatten()
        .collect();
    let pairs = |sql: &str| -> rusqlite::Result<HashMap<i64, i64>> {
        Ok(conn.prepare(sql)?.query_map([book_id], |r| Ok((r.get(0)?, r.get(1)?)))?.flatten().collect())
    };
    let hl = pairs("SELECT id, read_n FROM highlights WHERE book_id = ?1 AND deleted_at IS NULL")?;
    let bm = pairs("SELECT id, read_n FROM bookmarks WHERE book_id = ?1 AND deleted_at IS NULL")?;
    let top = hl.values().chain(bm.values()).copied().max().unwrap_or(1).max(cur);
    let reads = (1..=top)
        .map(|n| Read {
            n,
            started_at: started.get(&n).copied(),
            highlights: hl.values().filter(|x| **x == n).count() as i64,
            bookmarks: bm.values().filter(|x| **x == n).count() as i64,
        })
        .collect();
    Ok(Reads { current: cur, reads, hl, bm })
}

/// The day a book was finished, as Grimmory keeps `dateFinished`: set when its status becomes Read (a
/// book that was already Read keeps its day), and served with that status.
pub fn mark_finished(conn: &Connection, id: i64, was_read: bool) -> rusqlite::Result<()> {
    let now = crate::db::now();
    if was_read {
        conn.execute("UPDATE books SET finished_at = COALESCE(finished_at, ?2) WHERE id = ?1", params![id, now])?;
    } else {
        conn.execute("UPDATE books SET finished_at = ?2 WHERE id = ?1", params![id, now])?;
    }
    Ok(())
}

/// A Local book's status here (Re-reading starts a new read, Read sets the day it was finished).
pub fn set_local_status(conn: &Connection, id: i64, status: &str) -> rusqlite::Result<()> {
    let before: Option<String> = conn.query_row("SELECT read_status FROM books WHERE id = ?1", [id], |r| r.get(0)).ok().flatten();
    conn.execute("UPDATE books SET read_status = ?2 WHERE id = ?1", params![id, status])?;
    if status == "READ" {
        mark_finished(conn, id, before.as_deref() == Some("READ"))?;
    }
    if status == "RE_READING" {
        start(conn, id)?;
    }
    Ok(())
}

/// Starts the next read: marks made from now on belong to it. A read with no marks yet is kept as it
/// is (asking twice doesn't make empty reads).
pub fn start(conn: &Connection, book_id: i64) -> rusqlite::Result<i64> {
    let cur = current(conn, book_id);
    let has_row: bool = conn
        .query_row("SELECT COUNT(*) > 0 FROM book_reads WHERE book_id = ?1", [book_id], |r| r.get(0))
        .unwrap_or(false);
    let used: i64 = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM highlights WHERE book_id = ?1 AND read_n = ?2 AND deleted_at IS NULL)
              + (SELECT COUNT(*) FROM bookmarks WHERE book_id = ?1 AND read_n = ?2 AND deleted_at IS NULL)",
        params![book_id, cur],
        |r| r.get(0),
    )?;
    if used == 0 && has_row {
        return Ok(cur);
    }
    if !has_row {
        // the first read, from before reads existed
        conn.execute("INSERT OR IGNORE INTO book_reads (book_id, n, started_at) VALUES (?1, 1, ?2)", params![book_id, 0])?;
    }
    if used == 0 {
        return Ok(cur);
    }
    let next = cur + 1;
    conn.execute("INSERT OR IGNORE INTO book_reads (book_id, n, started_at) VALUES (?1, ?2, ?3)", params![book_id, next, now()])?;
    Ok(next)
}

#[tauri::command]
pub fn book_reads(lib: State<Library>, book_id: i64) -> Result<Reads, String> {
    let conn = lib.db.0.lock().unwrap();
    reads(&conn, book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn book_new_read(lib: State<Library>, book_id: i64) -> Result<i64, String> {
    let conn = lib.db.0.lock().unwrap();
    start(&conn, book_id).map_err(|e| e.to_string())
}

/// A Local book's reading status (kept on this PC; a Grimmory book's is Grimmory's).
#[tauri::command]
pub fn book_status(lib: State<Library>, id: i64) -> Option<String> {
    let conn = lib.db.0.lock().unwrap();
    conn.query_row("SELECT read_status FROM books WHERE id = ?1", [id], |r| r.get(0)).ok().flatten()
}

/// Sets a Local book's status: Unread clears its place too, Re-reading starts a new read. An empty status
/// takes it off again (Undo of the first status a book was given); nothing else changes.
#[tauri::command]
pub fn book_set_status(app: tauri::AppHandle, lib: State<Library>, id: i64, status: String) -> Result<String, String> {
    if status.is_empty() {
        let conn = lib.db.0.lock().unwrap();
        conn.execute("UPDATE books SET read_status = NULL WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        return Ok(status);
    }
    if !crate::grimmory::sync::STATUSES.contains(&status.as_str()) {
        return Err(format!("{status} isn't a reading status"));
    }
    {
        let conn = lib.db.0.lock().unwrap();
        set_local_status(&conn, id, &status).map_err(|e| e.to_string())?;
    }
    if status == "UNREAD" {
        crate::grimmory::sync::clear(&app, id);
    }
    Ok(status)
}

/// What a status change can change here besides the status: the day the book was finished (Read sets it,
/// Unread clears it) and its current read (Re-reading starts one). Taken before a change; Undo puts it back.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusMarks {
    pub finished_at: Option<i64>,
    pub read: i64,
}

pub fn status_marks(conn: &Connection, id: i64) -> rusqlite::Result<StatusMarks> {
    let finished_at = conn.query_row("SELECT finished_at FROM books WHERE id = ?1", [id], |r| r.get(0))?;
    Ok(StatusMarks { finished_at, read: current(conn, id) })
}

/// Puts back what `status_marks` took: the finished day, and no reads started since that are still empty.
pub fn put_status_marks(conn: &Connection, id: i64, m: &StatusMarks) -> rusqlite::Result<()> {
    conn.execute("UPDATE books SET finished_at = ?2 WHERE id = ?1", params![id, m.finished_at])?;
    conn.execute(
        "DELETE FROM book_reads WHERE book_id = ?1 AND n > ?2
            AND NOT EXISTS (SELECT 1 FROM highlights h WHERE h.book_id = ?1 AND h.read_n = book_reads.n AND h.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM bookmarks m WHERE m.book_id = ?1 AND m.read_n = book_reads.n AND m.deleted_at IS NULL)",
        params![id, m.read],
    )?;
    Ok(())
}

#[tauri::command]
pub fn book_status_marks(lib: State<Library>, id: i64) -> Result<StatusMarks, String> {
    status_marks(&lib.db.0.lock().unwrap(), id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn book_status_put_back(lib: State<Library>, id: i64, m: StatusMarks) -> Result<(), String> {
    put_status_marks(&lib.db.0.lock().unwrap(), id, &m).map_err(|e| e.to_string())
}

/// Moves one mark to another read (made in the wrong one).
#[tauri::command]
pub fn mark_move_read(lib: State<Library>, highlight: Option<i64>, bookmark: Option<i64>, n: i64) -> Result<(), String> {
    let conn = lib.db.0.lock().unwrap();
    let n = n.max(1);
    if let Some(id) = highlight {
        conn.execute("UPDATE highlights SET read_n = ?2 WHERE id = ?1", params![id, n]).map_err(|e| e.to_string())?;
    }
    if let Some(id) = bookmark {
        conn.execute("UPDATE bookmarks SET read_n = ?2 WHERE id = ?1", params![id, n]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY);
             CREATE TABLE highlights (id INTEGER PRIMARY KEY, book_id INTEGER, deleted_at INTEGER);
             CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, book_id INTEGER, deleted_at INTEGER);
             INSERT INTO books VALUES (1);
             INSERT INTO highlights (book_id) VALUES (1), (1);",
        )
        .unwrap();
        c.execute_batch(SCHEMA_V9).unwrap();
        c
    }

    #[test]
    fn old_marks_are_read_one_and_new_ones_follow_the_current_read() {
        let c = db();
        let r = reads(&c, 1).unwrap();
        assert_eq!((r.current, r.reads.len(), r.reads[0].highlights), (1, 1, 2));
        assert_eq!(start(&c, 1).unwrap(), 2);
        // a second ask with nothing marked in read 2 makes no empty read 3
        assert_eq!(start(&c, 1).unwrap(), 2);
        c.execute("INSERT INTO highlights (book_id) VALUES (1)", []).unwrap();
        c.execute("INSERT INTO bookmarks (book_id) VALUES (1)", []).unwrap();
        let r = reads(&c, 1).unwrap();
        assert_eq!(r.current, 2);
        assert_eq!((r.reads[1].highlights, r.reads[1].bookmarks), (1, 1));
        assert_eq!(start(&c, 1).unwrap(), 3);
    }

    #[test]
    fn undo_of_a_status_puts_back_the_finished_day_and_drops_an_empty_new_read() {
        let c = db();
        c.execute_batch("ALTER TABLE books ADD COLUMN finished_at INTEGER; ALTER TABLE books ADD COLUMN read_status TEXT;").unwrap();
        c.execute("UPDATE books SET finished_at = 1000 WHERE id = 1", []).unwrap();
        let before = status_marks(&c, 1).unwrap();
        assert_eq!(before, StatusMarks { finished_at: Some(1000), read: 1 });
        // Re-reading: a new read, and Read again later sets a new day
        set_local_status(&c, 1, "RE_READING").unwrap();
        set_local_status(&c, 1, "READ").unwrap();
        assert_eq!(current(&c, 1), 2);
        put_status_marks(&c, 1, &before).unwrap();
        assert_eq!(status_marks(&c, 1).unwrap(), before);
        // a read that has marks by now stays
        set_local_status(&c, 1, "RE_READING").unwrap();
        c.execute("INSERT INTO highlights (book_id) VALUES (1)", []).unwrap();
        put_status_marks(&c, 1, &before).unwrap();
        assert_eq!(current(&c, 1), 2);
    }
}
