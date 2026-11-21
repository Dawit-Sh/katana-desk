//! A phone's reading place. Katana on the phone talks to this PC as it talks to Grimmory, so this PC is
//! the server: what it answers for a book is the newest of its own place and the last place a phone
//! sent (Grimmory keeps the last push). A place that comes in is the book's **peer place**; it never goes
//! straight over this PC's place: `grimmory::place::decide` weighs it like a Grimmory place (newer wins,
//! a place read here in the last 2 minutes keeps its ground, going back and any move of an open book
//! are asked first). The phone's own clock never counts: a place is stamped with this PC's clock when it
//! lands, as Grimmory stamps its own.

use crate::grimmory::place::{decide, Decision, LocalPlace, Seen, ServerPlace, FUTURE_LIMIT_MS};
use serde::{Deserialize, Serialize};

/// The place a phone last sent for a book (kept in `books.peer_place`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeerPlace {
    /// An EPUB CFI, or a PDF's or comic's page from 1 (as the page reader keeps it)
    pub cfi: Option<String>,
    pub href: Option<String>,
    /// 0..1
    pub fraction: Option<f64>,
    pub page: Option<i64>,
    /// When it landed here (this PC's clock)
    pub at: i64,
}

impl PeerPlace {
    pub fn has_place(&self) -> bool {
        self.cfi.is_some() || self.page.is_some() || self.fraction.unwrap_or(0.0) > 0.0
    }
    pub fn server(&self) -> ServerPlace {
        ServerPlace {
            cfi: self.cfi.clone(),
            href: self.href.clone(),
            fraction: self.fraction,
            page: self.page,
            at: Some(self.at),
            zoneless: false,
        }
    }
}

/// This PC's own place for a book, as `books` keeps it.
#[derive(Clone, Debug, Default)]
pub struct DeskPlace {
    pub location: Option<String>,
    pub fraction: Option<f64>,
    pub href: Option<String>,
    /// when it was read here (`place_at`)
    pub place_at: Option<i64>,
    /// when it was last chosen over a phone's (`peer_served_at`)
    pub served_at: Option<i64>,
    /// when a phone's place was last weighed (`peer_synced_at`)
    pub synced_at: Option<i64>,
}

impl DeskPlace {
    pub fn has_place(&self) -> bool {
        self.location.is_some() || self.fraction.unwrap_or(0.0) > 0.0
    }
    /// When this PC's place became the server copy.
    pub fn stamp(&self) -> Option<i64> {
        match (self.place_at, self.served_at) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        }
    }
    /// `pending`: read here since a phone's place was last weighed. A time more than a day ahead of this
    /// PC's clock doesn't count as a read (a clock gone wrong).
    pub fn local(&self, now: i64) -> LocalPlace {
        let at = self.place_at.filter(|a| *a <= now + FUTURE_LIMIT_MS);
        LocalPlace {
            cfi: self.location.clone(),
            fraction: self.fraction,
            pending: at.map_or(false, |a| a > self.synced_at.unwrap_or(0)),
            at,
        }
    }
}

/// What this PC answers as the book's place: a phone's place while it's the newest (until this PC reads
/// on, or its reader says "stay"), otherwise this PC's own. `None`: unread.
#[derive(Clone, Debug, PartialEq)]
pub struct Served {
    pub cfi: Option<String>,
    pub href: Option<String>,
    pub fraction: Option<f64>,
    pub page: Option<i64>,
    pub at: Option<i64>,
    pub from_peer: bool,
}

pub fn served(desk: &DeskPlace, peer: Option<&PeerPlace>) -> Option<Served> {
    if let Some(p) = peer.filter(|p| p.has_place()) {
        if !desk.has_place() || p.at > desk.stamp().unwrap_or(0) {
            return Some(Served { cfi: p.cfi.clone(), href: p.href.clone(), fraction: p.fraction, page: p.page, at: Some(p.at), from_peer: true });
        }
    }
    if !desk.has_place() {
        return None;
    }
    let page = desk.location.as_deref().and_then(|l| l.parse::<i64>().ok()).filter(|n| *n >= 1);
    Some(Served {
        cfi: desk.location.clone(),
        href: desk.href.clone(),
        fraction: desk.fraction,
        page,
        at: desk.stamp(),
        from_peer: false,
    })
}

/// What to do with a place a phone just sent.
pub fn weigh(desk: &DeskPlace, incoming: &PeerPlace, last: Option<&PeerPlace>, now: i64) -> Decision {
    let seen = last.map(|p| Seen { cfi: p.cfi.clone(), fraction: p.fraction });
    let local = desk.local(now);
    decide(Some(&local), Some(&incoming.server()), seen.as_ref(), now)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const MIN: i64 = 60_000;

    fn desk(cfi: &str, f: f64, place_at: i64, synced_at: Option<i64>) -> DeskPlace {
        DeskPlace { location: Some(cfi.into()), fraction: Some(f), href: None, place_at: Some(place_at), served_at: None, synced_at }
    }
    fn phone(cfi: &str, f: f64, at: i64) -> PeerPlace {
        PeerPlace { cfi: Some(cfi.into()), href: None, fraction: Some(f), page: None, at }
    }

    #[test]
    fn a_phone_that_read_further_moves_this_pc_on() {
        // read here an hour ago, the phone read on since
        let d = desk("a", 0.2, NOW - 60 * MIN, Some(NOW - 50 * MIN));
        let last = phone("a", 0.2, NOW - 50 * MIN);
        assert_eq!(weigh(&d, &phone("b", 0.4, NOW), Some(&last), NOW), Decision::Apply { use_cfi: true });
        // a book never read here takes the phone's place
        assert_eq!(weigh(&DeskPlace::default(), &phone("b", 0.4, NOW), None, NOW), Decision::Apply { use_cfi: true });
    }

    #[test]
    fn a_place_read_here_in_the_last_two_minutes_keeps_its_ground() {
        let d = desk("c", 0.3, NOW - MIN, Some(NOW - 30 * MIN));
        let last = phone("a", 0.2, NOW - 30 * MIN);
        assert_eq!(weigh(&d, &phone("b", 0.35, NOW), Some(&last), NOW), Decision::Push);
        // read here 3 minutes ago: the phone's newer place wins
        let d = desk("c", 0.3, NOW - 3 * MIN, Some(NOW - 30 * MIN));
        assert_eq!(weigh(&d, &phone("b", 0.35, NOW), Some(&last), NOW), Decision::Apply { use_cfi: true });
    }

    #[test]
    fn a_phone_behind_this_pc_is_asked_about() {
        let d = desk("c", 0.6, NOW - 60 * MIN, Some(NOW - 50 * MIN));
        let last = phone("c", 0.6, NOW - 50 * MIN);
        assert_eq!(weigh(&d, &phone("b", 0.1, NOW), Some(&last), NOW), Decision::Offer { use_cfi: true });
    }

    #[test]
    fn a_pc_time_more_than_a_day_ahead_does_not_count() {
        // this PC's place carries a time a week ahead (a clock gone wrong): not a read that keeps its ground
        let d = desk("c", 0.3, NOW + 7 * 24 * 60 * MIN, Some(NOW - 30 * MIN));
        let last = phone("a", 0.2, NOW - 30 * MIN);
        assert_eq!(weigh(&d, &phone("b", 0.35, NOW), Some(&last), NOW), Decision::Apply { use_cfi: true });
    }

    #[test]
    fn the_same_place_again_is_not_news() {
        let d = desk("c", 0.3, NOW - 60 * MIN, Some(NOW - 50 * MIN));
        assert_eq!(weigh(&d, &phone("c", 0.3, NOW), None, NOW), Decision::Keep);
    }

    #[test]
    fn the_server_copy_is_the_newest_of_the_two() {
        let mut d = desk("c", 0.3, NOW - 10 * MIN, None);
        let p = phone("b", 0.5, NOW - MIN);
        // the phone's place landed after this PC's last read: it's what a phone sees
        let s = served(&d, Some(&p)).unwrap();
        assert!(s.from_peer);
        assert_eq!(s.cfi.as_deref(), Some("b"));
        // this PC's reader said "stay" (or this PC won): its place is the copy now
        d.served_at = Some(NOW);
        let s = served(&d, Some(&p)).unwrap();
        assert!(!s.from_peer);
        assert_eq!((s.cfi.as_deref(), s.at), (Some("c"), Some(NOW)));
        // read on here: this PC's place
        let d = desk("d", 0.6, NOW, None);
        assert!(!served(&d, Some(&p)).unwrap().from_peer);
        // nothing anywhere: unread
        assert_eq!(served(&DeskPlace::default(), None), None);
        // a PDF's page
        let d = desk("12", 0.1, NOW, None);
        assert_eq!(served(&d, None).unwrap().page, Some(12));
    }
}
