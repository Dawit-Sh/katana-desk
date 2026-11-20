//! Grimmory, the book server on the Zima: sign-in, the library, covers, downloads and the reading place.
//! The API and the rules are the ones Katana on Android already proved against the same server.
//!
//! - Sign-in: `/api/v1/auth/login` once (his password is typed by him and never stored), then the
//!   refresh token. Grimmory replaces the refresh token on every renewal and refuses the old one, so all
//!   renewals go through one place, one at a time, and the new tokens are saved the moment they arrive.
//! - One slow reply never shows Grimmory offline: a failed request starts a second look 1.5 s later.
//! - Requests wait for silence, never for a total time: 10 s to connect, 60 s without a byte.

pub mod catalog;
pub mod covers;
pub mod downloads;
pub mod marks_sync;
pub mod matching;
pub mod pdf_annots;
pub mod place;
pub mod sync;

use crate::db::{self, Db};
use std::sync::Arc;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const DEFAULT_URL: &str = "http://192.168.100.100:6060";

const K_URL: &str = "grimmory.url";
const K_USER: &str = "grimmory.user";
const K_ACCESS: &str = "grimmory.access";
const K_REFRESH: &str = "grimmory.refresh";
const K_SIGNED_OUT: &str = "grimmory.signedOut";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Reach {
    Unknown,
    Online,
    Offline,
}

/// What the screens show about Grimmory.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub url: String,
    pub user: Option<String>,
    pub signed_in: bool,
    /// signed in once, but Grimmory refused the sign-in since (sign in again)
    pub signed_out: bool,
    pub reach: Reach,
    pub syncing: bool,
    /// "Getting your library · 1,250 of 6,216"
    pub sync_done: usize,
    pub sync_total: usize,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
    /// reading places waiting to go up
    pub waiting: usize,
}

#[derive(Debug)]
pub enum GErr {
    SignedOut,
    /// no answer: Wi-Fi, the Zima asleep, a dropped connection
    Offline(String),
    Server(u16, String),
    Other(String),
}

impl std::fmt::Display for GErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GErr::SignedOut => write!(f, "Grimmory signed this PC out. Sign in again."),
            GErr::Offline(m) => write!(f, "Grimmory can't be reached ({m})."),
            GErr::Server(c, m) if m.is_empty() => write!(f, "Grimmory answered {c}."),
            GErr::Server(c, m) => write!(f, "Grimmory answered {c}: {m}"),
            GErr::Other(m) => write!(f, "{m}"),
        }
    }
}

impl From<GErr> for String {
    fn from(e: GErr) -> String {
        e.to_string()
    }
}

pub type GRes<T> = Result<T, GErr>;

/// A request that never reached Grimmory or broke off on the way, as opposed to an answer.
pub fn is_connection(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout() || e.is_request() || e.is_body() || e.is_decode() && e.status().is_none()
}

fn net(e: reqwest::Error) -> GErr {
    if is_connection(&e) {
        let mut m = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            m = s.to_string();
            src = s.source();
        }
        GErr::Offline(m)
    } else {
        GErr::Other(e.to_string())
    }
}

struct Tokens {
    access: String,
    refresh: String,
    renewed_at: i64,
}

pub struct Grimmory {
    pub db: Arc<Db>,
    pub http: reqwest::Client,
    /// <app data>/grimmory: downloaded books, partial downloads, covers
    pub dir: PathBuf,
    tokens: Mutex<Option<Tokens>>,
    renewing: tokio::sync::Mutex<()>,
    pub status: Mutex<Status>,
    rechecking: AtomicBool,
    /// bumped to stop the retry timer when a newer one starts
    retry_gen: AtomicU64,
    pub sync_lock: tokio::sync::Mutex<()>,
    pub cover_slots: tokio::sync::Semaphore,
    pub match_lock: tokio::sync::Mutex<()>,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .pool_idle_timeout(Duration::from_secs(50))
        .user_agent(concat!("KatanaDesk/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

pub fn g(app: &AppHandle) -> tauri::State<'_, Grimmory> {
    app.state::<Grimmory>()
}

/// The library's database (shared with Local).
pub fn conn_of(app: &AppHandle) -> std::sync::MutexGuard<'_, rusqlite::Connection> {
    app.state::<Grimmory>().inner().db.0.lock().unwrap()
}

fn setting_in(db: &Db, key: &str) -> Option<String> {
    db::get_setting(&db.0.lock().unwrap(), key).ok().flatten().filter(|s| !s.is_empty())
}

pub fn setting(app: &AppHandle, key: &str) -> Option<String> {
    db::get_setting(&conn_of(app), key).ok().flatten().filter(|s| !s.is_empty())
}

pub fn set(app: &AppHandle, key: &str, value: &str) {
    let _ = db::set_setting(&conn_of(app), key, value);
}

impl Grimmory {
    pub fn new(db: Arc<Db>, dir: PathBuf) -> Grimmory {
        let url = setting_in(&db, K_URL).unwrap_or_else(|| DEFAULT_URL.to_string());
        let user = setting_in(&db, K_USER);
        let tokens = match (setting_in(&db, K_ACCESS), setting_in(&db, K_REFRESH)) {
            (Some(access), Some(refresh)) => Some(Tokens { access, refresh, renewed_at: 0 }),
            _ => None,
        };
        let signed_out = setting_in(&db, K_SIGNED_OUT).as_deref() == Some("1");
        let last_sync = setting_in(&db, catalog::K_LAST_SYNC).and_then(|s| s.parse().ok());
        Grimmory {
            db,
            http: client(),
            dir,
            status: Mutex::new(Status {
                url,
                user,
                signed_in: tokens.is_some(),
                signed_out,
                reach: Reach::Unknown,
                syncing: false,
                sync_done: 0,
                sync_total: 0,
                last_sync,
                last_error: None,
                waiting: 0,
            }),
            tokens: Mutex::new(tokens),
            renewing: tokio::sync::Mutex::new(()),
            rechecking: AtomicBool::new(false),
            retry_gen: AtomicU64::new(0),
            sync_lock: tokio::sync::Mutex::new(()),
            cover_slots: tokio::sync::Semaphore::new(6),
            match_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn base(&self) -> String {
        self.status.lock().unwrap().url.trim_end_matches('/').to_string()
    }

    pub fn signed_in(&self) -> bool {
        self.tokens.lock().unwrap().is_some()
    }

    fn access(&self) -> Option<String> {
        self.tokens.lock().unwrap().as_ref().map(|t| t.access.clone())
    }
}

pub fn emit_status(app: &AppHandle) {
    let st = g(app).status.lock().unwrap().clone();
    let _ = app.emit("grimmory-status", st);
}

pub fn update_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    {
        let gr = g(app);
        let mut s = gr.status.lock().unwrap();
        f(&mut s);
    }
    emit_status(app);
}

/// Sends a request with the saved sign-in; renews it once on a 401. `build` makes the request from
/// (client, server address, access token) and may run twice.
pub async fn send(app: &AppHandle, build: impl Fn(&reqwest::Client, &str, &str) -> RequestBuilder) -> GRes<Response> {
    let gr = g(app);
    let base = gr.base();
    let Some(token) = gr.access() else { return Err(GErr::SignedOut) };
    let resp = match build(&gr.http, &base, &token).send().await {
        Ok(r) => r,
        Err(e) => return Err(failed(app, net(e))),
    };
    let resp = if resp.status() == StatusCode::UNAUTHORIZED {
        let token = renew(app, &token).await?;
        match build(&gr.http, &base, &token).send().await {
            Ok(r) => r,
            Err(e) => return Err(failed(app, net(e))),
        }
    } else {
        resp
    };
    if resp.status() == StatusCode::UNAUTHORIZED {
        return Err(GErr::Server(401, "the sign-in was refused".into()));
    }
    reached(app);
    Ok(resp)
}

/// The answer's body as JSON, or the server's own message for an error.
pub async fn json(app: &AppHandle, build: impl Fn(&reqwest::Client, &str, &str) -> RequestBuilder) -> GRes<serde_json::Value> {
    let resp = send(app, build).await?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| failed(app, net(e)))?;
    if !status.is_success() {
        return Err(GErr::Server(status.as_u16(), server_message(&text)));
    }
    serde_json::from_str(&text).map_err(|e| GErr::Other(format!("Grimmory's answer wasn't readable: {e}")))
}

pub fn server_message(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            ["message", "detail", "error"]
                .iter()
                .find_map(|k| v.get(*k).and_then(|m| m.as_str()).filter(|m| !m.is_empty()).map(String::from))
        })
        .unwrap_or_default()
}

/// One renewal at a time. A token someone else already renewed is answered from memory; the new
/// tokens are saved before anything else happens.
async fn renew(app: &AppHandle, used: &str) -> GRes<String> {
    let gr = g(app);
    let _one = gr.renewing.lock().await;
    let (refresh, renewed_at, current) = {
        let t = gr.tokens.lock().unwrap();
        match t.as_ref() {
            Some(t) => (t.refresh.clone(), t.renewed_at, t.access.clone()),
            None => return Err(GErr::SignedOut),
        }
    };
    if current != used {
        return Ok(current);
    }
    // Grimmory refuses a refresh token in its first minute (and locks out after 5 refusals in 15
    // minutes): a second renewal waits that minute out instead of being refused
    let since = db::now() - renewed_at;
    if since < 61_000 {
        tokio::time::sleep(std::time::Duration::from_millis((61_000 - since) as u64)).await;
    }
    let base = gr.base();
    let resp = gr
        .http
        .post(format!("{base}/api/v1/auth/refresh"))
        .json(&serde_json::json!({ "refreshToken": refresh }))
        .send()
        .await
        .map_err(|e| failed(app, net(e)))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| failed(app, net(e)))?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        signed_out(app);
        return Err(GErr::SignedOut);
    }
    if !status.is_success() {
        return Err(GErr::Server(status.as_u16(), server_message(&text)));
    }
    let (access, refresh) = tokens_of(&text)?;
    save_tokens(app, &access, &refresh);
    Ok(access)
}

fn tokens_of(text: &str) -> GRes<(String, String)> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|_| GErr::Other("Grimmory's sign-in answer wasn't readable.".into()))?;
    let pick = |keys: &[&str]| keys.iter().find_map(|k| v.get(*k).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from));
    let access = pick(&["accessToken", "access_token", "token"]).ok_or_else(|| GErr::Other("Grimmory sent no access token.".into()))?;
    let refresh = pick(&["refreshToken", "refresh_token"]).ok_or_else(|| GErr::Other("Grimmory sent no refresh token.".into()))?;
    Ok((access, refresh))
}

fn save_tokens(app: &AppHandle, access: &str, refresh: &str) {
    set(app, K_ACCESS, access);
    set(app, K_REFRESH, refresh);
    set(app, K_SIGNED_OUT, "0");
    *g(app).tokens.lock().unwrap() = Some(Tokens { access: access.into(), refresh: refresh.into(), renewed_at: db::now() });
}

fn signed_out(app: &AppHandle) {
    *g(app).tokens.lock().unwrap() = None;
    set(app, K_ACCESS, "");
    set(app, K_REFRESH, "");
    set(app, K_SIGNED_OUT, "1");
    update_status(app, |s| {
        s.signed_in = false;
        s.signed_out = true;
    });
}

/// A request got through: Grimmory is online.
pub fn reached(app: &AppHandle) {
    let was = g(app).status.lock().unwrap().reach.clone();
    if was != Reach::Online {
        update_status(app, |s| s.reach = Reach::Online);
        if was == Reach::Offline {
            back_online(app);
        }
    }
}

/// A request failed. A connection failure starts a second look before Grimmory is shown offline.
pub fn failed(app: &AppHandle, e: GErr) -> GErr {
    if matches!(e, GErr::Offline(_)) {
        recheck(app);
    }
    e
}

pub async fn health(app: &AppHandle) -> bool {
    let gr = g(app);
    let base = gr.base();
    let ok = gr
        .http
        .get(format!("{base}/api/v1/healthcheck"))
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    ok
}

fn recheck(app: &AppHandle) {
    let gr = g(app);
    if gr.status.lock().unwrap().reach == Reach::Offline || gr.rechecking.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let ok = health(&app).await;
        g(&app).rechecking.store(false, Ordering::SeqCst);
        if ok {
            reached(&app);
        } else {
            update_status(&app, |s| s.reach = Reach::Offline);
            start_retry_timer(&app);
        }
    });
}

/// While Grimmory is offline: look again after 2 minutes, then 4, 8, 16, and every 30.
pub fn start_retry_timer(app: &AppHandle) {
    let gr = g(app);
    let gen = gr.retry_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut wait = 2u64;
        loop {
            tokio::time::sleep(Duration::from_secs(wait * 60)).await;
            if g(&app).retry_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            if g(&app).status.lock().unwrap().reach != Reach::Offline {
                return;
            }
            if health(&app).await {
                reached(&app);
                return;
            }
            wait = (wait * 2).min(30);
        }
    });
}

/// Back from offline: places waiting go up, waiting downloads go on, the library catches up.
fn back_online(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sync::push_all(&app).await;
        marks_sync::push_all(&app).await;
        downloads::resume_waiting(&app);
        let _ = catalog::sync(&app, false).await;
    });
}

/// Try again: look at Grimmory right away.
pub async fn check_now(app: &AppHandle) -> bool {
    let ok = health(app).await;
    if ok {
        reached(app);
    } else {
        update_status(app, |s| s.reach = Reach::Offline);
        start_retry_timer(app);
    }
    ok
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        sync::count_waiting(&app);
        if !g(&app).signed_in() {
            return;
        }
        downloads::restore(&app);
        sync::push_all(&app).await;
        marks_sync::push_all(&app).await;
        let _ = catalog::sync(&app, false).await;
        // keep up while open: the reading places that moved elsewhere, every 10 minutes
        loop {
            tokio::time::sleep(Duration::from_secs(600)).await;
            if g(&app).signed_in() {
                let _ = catalog::sync(&app, false).await;
            }
        }
    });
}

// ---- commands ----

#[tauri::command]
pub fn grimmory_status(app: AppHandle) -> Status {
    g(&app).status.lock().unwrap().clone()
}

/// Signs in with the username and password he types. The password goes to Grimmory once and is never kept.
#[tauri::command]
pub async fn grimmory_sign_in(app: AppHandle, url: String, user: String, password: String) -> Result<Status, String> {
    let url = normalize_url(&url)?;
    let gr = g(&app);
    let resp = gr
        .http
        .post(format!("{url}/api/v1/auth/login"))
        .json(&serde_json::json!({ "username": user.trim(), "password": password }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| match net(e) {
            GErr::Offline(_) => format!("Nothing answered at {url}. Is the address right, and is the Zima on?"),
            other => other.to_string(),
        })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        let m = server_message(&text);
        return Err(if m.is_empty() { "Grimmory didn't accept that username and password.".into() } else { m });
    }
    if !status.is_success() {
        return Err(GErr::Server(status.as_u16(), server_message(&text)).to_string());
    }
    let (access, refresh) = tokens_of(&text).map_err(String::from)?;
    let old_url = gr.base();
    set(&app, K_URL, &url);
    set(&app, K_USER, user.trim());
    save_tokens(&app, &access, &refresh);
    if old_url != url {
        // another server: its books are other books
        catalog::forget(&app);
    }
    update_status(&app, |s| {
        s.url = url.clone();
        s.user = Some(user.trim().to_string());
        s.signed_in = true;
        s.signed_out = false;
        s.reach = Reach::Online;
        s.last_error = None;
    });
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = catalog::sync(&a, true).await;
        sync::push_all(&a).await;
    });
    Ok(g(&app).status.lock().unwrap().clone())
}

#[tauri::command]
pub fn grimmory_sign_out(app: AppHandle) {
    *g(&app).tokens.lock().unwrap() = None;
    set(&app, K_ACCESS, "");
    set(&app, K_REFRESH, "");
    set(&app, K_SIGNED_OUT, "0");
    update_status(&app, |s| {
        s.signed_in = false;
        s.signed_out = false;
    });
}

/// Changes the server address (Settings). Signing in again follows when it's another server.
#[tauri::command]
pub fn grimmory_set_url(app: AppHandle, url: String) -> Result<Status, String> {
    let url = normalize_url(&url)?;
    let same = g(&app).base() == url;
    set(&app, K_URL, &url);
    if !same {
        grimmory_sign_out(app.clone());
    }
    update_status(&app, |s| {
        s.url = url;
        s.reach = Reach::Unknown;
    });
    Ok(g(&app).status.lock().unwrap().clone())
}

#[tauri::command]
pub async fn grimmory_check(app: AppHandle) -> bool {
    let ok = check_now(&app).await;
    if ok {
        downloads::resume_waiting(&app);
        sync::push_all(&app).await;
        marks_sync::push_all(&app).await;
    }
    ok
}

fn normalize_url(url: &str) -> Result<String, String> {
    let mut u = url.trim().trim_end_matches('/').to_string();
    if u.is_empty() {
        return Err("Type the server's address, like http://192.168.100.100:6060".into());
    }
    if !u.starts_with("http://") && !u.starts_with("https://") {
        u = format!("http://{u}");
    }
    reqwest::Url::parse(&u).map_err(|_| format!("“{url}” isn't an address Katana Desk can use."))?;
    Ok(u)
}
