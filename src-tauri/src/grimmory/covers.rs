//! Grimmory covers, served to the page as `kcover://localhost/<book id>-<cover version>`.
//! The first time a cover shows, its full picture (Grimmory keeps up to 1000x1500; its thumbnails are
//! squeezed into 250x350 whatever their shape) is fetched once, made library-sized and kept on this PC.
//! A replaced cover has a new version, so it's fetched again. Six at a time.

use super::{g, send, GErr, GRes};
use crate::meta;
use std::path::PathBuf;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, UriSchemeResponder, Wry};

pub fn dir(app: &AppHandle) -> PathBuf {
    g(app).dir.join("covers")
}

pub fn cached(app: &AppHandle, id: i64, v: i64) -> PathBuf {
    dir(app).join(format!("{id}-{v}.jpg"))
}

/// The cover on this PC, fetched from Grimmory first if needed.
pub async fn ensure(app: &AppHandle, id: i64, v: i64) -> GRes<PathBuf> {
    let path = cached(app, id, v);
    if path.exists() {
        return Ok(path);
    }
    let gr = g(app);
    let _slot = gr.cover_slots.acquire().await.map_err(|e| GErr::Other(e.to_string()))?;
    if path.exists() {
        return Ok(path);
    }
    let resp = send(app, move |c, base, tok| {
        c.get(format!("{base}/api/v1/media/book/{id}/cover"))
            .bearer_auth(tok)
            .query(&[("token", tok)])
    })
    .await?;
    if !resp.status().is_success() {
        return Err(GErr::Server(resp.status().as_u16(), String::new()));
    }
    let bytes = resp.bytes().await.map_err(|e| super::failed(app, super::GErr::Offline(e.to_string())))?;
    let out = path.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let _ = std::fs::create_dir_all(out.parent().unwrap());
        meta::save_cover(&bytes, &out)
    })
    .await
    .map_err(|e| GErr::Other(e.to_string()))?;
    if saved.is_none() {
        return Err(GErr::Other("not a picture".into()));
    }
    // the book's older cover versions are only a cache
    if let Ok(rd) = std::fs::read_dir(dir(app)) {
        let prefix = format!("{id}-");
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with(&prefix) && e.path() != path {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(path)
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap()
}

/// The `kcover` protocol handler.
pub fn handle(ctx: UriSchemeContext<'_, Wry>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let path = req.uri().path().trim_start_matches('/').to_string();
    tauri::async_runtime::spawn(async move {
        let mut parts = path.split('-');
        let id = parts.next().and_then(|x| x.parse::<i64>().ok());
        let v = parts.next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
        let Some(id) = id else { return responder.respond(not_found()) };
        match ensure(&app, id, v).await {
            Ok(p) => match tokio::fs::read(&p).await {
                Ok(bytes) => responder.respond(
                    Response::builder()
                        .header(header::CONTENT_TYPE, "image/jpeg")
                        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(bytes)
                        .unwrap(),
                ),
                Err(_) => responder.respond(not_found()),
            },
            Err(_) => responder.respond(not_found()),
        }
    });
}

/// Grimmory's cover at its full size (up to 1000x1500), for Change cover. Read only: nothing on
/// Grimmory changes.
pub async fn full(app: &AppHandle, id: i64) -> GRes<Vec<u8>> {
    let resp = send(app, move |c, base, tok| {
        c.get(format!("{base}/api/v1/media/book/{id}/cover"))
            .bearer_auth(tok)
            .query(&[("token", tok)])
    })
    .await?;
    if !resp.status().is_success() {
        return Err(GErr::Server(resp.status().as_u16(), String::new()));
    }
    Ok(resp.bytes().await.map_err(|e| GErr::Offline(e.to_string()))?.to_vec())
}
