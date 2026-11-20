//! The dictionaries: Wiktionary and WordNet built in (offline once downloaded), and StarDict files he
//! adds in Settings. The word card asks all of them at once and shows each that knows the word.

pub mod builtin;
pub mod download;
pub mod morph;
pub mod stardict;

use crate::db::{self, Db};
use builtin::{Builtin, Entry};
use serde::{Deserialize, Serialize};
use stardict::StarDict;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// The built-in ones, in the card's order, with what is known before the list is fetched.
pub const BUILT_IN: &[(&str, &str, &str, &str, &str)] = &[
    (
        "wiktionary-en",
        "Wiktionary",
        "CC BY-SA 4.0",
        "https://creativecommons.org/licenses/by-sa/4.0/",
        "Definitions from Wiktionary (https://en.wiktionary.org), by its contributors, extracted with wiktextract by Tatu Ylonen (https://kaikki.org). CC BY-SA 4.0.",
    ),
    (
        "wordnet-en",
        "WordNet",
        "CC BY 4.0",
        "https://creativecommons.org/licenses/by/4.0/",
        "Open English WordNet (https://en-word.net), by John P. McCrae and its contributors, based on Princeton WordNet 3.0 (Princeton University). CC BY 4.0.",
    ),
];

pub struct Dicts {
    pub db: Arc<Db>,
    /// <app data>/dictionaries
    pub dir: PathBuf,
    pub http: reqwest::Client,
    open: Mutex<HashMap<String, Arc<Builtin>>>,
    stars: Mutex<HashMap<String, Arc<StarDict>>>,
}

impl Dicts {
    pub fn new(db: Arc<Db>, dir: PathBuf) -> Dicts {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .user_agent(concat!("KatanaDesk/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Dicts { db, dir, http, open: Mutex::new(HashMap::new()), stars: Mutex::new(HashMap::new()) }
    }
}

pub fn dicts(app: &AppHandle) -> tauri::State<'_, Dicts> {
    app.state::<Dicts>()
}

pub fn setting(app: &AppHandle, key: &str) -> Option<String> {
    db::get_setting(&dicts(app).db.0.lock().unwrap(), key).ok().flatten().filter(|s| !s.is_empty())
}
pub fn set_setting(app: &AppHandle, key: &str, value: &str) {
    let _ = db::set_setting(&dicts(app).db.0.lock().unwrap(), key, value);
}

/// The installed file of a built-in dictionary (`<id>*.sqlite` in the folder; the newest edition).
fn file_of(dir: &Path, id: &str) -> Option<PathBuf> {
    let prefix = format!("katana-{}", id.trim_end_matches("-en"));
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            n.starts_with(&prefix) && n.ends_with(".sqlite")
        })
        .collect();
    found.sort();
    found.pop()
}

/// Removes the installed files of a dictionary, but `keep`.
pub fn remove_files_of(dir: &Path, id: &str, keep: &str) {
    let prefix = format!("katana-{}", id.trim_end_matches("-en"));
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n.starts_with(&prefix) && n.ends_with(".sqlite") && n != keep {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Closes an open dictionary so a new file can take its place.
pub fn forget_open(app: &AppHandle, id: &str) {
    dicts(app).open.lock().unwrap().remove(id);
}

fn builtin(app: &AppHandle, id: &str) -> Option<Arc<Builtin>> {
    let d = dicts(app);
    if let Some(b) = d.open.lock().unwrap().get(id) {
        return Some(b.clone());
    }
    let path = file_of(&d.dir, id)?;
    let b = Arc::new(Builtin::open(&path).ok()?);
    d.open.lock().unwrap().insert(id.into(), b.clone());
    Some(b)
}

// ---------- StarDict files he adds ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StarInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub words: u64,
}

fn star_list(app: &AppHandle) -> Vec<StarInfo> {
    setting(app, "dict.stardict").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save_star_list(app: &AppHandle, list: &[StarInfo]) {
    set_setting(app, "dict.stardict", &serde_json::to_string(list).unwrap_or_default());
}

fn star(app: &AppHandle, info: &StarInfo) -> Result<Arc<StarDict>, String> {
    let d = dicts(app);
    if let Some(s) = d.stars.lock().unwrap().get(&info.id) {
        return Ok(s.clone());
    }
    let s = Arc::new(StarDict::open(Path::new(&info.path))?);
    d.stars.lock().unwrap().insert(info.id.clone(), s.clone());
    Ok(s)
}

// ---------- looking up ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StarEntry {
    pub word: String,
    pub phonetic: Option<String>,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub id: String,
    pub name: String,
    /// "builtin" or "stardict"
    pub kind: String,
    pub headword: String,
    pub entries: Vec<Entry>,
    pub texts: Vec<StarEntry>,
    pub edition: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    pub word: String,
    pub found: Vec<Found>,
    /// built-in dictionaries not on this PC yet
    pub missing: Vec<String>,
    /// StarDict files that couldn't be read (moved, deleted)
    pub broken: Vec<String>,
}

pub fn lookup_now(app: &AppHandle, word: &str) -> Lookup {
    let mut found = vec![];
    let mut missing = vec![];
    for (id, name, ..) in BUILT_IN {
        match builtin(app, id) {
            Some(b) => {
                if let Some((headword, entries)) = b.lookup(word) {
                    found.push(Found { id: id.to_string(), name: name.to_string(), kind: "builtin".into(), headword, entries, texts: vec![], edition: b.edition.clone() });
                }
            }
            None => missing.push(id.to_string()),
        }
    }
    let mut broken = vec![];
    for info in star_list(app) {
        match star(app, &info) {
            Ok(s) => {
                if let Some((headword, list)) = s.lookup(word) {
                    found.push(Found {
                        id: info.id.clone(),
                        name: info.name.clone(),
                        kind: "stardict".into(),
                        headword,
                        entries: vec![],
                        texts: list.into_iter().map(|(w, p, t)| StarEntry { word: w, phonetic: p, text: t }).collect(),
                        edition: String::new(),
                    })
                }
            }
            Err(_) => broken.push(info.name.clone()),
        }
    }
    Lookup { word: word.to_string(), found, missing, broken }
}

/// A word's short meaning for My words: the headword, its part of speech and its first sense.
pub fn meaning_of(app: &AppHandle, word: &str) -> Option<(String, Option<String>, String)> {
    for (id, ..) in BUILT_IN {
        if let Some(b) = builtin(app, id) {
            if let Some((h, entries)) = b.lookup(word) {
                if let Some(e) = entries.iter().find(|e| !e.senses.is_empty()) {
                    return Some((h, e.pos.clone(), e.senses[0].gloss.clone()));
                }
            }
        }
    }
    for info in star_list(app) {
        if let Ok(s) = star(app, &info) {
            if let Some((h, list)) = s.lookup(word) {
                if let Some((_, _, t)) = list.first() {
                    let first = t.lines().find(|l| l.trim().len() > 2).unwrap_or("").trim();
                    if !first.is_empty() {
                        return Some((h, None, first.chars().take(240).collect()));
                    }
                }
            }
        }
    }
    None
}

// ---------- status for the card and Settings ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinState {
    pub id: String,
    pub name: String,
    pub edition: String,
    pub installed: bool,
    /// on this PC
    pub size: u64,
    /// the download, from the list (0 until it's fetched)
    pub download_size: u64,
    pub kept: u64,
    pub licence: String,
    pub licence_url: String,
    pub credit: String,
    pub progress: Option<download::Progress>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub url: String,
    pub default_url: String,
    pub builtin: Vec<BuiltinState>,
    pub stardict: Vec<StarInfo>,
}

pub fn status(app: &AppHandle) -> Status {
    let d = dicts(app);
    let man = download::cached(app);
    let builtin = BUILT_IN
        .iter()
        .map(|(id, name, lic, lic_url, credit)| {
            let file = file_of(&d.dir, id);
            let item = man.as_ref().and_then(|m| m.dictionaries.iter().find(|i| i.id == *id)).cloned();
            let installed = file.is_some();
            let edition = match (&file, &item) {
                (Some(_), _) => builtin(app, id).map(|b| b.edition.clone()).unwrap_or_default(),
                (None, Some(i)) => i.edition.clone(),
                _ => String::new(),
            };
            let mut prog = download::state_of(id);
            let kept = item.as_ref().map(|i| download::kept(app, i)).unwrap_or(0);
            if prog.is_none() && kept > 0 && !installed {
                prog = Some(download::Progress { id: id.to_string(), state: "paused".into(), done: kept, total: item.as_ref().map(|i| i.download_size).unwrap_or(0), error: None });
            }
            BuiltinState {
                id: id.to_string(),
                name: name.to_string(),
                edition,
                installed,
                size: file.and_then(|f| std::fs::metadata(f).ok()).map(|m| m.len()).unwrap_or(0),
                download_size: item.as_ref().map(|i| i.download_size).unwrap_or(0),
                kept,
                licence: item.as_ref().map(|i| i.licence.clone()).unwrap_or_else(|| lic.to_string()),
                licence_url: item.as_ref().map(|i| i.licence_url.clone()).unwrap_or_else(|| lic_url.to_string()),
                credit: item.as_ref().map(|i| i.credit.clone()).unwrap_or_else(|| credit.to_string()),
                progress: prog.filter(|p| p.state != "done" || !installed),
            }
        })
        .collect();
    Status { url: download::url(app), default_url: download::DEFAULT_URL.into(), builtin, stardict: star_list(app) }
}

pub fn emit_status(app: &AppHandle) {
    let _ = app.emit("dict-status", status(app));
}

/// At start: the folder, and downloads that were going go on.
pub fn start(app: &AppHandle) {
    let _ = std::fs::create_dir_all(dicts(app).dir.join("partial"));
    download::restore(app);
}

// ---------- commands ----------

#[tauri::command]
pub async fn dict_lookup(app: AppHandle, word: String) -> Result<Lookup, String> {
    let w = word.chars().take(80).collect::<String>();
    tauri::async_runtime::spawn_blocking(move || lookup_now(&app, &w)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dict_status(app: AppHandle) -> Status {
    status(&app)
}

/// Fetches the list (sizes for Settings and the card); quiet when it can't be reached.
#[tauri::command]
pub async fn dict_refresh(app: AppHandle) -> Result<Status, String> {
    download::manifest(&app).await?;
    Ok(status(&app))
}

/// Gets the built-in dictionaries not on this PC (or one of them).
#[tauri::command]
pub fn dict_download(app: AppHandle, id: Option<String>) {
    let ids: Vec<String> = match id {
        Some(i) => vec![i],
        None => BUILT_IN.iter().filter(|(i, ..)| file_of(&dicts(&app).dir, i).is_none()).map(|(i, ..)| i.to_string()).collect(),
    };
    for i in ids {
        download::start(&app, &i);
    }
}

#[tauri::command]
pub fn dict_pause(app: AppHandle, id: String) {
    download::pause(&app, &id);
}

#[tauri::command]
pub fn dict_cancel(app: AppHandle, id: String) {
    download::cancel(&app, &id);
}

/// Removes a built-in dictionary from this PC (it can be downloaded again).
#[tauri::command]
pub fn dict_remove(app: AppHandle, id: String) -> Status {
    forget_open(&app, &id);
    remove_files_of(&dicts(&app).dir, &id, "");
    status(&app)
}

#[tauri::command]
pub fn dict_set_url(app: AppHandle, url: String) -> Result<Status, String> {
    let u = url.trim();
    if !u.is_empty() && reqwest::Url::parse(u).is_err() {
        return Err("That isn't a web address.".into());
    }
    set_setting(&app, "dict.url", u);
    Ok(status(&app))
}

/// Adds a StarDict dictionary by its `.ifo` file (read where it is, never copied).
#[tauri::command]
pub async fn stardict_add(app: AppHandle, path: String) -> Result<Status, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let ifo = if p.extension().map_or(false, |e| e.eq_ignore_ascii_case("ifo")) {
            p
        } else {
            // a folder: its first .ifo
            std::fs::read_dir(&p)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|e| e.path())
                .find(|x| x.extension().map_or(false, |e| e.eq_ignore_ascii_case("ifo")))
                .ok_or("There's no StarDict .ifo file there.")?
        };
        let s = StarDict::open(&ifo)?;
        let mut list = star_list(&app2);
        let path_s = ifo.to_string_lossy().to_string();
        if list.iter().any(|x| x.path.eq_ignore_ascii_case(&path_s)) {
            return Err(format!("{} is already added.", s.name));
        }
        let id = format!("stardict-{}", crate::marks::new_uuid().split('-').next().unwrap_or("x"));
        let info = StarInfo { id: id.clone(), name: s.name.clone(), path: path_s, words: s.words() as u64 };
        dicts(&app2).stars.lock().unwrap().insert(id, Arc::new(s));
        list.push(info);
        save_star_list(&app2, &list);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(status(&app))
}

#[tauri::command]
pub fn stardict_remove(app: AppHandle, id: String) -> Status {
    let mut list = star_list(&app);
    list.retain(|x| x.id != id);
    save_star_list(&app, &list);
    dicts(&app).stars.lock().unwrap().remove(&id);
    status(&app)
}

/// Opens a web page in the default browser (Look it up online, the licences).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web addresses open in the browser.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // rundll32 hands the address to the default browser without a console window
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener).arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
