//! Highlights and bookmarks, both ways with Grimmory: `/api/v1/annotations` (the highlights its web
//! reader and the grimmory.koplugin share) and `/api/v1/bookmarks` (the web readers' bookmarks, with
//! names and notes). The rules are the ones Katana on Android proved against the same server:
//!
//! - A mark is the same on both sides by Grimmory's id; one made here that has no id yet (its answer
//!   got lost, or KOReader made a changed highlight again) is matched by its place, or by its words in
//!   the same chapter, so nothing is sent twice.
//! - The last change wins, with the 2-minute margin of reading places: a change waiting here loses only
//!   to a server copy changed since we last saw it and newer by more than that.
//! - Removed on one side is removed on the other, unless the other side changed it later (a change
//!   waiting here goes back up as a new mark).
//! - A server that suddenly lacks at least 5 of a book's marks, and more than half of them, isn't
//!   believed: nothing is removed, and the reader asks (remove here, or put them back on Grimmory).
//! - Only EPUBs sync. Their places are foliate-js's CFIs, the same ones Grimmory's web reader makes, so
//!   they go up and come down as they are. MOBI, AZW3 and FB2 keep their marks on this PC (Grimmory's
//!   web reader reads the original file, whose places differ), as on Android.
//!
//! **Times.** Grimmory writes a mark's times without a zone, in its own wall clock. They are never
//! compared with this PC's clock: whether a server copy changed is told by what it holds (and its own
//! time string) against what we last saw. Only when both sides changed the same mark are times weighed,
//! and then the server's time is first put on this PC's clock with the server's own "now" (the health
//! check's zone-less timestamp, read in the same moment), so a zone or a clock running off cancels out.
//! Without that, the change made here wins.

use super::place::{FUTURE_LIMIT_MS, PENDING_MARGIN_MS};
use super::{conn_of, g, send, GErr, GRes};
use crate::db;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// ---------- what each side holds ----------

/// A highlight as Grimmory has it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteHl {
    pub id: i64,
    pub cfi: Option<String>,
    pub text: String,
    pub color: Option<String>,
    pub style: Option<String>,
    pub note: Option<String>,
    pub chapter: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
}

/// A bookmark as Grimmory has it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteBm {
    pub id: i64,
    /// an EPUB's CFI; for PDFs and comics the page as this PC keys it (`page:12`), see [`keyed`]
    pub cfi: Option<String>,
    /// a PDF bookmark's page (from 1), as Grimmory keeps it
    pub page_number: Option<i64>,
    pub title: Option<String>,
    pub notes: Option<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
}

/// What we last saw of a highlight on Grimmory.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SeenHl {
    pub color: Option<String>,
    pub style: Option<String>,
    pub note: Option<String>,
    pub updated: Option<String>,
}

impl SeenHl {
    pub fn of(s: &RemoteHl) -> SeenHl {
        SeenHl { color: s.color.clone(), style: s.style.clone(), note: norm(s.note.as_deref()), updated: secs(&s.updated) }
    }
}

/// What we last saw of a bookmark on Grimmory. `auto`: the name it was sent up with when it had none
/// here (its chapter, the way the web reader names its own), which coming back isn't a name.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SeenBm {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub updated: Option<String>,
    pub auto: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalHl {
    pub id: i64,
    pub cfi: String,
    pub text: String,
    pub color: String,
    pub style: String,
    pub note: Option<String>,
    pub updated_at: i64,
    pub deleted: bool,
    pub remote_id: Option<i64>,
    pub seen: Option<SeenHl>,
    pub state: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalBm {
    pub id: i64,
    pub cfi: String,
    pub chapter: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
    pub updated_at: i64,
    pub deleted: bool,
    pub remote_id: Option<i64>,
    pub seen: Option<SeenBm>,
    pub state: String,
}

/// A server time to the second: Grimmory answers a write with microseconds but lists whole seconds.
fn secs(s: &Option<String>) -> Option<String> {
    let s = s.as_deref()?.trim();
    match s.find('.') {
        Some(i) => {
            let rest = &s[i + 1..];
            let zone = rest.trim_start_matches(|c: char| c.is_ascii_digit());
            Some(format!("{}{}", &s[..i], zone))
        }
        None => Some(s.to_string()),
    }
}

fn norm(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

// ---------- colours and styles ----------

/// Katana's five go up as the five of Grimmory's web reader of the same name.
pub fn color_hex(name: &str) -> &'static str {
    match name {
        "green" => "#4ADE80",
        "blue" => "#38BDF8",
        "pink" => "#F472B6",
        "orange" => "#FB923C",
        _ => "#FACC15",
    }
}

/// A colour coming down: the web reader's (light and dark sets), KOReader's and Katana's own by name;
/// any other the nearest in hue.
pub fn color_name(hex: Option<&str>) -> &'static str {
    let Some(rgb) = hex.map(|h| h.trim().trim_start_matches('#')).filter(|h| h.len() == 6).and_then(|h| u32::from_str_radix(h, 16).ok())
    else {
        return "yellow";
    };
    let known: &[(u32, &str)] = &[
        (0xFACC15, "yellow"),
        (0x4ADE80, "green"),
        (0x38BDF8, "blue"),
        (0xF472B6, "pink"),
        (0xFB923C, "orange"),
        (0xB8860B, "yellow"),
        (0x228B22, "green"),
        (0x1E90FF, "blue"),
        (0xDC143C, "pink"),
        (0xFF8C00, "orange"),
        (0xFFFF00, "yellow"),
        (0xFFC107, "yellow"),
        (0xFB523C, "orange"),
        (0xF452FC, "pink"),
        (0x0248F8, "blue"),
        (0xAAAAAA, "yellow"),
        (0xFAFAFA, "yellow"),
        // Katana's own (the desk's dots and Android's)
        (0xF2C230, "yellow"),
        (0x5CB85C, "green"),
        (0x4A90D9, "blue"),
        (0xE0609F, "pink"),
        (0xEF8A2F, "orange"),
    ];
    if let Some((_, n)) = known.iter().find(|(c, _)| *c == rgb) {
        return n;
    }
    let Some(h) = hue(rgb) else { return "yellow" };
    let names = ["yellow", "green", "blue", "pink", "orange"];
    names
        .iter()
        .min_by(|a, b| {
            let d = |n: &&str| {
                let o = hue(u32::from_str_radix(&color_hex(n)[1..], 16).unwrap()).unwrap();
                let x = (h - o).abs();
                x.min(360.0 - x)
            };
            d(a).partial_cmp(&d(b)).unwrap()
        })
        .copied()
        .unwrap_or("yellow")
}

fn hue(rgb: u32) -> Option<f64> {
    let r = ((rgb >> 16) & 0xff) as f64 / 255.0;
    let g = ((rgb >> 8) & 0xff) as f64 / 255.0;
    let b = (rgb & 0xff) as f64 / 255.0;
    let hi = r.max(g).max(b);
    let lo = r.min(g).min(b);
    let c = hi - lo;
    if c < 0.12 {
        return None;
    }
    let s = if hi == r {
        ((g - b) / c).rem_euclid(6.0)
    } else if hi == g {
        (b - r) / c + 2.0
    } else {
        (r - g) / c + 4.0
    };
    Some(s * 60.0)
}

pub fn style_name(s: Option<&str>) -> &'static str {
    crate::highlights::style_ok(&s.unwrap_or("").trim().to_lowercase())
}

// ---------- places ----------

/// A CFI without its `[...]` assertions (ids, quoted text) and spaces, so the web reader's and
/// KOReader's ways of writing the same place compare equal.
fn without_assertions(cfi: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    let mut chars = cfi.chars();
    while let Some(c) = chars.next() {
        match c {
            '^' => {
                chars.next();
            }
            '[' => inside = true,
            ']' => inside = false,
            c if !inside && !c.is_whitespace() => out.push(c),
            _ => {}
        }
    }
    out
}

/// "start;end", each the full path; a page place (`page:12`) as it is; None for what isn't a CFI.
fn place_key(cfi: &str) -> Option<String> {
    if cfi.starts_with("page:") {
        return Some(cfi.to_string());
    }
    let inner = cfi.trim().strip_prefix("epubcfi(")?.strip_suffix(')')?;
    let s = without_assertions(inner);
    let parts: Vec<&str> = s.split(',').collect();
    match parts.len() {
        1 => Some(format!("{0};{0}", parts[0])),
        3 => Some(format!("{}{};{}{}", parts[0], parts[1], parts[0], parts[2])),
        _ => None,
    }
}

pub fn same_place(a: &str, b: &str) -> bool {
    matches!((place_key(a), place_key(b)), (Some(x), Some(y)) if x == y)
}

/// The chapter (spine item) a CFI is in: `/6/14`.
pub fn chapter_key(cfi: &str) -> Option<String> {
    place_key(cfi).and_then(|k| k.split('!').next().map(String::from)).filter(|s| !s.is_empty())
}

/// Words with spaces, soft hyphens, zero-width marks and letter case left out.
pub fn words_key(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '\u{00AD}' | '\u{FEFF}' | '\u{200B}'..='\u{200D}'))
        .flat_map(char::to_lowercase)
        .collect()
}

// ---------- the server's clock ----------

/// This PC's clock and, when known, how far the server's wall clock is from it.
#[derive(Clone, Copy, Debug)]
pub struct Clock {
    pub now: i64,
    /// the server's wall clock read as UTC, minus this PC's clock, in the same moment
    pub offset: Option<i64>,
}

impl Clock {
    /// A server time on this PC's clock, when it can be put there.
    pub fn at(&self, s: Option<&str>) -> Option<i64> {
        let s = s?.trim();
        let t = if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
            t.timestamp_millis()
        } else {
            let naive = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
                .ok()?;
            naive.and_utc().timestamp_millis() - self.offset?
        };
        // a time more than a day ahead never wins
        (t <= self.now + FUTURE_LIMIT_MS).then_some(t)
    }
}

/// The offset from a health-check timestamp read at `now` (this PC's clock).
pub fn offset_of(timestamp: &str, now: i64) -> Option<i64> {
    let s = timestamp.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        // a zoned answer: the zone is the offset, the clocks are taken as agreeing
        return Some(t.naive_local().and_utc().timestamp_millis() - t.timestamp_millis());
    }
    let naive = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    Some(naive.and_utc().timestamp_millis() - now)
}

// ---------- the plans ----------

#[derive(Clone, Debug, PartialEq)]
pub enum Act<R> {
    /// new here: the server's copy
    Insert(R),
    /// take the server's copy (a tombstone comes back)
    Take { id: i64, server: R },
    /// linked and the same on both sides
    InStep { id: i64, server: R },
    /// linked; a change from here follows
    Link { id: i64, server: R },
    /// gone here (removed on the server, or a removal that already happened there)
    Purge(i64),
    /// removed on the server while changed here: no longer linked, it goes up again
    Unlink(i64),
    Create(i64),
    Update { id: i64, remote: i64 },
    Delete { id: i64, remote: i64 },
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Plan<R> {
    pub acts: Vec<Act<R>>,
    /// marks the server no longer has, held back because too many went at once
    pub held: Vec<i64>,
}

/// Holds back removals when the server lost too many at once: at least 5, and more than half of the
/// book's marks that it had.
fn guard<R>(acts: Vec<Act<R>>, lost: &HashSet<i64>, linked: usize) -> Plan<R> {
    if lost.len() >= 5 && lost.len() * 2 > linked {
        let mut held: Vec<i64> = lost.iter().copied().collect();
        held.sort();
        let acts = acts.into_iter().filter(|a| !matches!(a, Act::Purge(id) if lost.contains(id))).collect();
        return Plan { acts, held };
    }
    Plan { acts, held: vec![] }
}

fn waiting(state: &str) -> bool {
    matches!(state, "local" | "dirty" | "kept")
}

pub fn plan_highlights(local: &[LocalHl], remote: &[RemoteHl], clock: &Clock) -> Plan<RemoteHl> {
    let remote: Vec<&RemoteHl> = remote.iter().filter(|r| r.cfi.as_deref().map_or(false, |c| c.starts_with("epubcfi("))).collect();
    let remote_ids: HashSet<i64> = remote.iter().map(|r| r.id).collect();
    let by_remote: HashMap<i64, &LocalHl> = local.iter().filter_map(|l| l.remote_id.map(|r| (r, l))).collect();
    let mut used: HashSet<i64> = HashSet::new();
    let mut acts = vec![];
    for s in &remote {
        let l = by_remote.get(&s.id).copied().filter(|l| !used.contains(&l.id)).or_else(|| {
            local.iter().find(|l| {
                !used.contains(&l.id)
                    && l.remote_id.map_or(true, |r| !remote_ids.contains(&r))
                    && !(l.deleted && l.remote_id.is_none())
                    && same_highlight(l, s)
            })
        });
        let Some(l) = l else {
            acts.push(Act::Insert((*s).clone()));
            continue;
        };
        used.insert(l.id);
        let differs = l.color != color_name(s.color.as_deref())
            || l.style != style_name(s.style.as_deref())
            || norm(l.note.as_deref()) != norm(s.note.as_deref());
        let changed_there = l.seen.as_ref().map_or(true, |seen| *seen != SeenHl::of(s));
        let pending = l.deleted || waiting(&l.state);
        let server_newer = changed_there && clock.at(s.updated.as_deref()).map_or(false, |t| t > l.updated_at + PENDING_MARGIN_MS);
        let next = if !pending {
            if differs {
                Act::Take { id: l.id, server: (*s).clone() }
            } else if changed_there || l.remote_id != Some(s.id) || l.state != "synced" {
                Act::InStep { id: l.id, server: (*s).clone() }
            } else {
                continue;
            }
        } else if server_newer {
            Act::Take { id: l.id, server: (*s).clone() }
        } else if l.deleted {
            acts.push(Act::Link { id: l.id, server: (*s).clone() });
            Act::Delete { id: l.id, remote: s.id }
        } else if differs {
            acts.push(Act::Link { id: l.id, server: (*s).clone() });
            Act::Update { id: l.id, remote: s.id }
        } else {
            Act::InStep { id: l.id, server: (*s).clone() }
        };
        acts.push(next);
    }
    let mut lost = HashSet::new();
    let mut linked = 0;
    for l in local {
        if l.remote_id.is_some() && !l.deleted {
            linked += 1;
        }
        if used.contains(&l.id) {
            continue;
        }
        if l.deleted {
            acts.push(Act::Purge(l.id));
        } else if l.remote_id.is_some() && l.state == "synced" {
            lost.insert(l.id);
            acts.push(Act::Purge(l.id));
        } else if matches!(l.state.as_str(), "local" | "dirty") {
            if l.remote_id.is_some() {
                acts.push(Act::Unlink(l.id));
            }
            acts.push(Act::Create(l.id));
        }
    }
    guard(acts, &lost, linked)
}

fn same_highlight(l: &LocalHl, s: &RemoteHl) -> bool {
    let Some(sc) = s.cfi.as_deref() else { return false };
    same_place(&l.cfi, sc)
        || (chapter_key(&l.cfi).is_some() && chapter_key(&l.cfi) == chapter_key(sc) && words_key(&l.text) == words_key(&s.text) && !s.text.trim().is_empty())
}

/// A bookmark's name as Grimmory has it, or None when it's only the name it went up with, or its chapter.
fn server_name(s: &RemoteBm, l: Option<&LocalBm>) -> Option<String> {
    let t = norm(s.title.as_deref())?;
    if let Some(l) = l {
        let page_name = page_of(&l.cfi).is_some() && auto_name(l) == t;
        if l.seen.as_ref().and_then(|x| x.auto.as_deref()) == Some(t.as_str()) || norm(l.chapter.as_deref()).as_deref() == Some(t.as_str()) || page_name {
            return None;
        }
    }
    Some(t)
}

/// What kind of book's marks sync: an EPUB's (highlights and bookmarks, places by CFI), or a PDF's or a
/// comic's (bookmarks by page: a PDF's in `pageNumber`, a comic's page written in `cfi`, as Grimmory's
/// own readers keep them).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Epub,
    Pdf,
    Comic,
}

impl Kind {
    pub fn of(format: &str) -> Option<Kind> {
        match format {
            "epub" => Some(Kind::Epub),
            "pdf" => Some(Kind::Pdf),
            "cbz" | "cbr" => Some(Kind::Comic),
            _ => None,
        }
    }
}

/// Grimmory's bookmarks of the kind this book keeps, with their place as this PC keys it; a place of the
/// other kind (a CFI on a PDF, a page on an EPUB) is left alone on the server.
pub fn keyed(kind: Kind, remote: Vec<RemoteBm>) -> Vec<RemoteBm> {
    remote
        .into_iter()
        .filter_map(|mut r| {
            let place = match kind {
                Kind::Epub => r.cfi.clone().filter(|c| c.starts_with("epubcfi(")),
                Kind::Pdf => r.page_number.filter(|n| *n >= 1).map(|n| format!("page:{n}")),
                Kind::Comic => r.cfi.as_deref().and_then(|c| c.trim().parse::<i64>().ok()).filter(|n| *n >= 1).map(|n| format!("page:{n}")),
            }?;
            r.cfi = Some(place);
            Some(r)
        })
        .collect()
}

/// A page place's page (from 1).
fn page_of(cfi: &str) -> Option<i64> {
    cfi.strip_prefix("page:")?.split(':').next()?.parse().ok()
}

pub fn plan_bookmarks(local: &[LocalBm], remote: &[RemoteBm], clock: &Clock) -> Plan<RemoteBm> {
    let remote: Vec<&RemoteBm> =
        remote.iter().filter(|r| r.cfi.as_deref().map_or(false, |c| c.starts_with("epubcfi(") || c.starts_with("page:"))).collect();
    let remote_ids: HashSet<i64> = remote.iter().map(|r| r.id).collect();
    let by_remote: HashMap<i64, &LocalBm> = local.iter().filter_map(|l| l.remote_id.map(|r| (r, l))).collect();
    let mut used: HashSet<i64> = HashSet::new();
    let mut acts = vec![];
    for s in &remote {
        let l = by_remote.get(&s.id).copied().filter(|l| !used.contains(&l.id)).or_else(|| {
            local.iter().find(|l| {
                !used.contains(&l.id)
                    && l.remote_id.map_or(true, |r| !remote_ids.contains(&r))
                    && !(l.deleted && l.remote_id.is_none())
                    && s.cfi.as_deref().map_or(false, |c| same_place(&l.cfi, c))
            })
        });
        let Some(l) = l else {
            acts.push(Act::Insert((*s).clone()));
            continue;
        };
        used.insert(l.id);
        let differs = norm(l.title.as_deref()) != server_name(s, Some(l)) || norm(l.note.as_deref()) != norm(s.notes.as_deref());
        let seen_now = |l: &LocalBm| SeenBm {
            title: norm(s.title.as_deref()),
            notes: norm(s.notes.as_deref()),
            updated: secs(&s.updated),
            auto: l.seen.as_ref().and_then(|x| x.auto.clone()),
        };
        let changed_there = l.seen.as_ref().map_or(true, |seen| *seen != seen_now(l));
        let pending = l.deleted || waiting(&l.state);
        let server_newer = changed_there && clock.at(s.updated.as_deref()).map_or(false, |t| t > l.updated_at + PENDING_MARGIN_MS);
        // a first match by place (a lost answer) keeps whichever side has a name or note
        let first_match = l.remote_id.is_none() && !l.deleted;
        let next = if !pending {
            if differs {
                Act::Take { id: l.id, server: (*s).clone() }
            } else if changed_there || l.remote_id != Some(s.id) || l.state != "synced" {
                Act::InStep { id: l.id, server: (*s).clone() }
            } else {
                continue;
            }
        } else if server_newer && !(first_match && (l.title.is_some() || l.note.is_some())) {
            Act::Take { id: l.id, server: (*s).clone() }
        } else if l.deleted {
            acts.push(Act::Link { id: l.id, server: (*s).clone() });
            Act::Delete { id: l.id, remote: s.id }
        } else if differs {
            acts.push(Act::Link { id: l.id, server: (*s).clone() });
            Act::Update { id: l.id, remote: s.id }
        } else {
            Act::InStep { id: l.id, server: (*s).clone() }
        };
        acts.push(next);
    }
    let mut lost = HashSet::new();
    let mut linked = 0;
    for l in local {
        if l.remote_id.is_some() && !l.deleted {
            linked += 1;
        }
        if used.contains(&l.id) {
            continue;
        }
        if l.deleted {
            acts.push(Act::Purge(l.id));
        } else if l.remote_id.is_some() && l.state == "synced" {
            lost.insert(l.id);
            acts.push(Act::Purge(l.id));
        } else if matches!(l.state.as_str(), "local" | "dirty") {
            if l.remote_id.is_some() {
                acts.push(Act::Unlink(l.id));
            }
            acts.push(Act::Create(l.id));
        }
    }
    guard(acts, &lost, linked)
}

// ---------- Grimmory's answers ----------

fn s(v: &Value, k: &str) -> Option<String> {
    match v.get(k)? {
        Value::String(x) => Some(x.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn list_of(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("content") {
            Some(Value::Array(a)) => a,
            _ => vec![],
        },
        _ => vec![],
    }
}

pub fn remote_hl(v: &Value) -> Option<RemoteHl> {
    Some(RemoteHl {
        id: v.get("id")?.as_i64()?,
        cfi: s(v, "cfi").filter(|x| !x.trim().is_empty()),
        text: s(v, "text").unwrap_or_default(),
        color: s(v, "color"),
        style: s(v, "style"),
        note: norm(s(v, "note").as_deref()),
        chapter: norm(s(v, "chapterTitle").as_deref()),
        created: s(v, "createdAt"),
        updated: s(v, "updatedAt").or_else(|| s(v, "createdAt")),
    })
}

pub fn remote_bm(v: &Value) -> Option<RemoteBm> {
    Some(RemoteBm {
        id: v.get("id")?.as_i64()?,
        cfi: s(v, "cfi").filter(|x| !x.trim().is_empty()),
        page_number: v.get("pageNumber").and_then(|x| x.as_i64()),
        title: norm(s(v, "title").as_deref()),
        notes: norm(s(v, "notes").as_deref()),
        created: s(v, "createdAt"),
        updated: s(v, "updatedAt").or_else(|| s(v, "createdAt")),
    })
}

enum Write<T> {
    Saved(T),
    /// gone on the server
    Missing,
    /// the book already has one at this place
    AlreadyThere,
    /// turned down as it is: sending it again won't help
    Refused,
}

async fn write(app: &AppHandle, method: reqwest::Method, path: String, body: Value) -> GRes<Write<Value>> {
    let resp = send(app, move |c, base, tok| c.request(method.clone(), format!("{base}{path}")).bearer_auth(tok).json(&body)).await?;
    let st = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    match st {
        404 => Ok(Write::Missing),
        409 => Ok(Write::AlreadyThere),
        400 | 422 => {
            eprintln!("katana: Grimmory refused a mark: {}", super::server_message(&text));
            Ok(Write::Refused)
        }
        _ if (200..300).contains(&st) => Ok(Write::Saved(serde_json::from_str(&text).unwrap_or(Value::Null))),
        _ => Err(GErr::Server(st, super::server_message(&text))),
    }
}

async fn delete(app: &AppHandle, path: String) -> GRes<()> {
    let resp = send(app, move |c, base, tok| c.delete(format!("{base}{path}")).bearer_auth(tok)).await?;
    let st = resp.status().as_u16();
    if st == 404 || (200..300).contains(&st) {
        Ok(())
    } else {
        Err(GErr::Server(st, String::new()))
    }
}

async fn get_list(app: &AppHandle, path: String) -> GRes<Vec<Value>> {
    let v = super::json(app, move |c, base, tok| c.get(format!("{base}{path}")).bearer_auth(tok)).await?;
    Ok(list_of(v))
}

/// The server's wall clock against this PC's, read once every ten minutes.
async fn clock(app: &AppHandle) -> Clock {
    static C: OnceLock<Mutex<Option<(i64, Option<i64>)>>> = OnceLock::new();
    let cache = C.get_or_init(Default::default);
    let now = db::now();
    if let Some((at, off)) = *cache.lock().unwrap() {
        if now - at < 600_000 && off.is_some() {
            return Clock { now, offset: off };
        }
    }
    let gr = g(app);
    let base = gr.base();
    let before = db::now();
    let v: Option<Value> = match gr.http.get(format!("{base}/api/v1/healthcheck")).timeout(Duration::from_secs(8)).send().await {
        Ok(r) => r.json().await.ok(),
        Err(_) => None,
    };
    let mid = (before + db::now()) / 2;
    let ts = v.as_ref().and_then(|v| v.get("data").and_then(|d| s(d, "timestamp")).or_else(|| s(v, "timestamp")));
    let off = ts.and_then(|t| offset_of(&t, mid));
    *cache.lock().unwrap() = Some((now, off));
    Clock { now: db::now(), offset: off }
}

// ---------- one book ----------

fn sync_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Marks Grimmory no longer has, held back (book id -> (highlight ids, bookmark ids)). Worked out again
/// on every sync, so a restart loses nothing.
fn held() -> &'static Mutex<HashMap<i64, (Vec<i64>, Vec<i64>)>> {
    static H: OnceLock<Mutex<HashMap<i64, (Vec<i64>, Vec<i64>)>>> = OnceLock::new();
    H.get_or_init(Default::default)
}

/// The Grimmory book a book on this PC is, and what of its marks sync: an EPUB's highlights and
/// bookmarks, a PDF's or a comic's bookmarks.
pub fn synced_kind(app: &AppHandle, book_id: i64) -> Option<(i64, Kind)> {
    conn_of(app)
        .query_row("SELECT grimmory_id, format FROM books WHERE id = ?1 AND missing = 0", [book_id], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?))
        })
        .ok()
        .and_then(|(gid, f)| Some((gid?, Kind::of(&f)?)))
}

pub fn synced_gid(app: &AppHandle, book_id: i64) -> Option<i64> {
    synced_kind(app, book_id).map(|x| x.0)
}

fn local_hls(app: &AppHandle, book_id: i64) -> Vec<LocalHl> {
    let conn = conn_of(app);
    let Ok(mut st) = conn.prepare(
        "SELECT id, cfi, text, color, style, note, updated_at, deleted_at IS NOT NULL, remote_id, remote_seen, sync_state
         FROM highlights WHERE book_id = ?1",
    ) else {
        return vec![];
    };
    let rows = st.query_map([book_id], |r| {
        let seen: Option<String> = r.get(9)?;
        Ok(LocalHl {
            id: r.get(0)?,
            cfi: r.get(1)?,
            text: r.get(2)?,
            color: r.get(3)?,
            style: r.get(4)?,
            note: r.get(5)?,
            updated_at: r.get(6)?,
            deleted: r.get(7)?,
            remote_id: r.get(8)?,
            seen: seen.and_then(|s| serde_json::from_str(&s).ok()),
            state: r.get(10)?,
        })
    });
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

fn local_bms(app: &AppHandle, book_id: i64) -> Vec<LocalBm> {
    let conn = conn_of(app);
    let Ok(mut st) = conn.prepare(
        "SELECT id, cfi, chapter, title, note, updated_at, deleted_at IS NOT NULL, remote_id, remote_seen, sync_state
         FROM bookmarks WHERE book_id = ?1",
    ) else {
        return vec![];
    };
    let rows = st.query_map([book_id], |r| {
        let seen: Option<String> = r.get(8)?;
        Ok(LocalBm {
            id: r.get(0)?,
            cfi: r.get(1)?,
            chapter: r.get(2)?,
            title: r.get(3)?,
            note: r.get(4)?,
            updated_at: r.get(5)?,
            deleted: r.get(6)?,
            remote_id: r.get(7)?,
            seen: seen.and_then(|s| serde_json::from_str(&s).ok()),
            state: r.get(9)?,
        })
    });
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

fn js<T: Serialize>(t: &T) -> String {
    serde_json::to_string(t).unwrap_or_default()
}

/// The name a bookmark goes up with when it has none here, as the web reader names its own: an EPUB's
/// its chapter, a page's "Page 12".
fn auto_name(l: &LocalBm) -> String {
    if let Some(n) = page_of(&l.cfi) {
        return format!("Page {n}");
    }
    norm(l.chapter.as_deref()).unwrap_or_else(|| "Bookmark".into())
}

/// Syncs one book's highlights and bookmarks. Returns whether anything here changed.
pub async fn sync_book(app: &AppHandle, book_id: i64) -> GRes<bool> {
    let Some((gid, kind)) = synced_kind(app, book_id) else { return Ok(false) };
    if !g(app).signed_in() {
        return Err(GErr::SignedOut);
    }
    let _one = sync_lock().lock().await;
    let mut changed = false;
    // a second round settles what the first one learned (a 409 to match by place, a mark gone on the server)
    for _ in 0..2 {
        let (c, again) = round(app, book_id, gid, kind).await?;
        changed |= c;
        if !again {
            break;
        }
    }
    if changed {
        let _ = app.emit("marks-changed", book_id);
    }
    Ok(changed)
}

async fn round(app: &AppHandle, book_id: i64, gid: i64, kind: Kind) -> GRes<(bool, bool)> {
    let clock = clock(app).await;
    // a PDF's and a comic's highlights stay on this PC (Grimmory keeps no page highlights of this shape)
    let epub = kind == Kind::Epub;
    let hls: Vec<RemoteHl> = if epub {
        get_list(app, format!("/api/v1/annotations/book/{gid}")).await?.iter().filter_map(remote_hl).collect()
    } else {
        vec![]
    };
    let bms: Vec<RemoteBm> = keyed(kind, get_list(app, format!("/api/v1/bookmarks/book/{gid}")).await?.iter().filter_map(remote_bm).collect());
    let lh = if epub { local_hls(app, book_id) } else { vec![] };
    let lb: Vec<LocalBm> = local_bms(app, book_id)
        .into_iter()
        .filter(|l| if epub { l.cfi.starts_with("epubcfi(") } else { l.cfi.starts_with("page:") })
        .collect();
    let ph = plan_highlights(&lh, &hls, &clock);
    let pb = plan_bookmarks(&lb, &bms, &clock);
    {
        let mut h = held().lock().unwrap();
        if ph.held.is_empty() && pb.held.is_empty() {
            h.remove(&book_id);
        } else {
            let first = !h.contains_key(&book_id);
            h.insert(book_id, (ph.held.clone(), pb.held.clone()));
            if first {
                let _ = app.emit("marks-lost", book_id);
            }
        }
    }
    let mut changed = false;
    let mut again = false;
    let exp_h: HashMap<i64, i64> = lh.iter().map(|l| (l.id, l.updated_at)).collect();
    let exp_b: HashMap<i64, i64> = lb.iter().map(|l| (l.id, l.updated_at)).collect();
    for a in ph.acts {
        let (c, ag) = apply_hl(app, book_id, gid, a, &exp_h, &clock).await?;
        changed |= c;
        again |= ag;
    }
    for a in pb.acts {
        let (c, ag) = apply_bm(app, book_id, gid, kind, a, &exp_b, &clock, &lb).await?;
        changed |= c;
        again |= ag;
    }
    Ok((changed, again))
}

async fn apply_hl(
    app: &AppHandle,
    book_id: i64,
    gid: i64,
    a: Act<RemoteHl>,
    exp: &HashMap<i64, i64>,
    clock: &Clock,
) -> GRes<(bool, bool)> {
    let now = db::now();
    match a {
        Act::Insert(s) => {
            let Some(cfi) = s.cfi.clone() else { return Ok((false, false)) };
            let created = clock.at(s.created.as_deref()).unwrap_or(now);
            let updated = clock.at(s.updated.as_deref()).unwrap_or(created);
            let conn = conn_of(app);
            let _ = conn.execute(
                "INSERT INTO highlights (uuid, book_id, cfi, text, chapter, color, style, note, created_at, updated_at, remote_id, remote_seen, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'synced')",
                params![
                    crate::marks::new_uuid(),
                    book_id,
                    cfi,
                    s.text.trim(),
                    s.chapter,
                    color_name(s.color.as_deref()),
                    style_name(s.style.as_deref()),
                    norm(s.note.as_deref()),
                    created,
                    updated,
                    s.id,
                    js(&SeenHl::of(&s))
                ],
            );
            Ok((true, false))
        }
        Act::Take { id, server: s } => {
            let at = clock.at(s.updated.as_deref()).unwrap_or(now);
            let n = conn_of(app)
                .execute(
                    "UPDATE highlights SET color = ?2, style = ?3, note = ?4, deleted_at = NULL, updated_at = MAX(updated_at, ?5),
                        remote_id = ?6, remote_seen = ?7, sync_state = 'synced' WHERE id = ?1 AND updated_at = ?8",
                    params![
                        id,
                        color_name(s.color.as_deref()),
                        style_name(s.style.as_deref()),
                        norm(s.note.as_deref()),
                        at,
                        s.id,
                        js(&SeenHl::of(&s)),
                        exp.get(&id)
                    ],
                )
                .unwrap_or(0);
            Ok((n > 0, false))
        }
        Act::InStep { id, server: s } => {
            let _ = conn_of(app).execute(
                "UPDATE highlights SET remote_id = ?2, remote_seen = ?3, sync_state = 'synced' WHERE id = ?1 AND updated_at = ?4",
                params![id, s.id, js(&SeenHl::of(&s)), exp.get(&id)],
            );
            Ok((false, false))
        }
        Act::Link { id, server: s } => {
            let _ = conn_of(app).execute(
                "UPDATE highlights SET remote_id = ?2, remote_seen = ?3 WHERE id = ?1",
                params![id, s.id, js(&SeenHl::of(&s))],
            );
            Ok((false, false))
        }
        Act::Purge(id) => {
            let n = conn_of(app).execute("DELETE FROM highlights WHERE id = ?1 AND updated_at = ?2", params![id, exp.get(&id)]).unwrap_or(0);
            Ok((n > 0, false))
        }
        Act::Unlink(id) => {
            let _ = conn_of(app).execute(
                "UPDATE highlights SET remote_id = NULL, remote_seen = NULL, sync_state = 'local' WHERE id = ?1",
                [id],
            );
            Ok((false, false))
        }
        Act::Create(id) => {
            let Some(h) = crate::highlights::get(&conn_of(app), id).ok().flatten().filter(|h| h.remote_id.is_none()) else {
                return Ok((false, false));
            };
            let mut body = json!({
                "bookId": gid,
                "cfi": h.cfi,
                "text": h.text.chars().take(5000).collect::<String>(),
                "color": color_hex(&h.color),
                "style": h.style,
            });
            if let Some(n) = norm(h.note.as_deref()) {
                body["note"] = json!(n.chars().take(5000).collect::<String>());
            }
            if let Some(c) = norm(h.chapter.as_deref()) {
                body["chapterTitle"] = json!(c.chars().take(500).collect::<String>());
            }
            match write(app, reqwest::Method::POST, "/api/v1/annotations".into(), body).await? {
                Write::Saved(v) => {
                    if let Some(s) = remote_hl(&v) {
                        saved_hl(app, id, h.updated_at, &s);
                    }
                    Ok((false, false))
                }
                Write::AlreadyThere => Ok((false, true)),
                Write::Refused => {
                    kept(app, "highlights", id);
                    Ok((false, false))
                }
                Write::Missing => Ok((false, false)),
            }
        }
        Act::Update { id, remote } => {
            let Some(h) = crate::highlights::get(&conn_of(app), id).ok().flatten() else { return Ok((false, false)) };
            let body = json!({
                "color": color_hex(&h.color),
                "style": h.style,
                "note": h.note.clone().unwrap_or_default().chars().take(5000).collect::<String>(),
            });
            match write(app, reqwest::Method::PUT, format!("/api/v1/annotations/{remote}"), body).await? {
                Write::Saved(v) => {
                    if let Some(s) = remote_hl(&v) {
                        saved_hl(app, id, h.updated_at, &s);
                    }
                    Ok((false, false))
                }
                // removed there meanwhile: it goes up again as new on the next round
                Write::Missing => Ok((false, true)),
                Write::AlreadyThere => Ok((false, true)),
                Write::Refused => {
                    kept(app, "highlights", id);
                    Ok((false, false))
                }
            }
        }
        Act::Delete { id, remote } => {
            delete(app, format!("/api/v1/annotations/{remote}")).await?;
            let _ = conn_of(app).execute("DELETE FROM highlights WHERE id = ?1 AND deleted_at IS NOT NULL", [id]);
            Ok((false, false))
        }
    }
}

/// Grimmory's answer to a highlight sent up. A change made while it was on its way stays waiting.
fn saved_hl(app: &AppHandle, id: i64, sent_at: i64, s: &RemoteHl) {
    let _ = conn_of(app).execute(
        "UPDATE highlights SET remote_id = ?2, remote_seen = ?3,
            sync_state = CASE WHEN updated_at = ?4 AND deleted_at IS NULL THEN 'synced'
                              WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE 'dirty' END
         WHERE id = ?1",
        params![id, s.id, js(&SeenHl::of(s)), sent_at],
    );
}

fn kept(app: &AppHandle, table: &str, id: i64) {
    let _ = conn_of(app).execute(&format!("UPDATE {table} SET sync_state = 'kept' WHERE id = ?1 AND sync_state IN ('local', 'dirty')"), [id]);
}

#[allow(clippy::too_many_arguments)]
async fn apply_bm(
    app: &AppHandle,
    book_id: i64,
    gid: i64,
    kind: Kind,
    a: Act<RemoteBm>,
    exp: &HashMap<i64, i64>,
    clock: &Clock,
    local: &[LocalBm],
) -> GRes<(bool, bool)> {
    let now = db::now();
    let lb = |id: i64| local.iter().find(|l| l.id == id);
    let seen = |s: &RemoteBm, auto: Option<String>| SeenBm { title: norm(s.title.as_deref()), notes: norm(s.notes.as_deref()), updated: secs(&s.updated), auto };
    match a {
        Act::Insert(s) => {
            let Some(cfi) = s.cfi.clone() else { return Ok((false, false)) };
            let created = clock.at(s.created.as_deref()).unwrap_or(now);
            let updated = clock.at(s.updated.as_deref()).unwrap_or(created);
            let _ = conn_of(app).execute(
                "INSERT INTO bookmarks (uuid, book_id, cfi, title, note, created_at, updated_at, remote_id, remote_cfi, remote_seen, sync_state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?3, ?9, 'synced')",
                params![crate::marks::new_uuid(), book_id, cfi, norm(s.title.as_deref()), norm(s.notes.as_deref()), created, updated, s.id, js(&seen(&s, None))],
            );
            Ok((true, false))
        }
        Act::Take { id, server: s } => {
            let at = clock.at(s.updated.as_deref()).unwrap_or(now);
            let l = lb(id);
            let auto = l.and_then(|l| l.seen.as_ref().and_then(|x| x.auto.clone()));
            let n = conn_of(app)
                .execute(
                    "UPDATE bookmarks SET title = ?2, note = ?3, deleted_at = NULL, updated_at = MAX(updated_at, ?4),
                        remote_id = ?5, remote_cfi = ?6, remote_seen = ?7, sync_state = 'synced' WHERE id = ?1 AND updated_at = ?8",
                    params![id, server_name(&s, l), norm(s.notes.as_deref()), at, s.id, s.cfi, js(&seen(&s, auto)), exp.get(&id)],
                )
                .unwrap_or(0);
            Ok((n > 0, false))
        }
        Act::InStep { id, server: s } => {
            let auto = lb(id).and_then(|l| l.seen.as_ref().and_then(|x| x.auto.clone()));
            let _ = conn_of(app).execute(
                "UPDATE bookmarks SET remote_id = ?2, remote_cfi = ?3, remote_seen = ?4, sync_state = 'synced'
                 WHERE id = ?1 AND updated_at = ?5 AND deleted_at IS NULL",
                params![id, s.id, s.cfi, js(&seen(&s, auto)), exp.get(&id)],
            );
            Ok((false, false))
        }
        Act::Link { id, server: s } => {
            let auto = lb(id).and_then(|l| l.seen.as_ref().and_then(|x| x.auto.clone()));
            let _ = conn_of(app).execute(
                "UPDATE bookmarks SET remote_id = ?2, remote_cfi = ?3, remote_seen = ?4 WHERE id = ?1",
                params![id, s.id, s.cfi, js(&seen(&s, auto))],
            );
            Ok((false, false))
        }
        Act::Purge(id) => {
            let n = conn_of(app).execute("DELETE FROM bookmarks WHERE id = ?1 AND updated_at = ?2", params![id, exp.get(&id)]).unwrap_or(0);
            Ok((n > 0, false))
        }
        Act::Unlink(id) => {
            let _ = conn_of(app).execute(
                "UPDATE bookmarks SET remote_id = NULL, remote_cfi = NULL, remote_seen = NULL, sync_state = 'local' WHERE id = ?1",
                [id],
            );
            Ok((false, false))
        }
        Act::Create(id) => {
            let Some(l) = local_bms(app, book_id).into_iter().find(|b| b.id == id && b.remote_id.is_none() && !b.deleted) else {
                return Ok((false, false));
            };
            let auto = norm(l.title.as_deref()).is_none().then(|| auto_name(&l));
            let title: String = norm(l.title.as_deref()).or(auto.clone()).unwrap_or_default().chars().take(255).collect();
            let body = match (kind, page_of(&l.cfi)) {
                (Kind::Pdf, Some(n)) => json!({ "bookId": gid, "pageNumber": n, "title": title }),
                (Kind::Comic, Some(n)) => json!({ "bookId": gid, "cfi": n.to_string(), "title": title }),
                _ => json!({ "bookId": gid, "cfi": l.cfi, "title": title }),
            };
            match write(app, reqwest::Method::POST, "/api/v1/bookmarks".into(), body).await? {
                Write::Saved(v) => {
                    let Some(mut s) = remote_bm(&v).and_then(|s| keyed(kind, vec![s]).pop()) else { return Ok((false, false)) };
                    // Grimmory takes no note when a bookmark is made: it goes in a second request
                    if let Some(n) = norm(l.note.as_deref()) {
                        let body = json!({ "title": title, "notes": n.chars().take(2000).collect::<String>() });
                        if let Write::Saved(v2) = write(app, reqwest::Method::PUT, format!("/api/v1/bookmarks/{}", s.id), body).await? {
                            if let Some(s2) = remote_bm(&v2).and_then(|s| keyed(kind, vec![s]).pop()) {
                                s = s2;
                            }
                        }
                    }
                    saved_bm(app, id, l.updated_at, &s, auto);
                    Ok((false, false))
                }
                Write::AlreadyThere => Ok((false, true)),
                Write::Refused => {
                    kept(app, "bookmarks", id);
                    Ok((false, false))
                }
                Write::Missing => Ok((false, false)),
            }
        }
        Act::Update { id, remote } => {
            let Some(l) = local_bms(app, book_id).into_iter().find(|b| b.id == id) else { return Ok((false, false)) };
            let auto = norm(l.title.as_deref()).is_none().then(|| l.seen.as_ref().and_then(|x| x.auto.clone()).unwrap_or_else(|| auto_name(&l)));
            let title: String = norm(l.title.as_deref()).or(auto.clone()).unwrap_or_default().chars().take(255).collect();
            let body = json!({ "title": title, "notes": l.note.clone().unwrap_or_default().chars().take(2000).collect::<String>() });
            match write(app, reqwest::Method::PUT, format!("/api/v1/bookmarks/{remote}"), body).await? {
                Write::Saved(v) => {
                    if let Some(s) = remote_bm(&v).and_then(|s| keyed(kind, vec![s]).pop()) {
                        saved_bm(app, id, l.updated_at, &s, auto);
                    }
                    Ok((false, false))
                }
                Write::Missing | Write::AlreadyThere => Ok((false, true)),
                Write::Refused => {
                    kept(app, "bookmarks", id);
                    Ok((false, false))
                }
            }
        }
        Act::Delete { id, remote } => {
            delete(app, format!("/api/v1/bookmarks/{remote}")).await?;
            let _ = conn_of(app).execute("DELETE FROM bookmarks WHERE id = ?1 AND deleted_at IS NOT NULL", [id]);
            Ok((false, false))
        }
    }
}

fn saved_bm(app: &AppHandle, id: i64, sent_at: i64, s: &RemoteBm, auto: Option<String>) {
    let seen = SeenBm { title: norm(s.title.as_deref()), notes: norm(s.notes.as_deref()), updated: secs(&s.updated), auto };
    let _ = conn_of(app).execute(
        "UPDATE bookmarks SET remote_id = ?2, remote_cfi = ?3, remote_seen = ?4,
            sync_state = CASE WHEN updated_at = ?5 AND deleted_at IS NULL THEN 'synced'
                              WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE 'dirty' END
         WHERE id = ?1",
        params![id, s.id, s.cfi, js(&seen), sent_at],
    );
}

// ---------- when ----------

fn timers() -> &'static Mutex<HashMap<i64, u64>> {
    static T: OnceLock<Mutex<HashMap<i64, u64>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// A mark changed: the book's marks go up about 4 seconds after the last change.
pub fn schedule(app: &AppHandle, book_id: i64) {
    if synced_gid(app, book_id).is_none() {
        return;
    }
    let n = {
        let mut t = timers().lock().unwrap();
        let n = t.entry(book_id).or_insert(0);
        *n += 1;
        *n
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if timers().lock().unwrap().get(&book_id) == Some(&n) && g(&app).signed_in() {
            if let Err(e) = sync_book(&app, book_id).await {
                eprintln!("katana: marks of book {book_id} wait: {e}");
            }
        }
    });
}

/// Every book with marks waiting to go up (at start, back online, Try again).
pub async fn push_all(app: &AppHandle) {
    if !g(app).signed_in() {
        return;
    }
    let ids: Vec<i64> = {
        let conn = conn_of(app);
        let Ok(mut st) = conn.prepare(
            "SELECT DISTINCT b.id FROM books b WHERE b.grimmory_id IS NOT NULL AND b.format IN ('epub', 'pdf', 'cbz', 'cbr') AND b.missing = 0 AND (
                (b.format = 'epub' AND EXISTS (SELECT 1 FROM highlights h WHERE h.book_id = b.id AND h.sync_state IN ('local', 'dirty', 'deleted')))
                OR EXISTS (SELECT 1 FROM bookmarks m WHERE m.book_id = b.id AND m.sync_state IN ('local', 'dirty', 'deleted')))",
        ) else {
            return;
        };
        let rows = st.query_map([], |r| r.get(0));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    };
    for id in ids {
        if let Err(e) = sync_book(app, id).await {
            eprintln!("katana: marks of book {id} wait: {e}");
            if matches!(e, GErr::Offline(_) | GErr::SignedOut) {
                break;
            }
        }
    }
}

const K_NOTEBOOK: &str = "grimmory.marksSeen";

/// After a library sync: one look at every book's marks (Grimmory's notebook, two requests), and a sync
/// of the books on this PC whose marks changed there since the last look.
pub async fn after_library_sync(app: &AppHandle) {
    let mut sigs: HashMap<i64, String> = HashMap::new();
    for kind in ["HIGHLIGHT", "BOOKMARK"] {
        let path = format!("/api/v1/notebook/export?types={kind}&sort=asc");
        let list = match get_list(app, path).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("katana: Grimmory's notebook: {e}");
                return;
            }
        };
        for v in list {
            let Some(gid) = v.get("bookId").and_then(|x| x.as_i64()) else { continue };
            let e = sigs.entry(gid).or_default();
            for k in ["type", "id", "updatedAt", "text", "note", "color", "style"] {
                e.push_str(&s(&v, k).unwrap_or_default());
                e.push('\u{1f}');
            }
            e.push('\u{1e}');
        }
    }
    let sig: HashMap<i64, String> = sigs.into_iter().map(|(k, v)| (k, format!("{:x}", <md5::Md5 as md5::Digest>::digest(v.as_bytes())))).collect();
    let before: HashMap<i64, String> =
        super::setting(app, K_NOTEBOOK).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let changed: HashSet<i64> = sig
        .iter()
        .filter(|(k, v)| before.get(k) != Some(v))
        .map(|(k, _)| *k)
        .chain(before.keys().filter(|k| !sig.contains_key(k)).copied())
        .collect();
    let books: Vec<i64> = {
        let conn = conn_of(app);
        let Ok(mut st) = conn.prepare("SELECT id, grimmory_id FROM books WHERE grimmory_id IS NOT NULL AND format IN ('epub', 'pdf', 'cbz', 'cbr') AND missing = 0") else {
            return;
        };
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)));
        rows.map(|r| r.flatten().filter(|(_, gid)| changed.contains(gid)).map(|(id, _)| id).collect()).unwrap_or_default()
    };
    let mut ok = true;
    for id in books {
        if let Err(e) = sync_book(app, id).await {
            eprintln!("katana: marks of book {id}: {e}");
            ok = false;
            break;
        }
    }
    if ok {
        super::set(app, K_NOTEBOOK, &js(&sig));
    }
}

// ---------- commands ----------

/// The reader opened a book: its marks sync now (offline, it reads what this PC has).
#[tauri::command]
pub async fn marks_sync_book(app: AppHandle, id: i64) -> bool {
    if synced_gid(&app, id).is_none() || !g(&app).signed_in() {
        return false;
    }
    match tokio::time::timeout(Duration::from_secs(20), sync_book(&app, id)).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            eprintln!("katana: marks of book {id}: {e}");
            false
        }
        Err(_) => false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lost {
    pub highlights: usize,
    pub bookmarks: usize,
}

/// Marks Grimmory no longer has, held back for this book: the reader asks what to do.
#[tauri::command]
pub fn marks_lost(id: i64) -> Option<Lost> {
    held().lock().unwrap().get(&id).map(|(h, b)| Lost { highlights: h.len(), bookmarks: b.len() })
}

/// His answer: remove them here too, or put them back on Grimmory (sent up again as new).
#[tauri::command]
pub async fn marks_lost_answer(app: AppHandle, id: i64, put_back: bool) {
    let Some((h, b)) = held().lock().unwrap().remove(&id) else { return };
    {
        let conn = conn_of(&app);
        for (table, ids) in [("highlights", &h), ("bookmarks", &b)] {
            for x in ids {
                let _ = if put_back {
                    conn.execute(
                        &format!("UPDATE {table} SET remote_id = NULL, remote_seen = NULL, sync_state = 'local' WHERE id = ?1"),
                        [x],
                    )
                } else {
                    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [x])
                };
            }
        }
    }
    let _ = app.emit("marks-changed", id);
    if put_back {
        let _ = sync_book(&app, id).await;
    }
}

/// How a book's marks stand with Grimmory, for the marks panel's line.
#[tauri::command]
pub fn marks_sync_state(app: AppHandle, id: i64) -> String {
    if synced_gid(&app, id).is_none() {
        let fmt: Option<String> = conn_of(&app).query_row("SELECT format FROM books WHERE id = ?1", [id], |r| r.get(0)).optional().ok().flatten();
        let linked: bool = conn_of(&app)
            .query_row("SELECT grimmory_id IS NOT NULL FROM books WHERE id = ?1", [id], |r| r.get(0))
            .unwrap_or(false);
        return if linked && fmt.as_deref().and_then(Kind::of).is_none() { "format".into() } else { "local".into() };
    }
    let waiting: i64 = conn_of(&app)
        .query_row(
            "SELECT (SELECT COUNT(*) FROM highlights h JOIN books b ON b.id = h.book_id WHERE h.book_id = ?1 AND b.format = 'epub'
                        AND h.sync_state IN ('local', 'dirty', 'deleted'))
                  + (SELECT COUNT(*) FROM bookmarks WHERE book_id = ?1 AND sync_state IN ('local', 'dirty', 'deleted'))",
            [id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if waiting > 0 {
        "waiting".into()
    } else {
        "synced".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    fn clock() -> Clock {
        // the server's wall clock is 3 hours ahead (Addis), clocks agree
        Clock { now: NOW, offset: Some(3 * 3600 * 1000) }
    }
    /// A zone-less server time `mins` minutes from NOW, as Grimmory writes it.
    fn server_time(mins: i64) -> String {
        let t = chrono::DateTime::from_timestamp_millis(NOW + mins * 60_000 + 3 * 3600 * 1000).unwrap();
        t.naive_utc().format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
    }
    fn rh(id: i64, cfi: &str, text: &str) -> RemoteHl {
        RemoteHl {
            id,
            cfi: Some(cfi.into()),
            text: text.into(),
            color: Some("#FACC15".into()),
            style: Some("highlight".into()),
            note: None,
            chapter: Some("One".into()),
            created: Some(server_time(-60)),
            updated: Some(server_time(-60)),
        }
    }
    fn lh(id: i64, cfi: &str, text: &str, remote: Option<&RemoteHl>, state: &str) -> LocalHl {
        LocalHl {
            id,
            cfi: cfi.into(),
            text: text.into(),
            color: "yellow".into(),
            style: "highlight".into(),
            note: None,
            updated_at: NOW - 60 * 60_000,
            deleted: false,
            remote_id: remote.map(|r| r.id),
            seen: remote.map(SeenHl::of),
            state: state.into(),
        }
    }
    const C1: &str = "epubcfi(/6/14!/4[ch]/2,/1:0,/1:20)";
    const C1_KO: &str = "epubcfi(/6/14!/4/2,/1:0,/1:20)";
    const C2: &str = "epubcfi(/6/14!/4[ch]/8,/1:5,/1:40)";

    #[test]
    fn clock_puts_zoneless_times_on_this_pc() {
        let c = clock();
        assert_eq!(c.at(Some(&server_time(-5))), Some(NOW - 5 * 60_000));
        assert_eq!(c.at(Some("2026-11-20T09:34:13Z")), Some(chrono::DateTime::parse_from_rfc3339("2026-11-20T09:34:13Z").unwrap().timestamp_millis()));
        // no offset: a zone-less time is no time
        assert_eq!(Clock { now: NOW, offset: None }.at(Some(&server_time(-5))), None);
        // more than a day ahead never counts
        assert_eq!(c.at(Some(&server_time(60 * 25))), None);
        // the health check: a zone-less local time read at NOW
        assert_eq!(offset_of(&server_time(0), NOW), Some(3 * 3600 * 1000));
        assert_eq!(offset_of("2026-11-20T15:00:00+03:00", NOW), Some(3 * 3600 * 1000));
    }

    #[test]
    fn times_compare_to_the_second() {
        assert_eq!(secs(&Some("2026-11-20T15:01:17.298547".into())).as_deref(), Some("2026-11-20T15:01:17"));
        assert_eq!(secs(&Some("2026-11-20T15:01:17.2Z".into())).as_deref(), Some("2026-11-20T15:01:17Z"));
        assert_eq!(secs(&Some("2026-11-20T15:01:17".into())).as_deref(), Some("2026-11-20T15:01:17"));
        let mut a = RemoteHl { updated: Some("2026-11-20T15:01:17.298547".into()), ..Default::default() };
        let seen = SeenHl::of(&a);
        a.updated = Some("2026-11-20T15:01:17".into());
        assert_eq!(seen, SeenHl::of(&a));
    }

    #[test]
    fn places_compare_without_ids() {
        assert!(same_place(C1, C1_KO));
        assert!(!same_place(C1, C2));
        assert_eq!(chapter_key(C1).as_deref(), Some("/6/14"));
        assert_eq!(words_key("Hard and\u{00AD} sharp "), "hardandsharp");
        assert_eq!(color_name(Some("#38bdf8")), "blue");
        assert_eq!(color_name(Some("#FFC107")), "yellow");
        assert_eq!(color_name(Some("#00FF7F")), "green");
        assert_eq!(color_name(None), "yellow");
        assert_eq!(style_name(Some("Squiggly")), "squiggly");
    }

    #[test]
    fn new_on_either_side() {
        let s = rh(5, C1, "words");
        let l = lh(1, C2, "other", None, "local");
        let p = plan_highlights(&[l], &[s.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Insert(s), Act::Create(1)]);
    }

    #[test]
    fn lost_answer_matches_by_place_or_words() {
        // made here, sent, the answer lost: the server has it under an id we don't know
        let s = rh(9, C1_KO, "the words");
        let l = lh(1, C1, "the words", None, "local");
        let p = plan_highlights(&[l.clone()], &[s.clone()], &clock());
        assert_eq!(p.acts, vec![Act::InStep { id: 1, server: s.clone() }]);
        // KOReader counted the characters a little differently: the same words in the same chapter
        let mut s2 = s.clone();
        s2.cfi = Some("epubcfi(/6/14!/4/2,/1:1,/1:21)".into());
        let p = plan_highlights(&[l], &[s2.clone()], &clock());
        assert_eq!(p.acts, vec![Act::InStep { id: 1, server: s2 }]);
    }

    #[test]
    fn changes_go_up_and_come_down() {
        let s = rh(5, C1, "w");
        // changed here: goes up
        let mut l = lh(1, C1, "w", Some(&s), "dirty");
        l.color = "pink".into();
        l.updated_at = NOW;
        let p = plan_highlights(&[l.clone()], &[s.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Link { id: 1, server: s.clone() }, Act::Update { id: 1, remote: 5 }]);
        // changed on the server, in step here: comes down
        let mut s2 = s.clone();
        s2.note = Some("from the web".into());
        s2.updated = Some(server_time(-1));
        let l2 = lh(1, C1, "w", Some(&s), "synced");
        let p = plan_highlights(&[l2], &[s2.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Take { id: 1, server: s2.clone() }]);
        // both changed: the server copy wins only when newer by more than 2 minutes
        let p = plan_highlights(&[l.clone()], &[s2.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Link { id: 1, server: s2.clone() }, Act::Update { id: 1, remote: 5 }]);
        let mut s3 = s2.clone();
        s3.updated = Some(server_time(3));
        let p = plan_highlights(&[l.clone()], &[s3.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Take { id: 1, server: s3.clone() }]);
        // without the server's clock, the change made here wins
        let p = plan_highlights(&[l], &[s3], &Clock { now: NOW, offset: None });
        assert!(matches!(p.acts.last(), Some(Act::Update { .. })));
    }

    #[test]
    fn removals_both_ways() {
        let s = rh(5, C1, "w");
        // removed here: the removal goes up
        let mut l = lh(1, C1, "w", Some(&s), "deleted");
        l.deleted = true;
        let p = plan_highlights(&[l.clone()], &[s.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Link { id: 1, server: s.clone() }, Act::Delete { id: 1, remote: 5 }]);
        // removed on the server: gone here
        let l2 = lh(2, C2, "x", Some(&rh(6, C2, "x")), "synced");
        let p = plan_highlights(&[l2.clone()], &[], &clock());
        assert_eq!(p.acts, vec![Act::Purge(2)]);
        // removed there but changed here meanwhile: goes back up as new
        let mut l3 = l2.clone();
        l3.state = "dirty".into();
        l3.note = Some("typed while it went".into());
        let p = plan_highlights(&[l3], &[], &clock());
        assert_eq!(p.acts, vec![Act::Unlink(2), Act::Create(2)]);
        // a tombstone the server no longer has: done
        let p = plan_highlights(&[l], &[], &clock());
        assert_eq!(p.acts, vec![Act::Purge(1)]);
    }

    #[test]
    fn a_server_that_lost_marks_is_not_believed() {
        let local: Vec<LocalHl> = (0..6)
            .map(|i| {
                let cfi = format!("epubcfi(/6/14!/4/{},/1:0,/1:3)", 2 * (i + 1));
                lh(i, &cfi, "w", Some(&rh(100 + i, &cfi, "w")), "synced")
            })
            .collect();
        let p = plan_highlights(&local, &[], &clock());
        assert!(p.acts.is_empty());
        assert_eq!(p.held.len(), 6);
        // one or two removed on the web still go at once
        let keep: Vec<RemoteHl> = local[2..].iter().map(|l| rh(l.remote_id.unwrap(), &l.cfi, "w")).collect();
        let p = plan_highlights(&local, &keep, &clock());
        assert_eq!(p.acts, vec![Act::Purge(0), Act::Purge(1)]);
        assert!(p.held.is_empty());
    }

    fn rb(id: i64, cfi: &str, title: Option<&str>) -> RemoteBm {
        RemoteBm { id, cfi: Some(cfi.into()), page_number: None, title: title.map(String::from), notes: None, created: Some(server_time(-60)), updated: Some(server_time(-60)) }
    }
    fn lb(id: i64, cfi: &str, remote: Option<(&RemoteBm, Option<&str>)>, state: &str) -> LocalBm {
        LocalBm {
            id,
            cfi: cfi.into(),
            chapter: Some("Stave One".into()),
            title: None,
            note: None,
            updated_at: NOW - 60 * 60_000,
            deleted: false,
            remote_id: remote.map(|r| r.0.id),
            seen: remote.map(|(r, auto)| SeenBm {
                title: r.title.clone(),
                notes: r.notes.clone(),
                updated: secs(&r.updated),
                auto: auto.map(String::from),
            }),
            state: state.into(),
        }
    }
    const B1: &str = "epubcfi(/6/14!/4/2/1:0)";

    #[test]
    fn bookmark_names_after_the_chapter_dont_come_back_as_names() {
        let s = rb(3, B1, Some("Stave One"));
        let l = lb(1, B1, Some((&s, Some("Stave One"))), "synced");
        let p = plan_bookmarks(&[l.clone()], &[s.clone()], &clock());
        assert!(p.acts.is_empty());
        // a web reader bookmark named after its chapter, matched by place, isn't a name either
        let l2 = lb(1, B1, None, "local");
        let p = plan_bookmarks(&[l2], &[s.clone()], &clock());
        assert_eq!(p.acts, vec![Act::InStep { id: 1, server: s.clone() }]);
        // a real name from the web comes down
        let mut s2 = s.clone();
        s2.title = Some("The knocker".into());
        s2.updated = Some(server_time(-2));
        let p = plan_bookmarks(&[l], &[s2.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Take { id: 1, server: s2 }]);
    }

    #[test]
    fn a_lost_answer_keeps_the_note_made_here() {
        // the note went in the second request, which never happened; the server copy looks newer
        let mut s = rb(3, B1, Some("Stave One"));
        s.updated = Some(server_time(0));
        let mut l = lb(1, B1, None, "local");
        l.note = Some("first ghost".into());
        l.updated_at = NOW - 10 * 60_000;
        let p = plan_bookmarks(&[l], &[s.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Link { id: 1, server: s }, Act::Update { id: 1, remote: 3 }]);
    }

    #[test]
    fn bookmark_removals_and_new() {
        let s = rb(3, B1, None);
        let l = lb(1, B1, Some((&s, None)), "synced");
        assert_eq!(plan_bookmarks(&[l.clone()], &[], &clock()).acts, vec![Act::Purge(1)]);
        let mut d = l.clone();
        d.deleted = true;
        d.state = "deleted".into();
        assert_eq!(plan_bookmarks(&[d], &[s.clone()], &clock()).acts, vec![Act::Link { id: 1, server: s.clone() }, Act::Delete { id: 1, remote: 3 }]);
        let n = lb(2, "epubcfi(/6/20!/4/2/1:0)", None, "local");
        assert_eq!(plan_bookmarks(&[n], &[s.clone()], &clock()).acts, vec![Act::Insert(s), Act::Create(2)]);
        // a PDF page bookmark on the server is left alone
        let pdf = RemoteBm { id: 8, cfi: None, ..Default::default() };
        assert!(plan_bookmarks(&[], &[pdf], &clock()).acts.is_empty());
    }

    #[test]
    fn page_bookmarks_key_by_page() {
        let pdf = RemoteBm { id: 1, page_number: Some(12), ..Default::default() };
        let comic = RemoteBm { id: 2, cfi: Some("7".into()), ..Default::default() };
        let epub = RemoteBm { id: 3, cfi: Some(B1.into()), ..Default::default() };
        let all = vec![pdf.clone(), comic.clone(), epub.clone()];
        // each kind takes only its own: a PDF's pageNumber, a comic's page in cfi, an EPUB's CFI
        let k = keyed(Kind::Pdf, all.clone());
        assert_eq!(k.len(), 1);
        assert_eq!(k[0].cfi.as_deref(), Some("page:12"));
        let k = keyed(Kind::Comic, all.clone());
        assert_eq!((k.len(), k[0].cfi.as_deref()), (1, Some("page:7")));
        let k = keyed(Kind::Epub, all);
        assert_eq!((k.len(), k[0].id), (1, 3));
        assert_eq!(Kind::of("cbr"), Some(Kind::Comic));
        assert_eq!(Kind::of("djvu"), None);
    }

    #[test]
    fn page_bookmarks_plan_like_epub_ones() {
        let s = RemoteBm { id: 5, cfi: Some("page:12".into()), title: Some("Page 12".into()), updated: Some(server_time(-60)), ..Default::default() };
        // the same page made here and on Grimmory: one bookmark, linked
        let mut l = lb(1, "page:12", None, "local");
        l.chapter = Some("Chapter 2".into());
        let p = plan_bookmarks(&[l.clone()], &[s.clone()], &clock());
        assert!(matches!(p.acts.as_slice(), [Act::InStep { id: 1, .. }]), "{:?}", p.acts);
        // another page: both stay, each goes to the other side
        let other = lb(2, "page:30", None, "local");
        let p = plan_bookmarks(&[other], &[s.clone()], &clock());
        assert_eq!(p.acts, vec![Act::Insert(s), Act::Create(2)]);
        // unnamed, it goes up as "Page 30", the way Grimmory's own readers name theirs
        assert_eq!(auto_name(&lb(2, "page:30", None, "local")), "Page 30");
        assert_eq!(page_of("page:30:5-9"), Some(30));
    }
}
