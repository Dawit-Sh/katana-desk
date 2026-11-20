//! My words: words saved from the word card with the sentence and book they came from, their meaning
//! from the built-in dictionary, and their flashcard review. Shaped like Katana's `saved_words` on
//! Android (uuid, book title and author, word, sentence, chapter, place, note, created, review level,
//! due and reviewed times) so the two can sync later.
//!
//! Also the learning numbers the Journal shows (milestone 7): every review answer, word learned,
//! highlight / note / bookmark / word gone back to, highlight edited and word looked up is one row
//! in `learning`, with its local day.

use crate::db::now;
use crate::marks::new_uuid;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const SCHEMA_V5: &str = "
CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE,
    word TEXT NOT NULL,
    headword TEXT NOT NULL,
    book_id INTEGER,
    book_title TEXT,
    book_author TEXT,
    sentence TEXT,
    chapter TEXT,
    cfi TEXT,
    fraction REAL,
    page_label TEXT,
    meaning TEXT,
    pos TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    review_level INTEGER NOT NULL DEFAULT 0,
    review_due_at INTEGER,
    reviewed_at INTEGER,
    learned_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS words_headword ON words(headword);
CREATE INDEX IF NOT EXISTS words_book ON words(book_id);
CREATE TABLE IF NOT EXISTS learning (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    book_id INTEGER,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS learning_kind_at ON learning(kind, at);
";

/// Known at the 7-day step (three right answers on three different days): learned.
pub const LEARNED_LEVEL: i64 = 3;
const DAY: i64 = 24 * 60 * 60 * 1000;
/// Katana's schedule: known moves a word a step on (1, 3, 7, 14, 30 days); Again starts it over.
const INTERVAL_DAYS: [i64; 5] = [1, 3, 7, 14, 30];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub id: i64,
    pub uuid: String,
    pub word: String,
    pub headword: String,
    pub book_id: Option<i64>,
    pub book_title: Option<String>,
    pub book_author: Option<String>,
    pub sentence: Option<String>,
    pub chapter: Option<String>,
    pub cfi: Option<String>,
    pub fraction: Option<f64>,
    pub page_label: Option<String>,
    pub meaning: Option<String>,
    pub pos: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub review_level: i64,
    pub review_due_at: Option<i64>,
    pub reviewed_at: Option<i64>,
    pub learned_at: Option<i64>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewWord {
    pub word: String,
    pub headword: String,
    pub book_id: Option<i64>,
    pub sentence: Option<String>,
    pub chapter: Option<String>,
    pub cfi: Option<String>,
    pub fraction: Option<f64>,
    pub page_label: Option<String>,
    pub meaning: Option<String>,
    pub pos: Option<String>,
}

const COLS: &str = "id, uuid, word, headword, book_id, book_title, book_author, sentence, chapter, cfi, fraction, page_label, meaning, pos, note, created_at, updated_at, review_level, review_due_at, reviewed_at, learned_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Word> {
    Ok(Word {
        id: r.get(0)?,
        uuid: r.get(1)?,
        word: r.get(2)?,
        headword: r.get(3)?,
        book_id: r.get(4)?,
        book_title: r.get(5)?,
        book_author: r.get(6)?,
        sentence: r.get(7)?,
        chapter: r.get(8)?,
        cfi: r.get(9)?,
        fraction: r.get(10)?,
        page_label: r.get(11)?,
        meaning: r.get(12)?,
        pos: r.get(13)?,
        note: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
        review_level: r.get(17)?,
        review_due_at: r.get(18)?,
        reviewed_at: r.get(19)?,
        learned_at: r.get(20)?,
    })
}

pub fn key(headword: &str) -> String {
    crate::dict::morph::key_of(headword)
}

pub fn list(conn: &Connection, book_id: Option<i64>) -> rusqlite::Result<Vec<Word>> {
    let sql = format!("SELECT {COLS} FROM words WHERE ?1 IS NULL OR book_id = ?1 ORDER BY created_at DESC");
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map([book_id], row)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Word>> {
    conn.query_row(&format!("SELECT {COLS} FROM words WHERE id = ?1"), [id], row).optional()
}

/// The saved word for a headword (or the word as selected).
pub fn find(conn: &Connection, word: &str) -> rusqlite::Result<Option<Word>> {
    conn.query_row(&format!("SELECT {COLS} FROM words WHERE headword = ?1 OR lower(word) = ?1 LIMIT 1"), [key(word)], row).optional()
}

/// Saves a word; one already saved stays as it is (its first sentence and book are kept).
pub fn save(conn: &Connection, w: &NewWord) -> rusqlite::Result<Word> {
    let hw = key(if w.headword.trim().is_empty() { &w.word } else { &w.headword });
    if let Some(found) = conn.query_row(&format!("SELECT {COLS} FROM words WHERE headword = ?1"), [&hw], row).optional()? {
        return Ok(found);
    }
    let (title, author): (Option<String>, Option<String>) = match w.book_id {
        Some(b) => conn.query_row("SELECT title, author FROM books WHERE id = ?1", [b], |r| Ok((r.get(0)?, r.get(1)?))).optional()?.unwrap_or((None, None)),
        None => (None, None),
    };
    let t = now();
    conn.execute(
        "INSERT INTO words (uuid, word, headword, book_id, book_title, book_author, sentence, chapter, cfi, fraction, page_label, meaning, pos, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![new_uuid(), w.word.trim(), hw, w.book_id, title, author, w.sentence, w.chapter, w.cfi, w.fraction, w.page_label, w.meaning, w.pos, t],
    )?;
    get(conn, conn.last_insert_rowid()).map(|o| o.expect("just saved"))
}

pub fn remove(conn: &Connection, id: i64) -> rusqlite::Result<Option<Word>> {
    let w = get(conn, id)?;
    conn.execute("DELETE FROM words WHERE id = ?1", [id])?;
    Ok(w)
}

/// Undo: a word just removed comes back as it was.
pub fn restore(conn: &Connection, w: &Word) -> rusqlite::Result<Word> {
    conn.execute(
        &format!("INSERT OR IGNORE INTO words ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)"),
        params![
            w.id, w.uuid, w.word, w.headword, w.book_id, w.book_title, w.book_author, w.sentence, w.chapter, w.cfi, w.fraction,
            w.page_label, w.meaning, w.pos, w.note, w.created_at, w.updated_at, w.review_level, w.review_due_at, w.reviewed_at, w.learned_at
        ],
    )?;
    Ok(get(conn, w.id)?.unwrap_or_else(|| w.clone()))
}

pub fn set_note(conn: &Connection, id: i64, note: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE words SET note = ?2, updated_at = ?3 WHERE id = ?1", params![id, note.map(str::trim).filter(|n| !n.is_empty()), now()])?;
    Ok(())
}

pub fn set_meaning(conn: &Connection, id: i64, meaning: &str, pos: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE words SET meaning = ?2, pos = COALESCE(pos, ?3) WHERE id = ?1", params![id, meaning, pos])?;
    Ok(())
}

pub fn without_meaning(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut st = conn.prepare("SELECT id, headword FROM words WHERE meaning IS NULL OR meaning = ''")?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Whether a word is up for review: never reviewed, or its day has come.
pub fn is_due(w: &Word, at: i64) -> bool {
    w.review_due_at.map_or(true, |d| d <= at)
}

/// The words to review now (or all), those waiting longest first, as on Android.
pub fn due(conn: &Connection, book_id: Option<i64>, all: bool) -> rusqlite::Result<Vec<Word>> {
    let t = now();
    let mut list: Vec<Word> = list(conn, book_id)?.into_iter().filter(|w| all || is_due(w, t)).collect();
    list.sort_by_key(|w| (w.review_due_at.is_some(), w.review_due_at.unwrap_or(0), w.created_at));
    Ok(list)
}

/// A word's level and when it's next due after an answer.
pub fn next(level: i64, known: bool, at: i64) -> (i64, i64) {
    if !known {
        return (0, at);
    }
    let lv = (level.max(0) + 1).min(INTERVAL_DAYS.len() as i64);
    (lv, at + INTERVAL_DAYS[(lv - 1) as usize] * DAY)
}

/// A flashcard answer: the new level and due time, and the answer kept for the Journal. `first`: the
/// first answer for this word in the round (the Journal's "on the first try").
pub fn answer(conn: &Connection, id: i64, known: bool, first: bool, day: &str) -> rusqlite::Result<Option<Word>> {
    let Some(w) = get(conn, id)? else { return Ok(None) };
    let t = now();
    let (level, due) = next(w.review_level, known, t);
    let learned_now = level >= LEARNED_LEVEL && w.learned_at.is_none();
    conn.execute(
        "UPDATE words SET review_level = ?2, review_due_at = ?3, reviewed_at = ?4, learned_at = CASE WHEN ?5 THEN ?4 ELSE learned_at END WHERE id = ?1",
        params![id, level, due, t, learned_now],
    )?;
    let detail = serde_json::json!({ "known": known, "first": first, "level": level }).to_string();
    log(conn, "review", Some(&w.uuid), w.book_id, Some(&detail), day)?;
    if learned_now {
        log(conn, "learned", Some(&w.uuid), w.book_id, None, day)?;
    }
    get(conn, id)
}

/// One learning event: kind is review, learned, revisit, edit or lookup.
pub fn log(conn: &Connection, kind: &str, r: Option<&str>, book_id: Option<i64>, detail: Option<&str>, day: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO learning (at, day, kind, ref, book_id, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now(), day, kind, r, book_id, detail],
    )?;
    Ok(())
}

// ---------- the Journal's learning numbers ----------

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WordCounts {
    pub total: i64,
    pub new: i64,
    pub learning: i64,
    pub learned: i64,
    pub due: i64,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reviews {
    pub total: i64,
    pub year: i64,
    /// of the words met for the first time in a round this year, the share known at once (0..1)
    pub first_try: Option<f64>,
    /// the last 12 weeks (Monday to Sunday), oldest first, this week last
    pub weeks: Vec<i64>,
    pub learned_year: i64,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Most {
    pub text: String,
    pub times: i64,
    pub book_id: Option<i64>,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Revisits {
    pub year: i64,
    pub weeks: Vec<i64>,
    pub highlights: i64,
    pub notes: i64,
    pub bookmarks: i64,
    pub words: i64,
    /// highlights edited this year (colour, style or note)
    pub edits: i64,
    pub most: Option<Most>,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Learning {
    pub words: WordCounts,
    pub reviews: Reviews,
    pub revisits: Revisits,
    pub lookups_year: i64,
    pub lookup_weeks: Vec<i64>,
}

/// Counts per week for the last 12 weeks; `monday` is this week's Monday ("YYYY-MM-DD").
fn weeks(conn: &Connection, kind: &str, monday: chrono::NaiveDate) -> rusqlite::Result<Vec<i64>> {
    let mut out = vec![0i64; 12];
    let from = monday - chrono::Duration::weeks(11);
    let mut st = conn.prepare("SELECT day, COUNT(*) FROM learning WHERE kind = ?1 AND day >= ?2 GROUP BY day")?;
    let rows = st.query_map(params![kind, from.format("%Y-%m-%d").to_string()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for (day, n) in rows.flatten() {
        if let Ok(d) = chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d") {
            let w = (d - from).num_days() / 7;
            if (0..12).contains(&w) {
                out[w as usize] += n;
            }
        }
    }
    Ok(out)
}

pub fn stats(conn: &Connection, today: chrono::NaiveDate) -> rusqlite::Result<Learning> {
    use chrono::Datelike;
    let t = now();
    let all = list(conn, None)?;
    let mut words = WordCounts { total: all.len() as i64, ..Default::default() };
    for w in &all {
        if w.reviewed_at.is_none() {
            words.new += 1;
        } else if w.review_level >= LEARNED_LEVEL {
            words.learned += 1;
        } else {
            words.learning += 1;
        }
        if is_due(w, t) {
            words.due += 1;
        }
    }
    let year = format!("{}-01-01", today.year());
    let monday = today - chrono::Duration::days(today.weekday().num_days_from_monday() as i64);
    let count = |kind: &str, extra: &str| -> rusqlite::Result<i64> {
        conn.query_row(&format!("SELECT COUNT(*) FROM learning WHERE kind = ?1 AND day >= ?2 {extra}"), params![kind, year], |r| r.get(0))
    };
    let firsts: (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(json_extract(detail, '$.known')), 0) FROM learning
         WHERE kind = 'review' AND day >= ?1 AND json_extract(detail, '$.first') = 1",
        [&year],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let reviews = Reviews {
        total: conn.query_row("SELECT COUNT(*) FROM learning WHERE kind = 'review'", [], |r| r.get(0))?,
        year: count("review", "")?,
        first_try: if firsts.0 > 0 { Some(firsts.1 as f64 / firsts.0 as f64) } else { None },
        weeks: weeks(conn, "review", monday)?,
        learned_year: count("learned", "")?,
    };
    let most = conn
        .query_row(
            "SELECT h.text, COUNT(*) AS n, h.book_id FROM learning l JOIN highlights h ON h.uuid = l.ref
             WHERE l.kind = 'revisit' AND l.day >= ?1 AND h.sync_state != 'deleted'
             GROUP BY l.ref ORDER BY n DESC, MAX(l.at) DESC LIMIT 1",
            [&year],
            |r| Ok(Most { text: r.get(0)?, times: r.get(1)?, book_id: r.get(2)? }),
        )
        .optional()?
        .filter(|m| m.times > 1);
    let revisits = Revisits {
        year: count("revisit", "")?,
        weeks: weeks(conn, "revisit", monday)?,
        highlights: count("revisit", "AND detail = 'highlight'")?,
        notes: count("revisit", "AND detail = 'note'")?,
        bookmarks: count("revisit", "AND detail = 'bookmark'")?,
        words: count("revisit", "AND detail = 'word'")?,
        edits: count("edit", "")?,
        most,
    };
    Ok(Learning { words, reviews, revisits, lookups_year: count("lookup", "")?, lookup_weeks: weeks(conn, "lookup", monday)? })
}

// ---------- Markdown ----------

/// The sentence with the word in bold (its first appearance, any case).
pub fn bold_in(sentence: &str, word: &str) -> String {
    match word_at(sentence, word) {
        Some(i) => format!("{}**{}**{}", &sentence[..i], &sentence[i..i + word.len()], &sentence[i + word.len()..]),
        None => sentence.to_string(),
    }
}

/// Where the word stands on its own in the sentence (not inside a longer word), any case.
pub fn word_at(sentence: &str, word: &str) -> Option<usize> {
    let lower = sentence.to_lowercase();
    let w = word.to_lowercase();
    if w.is_empty() || lower.len() != sentence.len() || w.len() != word.len() {
        return None;
    }
    let mut from = 0;
    while let Some(j) = lower[from..].find(&w) {
        let i = from + j;
        let before = lower[..i].chars().next_back().map_or(false, |c| c.is_alphanumeric());
        let after = lower[i + w.len()..].chars().next().map_or(false, |c| c.is_alphanumeric());
        if !before && !after {
            return Some(i);
        }
        from = i + w.len();
    }
    None
}

/// My words as Markdown: each word with its meaning, the sentence it came from and the book.
pub fn markdown(words: &[Word], date: &str) -> String {
    let mut s = format!("# My words\n\nExported from Katana Desk on {date} · {} words\n", words.len());
    for w in words {
        s.push_str(&format!("\n## {}\n\n", w.word));
        if let Some(m) = &w.meaning {
            match &w.pos {
                Some(p) => s.push_str(&format!("*{p}* · {m}\n\n")),
                None => s.push_str(&format!("{m}\n\n")),
            }
        }
        if let Some(t) = &w.sentence {
            s.push_str(&format!("> {}\n\n", bold_in(t, &w.word)));
        }
        let place = w.page_label.as_ref().map(|p| format!(", p. {p}")).unwrap_or_default();
        if let Some(b) = &w.book_title {
            s.push_str(&format!("From *{b}*{place}\n"));
        }
        if let Some(n) = &w.note {
            s.push_str(&format!("\nNote: {n}\n"));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author TEXT); INSERT INTO books VALUES (1, 'A Christmas Carol', 'Charles Dickens');
                         CREATE TABLE highlights (id INTEGER PRIMARY KEY, uuid TEXT, book_id INTEGER, text TEXT, sync_state TEXT);").unwrap();
        c.execute_batch(SCHEMA_V5).unwrap();
        c
    }

    fn nw(word: &str, head: &str) -> NewWord {
        NewWord {
            word: word.into(),
            headword: head.into(),
            book_id: Some(1),
            sentence: Some(format!("the deadliest piece of {word} in the trade.")),
            chapter: None,
            cfi: None,
            fraction: Some(0.1),
            page_label: Some("11".into()),
            meaning: None,
            pos: None,
        }
    }

    #[test]
    fn saving_twice_keeps_one_word_with_its_first_sentence() {
        let c = conn();
        let a = save(&c, &nw("Ironmongery", "ironmongery")).unwrap();
        assert_eq!(a.book_title.as_deref(), Some("A Christmas Carol"));
        let b = save(&c, &nw("ironmongery", "ironmongery")).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(list(&c, None).unwrap().len(), 1);
        assert!(find(&c, "IRONMONGERY").unwrap().is_some());
        let gone = remove(&c, a.id).unwrap().unwrap();
        assert!(list(&c, None).unwrap().is_empty());
        restore(&c, &gone).unwrap();
        assert_eq!(list(&c, None).unwrap()[0].uuid, a.uuid);
    }

    #[test]
    fn reviews_follow_katanas_schedule() {
        assert_eq!(next(0, true, 0), (1, DAY));
        assert_eq!(next(1, true, 0), (2, 3 * DAY));
        assert_eq!(next(4, true, 0), (5, 30 * DAY));
        assert_eq!(next(5, true, 0), (5, 30 * DAY));
        assert_eq!(next(3, false, 7), (0, 7));
    }

    #[test]
    fn learning_numbers_count_reviews_and_revisits() {
        let c = conn();
        let w = save(&c, &nw("covetous", "covetous")).unwrap();
        let today = chrono::Local::now().date_naive();
        let day = today.format("%Y-%m-%d").to_string();
        assert_eq!(due(&c, None, false).unwrap().len(), 1);
        answer(&c, w.id, false, true, &day).unwrap();
        answer(&c, w.id, true, false, &day).unwrap();
        // three right answers make it learned
        c.execute("UPDATE words SET review_level = 2", []).unwrap();
        let w2 = answer(&c, w.id, true, false, &day).unwrap().unwrap();
        assert_eq!(w2.review_level, 3);
        assert!(w2.learned_at.is_some());
        assert!(due(&c, None, false).unwrap().is_empty());
        c.execute("INSERT INTO highlights VALUES (1, 'h1', 1, 'solitary as an oyster', 'synced')", []).unwrap();
        for _ in 0..3 {
            log(&c, "revisit", Some("h1"), Some(1), Some("highlight"), &day).unwrap();
        }
        log(&c, "edit", Some("h1"), Some(1), None, &day).unwrap();
        let s = stats(&c, today).unwrap();
        assert_eq!(s.words.total, 1);
        assert_eq!(s.words.learned, 1);
        assert_eq!(s.reviews.year, 3);
        assert_eq!(s.reviews.first_try, Some(0.0));
        assert_eq!(s.reviews.weeks[11], 3);
        assert_eq!(s.reviews.learned_year, 1);
        assert_eq!(s.revisits.year, 3);
        assert_eq!(s.revisits.edits, 1);
        assert_eq!(s.revisits.most.as_ref().unwrap().text, "solitary as an oyster");
    }

    #[test]
    fn markdown_bolds_the_word() {
        assert_eq!(bold_in("…his sole residuary legatee", "residuary"), "…his sole **residuary** legatee");
        assert_eq!(bold_in("the memory of him comes back to me now", "me"), "the memory of him comes back to **me** now");
        let c = conn();
        let mut w = save(&c, &nw("rime", "rime")).unwrap();
        w.meaning = Some("Frost formed from freezing fog.".into());
        w.pos = Some("noun".into());
        let md = markdown(&[w], "20 November 2026");
        assert!(md.contains("## rime\n\n*noun* · Frost formed from freezing fog.\n\n> the deadliest piece of **rime** in the trade.\n\nFrom *A Christmas Carol*, p. 11\n"));
    }
}
