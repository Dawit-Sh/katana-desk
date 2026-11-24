//! Reading done on a paired device, for the reading dashboard's "time left at your pace": Katana sends its
//! reading sessions for this PC's books the way it sends them to Grimmory (`POST /api/v1/reading-sessions`:
//! the book, when it started and ended, how long, and the place at each end as a percentage). Each one adds
//! its seconds and how far it moved to the book's pace here (`dashboard::add_device_pace`), once: a session
//! sent again (an answer lost on the way) is known by its book, start and end. The device's minutes don't go
//! into this PC's Journal or reading days.

use rusqlite::{params, Connection};
use serde_json::Value;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS peer_sessions (
    book_id INTEGER NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY (book_id, start_at, end_at)
);
";

/// A reading session as Katana sends it.
#[derive(Debug, PartialEq)]
pub struct Session {
    pub book_id: i64,
    pub start_at: i64,
    pub end_at: i64,
    pub seconds: i64,
    /// Shares of the book (0..1), when known
    pub from: Option<f64>,
    pub to: Option<f64>,
}

fn time_of(v: &Value, key: &str) -> Option<i64> {
    let s = v.get(key)?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|t| t.timestamp_millis())
}

fn share_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64()).filter(|x| x.is_finite()).map(|p| (p / 100.0).clamp(0.0, 1.0))
}

/// The session in a request body (Grimmory's shape); `None` when it isn't one.
pub fn session_in(v: &Value) -> Option<Session> {
    let book_id = v.get("bookId")?.as_i64()?;
    let (start_at, end_at) = (time_of(v, "startTime")?, time_of(v, "endTime")?);
    if end_at < start_at {
        return None;
    }
    let seconds = v.get("durationSeconds").and_then(|x| x.as_i64()).unwrap_or((end_at - start_at) / 1000).max(0);
    Some(Session { book_id, start_at, end_at, seconds, from: share_of(v, "startProgress"), to: share_of(v, "endProgress") })
}

/// Adds `s` to its book's pace, once. True when it counted (new, and reading rather than a jump).
pub fn take(conn: &Connection, s: &Session, device_id: &str) -> rusqlite::Result<bool> {
    conn.execute_batch(SCHEMA)?;
    let new = conn.execute(
        "INSERT OR IGNORE INTO peer_sessions (book_id, start_at, end_at, device_id) VALUES (?1, ?2, ?3, ?4)",
        params![s.book_id, s.start_at, s.end_at, device_id],
    )? > 0;
    if !new {
        return Ok(false);
    }
    match (s.from, s.to) {
        (Some(from), Some(to)) => crate::dashboard::add_device_pace(conn, s.book_id, s.seconds, from, to),
        // without both places it can't tell how far it went: only remembered, so it isn't weighed again
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE books (id INTEGER PRIMARY KEY, fraction REAL);").unwrap();
        c.execute_batch(crate::dashboard::SCHEMA).unwrap();
        c
    }

    fn body(start: &str, end: &str, from: f64, to: f64) -> Value {
        json!({ "bookId": 2, "bookType": "EPUB", "startTime": start, "endTime": end, "durationSeconds": 1200,
                "startProgress": from, "endProgress": to, "progressDelta": to - from })
    }

    #[test]
    fn a_session_reads_as_katana_sends_it() {
        let s = session_in(&body("2026-11-24T09:00:00Z", "2026-11-24T09:20:00Z", 50.0, 58.5)).unwrap();
        assert_eq!(s.book_id, 2);
        assert_eq!(s.end_at - s.start_at, 1_200_000);
        assert_eq!(s.seconds, 1200);
        assert!((s.from.unwrap() - 0.5).abs() < 1e-9 && (s.to.unwrap() - 0.585).abs() < 1e-9);
        assert!(session_in(&json!({ "bookId": 2 })).is_none());
        assert!(session_in(&body("2026-11-24T09:20:00Z", "2026-11-24T09:00:00Z", 1.0, 2.0)).is_none());
    }

    #[test]
    fn each_session_counts_once() {
        let c = db();
        let s = session_in(&body("2026-11-24T09:00:00Z", "2026-11-24T09:20:00Z", 50.0, 58.0)).unwrap();
        assert!(take(&c, &s, "d1").unwrap());
        // sent again (an answer lost on the way): not counted twice
        assert!(!take(&c, &s, "d1").unwrap());
        let (secs, moved): (i64, f64) = c.query_row("SELECT seconds, moved FROM book_pace WHERE book_id = 2", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(secs, 1200);
        assert!((moved - 0.08).abs() < 1e-9);
        // a jump is remembered but counts nothing
        let mut quick = body("2026-11-24T10:00:00Z", "2026-11-24T10:00:10Z", 10.0, 90.0);
        quick["durationSeconds"] = json!(10);
        let jump = session_in(&quick).unwrap();
        assert!(!take(&c, &jump, "d1").unwrap());
        assert_eq!(c.query_row("SELECT COUNT(*) FROM peer_sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
    }
}
