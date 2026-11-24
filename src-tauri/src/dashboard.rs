//! Local's reading dashboard (the band on top of Local, 2026-11-24): what it needs beyond the library list.
//! For each book that's started and not finished: its newest highlight or note, the time left at the pace
//! it's read on this PC, and whether its place came in from a paired device (Sync on this Wi-Fi). Also the
//! books set aside and the finished ones (for "9 of 75 read" and "Finished here lately").
//!
//! The pace: every reading tick (`add_reading`) adds its seconds and how far the place moved since the last
//! tick. A jump (contents, search, a place from Grimmory or a paired device, going back) counts neither.
//! The tables are made on every start (`CREATE ... IF NOT EXISTS`), so they need no schema version.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS book_pace (
    book_id INTEGER PRIMARY KEY,
    seconds INTEGER NOT NULL DEFAULT 0,
    moved REAL NOT NULL DEFAULT 0,
    last_fraction REAL
);
CREATE TABLE IF NOT EXISTS set_aside (
    book_id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL
);
";

/// Time left shows once a book has this much reading here, and has moved this far in it.
pub const PACE_MIN_SECONDS: i64 = 30 * 60;
pub const PACE_MIN_MOVED: f64 = 0.01;

/// The most a tick can move the place and still be reading: 3% of the book, or 0.2% a second.
fn max_move(seconds: i64) -> f64 {
    (seconds as f64 * 0.002).max(0.03)
}

/// One reading tick of `seconds` in a book (called with every `add_reading`).
pub fn add_pace(conn: &Connection, book_id: i64, seconds: i64) -> rusqlite::Result<()> {
    let fraction: Option<f64> = conn
        .query_row("SELECT fraction FROM books WHERE id = ?1", [book_id], |r| r.get(0))
        .optional()?
        .flatten();
    let Some(f) = fraction else { return Ok(()) };
    let last: Option<Option<f64>> =
        conn.query_row("SELECT last_fraction FROM book_pace WHERE book_id = ?1", [book_id], |r| r.get(0)).optional()?;
    let (secs, moved) = match last.flatten() {
        Some(lf) if f >= lf && f - lf <= max_move(seconds) => (seconds.max(0), f - lf),
        // the first tick only remembers where it is; a jump counts nothing
        _ => (0, 0.0),
    };
    conn.execute(
        "INSERT INTO book_pace (book_id, seconds, moved, last_fraction) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET seconds = seconds + excluded.seconds, moved = moved + excluded.moved,
            last_fraction = excluded.last_fraction",
        params![book_id, secs, moved, f],
    )?;
    Ok(())
}

/// Reading done on a paired device (Sync on this Wi-Fi): a session of `seconds` that moved the place from
/// `from` to `to` (shares of the book) adds to the book's pace here by the same rule as a tick here (going
/// back, or a move over `max_move`, counts nothing). This PC's own last tick (`last_fraction`) stays as it
/// was. True when it counted.
pub fn add_device_pace(conn: &Connection, book_id: i64, seconds: i64, from: f64, to: f64) -> rusqlite::Result<bool> {
    if seconds <= 0 || !from.is_finite() || !to.is_finite() || to < from || to - from > max_move(seconds) {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO book_pace (book_id, seconds, moved, last_fraction) VALUES (?1, ?2, ?3, NULL)
         ON CONFLICT(book_id) DO UPDATE SET seconds = seconds + excluded.seconds, moved = moved + excluded.moved",
        params![book_id, seconds, to - from],
    )?;
    Ok(true)
}

/// Seconds left at this book's pace here, when there's enough reading to tell.
pub fn seconds_left(fraction: f64, seconds: i64, moved: f64) -> Option<i64> {
    if seconds < PACE_MIN_SECONDS || moved < PACE_MIN_MOVED || fraction >= 1.0 {
        return None;
    }
    Some(((1.0 - fraction.max(0.0)) * seconds as f64 / moved).round() as i64)
}

/// Takes a book off the dashboard until it's opened again (`on`), or puts it back.
pub fn set_aside(conn: &Connection, book_id: i64, on: bool, now: i64) -> rusqlite::Result<()> {
    if on {
        conn.execute(
            "INSERT INTO set_aside (book_id, at) VALUES (?1, ?2) ON CONFLICT(book_id) DO UPDATE SET at = excluded.at",
            params![book_id, now],
        )?;
    } else {
        conn.execute("DELETE FROM set_aside WHERE book_id = ?1", [book_id])?;
    }
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub text: String,
    pub note: Option<String>,
    pub chapter: Option<String>,
    pub at: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Extra {
    pub id: i64,
    pub mark: Option<Mark>,
    pub secs_left: Option<i64>,
    /// the paired device whose place this is (the book was last read there)
    pub from_device: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub books: Vec<Extra>,
    /// set aside and not opened since
    pub aside: Vec<i64>,
    /// finished books and when: [id, ms] (0 when the time isn't known)
    pub finished: Vec<(i64, i64)>,
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

pub fn dashboard(conn: &Connection) -> rusqlite::Result<Dashboard> {
    // with one paired device (the usual case) this is its name; with several, the one heard from last
    let device: Option<String> = if has_table(conn, "peer_devices") {
        conn.query_row("SELECT name FROM peer_devices ORDER BY COALESCE(seen_at, paired_at) DESC LIMIT 1", [], |r| r.get(0))
            .optional()?
    } else {
        None
    };
    let peer_cols = has_table(conn, "peer_devices");
    let sql = format!(
        "SELECT b.id, b.fraction, COALESCE(p.seconds, 0), COALESCE(p.moved, 0), {}
         FROM books b LEFT JOIN book_pace p ON p.book_id = b.id
         WHERE COALESCE(b.missing, 0) = 0 AND b.fraction > 0.004 AND b.fraction < 0.995",
        if peer_cols { "b.peer_synced_at IS NOT NULL AND b.place_at = b.peer_synced_at" } else { "0" }
    );
    let mut st = conn.prepare(&sql)?;
    let rows: Vec<(i64, f64, i64, f64, bool)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0)))?
        .collect::<Result<_, _>>()?;
    let mut mark_st = conn.prepare(
        "SELECT text, note, chapter, MAX(created_at, updated_at) AS at FROM highlights
         WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY at DESC LIMIT 1",
    )?;
    let mut books = Vec::with_capacity(rows.len());
    for (id, fraction, seconds, moved, from_peer) in rows {
        let mark = mark_st
            .query_row([id], |r| {
                Ok(Mark { text: r.get(0)?, note: r.get::<_, Option<String>>(1)?.filter(|n| !n.trim().is_empty()), chapter: r.get(2)?, at: r.get(3)? })
            })
            .optional()?;
        books.push(Extra {
            id,
            mark,
            secs_left: seconds_left(fraction, seconds, moved),
            from_device: if from_peer { device.clone() } else { None },
        });
    }
    // off the dashboard: set aside and not opened since, or given up on (Abandoned, Won't read) here or on Grimmory
    let aside = conn
        .prepare(
            "SELECT a.book_id FROM set_aside a JOIN books b ON b.id = a.book_id WHERE b.opened_at IS NULL OR a.at >= b.opened_at
             UNION
             SELECT b.id FROM books b WHERE COALESCE(b.read_status, '') IN ('ABANDONED', 'WONT_READ')
                OR (b.grimmory_id IS NOT NULL AND EXISTS
                    (SELECT 1 FROM gbooks g WHERE g.id = b.grimmory_id AND g.read_status IN ('ABANDONED', 'WONT_READ')))
             ORDER BY 1",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let finished = conn
        .prepare("SELECT id, COALESCE(finished_at, 0) FROM books WHERE COALESCE(missing, 0) = 0 AND (finished_at IS NOT NULL OR fraction >= 0.995)")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(Dashboard { books, aside, finished })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, fraction REAL, opened_at INTEGER, finished_at INTEGER, missing INTEGER,
                place_at INTEGER, peer_synced_at INTEGER, read_status TEXT, grimmory_id INTEGER);
             CREATE TABLE gbooks (id INTEGER PRIMARY KEY, read_status TEXT);
             CREATE TABLE highlights (id INTEGER PRIMARY KEY, book_id INTEGER, text TEXT, note TEXT, chapter TEXT,
                created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
             CREATE TABLE peer_devices (device_id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT, paired_at INTEGER NOT NULL, seen_at INTEGER);",
        )
        .unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }
    fn at(c: &Connection, id: i64, f: f64) {
        c.execute("UPDATE books SET fraction = ?2 WHERE id = ?1", params![id, f]).unwrap();
    }
    fn pace(c: &Connection, id: i64) -> (i64, f64) {
        c.query_row("SELECT seconds, moved FROM book_pace WHERE book_id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    }

    #[test]
    fn reading_on_a_paired_device_adds_to_the_pace_here() {
        let c = db();
        c.execute("INSERT INTO books (id, fraction) VALUES (1, 0.10)", []).unwrap();
        // this PC's own tick remembers where it is
        add_pace(&c, 1, 30).unwrap();
        // 20 minutes on the device, 5% further
        assert!(add_device_pace(&c, 1, 1200, 0.10, 0.15).unwrap());
        let (s, m) = pace(&c, 1);
        assert_eq!(s, 1200);
        assert!((m - 0.05).abs() < 1e-9);
        // going back, a jump, or no time: nothing
        assert!(!add_device_pace(&c, 1, 600, 0.30, 0.20).unwrap());
        assert!(!add_device_pace(&c, 1, 10, 0.20, 0.60).unwrap());
        assert!(!add_device_pace(&c, 1, 0, 0.20, 0.21).unwrap());
        assert_eq!(pace(&c, 1).0, 1200);
        // this PC's last tick is untouched, so its next tick still counts from there
        let last: Option<f64> = c.query_row("SELECT last_fraction FROM book_pace WHERE book_id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(last, Some(0.10));
        // a book read only on the device starts its pace from that
        c.execute("INSERT INTO books (id, fraction) VALUES (2, 0.0)", []).unwrap();
        assert!(add_device_pace(&c, 2, 900, 0.0, 0.04).unwrap());
        assert_eq!(pace(&c, 2).0, 900);
    }

    #[test]
    fn pace_counts_reading_and_skips_jumps() {
        let c = db();
        c.execute("INSERT INTO books (id, fraction) VALUES (1, 0.10)", []).unwrap();
        add_pace(&c, 1, 60).unwrap(); // first tick: only remembers
        assert_eq!(pace(&c, 1), (0, 0.0));
        at(&c, 1, 0.11);
        add_pace(&c, 1, 60).unwrap();
        let (s, m) = pace(&c, 1);
        assert_eq!(s, 60);
        assert!((m - 0.01).abs() < 1e-9);
        // a jump through the contents: neither the time nor the move counts
        at(&c, 1, 0.40);
        add_pace(&c, 1, 60).unwrap();
        assert_eq!(pace(&c, 1).0, 60);
        // going back counts nothing either, and reading on from there counts again
        at(&c, 1, 0.38);
        add_pace(&c, 1, 30).unwrap();
        at(&c, 1, 0.385);
        add_pace(&c, 1, 30).unwrap();
        let (s, m) = pace(&c, 1);
        assert_eq!(s, 90);
        assert!((m - 0.015).abs() < 1e-9);
    }

    #[test]
    fn seconds_left_waits_for_enough_reading() {
        assert_eq!(seconds_left(0.5, 600, 0.05), None);
        assert_eq!(seconds_left(0.5, 3600, 0.005), None);
        // an hour moved 10%: half the book left is five hours
        assert_eq!(seconds_left(0.5, 3600, 0.10), Some(18000));
    }

    #[test]
    fn dashboard_marks_aside_finished_and_devices() {
        let c = db();
        c.execute_batch(
            "INSERT INTO books (id, fraction, opened_at, place_at, peer_synced_at) VALUES
                (1, 0.41, 100, 100, NULL),   -- read here
                (2, 0.68, 200, 200, 200),    -- its place came from the paired device
                (3, 0.30, 50, 300, 200),     -- read here after the device's place
                (4, 1.0, 10, NULL, NULL),
                (5, 0.20, 400, NULL, NULL),
                (6, 0.50, 400, NULL, NULL),  -- Abandoned here
                (7, 0.50, 400, NULL, NULL);  -- Won't read on Grimmory
             UPDATE books SET finished_at = 999 WHERE id = 4;
             UPDATE books SET read_status = 'ABANDONED' WHERE id = 6;
             UPDATE books SET grimmory_id = 70 WHERE id = 7;
             INSERT INTO gbooks (id, read_status) VALUES (70, 'WONT_READ');
             INSERT INTO peer_devices (device_id, name, paired_at, seen_at) VALUES ('a', 'Old one', 1, 5), ('b', 'My reader', 2, 50);
             INSERT INTO highlights (book_id, text, note, chapter, created_at, updated_at) VALUES
                (1, 'first', NULL, 'One', 10, 10), (1, 'second', 'go back here', 'Eight', 20, 20), (1, 'gone', NULL, NULL, 30, 30);
             UPDATE highlights SET deleted_at = 40 WHERE text = 'gone';",
        )
        .unwrap();
        set_aside(&c, 3, true, 500).unwrap(); // set aside after it was last opened
        set_aside(&c, 5, true, 300).unwrap(); // opened again since (400): back on the dashboard
        let d = dashboard(&c).unwrap();
        let by = |id: i64| d.books.iter().find(|b| b.id == id).unwrap();
        assert_eq!(d.books.len(), 6);
        assert_eq!(by(1).from_device, None);
        assert_eq!(by(2).from_device.as_deref(), Some("My reader"));
        assert_eq!(by(3).from_device, None);
        let m = by(1).mark.as_ref().unwrap();
        assert_eq!((m.text.as_str(), m.note.as_deref(), m.chapter.as_deref()), ("second", Some("go back here"), Some("Eight")));
        assert_eq!(d.aside, vec![3, 6, 7]);
        assert_eq!(d.finished, vec![(4, 999)]);
        set_aside(&c, 3, false, 600).unwrap();
        assert_eq!(dashboard(&c).unwrap().aside, vec![6, 7]);
    }
}
