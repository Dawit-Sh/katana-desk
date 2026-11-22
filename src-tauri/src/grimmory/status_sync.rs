//! Reading statuses both ways with Grimmory (Unread, Reading, Re-reading, Read, ...), whichever device set them.
//!
//! **Down:** a status changed on Grimmory's own site, or by Katana on a phone, may not move the book's
//! last-read time, so the library's quick sync (new books, places that moved) wouldn't see it. Every library
//! sync therefore asks Grimmory for its books by status (`/api/v1/app/books/ids?status=READ` and the rest,
//! eight small lists; a book with no status is in none) and takes the ones that differ from what this PC
//! holds. A book on this PC whose status changed there follows: Unread empties its place (the place sync
//! decides, so a place read here since still goes up), Read gives it the day it was finished.
//!
//! **Up:** a status set here goes to Grimmory at once (`grimmory_set_status`); when Grimmory can't be
//! reached it waits here (the setting `grimmory.statusWaiting`) and goes up when Grimmory answers again,
//! and the pull leaves it alone meanwhile.

use super::sync::STATUSES;
use super::{conn_of, json, send, set, setting, GErr, GRes};
use futures_util::{stream, StreamExt};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::AppHandle;

const K_WAITING: &str = "grimmory.statusWaiting";

/// Statuses set here that haven't reached Grimmory yet: Grimmory book id -> status.
pub fn waiting(app: &AppHandle) -> BTreeMap<i64, String> {
    setting(app, K_WAITING).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_waiting(app: &AppHandle, w: &BTreeMap<i64, String>) {
    set(app, K_WAITING, &serde_json::to_string(w).unwrap_or_else(|_| "{}".into()));
}

/// A status set here while Grimmory can't be reached: kept until it answers.
pub fn wait(app: &AppHandle, gid: i64, status: &str) {
    let mut w = waiting(app);
    w.insert(gid, status.to_string());
    save_waiting(app, &w);
}

/// A status that reached Grimmory: no longer waiting.
pub fn sent(app: &AppHandle, gid: i64) {
    let mut w = waiting(app);
    if w.remove(&gid).is_some() {
        save_waiting(app, &w);
    }
}

/// Sends the statuses waiting here, oldest book id first; stops at the first that can't get through.
pub async fn push(app: &AppHandle) {
    for (gid, status) in waiting(app) {
        let body = serde_json::json!({ "bookIds": [gid], "status": status });
        match send(app, move |c, base, tok| c.post(format!("{base}/api/v1/books/status")).bearer_auth(tok).json(&body)).await {
            Ok(r) if r.status().is_success() => sent(app, gid),
            // the book is gone from Grimmory, or Grimmory refuses the status: nothing will change that
            Ok(r) if r.status().is_client_error() => sent(app, gid),
            _ => return,
        }
    }
}

/// The statuses this PC holds for Grimmory's books (none for a book without one).
pub fn stored(app: &AppHandle) -> HashMap<i64, Option<String>> {
    let conn = conn_of(app);
    let Ok(mut st) = conn.prepare("SELECT id, read_status FROM gbooks") else { return HashMap::new() };
    let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)));
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

/// Grimmory's books by status, from its eight lists. None when a list didn't come, or when the server
/// ignores the filter (a book in two lists): nothing is changed then.
pub fn from_lists(lists: &[(&str, Vec<i64>)]) -> Option<HashMap<i64, String>> {
    let mut out = HashMap::new();
    for (status, ids) in lists {
        for id in ids {
            if out.insert(*id, status.to_string()).is_some() {
                return None;
            }
        }
    }
    Some(out)
}

/// The books whose status on Grimmory differs from the one held here, with the new one (none: no status
/// any more), leaving out the books whose status set here is still on its way up. In book order.
pub fn changes(stored: &HashMap<i64, Option<String>>, server: &HashMap<i64, String>, waiting: &BTreeMap<i64, String>) -> Vec<(i64, Option<String>)> {
    let mut out: Vec<(i64, Option<String>)> = stored
        .iter()
        .filter(|(id, _)| !waiting.contains_key(id))
        .filter_map(|(id, here)| {
            let there = server.get(id).cloned();
            (here.as_deref() != there.as_deref()).then_some((*id, there))
        })
        .collect();
    out.sort_by_key(|(id, _)| *id);
    out
}

/// Takes Grimmory's statuses into the library here. Returns how many changed.
pub async fn pull(app: &AppHandle) -> GRes<usize> {
    let answers: Vec<GRes<serde_json::Value>> = stream::iter(STATUSES.map(String::from))
        .map(|status: String| json(app, move |c, base, tok| c.get(format!("{base}/api/v1/app/books/ids")).bearer_auth(tok).query(&[("status", status.as_str())])))
        .buffered(4)
        .collect()
        .await;
    let mut lists = vec![];
    for (status, v) in STATUSES.into_iter().zip(answers) {
        let v = v?;
        let ids = v.as_array().ok_or_else(|| GErr::Other("Grimmory's status list isn't a list".into()))?.iter().filter_map(|x| x.as_i64()).collect();
        lists.push((status, ids));
    }
    let Some(server) = from_lists(&lists) else {
        eprintln!("katana: Grimmory ignores the status filter; statuses come down with the full sync only");
        return Ok(0);
    };
    let todo = changes(&stored(app), &server, &waiting(app));
    let conn = conn_of(app);
    for (gid, status) in &todo {
        let _ = conn.execute("UPDATE gbooks SET read_status = ?2 WHERE id = ?1", rusqlite::params![gid, status]);
    }
    Ok(todo.len())
}

/// After a library sync: the books on this PC whose Grimmory status changed since `before`, and the ones
/// that became Read get the day they were finished. Returns their Grimmory ids (their places are looked at
/// next, which is how Unread empties a place here). Books new to this PC (no status held before) are left.
pub fn follow(app: &AppHandle, before: &HashMap<i64, Option<String>>) -> Vec<i64> {
    let after = stored(app);
    let linked: HashSet<i64> = {
        let conn = conn_of(app);
        let Ok(mut st) = conn.prepare("SELECT DISTINCT grimmory_id FROM books WHERE grimmory_id IS NOT NULL AND missing = 0") else { return vec![] };
        let rows = st.query_map([], |r| r.get(0));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    };
    let mut out = vec![];
    for gid in linked {
        let (Some(was), Some(now)) = (before.get(&gid), after.get(&gid)) else { continue };
        if was == now {
            continue;
        }
        if now.as_deref() == Some("READ") {
            let ids: Vec<i64> = {
                let conn = conn_of(app);
                let mut st = match conn.prepare("SELECT id FROM books WHERE grimmory_id = ?1") {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let rows = st.query_map([gid], |r| r.get(0));
                rows.map(|r| r.flatten().collect()).unwrap_or_default()
            };
            for id in ids {
                let _ = crate::reads::mark_finished(&conn_of(app), id, false);
            }
        }
        out.push(gid);
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_come_from_the_lists_and_a_server_that_ignores_the_filter_changes_nothing() {
        let got = from_lists(&[("READ", vec![1, 2]), ("UNREAD", vec![3]), ("PAUSED", vec![])]).unwrap();
        assert_eq!(got.get(&1).map(String::as_str), Some("READ"));
        assert_eq!(got.get(&3).map(String::as_str), Some("UNREAD"));
        assert_eq!(got.get(&4), None);
        // every list holding every book: the filter isn't there
        assert!(from_lists(&[("READ", vec![1, 2]), ("UNREAD", vec![1, 2])]).is_none());
    }

    #[test]
    fn a_status_changed_on_grimmory_comes_down_unless_one_set_here_waits_to_go_up() {
        let stored: HashMap<i64, Option<String>> = [
            (1, Some("READING".to_string())), // marked unread on the phone
            (2, Some("READ".to_string())),    // the same both sides
            (3, None),                        // set to Paused on Grimmory's site
            (4, Some("READING".to_string())), // its status there was taken away
            (5, Some("ABANDONED".to_string())), // set here while offline, still waiting
        ]
        .into_iter()
        .collect();
        let server: HashMap<i64, String> = [(1, "UNREAD"), (2, "READ"), (3, "PAUSED"), (5, "READING")].into_iter().map(|(k, v)| (k, v.to_string())).collect();
        let waiting: BTreeMap<i64, String> = [(5, "ABANDONED".to_string())].into_iter().collect();
        assert_eq!(
            changes(&stored, &server, &waiting),
            vec![(1, Some("UNREAD".to_string())), (3, Some("PAUSED".to_string())), (4, None)]
        );
    }
}
