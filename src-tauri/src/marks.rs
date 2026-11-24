//! Bookmarks and per-book reading settings (milestone 3).
//!
//! Bookmarks are shaped for milestone 4's Grimmory sync, the same way as Katana's tables on Android:
//! they key on the local book id (`books.id`, which links to Grimmory through `books.grimmory_id`),
//! carry a stable `uuid`, `remote_id`, `remote_cfi` and `sync_state`, and a removal of a bookmark that
//! Grimmory already has stays as a tombstone (`deleted_at`) until the removal has gone up.

use crate::db::now;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Tables added in schema 3. Additive only.
pub const SCHEMA_V3: &str = "
CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    cfi TEXT NOT NULL,
    fraction REAL,
    page_label TEXT,
    chapter TEXT,
    excerpt TEXT,
    title TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    remote_id INTEGER,
    remote_cfi TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS bookmarks_book ON bookmarks(book_id);
CREATE INDEX IF NOT EXISTS bookmarks_remote ON bookmarks(remote_id);
CREATE TABLE IF NOT EXISTS book_prefs (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    prefs TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
";

/// sync_state values: `local` (made here, not on Grimmory yet), `synced`, `dirty` (changed here since),
/// `deleted` (removed here, the removal still has to go up).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub uuid: String,
    pub book_id: i64,
    pub cfi: String,
    pub fraction: Option<f64>,
    pub page_label: Option<String>,
    pub chapter: Option<String>,
    pub excerpt: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub remote_id: Option<i64>,
    pub sync_state: String,
}

const COLS: &str =
    "id, uuid, book_id, cfi, fraction, page_label, chapter, excerpt, title, note, created_at, updated_at, remote_id, sync_state";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: r.get(0)?,
        uuid: r.get(1)?,
        book_id: r.get(2)?,
        cfi: r.get(3)?,
        fraction: r.get(4)?,
        page_label: r.get(5)?,
        chapter: r.get(6)?,
        excerpt: r.get(7)?,
        title: r.get(8)?,
        note: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
        remote_id: r.get(12)?,
        sync_state: r.get(13)?,
    })
}

/// A random v4 UUID. std's RandomState is seeded from the OS's random source on every platform Tauri
/// runs on, and each one built in a thread gets fresh keys, so no extra crate is needed.
pub fn new_uuid() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut b = [0u8; 16];
    for chunk in b.chunks_mut(8) {
        let mut h = RandomState::new().build_hasher();
        h.write_i64(now());
        chunk.copy_from_slice(&h.finish().to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn list(conn: &Connection, book_id: i64) -> rusqlite::Result<Vec<Bookmark>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM bookmarks WHERE book_id = ?1 AND deleted_at IS NULL ORDER BY fraction, created_at"
    ))?;
    let rows = st.query_map([book_id], row)?;
    rows.collect()
}

pub struct NewMark<'a> {
    pub book_id: i64,
    pub cfi: &'a str,
    pub fraction: Option<f64>,
    pub page_label: Option<&'a str>,
    pub chapter: Option<&'a str>,
    pub excerpt: Option<&'a str>,
}

pub fn add(conn: &Connection, m: &NewMark) -> rusqlite::Result<Bookmark> {
    // the same place twice is one bookmark (Grimmory answers 409 to a second one at the same CFI)
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM bookmarks WHERE book_id = ?1 AND cfi = ?2 AND deleted_at IS NULL",
            params![m.book_id, m.cfi],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return conn.query_row(&format!("SELECT {COLS} FROM bookmarks WHERE id = ?1"), [id], row);
    }
    let t = now();
    conn.execute(
        "INSERT INTO bookmarks (uuid, book_id, cfi, fraction, page_label, chapter, excerpt, created_at, updated_at, sync_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 'local')",
        params![new_uuid(), m.book_id, m.cfi, m.fraction, m.page_label, m.chapter, m.excerpt, t],
    )?;
    let id = conn.last_insert_rowid();
    conn.query_row(&format!("SELECT {COLS} FROM bookmarks WHERE id = ?1"), [id], row)
}

/// Removes a bookmark. One Grimmory never had goes at once; one it has stays as a tombstone so the
/// removal can go up in milestone 4.
pub fn remove(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    let remote: Option<Option<i64>> =
        conn.query_row("SELECT remote_id FROM bookmarks WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    match remote {
        Some(Some(_)) => {
            let t = now();
            conn.execute(
                "UPDATE bookmarks SET deleted_at = ?2, updated_at = ?2, sync_state = 'deleted' WHERE id = ?1",
                params![id, t],
            )?;
        }
        Some(None) => {
            conn.execute("DELETE FROM bookmarks WHERE id = ?1", [id])?;
        }
        None => {}
    }
    Ok(())
}

/// Brings back a bookmark removed (Undo), in the read it belonged to (`read_n`). As with highlights: a
/// tombstone comes back as a change to send, so Grimmory keeps it; one gone for good comes back as it was
/// (its uuid, name, note and day) and goes up as new. A bookmark made at the same place meanwhile is the one.
pub fn restore(conn: &Connection, b: &Bookmark, read_n: Option<i64>) -> rusqlite::Result<Bookmark> {
    let by_id = |id: i64| conn.query_row(&format!("SELECT {COLS} FROM bookmarks WHERE id = ?1"), [id], row);
    let mine: Option<(i64, bool)> = conn
        .query_row("SELECT id, deleted_at IS NOT NULL FROM bookmarks WHERE uuid = ?1", [&b.uuid], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match mine {
        Some((id, true)) => {
            conn.execute(
                "UPDATE bookmarks SET deleted_at = NULL, updated_at = ?2, sync_state = 'dirty' WHERE id = ?1",
                params![id, now()],
            )?;
            return by_id(id);
        }
        Some((id, false)) => return by_id(id),
        None => {}
    }
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM bookmarks WHERE book_id = ?1 AND cfi = ?2 AND deleted_at IS NULL",
            params![b.book_id, b.cfi],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        return by_id(id);
    }
    conn.execute(
        "INSERT INTO bookmarks (uuid, book_id, cfi, fraction, page_label, chapter, excerpt, title, note, created_at, updated_at, sync_state, read_n)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'local', COALESCE(?12, 0))",
        params![
            b.uuid,
            b.book_id,
            b.cfi,
            b.fraction,
            b.page_label,
            b.chapter,
            b.excerpt,
            clean(b.title.as_deref()),
            clean(b.note.as_deref()),
            b.created_at,
            now(),
            read_n.filter(|n| *n > 0)
        ],
    )?;
    by_id(conn.last_insert_rowid())
}

/// Names a bookmark and gives it a note (the marks panel in milestone 4).
pub fn update(conn: &Connection, id: i64, title: Option<&str>, note: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bookmarks SET title = ?2, note = ?3, updated_at = ?4,
             sync_state = CASE sync_state WHEN 'synced' THEN 'dirty' WHEN 'kept' THEN 'local' ELSE sync_state END
         WHERE id = ?1",
        params![id, clean(title), clean(note), now()],
    )?;
    Ok(())
}

fn clean(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// The book a mark belongs to (`table`: bookmarks or highlights).
pub fn book_of(conn: &Connection, table: &str, id: i64) -> Option<i64> {
    let table = if table == "highlights" { "highlights" } else { "bookmarks" };
    conn.query_row(&format!("SELECT book_id FROM {table} WHERE id = ?1"), [id], |r| r.get(0)).optional().ok().flatten()
}

/// Where a bookmark from Grimmory sits, worked out by the reader. Not a change: the sync state stays.
/// A name that is only its chapter (the web reader names its own that way) isn't kept as a name.
pub fn set_place(
    conn: &Connection,
    id: i64,
    fraction: Option<f64>,
    page_label: Option<&str>,
    chapter: Option<&str>,
    excerpt: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE bookmarks SET fraction = COALESCE(?2, fraction), page_label = COALESCE(?3, page_label),
             chapter = COALESCE(chapter, ?4), excerpt = COALESCE(excerpt, ?5),
             title = CASE WHEN title = COALESCE(chapter, ?4) THEN NULL ELSE title END
         WHERE id = ?1",
        params![id, fraction, page_label, chapter, excerpt],
    )?;
    Ok(())
}

pub fn book_prefs(conn: &Connection, book_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT prefs FROM book_prefs WHERE book_id = ?1", [book_id], |r| r.get(0)).optional()
}

pub fn set_book_prefs(conn: &Connection, book_id: i64, prefs: Option<&str>) -> rusqlite::Result<()> {
    match prefs {
        Some(p) => conn.execute(
            "INSERT INTO book_prefs (book_id, prefs, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(book_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at",
            params![book_id, p, now()],
        )?,
        None => conn.execute("DELETE FROM book_prefs WHERE book_id = ?1", [book_id])?,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO books (id, title) VALUES (1, 'A');",
        )
        .unwrap();
        c.execute_batch(SCHEMA_V3).unwrap();
        c
    }

    fn mark<'a>(cfi: &'a str, f: f64) -> NewMark<'a> {
        NewMark { book_id: 1, cfi, fraction: Some(f), page_label: Some("3"), chapter: Some("One"), excerpt: Some("It was") }
    }

    #[test]
    fn same_place_is_one_bookmark() {
        let c = db();
        let a = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        let b = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(list(&c, 1).unwrap().len(), 1);
        assert_eq!(a.sync_state, "local");
        assert_eq!(a.uuid.len(), 36);
    }

    #[test]
    fn listed_in_book_order() {
        let c = db();
        add(&c, &mark("epubcfi(/6/8!/4/2)", 0.5)).unwrap();
        add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        let l = list(&c, 1).unwrap();
        assert_eq!(l[0].fraction, Some(0.1));
        assert_ne!(l[0].uuid, l[1].uuid);
    }

    #[test]
    fn removal_keeps_a_tombstone_only_for_synced_marks() {
        let c = db();
        let a = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        let b = add(&c, &mark("epubcfi(/6/8!/4/2)", 0.5)).unwrap();
        c.execute("UPDATE bookmarks SET remote_id = 9, sync_state = 'synced' WHERE id = ?1", [b.id]).unwrap();
        remove(&c, a.id).unwrap();
        remove(&c, b.id).unwrap();
        assert!(list(&c, 1).unwrap().is_empty());
        let left: Vec<(i64, String)> = c
            .prepare("SELECT id, sync_state FROM bookmarks")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(left, vec![(b.id, "deleted".to_string())]);
        // a bookmark at the same place can be made again after a removal
        let again = add(&c, &mark("epubcfi(/6/8!/4/2)", 0.5)).unwrap();
        assert_ne!(again.id, b.id);
    }

    #[test]
    fn undo_brings_a_bookmark_back() {
        let c = db();
        c.execute_batch(crate::highlights::SCHEMA_V4).unwrap();
        c.execute_batch(crate::reads::SCHEMA_V9).unwrap();
        let a = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        update(&c, a.id, Some("Name"), Some("A note")).unwrap();
        let b = add(&c, &mark("epubcfi(/6/8!/4/2)", 0.5)).unwrap();
        c.execute("UPDATE bookmarks SET remote_id = 9, sync_state = 'synced' WHERE id = ?1", [b.id]).unwrap();
        let a = list(&c, 1).unwrap().into_iter().find(|x| x.id == a.id).unwrap();
        let b = list(&c, 1).unwrap().into_iter().find(|x| x.id == b.id).unwrap();
        crate::reads::start(&c, 1).unwrap();
        // never on Grimmory: gone for good, back with its uuid, name, note, day and read
        let read = crate::highlights::read_of(&c, "bookmarks", a.id);
        remove(&c, a.id).unwrap();
        let back = restore(&c, &a, read).unwrap();
        assert_eq!((back.uuid.as_str(), back.title.as_deref(), back.note.as_deref()), (a.uuid.as_str(), Some("Name"), Some("A note")));
        assert_eq!((back.created_at, back.sync_state.as_str()), (a.created_at, "local"));
        assert_eq!(crate::highlights::read_of(&c, "bookmarks", back.id), Some(1));
        // on Grimmory: the tombstone comes back as a change, still linked
        remove(&c, b.id).unwrap();
        let back = restore(&c, &b, Some(1)).unwrap();
        assert_eq!((back.id, back.remote_id, back.sync_state.as_str()), (b.id, Some(9), "dirty"));
        assert_eq!(list(&c, 1).unwrap().len(), 2);
        // twice is still one
        restore(&c, &b, Some(1)).unwrap();
        assert_eq!(list(&c, 1).unwrap().len(), 2);
    }

    #[test]
    fn naming_a_synced_mark_makes_it_dirty() {
        let c = db();
        let a = add(&c, &mark("epubcfi(/6/4!/4/2)", 0.1)).unwrap();
        c.execute("UPDATE bookmarks SET sync_state = 'synced' WHERE id = ?1", [a.id]).unwrap();
        update(&c, a.id, Some("Name"), None).unwrap();
        let l = list(&c, 1).unwrap();
        assert_eq!(l[0].sync_state, "dirty");
        assert_eq!(l[0].title.as_deref(), Some("Name"));
    }

    #[test]
    fn prefs_round_trip() {
        let c = db();
        assert_eq!(book_prefs(&c, 1).unwrap(), None);
        set_book_prefs(&c, 1, Some("{\"size\":110}")).unwrap();
        set_book_prefs(&c, 1, Some("{\"size\":120}")).unwrap();
        assert_eq!(book_prefs(&c, 1).unwrap().as_deref(), Some("{\"size\":120}"));
        set_book_prefs(&c, 1, None).unwrap();
        assert_eq!(book_prefs(&c, 1).unwrap(), None);
    }
}
