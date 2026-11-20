//! Ctrl K, search everything (milestone 7): books on this PC and on Grimmory, authors, highlights,
//! notes, bookmarks and My words, in every format (EPUB, PDF, DjVu, comics: their marks share the tables).
//! Words are matched anywhere, case-insensitive; a match at the start of a title or word comes first.

use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// "book" (on this PC), "gbook" (on Grimmory, not here), "author", "highlight", "note", "bookmark", "word"
    pub kind: String,
    pub id: i64,
    /// the book to open (a local id; for "gbook" the Grimmory id)
    pub book_id: Option<i64>,
    pub title: String,
    pub sub: String,
    /// the place to open at (a CFI or `page:N...`), for marks and words
    pub at: Option<String>,
    pub format: Option<String>,
    pub color: Option<String>,
    pub count: i64,
    pub uuid: Option<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub books: Vec<Hit>,
    pub authors: Vec<Hit>,
    pub marks: Vec<Hit>,
    pub words: Vec<Hit>,
}

fn like(q: &str) -> String {
    let esc = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{esc}%")
}

fn place(page: Option<String>, chapter: Option<String>) -> String {
    let mut parts = vec![];
    if let Some(c) = chapter.filter(|c| !c.trim().is_empty()) {
        parts.push(c);
    }
    if let Some(p) = page.filter(|p| !p.trim().is_empty()) {
        parts.push(if p.chars().all(|c| c.is_ascii_digit()) { format!("p. {p}") } else { p });
    }
    parts.join(" · ")
}

/// A short piece of `text` around the first match of `q`.
pub fn snippet(text: &str, q: &str, room: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = flat.to_lowercase();
    let chars: Vec<char> = flat.chars().collect();
    if chars.len() <= room {
        return flat;
    }
    // the match's char index (lowercase can change byte lengths, so count chars)
    let at = lower.find(&q.to_lowercase()).map(|b| lower[..b].chars().count()).unwrap_or(0);
    let start = at.saturating_sub(room / 3);
    let end = (start + room).min(chars.len());
    let start = end.saturating_sub(room);
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{}", s.trim_start());
    }
    if end < chars.len() {
        s = format!("{}…", s.trim_end());
    }
    s
}

pub fn search(conn: &Connection, q: &str) -> rusqlite::Result<Found> {
    let q = q.trim();
    let mut f = Found::default();
    if q.is_empty() {
        return Ok(f);
    }
    let pat = like(q);
    let pre = format!("{}%", like(q).trim_start_matches('%'));

    // books on this PC (Local and Grimmory downloads)
    let mut st = conn.prepare(
        "SELECT id, title, author, format, grimmory_id, fraction FROM books
         WHERE missing = 0 AND (title LIKE ?1 ESCAPE '\\' OR author LIKE ?1 ESCAPE '\\')
         ORDER BY (title LIKE ?2 ESCAPE '\\') DESC, COALESCE(opened_at, 0) DESC, title LIMIT 8",
    )?;
    let mut here = std::collections::HashSet::new();
    for r in st.query_map(params![pat, pre], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<i64>>(4)?, r.get::<_, Option<f64>>(5)?))
    })? {
        let (id, title, author, format, gid, frac) = r?;
        if let Some(g) = gid {
            here.insert(g);
        }
        let pct = frac.filter(|x| *x > 0.004).map(|x| if x >= 0.995 { "Finished".to_string() } else { format!("{}%", (x * 100.0).round()) });
        let sub = [author, Some(format.to_uppercase()), pct].into_iter().flatten().collect::<Vec<_>>().join(" · ");
        f.books.push(Hit { kind: "book".into(), id, book_id: Some(id), title, sub, format: Some(format), ..Default::default() });
    }
    // books on Grimmory that aren't here yet
    let mut st = conn.prepare(
        "SELECT id, title, authors, file_type, file_name FROM gbooks
         WHERE title LIKE ?1 ESCAPE '\\' OR authors LIKE ?1 ESCAPE '\\' OR series LIKE ?1 ESCAPE '\\'
         ORDER BY (title LIKE ?2 ESCAPE '\\') DESC, COALESCE(last_read, 0) DESC, title LIMIT 16",
    )?;
    for r in st.query_map(params![pat, pre], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
    })? {
        let (id, title, authors, ft, name) = r?;
        if here.contains(&id) || f.books.len() >= 10 {
            continue;
        }
        let ext = name.as_deref().and_then(|n| n.rsplit('.').next()).map(|e| e.to_lowercase());
        let fmt = match ft.as_deref() {
            Some("CBX") => ext.unwrap_or_else(|| "cbz".into()),
            Some(t) => t.to_lowercase(),
            None => ext.unwrap_or_default(),
        };
        let sub = [authors, Some("On Grimmory".to_string())].into_iter().flatten().collect::<Vec<_>>().join(" · ");
        f.books.push(Hit { kind: "gbook".into(), id, book_id: Some(id), title, sub, format: Some(fmt), ..Default::default() });
    }

    // authors: from both, counted once per book
    let mut authors: std::collections::BTreeMap<String, (String, i64)> = Default::default();
    let mut st = conn.prepare(
        "SELECT author FROM books WHERE missing = 0 AND author LIKE ?1 ESCAPE '\\' AND (grimmory_id IS NULL OR source = 'local')
         UNION ALL SELECT authors FROM gbooks WHERE authors LIKE ?1 ESCAPE '\\'",
    )?;
    let ql = q.to_lowercase();
    for r in st.query_map([&pat], |r| r.get::<_, Option<String>>(0))? {
        for a in r?.unwrap_or_default().split([',', ';', '&']) {
            let a = a.trim();
            if a.to_lowercase().contains(&ql) {
                let e = authors.entry(a.to_lowercase()).or_insert((a.to_string(), 0));
                e.1 += 1;
            }
        }
    }
    let mut list: Vec<_> = authors.into_values().collect();
    list.sort_by(|a, b| (!a.0.to_lowercase().starts_with(&ql)).cmp(&!b.0.to_lowercase().starts_with(&ql)).then(b.1.cmp(&a.1)));
    for (name, n) in list.into_iter().take(4) {
        f.authors.push(Hit { kind: "author".into(), title: name, count: n, sub: if n == 1 { "1 book".into() } else { format!("{n} books") }, ..Default::default() });
    }

    // highlights and notes
    let mut st = conn.prepare(
        "SELECT h.id, h.book_id, h.cfi, h.text, h.note, h.chapter, h.page_label, h.color, b.title, b.format, h.uuid
         FROM highlights h JOIN books b ON b.id = h.book_id
         WHERE h.deleted_at IS NULL AND (h.text LIKE ?1 ESCAPE '\\' OR h.note LIKE ?1 ESCAPE '\\')
         ORDER BY h.updated_at DESC LIMIT 12",
    )?;
    for r in st.query_map([&pat], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
        ))
    })? {
        let (id, book, cfi, text, note, chapter, page, color, btitle, fmt, uuid) = r?;
        let in_note = note.as_deref().is_some_and(|n| n.to_lowercase().contains(&ql)) && !text.to_lowercase().contains(&ql);
        let w = place(page, chapter);
        let sub = if in_note {
            format!("{btitle}{} · on “{}”", if w.is_empty() { String::new() } else { format!(" · {w}") }, snippet(&text, "", 40))
        } else {
            let n = note.as_deref().map(|n| format!(" · {}", snippet(n, "", 50))).unwrap_or_default();
            format!("{btitle}{}{n}", if w.is_empty() { String::new() } else { format!(" · {w}") })
        };
        f.marks.push(Hit {
            kind: if in_note { "note" } else { "highlight" }.into(),
            id,
            book_id: Some(book),
            title: if in_note { snippet(note.as_deref().unwrap_or(""), q, 90) } else { snippet(&text, q, 90) },
            sub,
            at: Some(cfi),
            format: Some(fmt),
            color: Some(color),
            uuid: Some(uuid),
            ..Default::default()
        });
    }
    // bookmarks: their name, note or first words
    let mut st = conn.prepare(
        "SELECT m.id, m.book_id, m.cfi, m.title, m.note, m.excerpt, m.chapter, m.page_label, b.title, b.format, m.uuid
         FROM bookmarks m JOIN books b ON b.id = m.book_id
         WHERE m.deleted_at IS NULL AND (m.title LIKE ?1 ESCAPE '\\' OR m.note LIKE ?1 ESCAPE '\\' OR m.excerpt LIKE ?1 ESCAPE '\\')
         ORDER BY m.updated_at DESC LIMIT 8",
    )?;
    for r in st.query_map([&pat], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
        ))
    })? {
        let (id, book, cfi, title, note, excerpt, chapter, page, btitle, fmt, uuid) = r?;
        let w = place(page, chapter.clone());
        let hit = [title.clone(), note.clone(), excerpt.clone()].into_iter().flatten().find(|t| t.to_lowercase().contains(&ql)).unwrap_or_default();
        let head = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| snippet(&hit, q, 80));
        f.marks.push(Hit {
            kind: "bookmark".into(),
            id,
            book_id: Some(book),
            title: head,
            sub: format!("{btitle}{}", if w.is_empty() { String::new() } else { format!(" · {w}") }),
            at: Some(cfi),
            format: Some(fmt),
            uuid: Some(uuid),
            ..Default::default()
        });
    }

    // My words
    let mut st = conn.prepare(
        "SELECT id, headword, word, meaning, sentence, book_id, cfi, book_title, uuid FROM words
         WHERE headword LIKE ?1 ESCAPE '\\' OR word LIKE ?1 ESCAPE '\\' OR meaning LIKE ?1 ESCAPE '\\' OR note LIKE ?1 ESCAPE '\\'
         ORDER BY (headword LIKE ?2 ESCAPE '\\') DESC, created_at DESC LIMIT 6",
    )?;
    for r in st.query_map(params![pat, pre], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, String>(8)?,
        ))
    })? {
        let (id, head, word, meaning, _sentence, book, cfi, btitle, uuid) = r?;
        let m = meaning.map(|m| snippet(&m, "", 70)).unwrap_or_default();
        f.words.push(Hit {
            kind: "word".into(),
            id,
            book_id: book,
            title: if head.is_empty() { word } else { head },
            sub: [Some(m).filter(|m| !m.is_empty()), btitle].into_iter().flatten().collect::<Vec<_>>().join(" · "),
            at: cfi,
            uuid: Some(uuid),
            ..Default::default()
        });
    }
    // marks: highlights before notes before bookmarks is less useful than the newest first, within a cap
    f.marks.truncate(12);
    Ok(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_keep_the_match_in_view() {
        let t = "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness";
        let s = snippet(t, "foolishness", 40);
        assert!(s.contains("foolishness"), "{s}");
        assert!(s.starts_with('…'));
        assert_eq!(snippet("short", "x", 40), "short");
    }

    #[test]
    fn like_escapes_wildcards() {
        assert_eq!(like("50%_off"), "%50\\%\\_off%");
    }
}
