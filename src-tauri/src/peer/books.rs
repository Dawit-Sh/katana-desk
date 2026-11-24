//! The book being read on this PC, and its file, for a phone that has just paired: Katana asks which book
//! is open here (or was read last), and when it doesn't have that file it downloads it into its Local
//! library, from Grimmory's own `/api/v1/books/{id}/content` (so Katana's resumable Grimmory download
//! works unchanged: ranges, `If-Range`, a strong `ETag`).

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};

/// A started, unfinished book (as the sidebar's reading card counts one).
const STARTED: f64 = 0.004;
const FINISHED: f64 = 0.995;

/// The book being read here: the one open now, else the last one opened that's started and not finished.
/// Only a book whose file is here (not missing).
pub fn reading_id(conn: &Connection, open: Option<i64>) -> Option<i64> {
    if let Some(id) = open {
        let here: bool = conn
            .query_row("SELECT missing = 0 AND path <> '' FROM books WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or(false);
        if here {
            return Some(id);
        }
    }
    conn.query_row(
        "SELECT id FROM books WHERE missing = 0 AND opened_at IS NOT NULL AND fraction > ?1 AND fraction < ?2
         ORDER BY opened_at DESC, id DESC LIMIT 1",
        rusqlite::params![STARTED, FINISHED],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Every book being read here, newest first: the one open in the reader, then each opened in the last 60 days that's
/// started and not finished (his ask: only the books you're reading move between devices).
pub fn reading_ids(conn: &Connection, open: Option<i64>) -> Vec<i64> {
    let mut ids: Vec<i64> = reading_id(conn, open).filter(|id| Some(*id) == open).into_iter().collect();
    let since = crate::db::now() - 60 * 24 * 3600 * 1000;
    if let Ok(mut st) = conn.prepare(
        "SELECT id FROM books WHERE missing = 0 AND path <> '' AND opened_at > ?3 AND fraction > ?1 AND fraction < ?2
         ORDER BY opened_at DESC, id DESC LIMIT 30",
    ) {
        if let Ok(rows) = st.query_map(rusqlite::params![STARTED, FINISHED, since], |r| r.get::<_, i64>(0)) {
            ids.extend(rows.flatten().filter(|id| Some(*id) != open));
        }
    }
    ids
}

/// The answer to `/katana-sync/v1/reading-list`: `{"books": [...]}`, each as `/reading` gives its book.
pub fn reading_list_json(conn: &Connection, open: Option<i64>) -> Value {
    let books: Vec<Value> = reading_ids(conn, open)
        .into_iter()
        .map(|id| {
            let mut v = reading_json(conn, Some(id));
            if let Some(b) = v.get_mut("book").filter(|b| b.is_object()) {
                b["open"] = json!(open == Some(id));
            }
            v["book"].take()
        })
        .filter(|b| b.is_object())
        .collect();
    json!({ "books": books })
}

/// The answer to `/katana-sync/v1/reading`: `{"book": {...}}`, or `{"book": null}` when nothing's being read.
pub fn reading_json(conn: &Connection, open: Option<i64>) -> Value {
    let Some(id) = reading_id(conn, open) else { return json!({ "book": null }) };
    let row = conn
        .query_row(
            "SELECT path, format, title, author, size, hash, grimmory_id, fraction FROM books WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<f64>>(7)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten();
    let Some((path, format, title, author, size, hash, grimmory_id, fraction)) = row else { return json!({ "book": null }) };
    let format = format.to_ascii_lowercase();
    let file_name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string());
    // the file as it is now (the library's size may be from before a change)
    let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(size);
    json!({
        "book": {
            "id": id,
            "title": title,
            "author": author,
            "format": format,
            "bookType": super::api::book_type(&format),
            "size": size,
            "md5": hash,
            "fileName": file_name,
            "grimmoryId": grimmory_id,
            "open": open == Some(id),
            "percentage": fraction.map(|f| (f.clamp(0.0, 1.0) * 100.0) as f32),
        }
    })
}

/// `Range: bytes=...` for a file of `total` bytes: the first and last byte to send. `None`: the whole
/// file (no range, or one this doesn't take, such as several ranges). `Some(Err(()))`: unsatisfiable (416).
pub fn byte_range(header: Option<&str>, total: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header?.trim().strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let range = if a.is_empty() {
        // the last n bytes
        let n: u64 = b.parse().ok()?;
        if n == 0 || total == 0 {
            return Some(Err(()));
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let first: u64 = a.parse().ok()?;
        let last: u64 = if b.is_empty() { total.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(total.saturating_sub(1)) };
        if first >= total || last < first {
            return Some(Err(()));
        }
        (first, last)
    };
    Some(Ok(range))
}

/// A strong entity tag for the file as it is (its length and last change).
pub fn etag(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("\"{:x}-{:x}\"", meta.len(), modified)
}

pub fn content_type(format: &str) -> &'static str {
    match format {
        "epub" => "application/epub+zip",
        "pdf" => "application/pdf",
        "cbz" => "application/vnd.comicbook+zip",
        "cbr" => "application/vnd.comicbook-rar",
        "djvu" => "image/vnd.djvu",
        "fb2" => "application/x-fictionbook+xml",
        "mobi" | "azw3" | "azw" => "application/x-mobipocket-ebook",
        _ => "application/octet-stream",
    }
}

/// `attachment; filename="..."` with the name in plain ASCII and, for any other letters, UTF-8 too.
pub fn disposition(name: &str) -> String {
    let plain: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
    let encoded: String = name
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    format!("attachment; filename=\"{plain}\"; filename*=UTF-8''{encoded}")
}

/// A file answer: the open file at its first byte to send, how many bytes, its status and headers.
pub struct FileAnswer {
    pub status: u16,
    pub reader: Box<dyn Read + Send>,
    pub len: u64,
    pub headers: Vec<(String, String)>,
}

/// The file of book `path` as `GET .../content` answers it, honouring `Range` (and `If-Range`: a range
/// for another version of the file gets the whole file).
pub fn file_answer(path: &str, format: &str, range: Option<&str>, if_range: Option<&str>) -> Result<FileAnswer, u16> {
    let mut file = std::fs::File::open(path).map_err(|_| 404u16)?;
    let meta = file.metadata().map_err(|_| 404u16)?;
    let total = meta.len();
    let tag = etag(&meta);
    let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "book".into());
    let mut headers = vec![
        ("Content-Type".to_string(), content_type(format).to_string()),
        ("Content-Disposition".to_string(), disposition(&name)),
        ("Accept-Ranges".to_string(), "bytes".to_string()),
        ("ETag".to_string(), tag.clone()),
    ];
    let same_file = if_range.map_or(true, |v| v.trim() == tag);
    match byte_range(range.filter(|_| same_file), total) {
        None => Ok(FileAnswer { status: 200, reader: Box::new(file), len: total, headers }),
        Some(Err(())) => {
            headers.push(("Content-Range".into(), format!("bytes */{total}")));
            Ok(FileAnswer { status: 416, reader: Box::new(std::io::empty()), len: 0, headers })
        }
        Some(Ok((first, last))) => {
            file.seek(SeekFrom::Start(first)).map_err(|_| 500u16)?;
            let len = last - first + 1;
            headers.push(("Content-Range".into(), format!("bytes {first}-{last}/{total}")));
            Ok(FileAnswer { status: 206, reader: Box::new(file.take(len)), len, headers })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, path TEXT NOT NULL, format TEXT NOT NULL, title TEXT NOT NULL,
                author TEXT, size INTEGER NOT NULL DEFAULT 0, hash TEXT, grimmory_id INTEGER, missing INTEGER NOT NULL DEFAULT 0,
                opened_at INTEGER, fraction REAL);",
        )
        .unwrap();
        c
    }

    fn add(c: &Connection, id: i64, opened_at: Option<i64>, fraction: Option<f64>, missing: bool) {
        c.execute(
            "INSERT INTO books (id, path, format, title, size, hash, opened_at, fraction, missing) VALUES (?1, ?2, 'EPUB', ?3, 10, 'abc', ?4, ?5, ?6)",
            params![id, format!("C:/books/b{id}.epub"), format!("Book {id}"), opened_at, fraction, missing],
        )
        .unwrap();
    }

    #[test]
    fn the_open_book_comes_first() {
        let c = db();
        add(&c, 1, Some(100), Some(0.5), false);
        add(&c, 2, Some(50), None, false);
        assert_eq!(reading_id(&c, Some(2)), Some(2));
        assert_eq!(reading_id(&c, None), Some(1));
    }

    #[test]
    fn the_last_started_unfinished_book_otherwise() {
        let c = db();
        add(&c, 1, Some(100), Some(0.2), false);
        add(&c, 2, Some(300), Some(1.0), false); // finished
        add(&c, 3, Some(200), Some(0.001), false); // only opened
        add(&c, 4, Some(400), Some(0.6), true); // its file is gone
        add(&c, 5, Some(150), Some(0.3), false);
        assert_eq!(reading_id(&c, None), Some(5));
        // an open book whose file is gone doesn't count
        assert_eq!(reading_id(&c, Some(4)), Some(5));
    }

    #[test]
    fn every_book_read_lately_is_listed_the_open_one_first() {
        let c = db();
        let now = crate::db::now();
        add(&c, 1, Some(now - 1000), Some(0.2), false);
        add(&c, 2, Some(now - 500), Some(1.0), false); // finished
        add(&c, 3, Some(now - 90 * 24 * 3600 * 1000), Some(0.4), false); // not read lately
        add(&c, 4, Some(now - 2000), Some(0.5), false);
        assert_eq!(reading_ids(&c, Some(4)), vec![4, 1]);
        assert_eq!(reading_ids(&c, None), vec![1, 4]);
        let list = reading_list_json(&c, Some(4));
        assert_eq!(list["books"].as_array().map(Vec::len), Some(2));
        assert_eq!(list["books"][0]["open"], true);
        assert_eq!(list["books"][1]["open"], false);
    }

    #[test]
    fn nothing_read_yet() {
        let c = db();
        add(&c, 1, None, None, false);
        assert_eq!(reading_id(&c, None), None);
        assert_eq!(reading_json(&c, None), json!({ "book": null }));
    }

    #[test]
    fn the_reading_answer_says_what_the_phone_needs() {
        let c = db();
        add(&c, 7, Some(100), Some(0.25), false);
        let v = reading_json(&c, Some(7));
        let b = &v["book"];
        assert_eq!(b["id"], 7);
        assert_eq!(b["format"], "epub");
        assert_eq!(b["bookType"], "EPUB");
        assert_eq!(b["fileName"], "b7.epub");
        assert_eq!(b["md5"], "abc");
        assert_eq!(b["open"], true);
        assert_eq!(b["percentage"], 25.0);
    }

    #[test]
    fn ranges() {
        assert_eq!(byte_range(None, 100), None);
        assert_eq!(byte_range(Some("bytes=0-"), 100), Some(Ok((0, 99))));
        assert_eq!(byte_range(Some("bytes=40-"), 100), Some(Ok((40, 99))));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Some(Ok((10, 19))));
        assert_eq!(byte_range(Some("bytes=90-500"), 100), Some(Ok((90, 99))));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Some(Ok((90, 99))));
        assert_eq!(byte_range(Some("bytes=100-"), 100), Some(Err(())));
        assert_eq!(byte_range(Some("bytes=20-10"), 100), Some(Err(())));
        assert_eq!(byte_range(Some("bytes=0-1,5-6"), 100), None);
        assert_eq!(byte_range(Some("items=0-1"), 100), None);
    }

    #[test]
    fn a_file_whole_in_part_and_for_another_version() {
        let dir = std::env::temp_dir().join(format!("katana-peer-books-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("Für Elise.epub");
        std::fs::write(&p, b"0123456789").unwrap();
        let path = p.to_string_lossy().to_string();
        let read = |mut a: FileAnswer| {
            let mut s = String::new();
            a.reader.read_to_string(&mut s).unwrap();
            (a.status, s, a.headers)
        };
        let (st, body, h) = read(file_answer(&path, "epub", None, None).unwrap());
        assert_eq!((st, body.as_str()), (200, "0123456789"));
        let tag = h.iter().find(|(k, _)| k == "ETag").unwrap().1.clone();
        assert!(tag.starts_with('"'));
        assert!(h.iter().any(|(k, v)| k == "Content-Disposition" && v.contains("filename*=UTF-8''F%C3%BCr%20Elise.epub")));
        let (st, body, h) = read(file_answer(&path, "epub", Some("bytes=4-"), Some(&tag)).unwrap());
        assert_eq!((st, body.as_str()), (206, "456789"));
        assert!(h.iter().any(|(k, v)| k == "Content-Range" && v == "bytes 4-9/10"));
        // a range asked for another version of the file: the whole file
        let (st, body, _) = read(file_answer(&path, "epub", Some("bytes=4-"), Some("\"old\"")).unwrap());
        assert_eq!((st, body.as_str()), (200, "0123456789"));
        let (st, _, _) = read(file_answer(&path, "epub", Some("bytes=10-"), None).unwrap());
        assert_eq!(st, 416);
        assert!(matches!(file_answer(&dir.join("gone.epub").to_string_lossy(), "epub", None, None), Err(404)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
