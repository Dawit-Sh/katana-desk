//! My words both ways with a phone. The desk only lists and takes; the phone keeps what both sides had after the
//! last sync, so it can tell a word removed on one side from a word new on the other. Only words tied to a book
//! the phone matched travel (by the desk's book id); a word is the same word on both sides when its text (any case)
//! and its book are the same, whatever its id. A change only lands when it is newer than the word here.

use crate::db::now;
use crate::marks::new_uuid;
use crate::words;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

/// A word as the phone sends it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PeerWord {
    pub word: String,
    pub book_id: i64,
    pub sentence: Option<String>,
    pub chapter: Option<String>,
    pub fraction: Option<f64>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a phone sends: words to save or change, and words it removed.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PeerWords {
    pub words: Vec<PeerWord>,
    pub removed: Vec<PeerWord>,
}

/// Every saved word tied to a book, for the phone.
pub fn list_json(conn: &Connection) -> rusqlite::Result<Value> {
    let rows: Vec<Value> = words::list(conn, None)?
        .iter()
        .filter_map(|w| {
            w.book_id.map(|b| {
                json!({
                    "word": w.word, "headword": w.headword, "bookId": b, "bookTitle": w.book_title, "bookAuthor": w.book_author,
                    "sentence": w.sentence, "chapter": w.chapter, "fraction": w.fraction, "note": w.note,
                    "createdAt": w.created_at, "updatedAt": w.updated_at,
                })
            })
        })
        .collect();
    Ok(json!({ "words": rows }))
}

// The word here that is the phone's word: same text and same book.
fn same(conn: &Connection, w: &PeerWord) -> rusqlite::Result<Option<words::Word>> {
    Ok(words::find(conn, w.word.trim())?.filter(|f| f.book_id == Some(w.book_id) && words::key(&f.word) == words::key(&w.word)))
}

/// Saves the phone's word, or changes the one here when the phone's change is newer. True when something changed.
pub fn take(conn: &Connection, w: &PeerWord) -> rusqlite::Result<bool> {
    let text = w.word.trim();
    if text.is_empty() {
        return Ok(false);
    }
    let at = if w.updated_at > 0 { w.updated_at } else { now() };
    if let Some(found) = same(conn, w)? {
        let newer = at > found.updated_at;
        if newer {
            conn.execute(
                "UPDATE words SET sentence = ?2, chapter = COALESCE(?3, chapter), fraction = COALESCE(?4, fraction), note = ?5, updated_at = ?6 WHERE id = ?1",
                params![found.id, w.sentence, w.chapter, w.fraction, w.note, at],
            )?;
        }
        return Ok(newer);
    }
    let (title, author): (Option<String>, Option<String>) = conn
        .query_row("SELECT title, author FROM books WHERE id = ?1", [w.book_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .unwrap_or((None, None));
    let created = if w.created_at > 0 { w.created_at } else { at };
    // A word saved here already from another book keeps its place (a headword is saved once).
    let n = conn.execute(
        "INSERT OR IGNORE INTO words (uuid, word, headword, book_id, book_title, book_author, sentence, chapter, fraction, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![new_uuid(), text, words::key(text), w.book_id, title, author, w.sentence, w.chapter, w.fraction, w.note, created, at],
    )?;
    Ok(n > 0)
}

/// Removes the word the phone removed (same text, same book). True when there was one.
pub fn drop(conn: &Connection, w: &PeerWord) -> rusqlite::Result<bool> {
    match same(conn, w)? {
        Some(found) => Ok(conn.execute("DELETE FROM words WHERE id = ?1", [found.id])? > 0),
        None => Ok(false),
    }
}

/// Takes all of a phone's words and removals; how many words here changed.
pub fn apply(conn: &Connection, sent: &PeerWords) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for w in &sent.words {
        changed += usize::from(take(conn, w)?);
    }
    for w in &sent.removed {
        changed += usize::from(drop(conn, w)?);
    }
    Ok(changed)
}

/// `POST /katana-sync/v1/words`: `{"words": [...], "removed": [...]}`; answers how many words here changed, and
/// tells My words to show them.
pub fn post(app: &tauri::AppHandle, v: &Value) -> Result<Value, String> {
    use tauri::Emitter;
    let sent: PeerWords = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
    let changed = apply(&crate::grimmory::conn_of(app), &sent).map_err(|e| e.to_string())?;
    if changed > 0 {
        let _ = app.emit("words-changed", ());
    }
    Ok(json!({ "changed": changed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author TEXT); INSERT INTO books VALUES (1, 'A Christmas Carol', 'Charles Dickens');")
            .unwrap();
        c.execute_batch(words::SCHEMA_V5).unwrap();
        c
    }

    fn word(text: &str, sentence: &str, at: i64) -> PeerWord {
        PeerWord { word: text.into(), book_id: 1, sentence: Some(sentence.into()), created_at: at, updated_at: at, ..Default::default() }
    }

    #[test]
    fn a_new_word_comes_with_its_book() {
        let c = conn();
        assert!(take(&c, &word("Humbug", "Bah, humbug!", 10)).unwrap());
        let listed = list_json(&c).unwrap();
        assert_eq!(listed["words"][0]["bookId"], 1);
        assert_eq!(listed["words"][0]["bookTitle"], "A Christmas Carol");
        assert_eq!(listed["words"][0]["updatedAt"], 10);
    }

    #[test]
    fn the_same_word_is_never_saved_twice() {
        let c = conn();
        take(&c, &word("humbug", "Bah, humbug!", 10)).unwrap();
        assert!(!take(&c, &word("Humbug", "Bah, humbug!", 5)).unwrap());
        assert_eq!(words::list(&c, None).unwrap().len(), 1);
    }

    #[test]
    fn the_newer_change_wins() {
        let c = conn();
        take(&c, &word("humbug", "old", 10)).unwrap();
        assert!(!take(&c, &word("humbug", "older", 5)).unwrap());
        assert!(take(&c, &word("humbug", "new", 20)).unwrap());
        assert_eq!(words::list(&c, None).unwrap()[0].sentence.as_deref(), Some("new"));
    }

    #[test]
    fn a_removed_word_goes() {
        let c = conn();
        take(&c, &word("humbug", "Bah, humbug!", 10)).unwrap();
        let other_book = PeerWord { book_id: 2, ..word("humbug", "", 0) };
        assert!(!drop(&c, &other_book).unwrap());
        let sent = PeerWords { words: vec![], removed: vec![word("HUMBUG", "", 0)] };
        assert_eq!(apply(&c, &sent).unwrap(), 1);
        assert!(words::list(&c, None).unwrap().is_empty());
    }
}
