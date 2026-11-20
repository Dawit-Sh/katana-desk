//! The reading-place rules, the same ones Katana on Android proved:
//! - the most recent read wins, but a place waiting to go up here only loses to a server copy newer
//!   by more than 2 minutes (the server stamps each push with its own clock when it lands);
//! - a server place behind this PC's place is offered, never applied on its own (ask before going back);
//! - a time more than a day ahead of this PC's clock never wins;
//! - a time without a zone is never compared with this PC's clock: then only "did the server's place
//!   change since we last saw it" counts.
//!
//! Pure functions, so they can be tested without a server.

use serde::{Deserialize, Serialize};

pub const PENDING_MARGIN_MS: i64 = 2 * 60 * 1000;
pub const FUTURE_LIMIT_MS: i64 = 24 * 60 * 60 * 1000;
/// Half a percent of the book: a server place closer than this to this PC's place is not "going back".
pub const BACKWARD_MARGIN: f64 = 0.005;

/// A time the server sent: with a zone (an instant) or without one (a wall-clock time in the server's zone).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ServerTime {
    Zoned(i64),
    Zoneless,
}

impl ServerTime {
    /// Epoch milliseconds when the time can be compared with this PC's clock.
    pub fn trusted(self, now: i64) -> Option<i64> {
        match self {
            ServerTime::Zoned(t) if t <= now + FUTURE_LIMIT_MS => Some(t),
            _ => None,
        }
    }
}

/// Parses a time as Grimmory sends it: an ISO instant (`...Z` or `+03:00`), a number of seconds
/// (Jackson's numeric form), or a local time without a zone.
pub fn parse_time(v: &serde_json::Value) -> Option<ServerTime> {
    match v {
        serde_json::Value::Number(n) => {
            let secs = n.as_f64()?;
            // seconds, or milliseconds from a server set up that way
            let ms = if secs > 1e11 { secs } else { secs * 1000.0 };
            Some(ServerTime::Zoned(ms.round() as i64))
        }
        serde_json::Value::String(s) => parse_time_str(s),
        _ => None,
    }
}

pub fn parse_time_str(s: &str) -> Option<ServerTime> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(ServerTime::Zoned(t.timestamp_millis()));
    }
    if chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
        || chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").is_ok()
    {
        return Some(ServerTime::Zoneless);
    }
    None
}

/// The server's place for a book.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerPlace {
    pub cfi: Option<String>,
    pub href: Option<String>,
    /// 0..1
    pub fraction: Option<f64>,
    /// 1-based page (comics)
    pub page: Option<i64>,
    /// When it was saved, when that can be compared with this PC's clock.
    pub at: Option<i64>,
    /// The server's time had no zone.
    pub zoneless: bool,
}

/// What this PC last saw (or sent) as the server's place. Times are left out on purpose: the server
/// stamps its own time on every push, so only the place itself tells whether it changed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Seen {
    pub cfi: Option<String>,
    pub fraction: Option<f64>,
}

impl Seen {
    pub fn of(p: &ServerPlace) -> Seen {
        Seen { cfi: p.cfi.clone(), fraction: p.fraction }
    }
    pub fn same_as(&self, p: &ServerPlace) -> bool {
        let f = match (self.fraction, p.fraction) {
            (Some(a), Some(b)) => (a - b).abs() < 0.001,
            (None, None) => true,
            _ => false,
        };
        f && self.cfi == p.cfi
    }
}

#[derive(Clone, Debug)]
pub struct LocalPlace {
    pub cfi: Option<String>,
    pub fraction: Option<f64>,
    /// Waiting to go up.
    pub pending: bool,
    /// When it was saved here (this PC's clock).
    pub at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    /// Nothing to do.
    Keep,
    /// This PC's place goes up.
    Push,
    /// Take the server's place. `use_cfi`: its CFI is fresh; otherwise go by how far through.
    Apply { use_cfi: bool },
    /// The server's place wins but sits behind this PC's: ask first.
    Offer { use_cfi: bool },
}

pub fn decide(local: Option<&LocalPlace>, server: Option<&ServerPlace>, seen: Option<&Seen>, now: i64) -> Decision {
    let local = local.filter(|l| l.cfi.is_some() || l.fraction.is_some());
    let Some(server) = server.filter(|s| s.cfi.is_some() || s.fraction.unwrap_or(0.0) > 0.0) else {
        // nothing on the server: a place here goes up
        return if local.map_or(false, |l| l.pending) { Decision::Push } else { Decision::Keep };
    };
    let changed = seen.map_or(true, |s| !s.same_as(server));
    // a fresh CFI is one the server didn't have when we last looked (a KOReader sync can move the
    // percentage and leave the old CFI behind)
    let use_cfi = server.cfi.is_some() && seen.map_or(true, |s| s.cfi != server.cfi);
    let Some(local) = local else {
        return Decision::Apply { use_cfi: server.cfi.is_some() };
    };
    if !changed {
        return if local.pending { Decision::Push } else { Decision::Keep };
    }
    if same_place(local, server) {
        return if local.pending { Decision::Push } else { Decision::Keep };
    }
    let server_wins = if !local.pending {
        // read on elsewhere since we last looked, nothing new here
        true
    } else {
        // both moved: the most recent read wins, if both times can be compared with the clock
        match (server.at.filter(|_| !server.zoneless), local.at) {
            (Some(s), Some(l)) => {
                let l = if l > now + FUTURE_LIMIT_MS { now } else { l };
                s > l + PENDING_MARGIN_MS
            }
            _ => false,
        }
    };
    if !server_wins {
        return Decision::Push;
    }
    if is_behind(server, local) {
        Decision::Offer { use_cfi }
    } else {
        Decision::Apply { use_cfi }
    }
}

fn same_place(local: &LocalPlace, server: &ServerPlace) -> bool {
    let close = match (local.fraction, server.fraction) {
        (Some(a), Some(b)) => (a - b).abs() < 0.001,
        _ => true,
    };
    matches!((&local.cfi, &server.cfi), (Some(a), Some(b)) if a == b) && close
}

/// Whether the server's place sits behind this PC's by more than half a percent.
pub fn is_behind(server: &ServerPlace, local: &LocalPlace) -> bool {
    match (server.fraction, local.fraction) {
        (Some(s), Some(l)) => s < l - BACKWARD_MARGIN,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn sp(cfi: &str, f: f64, at: Option<i64>) -> ServerPlace {
        ServerPlace { cfi: Some(cfi.into()), fraction: Some(f), at, ..Default::default() }
    }
    fn lp(cfi: &str, f: f64, pending: bool, at: i64) -> LocalPlace {
        LocalPlace { cfi: Some(cfi.into()), fraction: Some(f), pending, at: Some(at) }
    }

    #[test]
    fn first_open_takes_the_server_place() {
        let s = sp("epubcfi(/6/4)", 0.3, Some(NOW - 1000));
        assert_eq!(decide(None, Some(&s), None, NOW), Decision::Apply { use_cfi: true });
    }

    #[test]
    fn server_read_further_elsewhere_is_applied() {
        let seen = Seen { cfi: Some("a".into()), fraction: Some(0.2) };
        let l = lp("a", 0.2, false, NOW - 3_600_000);
        let s = sp("b", 0.4, Some(NOW - 60_000));
        assert_eq!(decide(Some(&l), Some(&s), Some(&seen), NOW), Decision::Apply { use_cfi: true });
    }

    #[test]
    fn server_behind_is_offered_not_applied() {
        let seen = Seen { cfi: Some("a".into()), fraction: Some(0.5) };
        let l = lp("a", 0.5, false, NOW - 3_600_000);
        let s = sp("b", 0.1, Some(NOW - 60_000));
        assert_eq!(decide(Some(&l), Some(&s), Some(&seen), NOW), Decision::Offer { use_cfi: true });
    }

    #[test]
    fn unchanged_server_and_waiting_place_goes_up() {
        let seen = Seen { cfi: Some("a".into()), fraction: Some(0.2) };
        let l = lp("c", 0.3, true, NOW - 1000);
        let s = sp("a", 0.2, Some(NOW - 9_000_000));
        assert_eq!(decide(Some(&l), Some(&s), Some(&seen), NOW), Decision::Push);
    }

    #[test]
    fn our_own_push_coming_back_is_not_news() {
        let seen = Seen { cfi: Some("c".into()), fraction: Some(0.3) };
        let l = lp("c", 0.3, false, NOW - 1000);
        // Grimmory keeps percentages as 32-bit floats
        let s = sp("c", 0.30000001, Some(NOW));
        assert_eq!(decide(Some(&l), Some(&s), Some(&seen), NOW), Decision::Keep);
    }

    #[test]
    fn both_moved_newer_server_wins_only_past_the_margin() {
        let seen = Seen { cfi: Some("a".into()), fraction: Some(0.2) };
        let l = lp("c", 0.3, true, NOW - 10 * 60_000);
        let close = sp("b", 0.35, Some(NOW - 9 * 60_000));
        assert_eq!(decide(Some(&l), Some(&close), Some(&seen), NOW), Decision::Push);
        let newer = sp("b", 0.35, Some(NOW - 60_000));
        assert_eq!(decide(Some(&l), Some(&newer), Some(&seen), NOW), Decision::Apply { use_cfi: true });
    }

    #[test]
    fn zoneless_server_time_never_beats_a_waiting_place() {
        let seen = Seen { cfi: Some("a".into()), fraction: Some(0.2) };
        let l = lp("c", 0.3, true, NOW - 10 * 60_000);
        let mut s = sp("b", 0.35, None);
        s.zoneless = true;
        assert_eq!(decide(Some(&l), Some(&s), Some(&seen), NOW), Decision::Push);
    }

    #[test]
    fn a_time_far_in_the_future_is_not_trusted() {
        assert_eq!(ServerTime::Zoned(NOW + FUTURE_LIMIT_MS + 1).trusted(NOW), None);
        assert_eq!(ServerTime::Zoned(NOW - 5).trusted(NOW), Some(NOW - 5));
        assert_eq!(ServerTime::Zoneless.trusted(NOW), None);
    }

    #[test]
    fn stale_cfi_with_new_percentage_goes_by_percentage() {
        // KOReader moved the percentage and left the old CFI
        let seen = Seen { cfi: Some("a".into()), fraction: Some(0.2) };
        let l = lp("a", 0.2, false, NOW - 3_600_000);
        let s = sp("a", 0.4, Some(NOW - 60_000));
        assert_eq!(decide(Some(&l), Some(&s), Some(&seen), NOW), Decision::Apply { use_cfi: false });
        let l2 = lp("x", 0.2, false, NOW - 3_600_000);
        assert_eq!(decide(Some(&l2), Some(&s), Some(&seen), NOW), Decision::Apply { use_cfi: false });
    }

    #[test]
    fn empty_server_place_takes_ours() {
        let l = lp("c", 0.3, true, NOW);
        let s = ServerPlace { cfi: Some("0".into()).filter(|c: &String| c != "0"), fraction: Some(0.0), ..Default::default() };
        assert_eq!(decide(Some(&l), Some(&s), None, NOW), Decision::Push);
        assert_eq!(decide(Some(&l), None, None, NOW), Decision::Push);
    }

    #[test]
    fn times_parse_with_and_without_zones() {
        assert_eq!(parse_time_str("2026-11-20T09:49:50Z"), Some(ServerTime::Zoned(1_795_168_190_000)));
        assert_eq!(parse_time_str("2026-11-20T12:49:50+03:00"), Some(ServerTime::Zoned(1_795_168_190_000)));
        assert_eq!(parse_time_str("2026-11-20T12:49:50.026007941"), Some(ServerTime::Zoneless));
        assert_eq!(parse_time(&serde_json::json!(1795168190.5)), Some(ServerTime::Zoned(1_795_168_190_500)));
        assert_eq!(parse_time_str("soon"), None);
    }
}
