//! A Local book that is the very same file as a Grimmory book shares that book's reading place.
//! Matched like Katana on Android: same kind of file, same byte size, and KOReader's partial MD5 (the
//! one Grimmory uses as its file id), worked out from the 12 one-kilobyte samples read from Grimmory
//! with Range requests. Only those 12 KB are read; a server that answers with the whole file is not
//! read on. At most 4 Grimmory books of the same size are checked per Local book, and the answers are
//! kept, so a book isn't read again until its file or the server's changes. Two Grimmory books with
//! the same file link neither.

use super::{conn_of, g, send, GErr, GRes};
use crate::db;
use md5::{Digest, Md5};
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use rusqlite::params;

/// Grimmory's file types for a format on this PC.
pub fn server_types(format: &str) -> &'static [&'static str] {
    match format {
        "epub" => &["EPUB"],
        "pdf" => &["PDF"],
        "cbz" => &["CBX", "CBZ"],
        "mobi" => &["MOBI"],
        "azw3" | "azw" => &["AZW3", "AZW"],
        "fb2" | "fbz" => &["FB2"],
        _ => &[],
    }
}

/// The sample ranges KOReader's partial MD5 reads: 1 KB at 256 B, 1 KB, 4 KB ... 1 GB, within the file.
pub fn sample_ranges(size: u64) -> Vec<(u64, u64)> {
    let mut out = vec![];
    for i in -1i32..=10 {
        let offset: u64 = if i < 0 { 256 } else { 1024u64 << (2 * i) };
        if offset >= size {
            break;
        }
        out.push((offset, (offset + 1023).min(size - 1)));
    }
    out
}

/// The partial MD5 of a Grimmory book's file, or None when the server won't give exactly the samples
/// or the file isn't `size` bytes.
async fn server_md5(app: &tauri::AppHandle, gid: i64, size: u64) -> GRes<Option<String>> {
    let mut h = Md5::new();
    for (a, b) in sample_ranges(size) {
        let resp = send(app, move |c, base, tok| {
            c.get(format!("{base}/api/v1/books/{gid}/content"))
                .bearer_auth(tok)
                .header(RANGE, format!("bytes={a}-{b}"))
                .header(ACCEPT_ENCODING, "identity")
        })
        .await?;
        if resp.status() != StatusCode::PARTIAL_CONTENT {
            // a whole file (200) is dropped unread; a 416 means the file is shorter
            return Ok(None);
        }
        let cr = resp.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let total = cr.rsplit('/').next().and_then(|x| x.trim().parse::<u64>().ok());
        if total != Some(size) || !cr.starts_with(&format!("bytes {a}-")) {
            return Ok(None);
        }
        let bytes = resp.bytes().await.map_err(|e| GErr::Offline(e.to_string()))?;
        if bytes.len() as u64 != b - a + 1 {
            return Ok(None);
        }
        h.update(&bytes);
    }
    Ok(Some(format!("{:x}", h.finalize())))
}

/// Links a Local book to its Grimmory book if it is the same file. Returns the Grimmory book's id.
pub async fn link(app: &tauri::AppHandle, id: i64) -> GRes<Option<i64>> {
    let gr = g(app);
    let _one = gr.match_lock.lock().await;
    let row: Option<(String, i64, Option<String>, Option<i64>, String, String, String)> = conn_of(app)
        .query_row("SELECT format, size, hash, grimmory_id, source, path, title FROM books WHERE id = ?1 AND missing = 0", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })
        .ok();
    let Some((format, size, hash, linked, source, path, title)) = row else { return Ok(None) };
    let file_name = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if linked.is_some() || source != "local" {
        return Ok(linked);
    }
    let Some(hash) = hash else { return Ok(None) };
    let types = server_types(&format);
    if types.is_empty() || size <= 0 {
        return Ok(None);
    }
    // Grimmory keeps sizes in KB: anything within a kilobyte either way
    let kb_lo = size / 1024 - 1;
    let kb_hi = (size + 1023) / 1024 + 1;
    let candidates: Vec<(i64, Option<i64>)> = {
        let conn = conn_of(app);
        let q = format!(
            "SELECT g.id, g.size_kb FROM gbooks g
             WHERE g.size_kb BETWEEN ?1 AND ?2 AND upper(g.file_type) IN ({})
               AND NOT EXISTS (SELECT 1 FROM gmatch m WHERE m.local_id = ?3 AND m.grimmory_id = g.id
                               AND m.local_hash = ?4 AND m.size_kb IS g.size_kb AND m.result = 'miss')
             ORDER BY lower(g.file_name) = ?5 DESC, lower(g.title) = ?6 DESC, abs(g.size_kb * 1024 - ?7) ASC
             LIMIT 4",
            types.iter().map(|t| format!("'{t}'")).collect::<Vec<_>>().join(", ")
        );
        let mut st = conn.prepare(&q).map_err(|e| GErr::Other(e.to_string()))?;
        let rows = st
            .query_map(params![kb_lo, kb_hi, id, hash, file_name, title.to_lowercase(), size], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| GErr::Other(e.to_string()))?;
        rows.flatten().collect()
    };
    let mut hits = vec![];
    for (gid, kb) in candidates {
        let m = server_md5(app, gid, size as u64).await?;
        let hit = m.as_deref() == Some(hash.as_str());
        let conn = conn_of(app);
        let _ = conn.execute(
            "INSERT OR REPLACE INTO gmatch (local_id, grimmory_id, local_hash, size_kb, result, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, gid, hash, kb, if hit { "match" } else { "miss" }, db::now()],
        );
        if hit {
            hits.push(gid);
        }
    }
    if hits.len() != 1 {
        return Ok(None);
    }
    let gid = hits[0];
    conn_of(app)
        // the place here isn't news to Grimmory: the first sync takes Grimmory's (asking before going back)
        .execute("UPDATE books SET grimmory_id = ?2, place_state = 'clean', server_place = NULL WHERE id = ?1", params![id, gid])
        .map_err(|e| GErr::Other(e.to_string()))?;
    Ok(Some(gid))
}

/// The Local book's page asks whether its file is on Grimmory too.
#[tauri::command]
pub async fn grimmory_match(app: tauri::AppHandle, id: i64) -> Option<i64> {
    if !g(&app).signed_in() {
        return conn_of(&app).query_row("SELECT grimmory_id FROM books WHERE id = ?1", [id], |r| r.get(0)).ok().flatten();
    }
    link(&app, id).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::sample_ranges;
    #[test]
    fn samples_follow_koreader() {
        let r = sample_ranges(5000);
        assert_eq!(r, vec![(256, 1279), (1024, 2047), (4096, 4999)]);
        assert_eq!(sample_ranges(2_000_000_000).len(), 12);
        assert!(sample_ranges(100).is_empty());
    }

    #[test]
    fn samples_hash_like_the_local_file() {
        // the partial MD5 from samples equals the one read from the file
        let dir = std::env::temp_dir().join(format!("katana-md5-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("b.bin");
        let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        std::fs::write(&p, &data).unwrap();
        let mut h = <md5::Md5 as md5::Digest>::new();
        for (a, b) in sample_ranges(data.len() as u64) {
            md5::Digest::update(&mut h, &data[a as usize..=b as usize]);
        }
        let ours = format!("{:x}", md5::Digest::finalize(h));
        assert_eq!(Some(ours), crate::meta::partial_md5(&p));
    }
}
