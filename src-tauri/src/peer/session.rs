//! A phone's sync as this PC sees it: when it starts and ends, and what came in meanwhile, so both apps
//! can show "syncing" and "synced". Katana says when it starts and ends (`/katana-sync/v1/sync`); an
//! older Katana that doesn't is seen by its requests: the first one starts a sync, a few quiet seconds end
//! it. A Katana that went quiet without saying it ended (Wi-Fi gone) is ended after a minute.

use serde::Serialize;
use std::collections::HashMap;

/// Quiet this long after a request ends a sync the phone didn't start out loud.
pub const QUIET_MS: i64 = 4_000;
/// Quiet this long ends any sync (the phone went away without saying so).
pub const GONE_MS: i64 = 60_000;

/// What a phone changed here during one sync (counted from its requests that went through).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub places: u32,
    pub statuses: u32,
    pub highlights: u32,
    pub bookmarks: u32,
    /// Books this PC sent the phone (their files)
    pub books_sent: u32,
}

/// What a request did, for the counts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Look,
    Place,
    Status,
    Highlight,
    Bookmark,
    BookSent,
}

impl Kind {
    /// What a request (method and path, as routed) does here.
    pub fn of(method: &str, segs: &[&str]) -> Kind {
        match (method, segs) {
            ("GET", ["api", "v1", "books", _, "content"]) => Kind::BookSent,
            ("GET", _) => Kind::Look,
            (_, ["api", "v1", "books", "progress"]) => Kind::Place,
            (_, ["api", "v1", "books", "status"]) | (_, ["api", "v1", "books", "reset-progress"]) => Kind::Status,
            (_, ["api", "v1", "annotations", ..]) => Kind::Highlight,
            (_, ["api", "v1", "bookmarks", ..]) => Kind::Bookmark,
            _ => Kind::Look,
        }
    }
}

/// What the phone said about its sync when it ended (its own side).
#[derive(Clone, Debug, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhoneSide {
    /// Books on both sides
    pub books: Option<u32>,
    /// Whether anything changed on the phone
    pub changed: Option<bool>,
    /// Why it didn't finish, in the phone's words
    pub problem: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sync {
    pub device_id: String,
    pub name: String,
    pub since: i64,
    /// Last request
    pub at: i64,
    /// Whether the phone said it started (then it says when it ends)
    #[serde(skip)]
    pub said: bool,
    pub got: Changes,
}

/// A sync that ended.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ended {
    pub device_id: String,
    pub name: String,
    pub since: i64,
    pub at: i64,
    pub got: Changes,
    pub phone: PhoneSide,
    /// Ended by going quiet, not by the phone saying so
    pub quiet: bool,
}

#[derive(Default)]
pub struct Syncs {
    open: HashMap<String, Sync>,
    pub last: Option<Ended>,
}

impl Syncs {
    pub fn open(&self) -> Vec<Sync> {
        let mut v: Vec<Sync> = self.open.values().cloned().collect();
        v.sort_by_key(|s| s.since);
        v
    }

    /// A request from a paired device that went through. A sync that started: `Some`.
    pub fn touch(&mut self, device_id: &str, name: &str, kind: Kind, now: i64) -> Option<Sync> {
        let mut started = None;
        let s = self.open.entry(device_id.to_string()).or_insert_with(|| {
            let s = Sync { device_id: device_id.into(), name: name.into(), since: now, at: now, said: false, got: Changes::default() };
            started = Some(s.clone());
            s
        });
        s.at = now;
        match kind {
            Kind::Look => {}
            Kind::Place => s.got.places += 1,
            Kind::Status => s.got.statuses += 1,
            Kind::Highlight => s.got.highlights += 1,
            Kind::Bookmark => s.got.bookmarks += 1,
            Kind::BookSent => s.got.books_sent += 1,
        }
        started
    }

    /// The phone says its sync starts. A sync already going on (its requests came first) carries on.
    pub fn start(&mut self, device_id: &str, name: &str, now: i64) -> Option<Sync> {
        let started = self.touch(device_id, name, Kind::Look, now);
        if let Some(s) = self.open.get_mut(device_id) {
            s.said = true;
        }
        started
    }

    /// The phone says its sync ended.
    pub fn end(&mut self, device_id: &str, phone: PhoneSide, now: i64) -> Option<Ended> {
        let s = self.open.remove(device_id)?;
        let e = Ended { device_id: s.device_id, name: s.name, since: s.since, at: now, got: s.got, phone, quiet: false };
        self.last = Some(e.clone());
        Some(e)
    }

    /// Syncs that went quiet: ended now.
    pub fn expire(&mut self, now: i64) -> Vec<Ended> {
        let gone: Vec<String> = self
            .open
            .values()
            .filter(|s| now - s.at >= if s.said { GONE_MS } else { QUIET_MS })
            .map(|s| s.device_id.clone())
            .collect();
        let mut out = vec![];
        for id in gone {
            if let Some(s) = self.open.remove(&id) {
                let e = Ended { device_id: s.device_id, name: s.name, since: s.since, at: s.at, got: s.got, phone: PhoneSide::default(), quiet: true };
                self.last = Some(e.clone());
                out.push(e);
            }
        }
        out
    }

    pub fn forget(&mut self, device_id: &str) {
        self.open.remove(device_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn requests_are_counted_by_what_they_do() {
        assert_eq!(Kind::of("POST", &["api", "v1", "books", "progress"]), Kind::Place);
        assert_eq!(Kind::of("POST", &["api", "v1", "books", "status"]), Kind::Status);
        assert_eq!(Kind::of("POST", &["api", "v1", "books", "reset-progress"]), Kind::Status);
        assert_eq!(Kind::of("PUT", &["api", "v1", "annotations", "4"]), Kind::Highlight);
        assert_eq!(Kind::of("DELETE", &["api", "v1", "bookmarks", "9"]), Kind::Bookmark);
        assert_eq!(Kind::of("GET", &["api", "v1", "books", "3", "content"]), Kind::BookSent);
        assert_eq!(Kind::of("GET", &["api", "v1", "annotations", "book", "3"]), Kind::Look);
        assert_eq!(Kind::of("POST", &["katana-sync", "v1", "match"]), Kind::Look);
    }

    #[test]
    fn a_said_sync_runs_until_the_phone_ends_it() {
        let mut s = Syncs::default();
        assert!(s.start("d1", "Pixel", NOW).is_some());
        assert!(s.touch("d1", "Pixel", Kind::Place, NOW + 100).is_none());
        s.touch("d1", "Pixel", Kind::Highlight, NOW + 200);
        // quiet for a while: still on (the phone said it started, so it says when it ends)
        assert!(s.expire(NOW + 200 + QUIET_MS + 1).is_empty());
        assert_eq!(s.open().len(), 1);
        let e = s.end("d1", PhoneSide { books: Some(2), changed: Some(true), problem: None }, NOW + 9000).unwrap();
        assert_eq!(e.got, Changes { places: 1, highlights: 1, ..Changes::default() });
        assert!(!e.quiet);
        assert_eq!(e.since, NOW);
        assert!(s.open().is_empty());
        assert_eq!(s.last.as_ref().map(|l| l.at), Some(NOW + 9000));
        // ending again: nothing
        assert!(s.end("d1", PhoneSide::default(), NOW + 9001).is_none());
    }

    #[test]
    fn an_older_katana_is_seen_by_its_requests() {
        let mut s = Syncs::default();
        assert!(s.touch("d1", "Fire", Kind::Look, NOW).is_some());
        s.touch("d1", "Fire", Kind::Bookmark, NOW + 500);
        assert!(s.expire(NOW + 500 + QUIET_MS - 1).is_empty());
        let ended = s.expire(NOW + 500 + QUIET_MS);
        assert_eq!(ended.len(), 1);
        assert!(ended[0].quiet);
        assert_eq!(ended[0].got.bookmarks, 1);
        // its end is its last request
        assert_eq!(ended[0].at, NOW + 500);
    }

    #[test]
    fn a_phone_gone_quiet_is_ended_after_a_minute() {
        let mut s = Syncs::default();
        s.start("d1", "Pixel", NOW);
        assert!(s.expire(NOW + GONE_MS - 1).is_empty());
        assert_eq!(s.expire(NOW + GONE_MS).len(), 1);
    }

    #[test]
    fn two_phones_sync_apart() {
        let mut s = Syncs::default();
        s.start("d1", "Pixel", NOW);
        s.start("d2", "Fire", NOW + 10);
        s.touch("d2", "Fire", Kind::Place, NOW + 20);
        let e = s.end("d1", PhoneSide::default(), NOW + 30).unwrap();
        assert_eq!(e.got, Changes::default());
        assert_eq!(s.open().len(), 1);
        assert_eq!(s.open()[0].got.places, 1);
    }
}
