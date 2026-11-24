//! Pairing a phone with this PC: Settings shows a 6-digit code while "Pair a device" is open (a new code
//! each time, good for 5 minutes, one device per code). The phone sends it once and gets a token (32
//! random bytes, hex) that this PC keeps only as its SHA-256. Five wrong codes in a row close pairing for
//! a minute. A code that ran out, or no code showing, is told apart from a wrong one, so the phone can say
//! which (and neither counts as a wrong try: no code could have worked).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const CODE_LIFE_MS: i64 = 5 * 60 * 1000;
pub const MAX_WRONG: u32 = 5;
pub const LOCK_MS: i64 = 60 * 1000;

/// Schema 11: each book's place as a phone last sent it, when this PC last weighed a phone's place and
/// when this PC's own place was last chosen over a phone's; the paired devices.
pub const SCHEMA_V11: &str = "
ALTER TABLE books ADD COLUMN peer_place TEXT;
ALTER TABLE books ADD COLUMN peer_synced_at INTEGER;
ALTER TABLE books ADD COLUMN peer_served_at INTEGER;
CREATE TABLE IF NOT EXISTS peer_devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    paired_at INTEGER NOT NULL,
    seen_at INTEGER
);
";

#[derive(Default)]
pub struct Pairing {
    code: Option<(String, i64)>,
    wrong: u32,
    locked_until: i64,
}

#[derive(Debug, PartialEq)]
pub enum Try {
    Ok,
    /// A code is showing and this isn't it
    Wrong,
    /// The code shown ran out (5 minutes): a new one is needed
    Expired,
    /// No code is showing here (pairing closed, or its code already paired a device)
    Closed,
    Locked,
}

impl Try {
    /// The word a refusal carries (`reason` in the answer), for the phone to say what to do.
    pub fn reason(&self) -> &'static str {
        match self {
            Try::Ok => "ok",
            Try::Wrong => "wrong",
            Try::Expired => "expired",
            Try::Closed => "closed",
            Try::Locked => "locked",
        }
    }
}

impl Pairing {
    /// A new code (the old one stops working).
    pub fn open(&mut self, now: i64) -> String {
        let c = new_code();
        self.code = Some((c.clone(), now + CODE_LIFE_MS));
        c
    }
    pub fn close(&mut self) {
        self.code = None;
    }
    /// The code on screen and when it runs out, while it's good.
    pub fn current(&self, now: i64) -> Option<(String, i64)> {
        self.code.clone().filter(|(_, until)| *until > now)
    }
    pub fn locked(&self, now: i64) -> bool {
        now < self.locked_until
    }
    pub fn check(&mut self, code: &str, now: i64) -> Try {
        if self.locked(now) {
            return Try::Locked;
        }
        let Some((c, until)) = &self.code else { return Try::Closed };
        if *until <= now {
            return Try::Expired;
        }
        if same(c, code.trim()) {
            // one device per code
            self.code = None;
            self.wrong = 0;
            return Try::Ok;
        }
        self.wrong += 1;
        if self.wrong >= MAX_WRONG {
            self.wrong = 0;
            self.locked_until = now + LOCK_MS;
            return Try::Locked;
        }
        Try::Wrong
    }
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random(buf: &mut [u8]) {
    if getrandom::getrandom(buf).is_err() {
        // never expected; still never a fixed value
        use std::hash::{BuildHasher, Hasher};
        for chunk in buf.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_i64(crate::db::now());
            let b = h.finish().to_le_bytes();
            chunk.copy_from_slice(&b[..chunk.len()]);
        }
    }
}

pub fn new_code() -> String {
    let mut b = [0u8; 4];
    random(&mut b);
    format!("{:06}", u32::from_le_bytes(b) % 1_000_000)
}

pub fn new_token() -> String {
    let mut b = [0u8; 32];
    random(&mut b);
    hex(&b)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn hash_token(token: &str) -> String {
    hex(&Sha256::digest(token.trim().as_bytes()))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub name: String,
    pub paired_at: i64,
    pub seen_at: Option<i64>,
}

/// Pairs a device (pairing the same device again gives it a new token; the old one stops working).
pub fn add_device(conn: &Connection, device_id: &str, name: &str, token: &str, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO peer_devices (device_id, name, token_hash, paired_at, seen_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash,
            paired_at = excluded.paired_at, seen_at = excluded.seen_at",
        params![device_id, name, hash_token(token), now],
    )?;
    Ok(())
}

/// The paired device a token belongs to (and notes that it was seen).
pub fn device_for(conn: &Connection, token: &str, now: i64) -> Option<Device> {
    let h = hash_token(token);
    let d = conn
        .query_row("SELECT device_id, name, paired_at, seen_at FROM peer_devices WHERE token_hash = ?1", [&h], |r| {
            Ok(Device { device_id: r.get(0)?, name: r.get(1)?, paired_at: r.get(2)?, seen_at: r.get(3)? })
        })
        .optional()
        .ok()
        .flatten()?;
    let _ = conn.execute("UPDATE peer_devices SET seen_at = ?2 WHERE device_id = ?1", params![d.device_id, now]);
    Some(d)
}

pub fn devices(conn: &Connection) -> Vec<Device> {
    let Ok(mut st) = conn.prepare("SELECT device_id, name, paired_at, seen_at FROM peer_devices ORDER BY paired_at") else {
        return vec![];
    };
    let rows = st.query_map([], |r| Ok(Device { device_id: r.get(0)?, name: r.get(1)?, paired_at: r.get(2)?, seen_at: r.get(3)? }));
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

pub fn forget(conn: &Connection, device_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM peer_devices WHERE device_id = ?1", [device_id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn a_code_is_six_digits_and_works_once() {
        let mut p = Pairing::default();
        let c = p.open(NOW);
        assert_eq!(c.len(), 6);
        assert!(c.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(p.check(&c, NOW + 1000), Try::Ok);
        // one device per code: after it, no code is showing
        assert_eq!(p.check(&c, NOW + 2000), Try::Closed);
    }

    #[test]
    fn a_code_runs_out_after_five_minutes() {
        let mut p = Pairing::default();
        let c = p.open(NOW);
        assert!(p.current(NOW + CODE_LIFE_MS - 1).is_some());
        assert!(p.current(NOW + CODE_LIFE_MS).is_none());
        // the right code and any other: it ran out, said as such
        assert_eq!(p.check(&c, NOW + CODE_LIFE_MS + 1), Try::Expired);
        assert_eq!(p.check("123", NOW + CODE_LIFE_MS + 1), Try::Expired);
        // a new code works at once
        let c2 = p.open(NOW + CODE_LIFE_MS + 2);
        assert_eq!(p.check(&c2, NOW + CODE_LIFE_MS + 3), Try::Ok);
    }

    #[test]
    fn a_ran_out_code_doesnt_count_toward_the_lock() {
        let mut p = Pairing::default();
        p.open(NOW);
        for i in 0..10 {
            assert_eq!(p.check("000000", NOW + CODE_LIFE_MS + i), Try::Expired);
        }
        let c = p.open(NOW + CODE_LIFE_MS + 20);
        assert_eq!(p.check(&c, NOW + CODE_LIFE_MS + 21), Try::Ok);
    }

    #[test]
    fn closed_pairing_takes_no_code() {
        let mut p = Pairing::default();
        let c = p.open(NOW);
        p.close();
        assert_eq!(p.check(&c, NOW), Try::Closed);
        assert_eq!(Pairing::default().check("123456", NOW), Try::Closed);
    }

    #[test]
    fn five_wrong_codes_lock_for_a_minute() {
        let mut p = Pairing::default();
        let c = p.open(NOW);
        let wrong = if c == "000000" { "000001" } else { "000000" };
        for i in 0..4 {
            assert_eq!(p.check(wrong, NOW + i), Try::Wrong);
        }
        assert_eq!(p.check(wrong, NOW + 5), Try::Locked);
        // even the right code waits out the minute
        assert_eq!(p.check(&c, NOW + 10), Try::Locked);
        assert_eq!(p.check(&c, NOW + 5 + LOCK_MS), Try::Ok);
    }

    #[test]
    fn tokens_are_kept_hashed_and_forget_revokes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute_batch(SCHEMA_V11).unwrap();
        let t = new_token();
        assert_eq!(t.len(), 64);
        assert_ne!(t, new_token());
        add_device(&conn, "dev-1", "Pixel", &t, NOW).unwrap();
        let stored: String = conn.query_row("SELECT token_hash FROM peer_devices", [], |r| r.get(0)).unwrap();
        assert_ne!(stored, t);
        assert_eq!(device_for(&conn, &t, NOW).map(|d| d.name), Some("Pixel".into()));
        assert!(device_for(&conn, "nope", NOW).is_none());
        // pairing again replaces the token
        let t2 = new_token();
        add_device(&conn, "dev-1", "Pixel", &t2, NOW).unwrap();
        assert!(device_for(&conn, &t, NOW).is_none());
        assert!(device_for(&conn, &t2, NOW).is_some());
        forget(&conn, "dev-1").unwrap();
        assert!(device_for(&conn, &t2, NOW).is_none());
        assert!(devices(&conn).is_empty());
    }
}
