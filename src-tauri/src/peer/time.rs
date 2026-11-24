//! Reading time both ways, counted once.
//!
//! Device -> PC: a paired device's session (already kept once in `peer_sessions`) also goes into this PC's
//! `reading_days` and `reading_log`, so the Journal, the analytics, the dashboard and the book's own time count
//! it. Each one is noted in `device_time` (by its session key) so it's never counted twice and never sent back.
//! PC -> device: `own_sessions` gives this PC's own reading per (day, hour, book), less the device time in it.

use chrono::{Local, LocalResult, NaiveDate, TimeZone, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS device_time (
    key TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    book_id INTEGER,
    day TEXT NOT NULL,
    hour INTEGER NOT NULL,
    seconds INTEGER NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_time_at ON device_time(day, hour, book_id);
";

const DAY_SECONDS: i64 = 86_400;

/// The seconds a device session may count: within its own span, not in the future, less any time the same
/// device already counted in those minutes (overlapping sessions).
fn countable(conn: &Connection, device_id: &str, start_at: i64, end_at: i64, seconds: i64, now_ms: i64) -> rusqlite::Result<i64> {
    let end_at = end_at.min(now_ms);
    if end_at <= start_at {
        return Ok(0);
    }
    let overlap: i64 = conn.query_row(
        "SELECT COALESCE(SUM(MAX(0, MIN(end_at, ?3) - MAX(start_at, ?2))), 0) FROM device_time WHERE device_id = ?1 AND seconds > 0",
        params![device_id, start_at, end_at],
        |r| r.get(0),
    )?;
    let span = (end_at - start_at - overlap).max(0) / 1000;
    Ok(seconds.clamp(0, DAY_SECONDS).min(span))
}

/// Count a device's session in this PC's Journal once. `book_id` is `None` when the book isn't on this PC: the time
/// then counts in the day's total only. Returns whether anything was counted.
pub fn count_device_session(
    conn: &Connection,
    device_id: &str,
    book_id: Option<i64>,
    start_at: i64,
    end_at: i64,
    seconds: i64,
) -> rusqlite::Result<bool> {
    conn.execute_batch(SCHEMA)?;
    let key = format!("{device_id}:{}:{start_at}:{end_at}", book_id.unwrap_or(0));
    let seen: Option<i64> = conn.query_row("SELECT 1 FROM device_time WHERE key = ?1", [&key], |r| r.get(0)).optional()?;
    if seen.is_some() {
        return Ok(false);
    }
    let secs = countable(conn, device_id, start_at, end_at, seconds, crate::db::now())?;
    let LocalResult::Single(at) = Local.timestamp_millis_opt(start_at) else { return Ok(false) };
    let (day, hour) = (at.format("%Y-%m-%d").to_string(), at.hour());
    conn.execute(
        "INSERT INTO device_time (key, device_id, book_id, day, hour, seconds, start_at, end_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![key, device_id, book_id, day, hour, secs, start_at, end_at],
    )?;
    if secs > 0 {
        crate::db::add_reading(conn, &day, hour, book_id, secs, 0)?;
    }
    Ok(secs > 0)
}

fn start_of(day: &str, hour: i64) -> Option<chrono::DateTime<Local>> {
    let d = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    let t = d.and_hms_opt(u32::try_from(hour).ok()?, 0, 0)?;
    Local.from_local_datetime(&t).earliest()
}

/// This PC's own reading per (day, hour, book) since a day (all when `None`), never a device's time. Each has a
/// stable id; its seconds grow while that hour goes on, so a device keeps the latest, never a sum.
pub fn own_sessions(conn: &Connection, desk_id: &str, since: Option<&str>) -> rusqlite::Result<Vec<Value>> {
    conn.execute_batch(SCHEMA)?;
    let mut st = conn.prepare(
        "SELECT l.day, l.hour, l.book_id, b.title, b.format,
                l.seconds - COALESCE((SELECT SUM(t.seconds) FROM device_time t
                    WHERE t.day = l.day AND t.hour = l.hour AND t.book_id = l.book_id), 0)
         FROM reading_log l JOIN books b ON b.id = l.book_id
         WHERE l.day >= ?1 ORDER BY l.day, l.hour",
    )?;
    let rows = st.query_map([since.unwrap_or("")], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?, r.get::<_, i64>(5)?))
    })?;
    let mut out = vec![];
    for (day, hour, book, title, format, seconds) in rows.flatten() {
        let Some(start) = start_of(&day, hour) else { continue };
        let seconds = seconds.min(3600);
        if seconds <= 0 {
            continue;
        }
        let end = start + chrono::Duration::seconds(seconds);
        out.push(json!({
            "id": format!("desk:{desk_id}:{day}:{hour}:{book}"),
            "bookId": book,
            "title": title.unwrap_or_default(),
            "format": format.unwrap_or_default(),
            "startTime": start.to_rfc3339(),
            "endTime": end.to_rfc3339(),
            "seconds": seconds,
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, format TEXT);
             CREATE TABLE reading_days (day TEXT PRIMARY KEY, seconds INTEGER NOT NULL DEFAULT 0);
             INSERT INTO books VALUES (1, 'One', 'EPUB');",
        )
        .unwrap();
        c.execute_batch(crate::db::SCHEMA_V7_LOG).unwrap();
        c
    }

    fn ms(day: &str, h: u32, m: u32) -> i64 {
        let t = NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap().and_hms_opt(h, m, 0).unwrap();
        Local.from_local_datetime(&t).earliest().unwrap().timestamp_millis()
    }

    fn total(c: &Connection) -> i64 {
        c.query_row("SELECT COALESCE(SUM(seconds), 0) FROM reading_days", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_device_session_counts_once_and_is_never_sent_back() {
        let c = db();
        let (a, b) = (ms("2026-11-20", 9, 0), ms("2026-11-20", 9, 20));
        assert!(count_device_session(&c, "dev", Some(1), a, b, 1200).unwrap());
        assert!(!count_device_session(&c, "dev", Some(1), a, b, 1200).unwrap());
        assert_eq!(total(&c), 1200);
        // overlapping the same device's minutes counts only the new part
        assert!(count_device_session(&c, "dev", Some(1), ms("2026-11-20", 9, 10), ms("2026-11-20", 9, 30), 1200).unwrap());
        assert_eq!(total(&c), 1800);
        // this PC reads 10 minutes in the same hour: only those go to the device
        crate::db::add_reading(&c, "2026-11-20", 9, Some(1), 600, 3).unwrap();
        let own = own_sessions(&c, "pc", None).unwrap();
        assert_eq!(own.len(), 1);
        assert_eq!(own[0]["seconds"], 600);
        assert_eq!(own[0]["id"], "desk:pc:2026-11-20:9:1");
    }

    #[test]
    fn bad_sessions_count_nothing_and_unknown_books_count_in_the_day_only() {
        let c = db();
        let a = ms("2026-11-20", 10, 0);
        assert!(!count_device_session(&c, "dev", Some(1), a, a, 60).unwrap());
        assert!(!count_device_session(&c, "dev", Some(1), a, a + 60_000, -5).unwrap());
        let future = crate::db::now() + 3_600_000;
        assert!(!count_device_session(&c, "dev", Some(1), future, future + 60_000, 60).unwrap());
        assert_eq!(total(&c), 0);
        assert!(count_device_session(&c, "dev", None, a, a + 300_000, 300).unwrap());
        assert_eq!(total(&c), 300);
        let logged: i64 = c.query_row("SELECT COUNT(*) FROM reading_log", [], |r| r.get(0)).unwrap();
        assert_eq!(logged, 0);
        assert!(own_sessions(&c, "pc", None).unwrap().is_empty());
    }
}
