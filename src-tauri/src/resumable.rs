//! Downloads that pause and go on where they stopped, with HTTP Range: the rules milestone 2 proved on
//! Grimmory's books, shared by Grimmory downloads (`grimmory/downloads.rs`) and the dictionaries
//! (`dict/download.rs`).
//!
//! - Bytes go into a `.part` file, with the length and `Last-Modified`/`ETag` beside it in a `.json`.
//!   Only a whole file is moved to where it belongs, so half a file is never taken for a file.
//! - Going on asks for `Range: bytes=<bytes kept>-` with `If-Range`. A 206 is appended only if it starts
//!   exactly there and the length and date still match; a 200 starts over; a 416 or a changed file
//!   throws the partial bytes away.
//! - Waiting is for silence only (the client's read timeout), never for a total time.

use futures_util::StreamExt;
use reqwest::header::{CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Info {
    pub total: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
}

/// A download's partial bytes and what is known about them.
pub struct Part {
    pub part: PathBuf,
    pub info: PathBuf,
}

impl Part {
    pub fn new(part: PathBuf) -> Part {
        let info = part.with_extension("json");
        Part { part, info }
    }

    /// The bytes kept so far and their info. Bytes kept without their info aren't trusted.
    pub fn kept(&self) -> (u64, Info) {
        if let Some(dir) = self.part.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let info: Option<Info> = std::fs::read(&self.info).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let have = std::fs::metadata(&self.part).map(|m| m.len()).unwrap_or(0);
        match info {
            Some(i) if have > 0 => (have, i),
            _ => {
                let _ = std::fs::remove_file(&self.part);
                (0, Info::default())
            }
        }
    }

    pub fn write_info(&self, info: &Info) {
        let _ = std::fs::write(&self.info, serde_json::to_vec(info).unwrap_or_default());
    }

    pub fn discard(&self) {
        let _ = std::fs::remove_file(&self.part);
        let _ = std::fs::remove_file(&self.info);
    }

    /// Asks for the rest when bytes are kept.
    pub fn ask(&self, req: RequestBuilder, have: u64, info: &Info) -> RequestBuilder {
        if have == 0 {
            return req;
        }
        let req = req.header(RANGE, format!("bytes={have}-"));
        match info.etag.as_ref().or(info.last_modified.as_ref()) {
            Some(v) => req.header(IF_RANGE, v),
            None => req,
        }
    }
}

/// What an answer means for the partial bytes.
pub enum Begin {
    /// the rest of the same file: append from `written` of `total`
    Append(tokio::fs::File, u64, u64),
    /// the whole file from the start (`total` 0 when the server didn't say)
    Fresh(tokio::fs::File, u64),
    /// another file now, or the range can't be served: the bytes were thrown away, ask again
    Restart,
    /// any other answer, for the caller to put in words
    Status(StatusCode),
    /// the file couldn't be written on this PC
    WriteFailed(String),
}

fn header(resp: &Response, h: reqwest::header::HeaderName) -> Option<String> {
    resp.headers().get(h).and_then(|v| v.to_str().ok()).map(String::from)
}

pub async fn begin(p: &Part, resp: &Response, have: u64, info: &Info) -> Begin {
    let new_lm = header(resp, LAST_MODIFIED);
    let new_et = header(resp, ETAG);
    match resp.status() {
        StatusCode::PARTIAL_CONTENT if have > 0 => {
            // "bytes 4000-9999/10000"
            let cr = header(resp, CONTENT_RANGE).unwrap_or_default();
            let start = cr.strip_prefix("bytes ").and_then(|r| r.split('-').next()).and_then(|x| x.trim().parse::<u64>().ok());
            let len = cr.rsplit('/').next().and_then(|x| x.trim().parse::<u64>().ok());
            let same_date = match (&info.last_modified, &new_lm) {
                (Some(a), Some(b)) => a == b,
                _ => true,
            };
            if start != Some(have) || len != Some(info.total) || !same_date {
                let _ = std::fs::remove_file(&p.part);
                return Begin::Restart;
            }
            match tokio::fs::OpenOptions::new().append(true).open(&p.part).await {
                Ok(f) => Begin::Append(f, have, info.total),
                Err(e) => Begin::WriteFailed(e.to_string()),
            }
        }
        StatusCode::OK | StatusCode::PARTIAL_CONTENT => {
            let total = resp.content_length().unwrap_or(0);
            p.write_info(&Info { total, last_modified: new_lm, etag: new_et });
            match tokio::fs::File::create(&p.part).await {
                Ok(f) => Begin::Fresh(f, total),
                Err(e) => Begin::WriteFailed(e.to_string()),
            }
        }
        StatusCode::RANGE_NOT_SATISFIABLE => {
            let _ = std::fs::remove_file(&p.part);
            Begin::Restart
        }
        s => Begin::Status(s),
    }
}

pub enum Streamed {
    /// the server stopped sending: `written` bytes are in the part file
    Ended(u64),
    /// paused (the stop flag was set)
    Stopped(u64),
    /// the connection broke off
    Broke(reqwest::Error),
    WriteFailed(String),
}

/// Writes the answer's body into the part file, telling `progress` at most every 300 ms.
pub async fn stream(
    resp: Response,
    mut file: tokio::fs::File,
    mut written: u64,
    total: u64,
    stop: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Streamed {
    let mut body = resp.bytes_stream();
    let mut last = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = file.flush().await;
            return Streamed::Stopped(written);
        }
        match body.next().await {
            Some(Ok(chunk)) => {
                if let Err(e) = file.write_all(&chunk).await {
                    return Streamed::WriteFailed(e.to_string());
                }
                written += chunk.len() as u64;
                if last.elapsed() > Duration::from_millis(300) {
                    last = Instant::now();
                    progress(written, total);
                }
            }
            Some(Err(e)) => {
                let _ = file.flush().await;
                progress(written, total);
                return Streamed::Broke(e);
            }
            None => break,
        }
    }
    let _ = file.flush().await;
    Streamed::Ended(written)
}

/// After the server stopped sending: a file whose length wasn't known keeps what came as its length.
pub fn settle(p: &Part, written: u64, total: u64) {
    if total == 0 {
        let mut info: Info = std::fs::read(&p.info).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        info.total = written;
        p.write_info(&info);
    }
}
