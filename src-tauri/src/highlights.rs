//! Highlights and their notes (milestone 4), and the lists the marks panel, the Bookmarks page and the
//! Markdown export read.
//!
//! Shaped like bookmarks (`marks.rs`) and Katana's tables on Android: keyed on the local book id, with
//! a stable `uuid`, `remote_id`, `remote_seen` (Grimmory's copy as last seen, JSON) and `sync_state`
//! (`local`, `synced`, `dirty`, `deleted`, `kept`). A removal Grimmory already has stays as a tombstone
//! until it has gone up. `kept`: Grimmory refused it as it is (a place too long, say); it stays on this
//! PC until it's changed again.
//!
//! The place is foliate-js's CFI range, the same one Grimmory's web reader makes, so it goes up as it
//! is. Colours are kept by name (yellow, green, blue, pink, orange) and styles as Grimmory names them
//! (highlight, underline, strikethrough, squiggly).

use crate::db::now;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Schema 4: highlights, and what Grimmory last had of each bookmark. Additive only.
pub const SCHEMA_V4: &str = "
CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    chapter TEXT,
    fraction REAL,
    page_label TEXT,
    color TEXT NOT NULL DEFAULT 'yellow',
    style TEXT NOT NULL DEFAULT 'highlight',
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    remote_id INTEGER,
    remote_seen TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS highlights_book ON highlights(book_id);
CREATE INDEX IF NOT EXISTS highlights_remote ON highlights(remote_id);
ALTER TABLE bookmarks ADD COLUMN remote_seen TEXT;
";

pub const COLORS: [&str; 5] = ["yellow", "green", "blue", "pink", "orange"];
pub const STYLES: [&str; 4] = ["highlight", "underline", "strikethrough", "squiggly"];

pub fn color_ok(c: &str) -> &'static str {
    COLORS.iter().find(|x| **x == c).copied().unwrap_or("yellow")
}
pub fn style_ok(s: &str) -> &'static str {
    STYLES.iter().find(|x| **x == s).copied().unwrap_or("highlight")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: i64,
    pub uuid: String,
    pub book_id: i64,
    pub cfi: String,
    pub text: String,
    pub chapter: Option<String>,
    pub fraction: Option<f64>,
    pub page_label: Option<String>,
    pub color: String,
    pub style: String,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub remote_id: Option<i64>,
    pub sync_state: String,
}

pub const COLS: &str =
    "id, uuid, book_id, cfi, text, chapter, fraction, page_label, color, style, note, created_at, updated_at, remote_id, sync_state";

pub fn row(r: &rusqlite::Row) -> rusqlite::Result<Highlight> {
    Ok(Highlight {
        id: r.get(0)?,
        uuid: r.get(1)?,
        book_id: r.get(2)?,
        cfi: r.get(3)?,
        text: r.get(4)?,
        chapter: r.get(5)?,
        fraction: r.get(6)?,
        page_label: r.get(7)?,
        color: r.get(8)?,
        style: r.get(9)?,
        note: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        remote_id: r.get(13)?,
        sync_state: r.get(14)?,
    })
}

pub fn list(conn: &Connection, book_id: i64) -> rusqlite::Result<Vec<Highlight>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM highlights WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY fraction, created_at"
    ))?;
    let rows = st.query_map([book_id], row)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Highlight>> {
    conn.query_row(&format!("SELECT {COLS} FROM highlights WHERE id = ?1"), [id], row).optional()
}

pub struct NewHighlight<'a> {
    pub book_id: i64,
    pub cfi: &'a str,
    pub text: &'a str,
    pub chapter: Option<&'a str>,
    pub fraction: Option<f64>,
    pub page_label: Option<&'a str>,
    pub color: &'a str,
    pub style: &'a str,
    pub note: Option<&'a str>,
}

fn clean_note(n: Option<&str>) -> Option<String> {
    n.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub fn add(conn: &Connection, h: &NewHighlight) -> rusqlite::Result<Highlight> {
    // the same words again (a second click on a dot, say) are one highlight: it takes the new look. Only
    // within the current read: the same passage marked on a reread is a new highlight of that read
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM highlights WHERE book_id = ?1 AND cfi = ?2 AND deleted_at IS NULL
                AND read_n = COALESCE((SELECT MAX(n) FROM book_reads WHERE book_id = ?1), 1)",
            params![h.book_id, h.cfi],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        let old = get(conn, id)?.unwrap();
        let note = clean_note(h.note).or(old.note);
        update(conn, id, h.color, h.style, note.as_deref())?;
        return Ok(get(conn, id)?.unwrap());
    }
    let t = now();
    conn.execute(
        "INSERT INTO highlights (uuid, book_id, cfi, text, chapter, fraction, page_label, color, style, note, created_at, updated_at, sync_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, 'local')",
        params![
            crate::marks::new_uuid(),
            h.book_id,
            h.cfi,
            h.text.trim(),
            h.chapter,
            h.fraction,
            h.page_label,
            color_ok(h.color),
            style_ok(h.style),
            clean_note(h.note),
            t
        ],
    )?;
    Ok(get(conn, conn.last_insert_rowid())?.unwrap())
}

/// A new look or note. A highlight in step with Grimmory becomes a change to send; one Grimmory turned
/// down is tried again.
pub fn update(conn: &Connection, id: i64, color: &str, style: &str, note: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE highlights SET color = ?2, style = ?3, note = ?4, updated_at = ?5,
             sync_state = CASE sync_state WHEN 'synced' THEN 'dirty' WHEN 'kept' THEN 'local' ELSE sync_state END
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id, color_ok(color), style_ok(style), clean_note(note), now()],
    )?;
    Ok(())
}

/// One Grimmory never had goes at once; one it has stays as a tombstone until the removal has gone up.
pub fn remove(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    let remote: Option<Option<i64>> =
        conn.query_row("SELECT remote_id FROM highlights WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    match remote {
        Some(Some(_)) => {
            conn.execute(
                "UPDATE highlights SET deleted_at = ?2, updated_at = ?2, sync_state = 'deleted' WHERE id = ?1",
                params![id, now()],
            )?;
        }
        Some(None) => {
            conn.execute("DELETE FROM highlights WHERE id = ?1", [id])?;
        }
        None => {}
    }
    Ok(())
}

/// Brings back a highlight just removed (Undo): as a change to send when Grimmory already took the removal.
pub fn restore(conn: &Connection, h: &Highlight) -> rusqlite::Result<Highlight> {
    let tomb: Option<i64> = conn
        .query_row("SELECT id FROM highlights WHERE uuid = ?1 AND deleted_at IS NOT NULL", [&h.uuid], |r| r.get(0))
        .optional()?;
    if let Some(id) = tomb {
        conn.execute(
            "UPDATE highlights SET deleted_at = NULL, updated_at = ?2, sync_state = 'dirty' WHERE id = ?1",
            params![id, now()],
        )?;
        return Ok(get(conn, id)?.unwrap());
    }
    let n = NewHighlight {
        book_id: h.book_id,
        cfi: &h.cfi,
        text: &h.text,
        chapter: h.chapter.as_deref(),
        fraction: h.fraction,
        page_label: h.page_label.as_deref(),
        color: &h.color,
        style: &h.style,
        note: h.note.as_deref(),
    };
    add(conn, &n)
}

/// Where a highlight sits in the book, worked out by the reader (for ones that came from Grimmory).
/// Not a change: the sync state stays as it is.
pub fn set_place(conn: &Connection, id: i64, fraction: Option<f64>, page_label: Option<&str>, chapter: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE highlights SET fraction = COALESCE(?2, fraction), page_label = COALESCE(?3, page_label),
             chapter = COALESCE(chapter, ?4) WHERE id = ?1",
        params![id, fraction, page_label, chapter],
    )?;
    Ok(())
}

// ---------- the Bookmarks page ----------

/// A book with marks, for the Bookmarks page's list.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarkedBook {
    pub id: i64,
    pub title: String,
    pub author: Option<String>,
    pub cover: Option<String>,
    pub format: String,
    pub fraction: Option<f64>,
    pub grimmory_id: Option<i64>,
    pub bookmarks: i64,
    pub highlights: i64,
    pub notes: i64,
    /// the newest mark, to put the book last worked on first
    pub latest: i64,
}

pub fn marked_books(conn: &Connection) -> rusqlite::Result<Vec<MarkedBook>> {
    let mut st = conn.prepare(
        "SELECT b.id, b.title, b.author, b.cover, b.format, b.fraction, b.grimmory_id,
            (SELECT COUNT(*) FROM bookmarks m WHERE m.book_id = b.id AND m.deleted_at IS NULL),
            (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id AND h.deleted_at IS NULL),
            (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id AND h.deleted_at IS NULL AND h.note IS NOT NULL)
              + (SELECT COUNT(*) FROM bookmarks m WHERE m.book_id = b.id AND m.deleted_at IS NULL AND m.note IS NOT NULL),
            MAX(COALESCE((SELECT MAX(updated_at) FROM bookmarks m WHERE m.book_id = b.id AND m.deleted_at IS NULL), 0),
                COALESCE((SELECT MAX(updated_at) FROM highlights h WHERE h.book_id = b.id AND h.deleted_at IS NULL), 0))
         FROM books b
         WHERE b.missing = 0 AND (EXISTS (SELECT 1 FROM bookmarks m WHERE m.book_id = b.id AND m.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM highlights h WHERE h.book_id = b.id AND h.deleted_at IS NULL))
         ORDER BY 10 DESC",
    )?;
    let rows = st.query_map([], |r| {
        Ok(MarkedBook {
            id: r.get(0)?,
            title: r.get(1)?,
            author: r.get(2)?,
            cover: r.get(3)?,
            format: r.get(4)?,
            fraction: r.get(5)?,
            grimmory_id: r.get(6)?,
            bookmarks: r.get(7)?,
            highlights: r.get(8)?,
            notes: r.get(9)?,
            latest: r.get(10)?,
        })
    })?;
    rows.collect()
}

/// Every mark's words, for the Bookmarks page's search across all books: (book id, the words).
pub fn search_all(conn: &Connection, needle: &str) -> rusqlite::Result<Vec<i64>> {
    let like = format!("%{}%", needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let mut st = conn.prepare(
        "SELECT DISTINCT book_id FROM (
            SELECT book_id FROM highlights WHERE deleted_at IS NULL
              AND (text LIKE ?1 ESCAPE '\\' OR note LIKE ?1 ESCAPE '\\' OR chapter LIKE ?1 ESCAPE '\\')
            UNION
            SELECT book_id FROM bookmarks WHERE deleted_at IS NULL
              AND (title LIKE ?1 ESCAPE '\\' OR note LIKE ?1 ESCAPE '\\' OR excerpt LIKE ?1 ESCAPE '\\' OR chapter LIKE ?1 ESCAPE '\\')
            UNION
            SELECT id FROM books WHERE title LIKE ?1 ESCAPE '\\' OR author LIKE ?1 ESCAPE '\\'
         )",
    )?;
    let rows = st.query_map([like], |r| r.get(0))?;
    rows.collect()
}

// ---------- Markdown ----------

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn quote(out: &mut String, text: &str) {
    for line in text.trim().lines() {
        let l = line.trim();
        if l.is_empty() {
            out.push_str(">\n");
        } else {
            out.push_str("> ");
            out.push_str(l);
            out.push('\n');
        }
    }
}

fn note_lines(note: &str) -> String {
    note.trim().replace("\r\n", "\n").replace('\n', "\n  ")
}

fn count(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// A book's bookmarks, highlights and notes as Markdown, the way Katana on Android writes them: the
/// bookmarked pages with their names and notes, then the quotes in reading order under their chapter,
/// each note under its quote.
pub fn markdown(
    title: &str,
    author: Option<&str>,
    bookmarks: &[crate::marks::Bookmark],
    highlights: &[Highlight],
    day: &str,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n", one_line(title)));
    if let Some(a) = author.filter(|a| !a.trim().is_empty()) {
        out.push_str(&format!("*{}*\n", one_line(a)));
    }
    out.push('\n');
    let mut parts = vec![count(highlights.len(), "highlight")];
    if !bookmarks.is_empty() {
        parts.push(count(bookmarks.len(), "bookmark"));
    }
    out.push_str(&format!("Exported from Katana Desk on {day}: {}.\n", parts.join(", ")));

    if !bookmarks.is_empty() {
        out.push_str("\n## Bookmarks\n\n");
        for b in bookmarks {
            let name = b.title.as_deref().map(one_line).filter(|s| !s.is_empty()).map(|s| format!("**{s}**, ")).unwrap_or_default();
            let place = match (&b.page_label, b.fraction) {
                (Some(p), _) => format!("p. {p}"),
                (None, Some(f)) => format!("{}%", (f * 100.0).round() as i64),
                _ => "a page".into(),
            };
            let words = b.excerpt.as_deref().map(one_line).filter(|s| !s.is_empty()).map(|s| format!(": \"{s}\"")).unwrap_or_default();
            let chapter = b.chapter.as_deref().map(one_line).filter(|s| !s.is_empty()).map(|s| format!(" ({s})")).unwrap_or_default();
            out.push_str(&format!("- {name}{place}{words}{chapter}\n"));
            if let Some(n) = b.note.as_deref().filter(|n| !n.trim().is_empty()) {
                out.push_str(&format!("  Note: {}\n", note_lines(n)));
            }
        }
    }

    if !highlights.is_empty() {
        out.push_str("\n## Highlights\n");
        let mut chapter: Option<String> = None;
        for h in highlights {
            let c = h.chapter.as_deref().map(one_line).filter(|s| !s.is_empty());
            if c.is_some() && c != chapter {
                out.push_str(&format!("\n### {}\n", c.clone().unwrap()));
                chapter = c;
            }
            out.push('\n');
            quote(&mut out, &h.text);
            if let Some(n) = h.note.as_deref().filter(|n| !n.trim().is_empty()) {
                out.push_str(&format!("\nNote: {}\n", note_lines(n)));
            }
        }
    }
    out.trim_end().to_string() + "\n"
}

/// A file name for the export: the book's title and the day, without characters Windows or Linux refuse.
pub fn file_name(title: &str, day: &str) -> String {
    let safe: String = title
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { ' ' } else { c })
        .collect();
    let safe = one_line(&safe);
    let safe: String = safe.chars().take(120).collect();
    let safe = safe.trim().trim_end_matches('.').to_string();
    format!("{} {day}.md", if safe.is_empty() { "Katana notebook".into() } else { safe })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author TEXT, cover TEXT, format TEXT, fraction REAL,
                grimmory_id INTEGER, missing INTEGER NOT NULL DEFAULT 0);
             INSERT INTO books (id, title, format) VALUES (1, 'A', 'epub');",
        )
        .unwrap();
        c.execute_batch(crate::marks::SCHEMA_V3).unwrap();
        c.execute_batch(SCHEMA_V4).unwrap();
        c.execute_batch(crate::grimmory::pdf_annots::SCHEMA_V8).unwrap();
        c.execute_batch(crate::reads::SCHEMA_V9).unwrap();
        c
    }

    #[test]
    fn a_reread_marks_the_same_words_again() {
        let c = db();
        let a = add(&c, &hl("epubcfi(/6/4!/4/2,/1:0,/1:5)")).unwrap();
        assert_eq!(add(&c, &hl("epubcfi(/6/4!/4/2,/1:0,/1:5)")).unwrap().id, a.id);
        crate::reads::start(&c, 1).unwrap();
        let b = add(&c, &hl("epubcfi(/6/4!/4/2,/1:0,/1:5)")).unwrap();
        assert_ne!(b.id, a.id);
        let r = crate::reads::reads(&c, 1).unwrap();
        assert_eq!((r.hl[&a.id], r.hl[&b.id]), (1, 2));
    }

    fn hl<'a>(cfi: &'a str) -> NewHighlight<'a> {
        NewHighlight {
            book_id: 1,
            cfi,
            text: " solitary as an oyster ",
            chapter: Some("Stave One"),
            fraction: Some(0.1),
            page_label: Some("12"),
            color: "green",
            style: "underline",
            note: Some("  "),
        }
    }

    #[test]
    fn add_update_remove() {
        let c = db();
        let a = add(&c, &hl("epubcfi(/6/4!/4/2,/1:0,/1:5)")).unwrap();
        assert_eq!(a.text, "solitary as an oyster");
        assert_eq!(a.note, None);
        assert_eq!((a.color.as_str(), a.style.as_str()), ("green", "underline"));
        // the same place again takes the new look, keeps one highlight
        let mut again = hl("epubcfi(/6/4!/4/2,/1:0,/1:5)");
        again.color = "pink";
        let b = add(&c, &again).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(b.color, "pink");
        // a synced one becomes a change to send
        c.execute("UPDATE highlights SET sync_state = 'synced', remote_id = 7 WHERE id = ?1", [a.id]).unwrap();
        update(&c, a.id, "blue", "nonsense", Some(" A note ")).unwrap();
        let x = get(&c, a.id).unwrap().unwrap();
        assert_eq!((x.color.as_str(), x.style.as_str(), x.note.as_deref(), x.sync_state.as_str()), ("blue", "highlight", Some("A note"), "dirty"));
        remove(&c, a.id).unwrap();
        assert!(list(&c, 1).unwrap().is_empty());
        let st: String = c.query_row("SELECT sync_state FROM highlights WHERE id = ?1", [a.id], |r| r.get(0)).unwrap();
        assert_eq!(st, "deleted");
        // undo brings it back as a change
        let back = restore(&c, &x).unwrap();
        assert_eq!(back.id, a.id);
        assert_eq!(back.sync_state, "dirty");
    }

    #[test]
    fn never_sent_goes_at_once() {
        let c = db();
        let a = add(&c, &hl("epubcfi(/6/4!/4/2,/1:0,/1:5)")).unwrap();
        remove(&c, a.id).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn marked_books_counts() {
        let c = db();
        add(&c, &hl("epubcfi(/6/4!/4/2,/1:0,/1:5)")).unwrap();
        let mut n = hl("epubcfi(/6/4!/4/4,/1:0,/1:5)");
        n.note = Some("a thought");
        add(&c, &n).unwrap();
        let books = marked_books(&c).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!((books[0].highlights, books[0].notes, books[0].bookmarks), (2, 1, 0));
        assert_eq!(search_all(&c, "thought").unwrap(), vec![1]);
        assert_eq!(search_all(&c, "100%").unwrap(), Vec::<i64>::new());
    }

    #[test]
    fn markdown_shape() {
        let c = db();
        let mut n = hl("epubcfi(/6/4!/4/2,/1:0,/1:5)");
        n.note = Some("Scrooge in one line.\nCold.");
        let h = add(&c, &n).unwrap();
        let b = crate::marks::add(
            &c,
            &crate::marks::NewMark { book_id: 1, cfi: "epubcfi(/6/4!/4/2)", fraction: Some(0.1), page_label: Some("18"), chapter: Some("Stave One"), excerpt: Some("Marley's face") },
        )
        .unwrap();
        crate::marks::update(&c, b.id, Some("The knocker"), Some("first ghost")).unwrap();
        let b = crate::marks::list(&c, 1).unwrap();
        let md = markdown("A Christmas Carol", Some("Charles Dickens"), &b, &[h], "20 November 2026");
        assert_eq!(
            md,
            "# A Christmas Carol\n*Charles Dickens*\n\nExported from Katana Desk on 20 November 2026: 1 highlight, 1 bookmark.\n\n\
             ## Bookmarks\n\n- **The knocker**, p. 18: \"Marley's face\" (Stave One)\n  Note: first ghost\n\n\
             ## Highlights\n\n### Stave One\n\n> solitary as an oyster\n\nNote: Scrooge in one line.\n  Cold.\n"
        );
        assert_eq!(file_name("Who: me?/you", "2026-11-20"), "Who me you 2026-11-20.md");
    }
}
