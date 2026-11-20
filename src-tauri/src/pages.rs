//! Books read as pages: DjVu (DjVuLibre, built from source by build.rs) and comics (CBZ, and CBR).
//! PDFs are drawn in the page by PDF.js; their covers come back from there (`pdf_cover`).
//!
//! Pages are served to the reader as `kpage://localhost/<book id>/<page index>?w=<width>`:
//! a DjVu page is drawn at that width (grey PNG for black-and-white pages, JPEG for the rest), a comic
//! page is its own picture from the archive, unchanged.

use crate::{db, library::Library, meta};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::{c_char, c_int, CStr, CString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder, Wry};

// ---------- DjVuLibre ----------

#[repr(C)]
struct KDjvu {
    _p: [u8; 0],
}

extern "C" {
    fn kdjvu_open(path: *const c_char, err: *mut c_char, errlen: c_int) -> *mut KDjvu;
    fn kdjvu_page_count(h: *mut KDjvu) -> c_int;
    fn kdjvu_page_info(h: *mut KDjvu, page: c_int, w: *mut c_int, ht: *mut c_int, dpi: *mut c_int) -> c_int;
    fn kdjvu_render(
        h: *mut KDjvu,
        page: c_int,
        w: c_int,
        ht: c_int,
        allow_grey: c_int,
        pixels: *mut u8,
        len: usize,
        err: *mut c_char,
        errlen: c_int,
    ) -> c_int;
    fn kdjvu_page_text(h: *mut KDjvu, page: c_int) -> *mut c_char;
    fn kdjvu_outline(h: *mut KDjvu) -> *mut c_char;
    fn kdjvu_free(s: *mut c_char);
    fn kdjvu_close(h: *mut KDjvu);
}

/// One open DjVu document. Calls on it are serialized by the Mutex it lives in.
pub struct Djvu {
    h: *mut KDjvu,
    pub pages: i32,
}

// The handle is only ever used under its Mutex.
unsafe impl Send for Djvu {}

impl Drop for Djvu {
    fn drop(&mut self) {
        unsafe { kdjvu_close(self.h) }
    }
}

fn take_string(p: *mut c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe { kdjvu_free(p) };
    Some(s)
}

impl Djvu {
    pub fn open(path: &Path) -> Result<Djvu, String> {
        let c = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "The path has a NUL byte".to_string())?;
        let mut err = vec![0 as c_char; 512];
        let h = unsafe { kdjvu_open(c.as_ptr(), err.as_mut_ptr(), err.len() as c_int) };
        if h.is_null() {
            let msg = unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned();
            return Err(if msg.is_empty() { "This DjVu file couldn't be opened.".into() } else { msg });
        }
        let pages = unsafe { kdjvu_page_count(h) };
        Ok(Djvu { h, pages })
    }

    /// Width, height (with the page's own rotation) and dpi.
    pub fn page_info(&self, page: i32) -> Option<(i32, i32, i32)> {
        let (mut w, mut h, mut d) = (0, 0, 0);
        let ok = unsafe { kdjvu_page_info(self.h, page, &mut w, &mut h, &mut d) };
        (ok == 1).then_some((w, h, d))
    }

    /// The page drawn at `width` px wide, as an image file's bytes and its type.
    pub fn render(&self, page: i32, width: u32, allow_grey: bool) -> Result<(Vec<u8>, &'static str), String> {
        let (pw, ph, _) = self.page_info(page).ok_or("This page couldn't be read.")?;
        let width = width.clamp(16, 6000);
        let height = ((ph as f64) * (width as f64) / (pw.max(1) as f64)).round().max(1.0) as u32;
        let mut buf = vec![0u8; (width as usize) * (height as usize) * 3];
        let mut err = vec![0 as c_char; 512];
        let kind = unsafe {
            kdjvu_render(
                self.h,
                page,
                width as c_int,
                height as c_int,
                allow_grey as c_int,
                buf.as_mut_ptr(),
                buf.len(),
                err.as_mut_ptr(),
                err.len() as c_int,
            )
        };
        if kind == 0 {
            let msg = unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned();
            return Err(if msg.is_empty() { "This page couldn't be drawn.".into() } else { msg });
        }
        let mut out = Vec::new();
        if kind == 2 || kind == -1 {
            buf.truncate((width as usize) * (height as usize));
            let img = image::GrayImage::from_raw(width, height, buf).ok_or("bad page size")?;
            let enc = image::codecs::png::PngEncoder::new_with_quality(
                &mut out,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::Sub,
            );
            img.write_with_encoder(enc).map_err(|e| e.to_string())?;
            Ok((out, "image/png"))
        } else {
            let img = image::RgbImage::from_raw(width, height, buf).ok_or("bad page size")?;
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
            enc.encode_image(&img).map_err(|e| e.to_string())?;
            Ok((out, "image/jpeg"))
        }
    }

    pub fn text(&self, page: i32) -> Option<serde_json::Value> {
        take_string(unsafe { kdjvu_page_text(self.h, page) }).and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn outline(&self) -> serde_json::Value {
        take_string(unsafe { kdjvu_outline(self.h) })
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!([]))
    }
}

/// Open DjVu documents: two lanes per book (the page you read and the thumbnails), so one never
/// waits for the other; the four most recently used books stay open.
type Lane = Arc<Mutex<Djvu>>;
fn open_docs() -> &'static Mutex<Vec<((i64, u8), Lane)>> {
    static D: OnceLock<Mutex<Vec<((i64, u8), Lane)>>> = OnceLock::new();
    D.get_or_init(Default::default)
}

fn djvu_doc(path: &Path, id: i64, lane: u8) -> Result<Lane, String> {
    {
        let mut docs = open_docs().lock().unwrap();
        if let Some(i) = docs.iter().position(|(k, _)| *k == (id, lane)) {
            let d = docs.remove(i);
            let l = d.1.clone();
            docs.push(d);
            return Ok(l);
        }
    }
    let d = Arc::new(Mutex::new(Djvu::open(path)?));
    let mut docs = open_docs().lock().unwrap();
    docs.push(((id, lane), d.clone()));
    while docs.len() > 8 {
        docs.remove(0);
    }
    Ok(d)
}

// ---------- comics ----------

/// Picture types counted as pages (the union of Kavita's and Grimmory's, as on Android).
const PAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];

fn is_page_name(name: &str) -> bool {
    let n = name.replace('\\', "/");
    if n.split('/').any(|part| part == "__MACOSX" || part.starts_with('.')) {
        return false;
    }
    let l = n.to_lowercase();
    l.rsplit_once('.').map_or(false, |(_, e)| PAGE_EXT.contains(&e))
}

/// Natural order ("page 2" before "page 10"), the one Grimmory and Katana use for comic pages.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn tokens(s: &str) -> Vec<Result<u128, String>> {
        let mut out = vec![];
        let mut cur = String::new();
        let mut digits = false;
        for c in s.to_lowercase().chars() {
            let d = c.is_ascii_digit();
            if !cur.is_empty() && d != digits {
                out.push(if digits { cur.parse::<u128>().map_err(|_| cur.clone()) } else { Err(cur.clone()) });
                cur.clear();
            }
            digits = d;
            cur.push(c);
        }
        if !cur.is_empty() {
            out.push(if digits { cur.parse::<u128>().map_err(|_| cur.clone()) } else { Err(cur) });
        }
        out
    }
    let (ta, tb) = (tokens(a), tokens(b));
    for (x, y) in ta.iter().zip(tb.iter()) {
        let o = match (x, y) {
            (Ok(p), Ok(q)) => p.cmp(q),
            (Ok(_), Err(_)) => std::cmp::Ordering::Less,
            (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
            (Err(p), Err(q)) => p.cmp(q),
        };
        if o != std::cmp::Ordering::Equal {
            return o;
        }
    }
    ta.len().cmp(&tb.len())
}

/// Where a comic's pages are read from.
#[derive(Clone)]
enum Comic {
    /// a ZIP (any CBZ, and a CBR that is really a ZIP): entry names in page order
    Zip { path: PathBuf, names: Vec<String> },
    /// a RAR, unpacked once into a folder: files in page order
    Dir { files: Vec<PathBuf> },
}

impl Comic {
    fn len(&self) -> usize {
        match self {
            Comic::Zip { names, .. } => names.len(),
            Comic::Dir { files } => files.len(),
        }
    }
    fn page(&self, i: usize) -> Option<(Vec<u8>, String)> {
        match self {
            Comic::Zip { path, names } => {
                let name = names.get(i)?;
                let mut z = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
                let mut f = z.by_name(name).ok()?;
                let mut out = Vec::with_capacity(f.size() as usize);
                f.read_to_end(&mut out).ok()?;
                Some((out, name.clone()))
            }
            Comic::Dir { files } => {
                let p = files.get(i)?;
                Some((std::fs::read(p).ok()?, p.to_string_lossy().into_owned()))
            }
        }
    }
}

fn is_zip(path: &Path) -> bool {
    let mut b = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut b)).is_ok() && &b == b"PK\x03\x04"
}

fn zip_pages(path: &Path) -> Result<Comic, String> {
    let z = zip::ZipArchive::new(std::fs::File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = z.file_names().filter(|n| is_page_name(n)).map(String::from).collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    Ok(Comic::Zip { path: path.to_path_buf(), names })
}

/// The programs that can unpack a RAR, tried in turn: bsdtar (Windows' own tar.exe is bsdtar with
/// libarchive, which reads RAR; on Linux the libarchive-tools package), then unrar, 7-Zip and unar.
fn unpack_rar(path: &Path, into: &Path) -> Result<(), String> {
    use std::process::Command;
    let _ = std::fs::create_dir_all(into);
    let mut tries: Vec<(PathBuf, Vec<std::ffi::OsString>)> = vec![];
    let p = path.as_os_str().to_os_string();
    let d = into.as_os_str().to_os_string();
    #[cfg(windows)]
    {
        let sys = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        tries.push((sys.join("System32").join("tar.exe"), vec!["-xf".into(), p.clone(), "-C".into(), d.clone()]));
        for seven in [r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe"] {
            let mut out = std::ffi::OsString::from("-o");
            out.push(&d);
            tries.push((PathBuf::from(seven), vec!["x".into(), "-y".into(), out, p.clone()]));
        }
    }
    #[cfg(not(windows))]
    {
        tries.push((PathBuf::from("bsdtar"), vec!["-xf".into(), p.clone(), "-C".into(), d.clone()]));
        let mut into_slash = d.clone();
        into_slash.push("/");
        tries.push((PathBuf::from("unrar"), vec!["x".into(), "-o+".into(), "-idq".into(), p.clone(), into_slash]));
        let mut out = std::ffi::OsString::from("-o");
        out.push(&d);
        tries.push((PathBuf::from("7z"), vec!["x".into(), "-y".into(), out, p.clone()]));
        tries.push((PathBuf::from("unar"), vec!["-q".into(), "-f".into(), "-o".into(), d.clone(), p.clone()]));
    }
    for (exe, args) in tries {
        let mut cmd = Command::new(&exe);
        cmd.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // no console window
        }
        if let Ok(st) = cmd.status() {
            if st.success() {
                return Ok(());
            }
        }
    }
    Err("This CBR is a RAR archive, and nothing on this PC could unpack it. On Linux, install libarchive-tools (bsdtar), unrar or 7-Zip.".into())
}

fn dir_pages(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(String, PathBuf)> = walkdir::WalkDir::new(dir)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let rel = e.path().strip_prefix(dir).ok()?.to_string_lossy().replace('\\', "/");
            is_page_name(&rel).then(|| (rel, e.path().to_path_buf()))
        })
        .collect();
    files.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    files.into_iter().map(|(_, p)| p).collect()
}

fn comics() -> &'static Mutex<HashMap<i64, Comic>> {
    static C: OnceLock<Mutex<HashMap<i64, Comic>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn cache_dir(app: &AppHandle) -> PathBuf {
    app.state::<Library>().covers_dir.parent().map(|p| p.join("comics")).unwrap_or_else(|| PathBuf::from("comics"))
}

/// A comic's pages, opened once per run (a RAR is unpacked into the app's data folder once and kept
/// there while it's the same file).
fn comic(app: &AppHandle, id: i64, path: &Path) -> Result<Comic, String> {
    if let Some(c) = comics().lock().unwrap().get(&id) {
        return Ok(c.clone());
    }
    // one opening at a time: the reader asks for the book and its first pages at once
    static OPENING: Mutex<()> = Mutex::new(());
    let _one = OPENING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = comics().lock().unwrap().get(&id) {
        return Ok(c.clone());
    }
    let c = if is_zip(path) {
        zip_pages(path)?
    } else {
        let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let stamp = format!("{}-{}", md.len(), md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()));
        let root = cache_dir(app);
        let dir = root.join(format!("{id}-{stamp}"));
        if !dir.join(".done").exists() {
            // an older unpacking of this book goes (a half-done one too)
            if let Ok(rd) = std::fs::read_dir(&root) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with(&format!("{id}-")) {
                        let _ = std::fs::remove_dir_all(e.path());
                    }
                }
            }
            // unpacked beside, then moved into place whole
            let part = root.join(format!("{id}-{stamp}.part"));
            unpack_rar(path, &part)?;
            let _ = std::fs::write(part.join(".done"), b"");
            std::fs::rename(&part, &dir).map_err(|e| e.to_string())?;
        }
        Comic::Dir { files: dir_pages(&dir) }
    };
    if c.len() == 0 {
        return Err("No pictures were found in this comic.".into());
    }
    comics().lock().unwrap().insert(id, c.clone());
    Ok(c)
}

fn mime_of(name: &str) -> &'static str {
    let l = name.to_lowercase();
    match l.rsplit_once('.').map(|x| x.1).unwrap_or("") {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    }
}

// ---------- the reader's calls ----------

fn book_path(app: &AppHandle, id: i64) -> Result<(PathBuf, String), String> {
    let lib = app.state::<Library>();
    let conn = lib.db.0.lock().unwrap();
    let b = db::book(&conn, id).map_err(|e| e.to_string())?.ok_or("This book is gone from the library.")?;
    Ok((PathBuf::from(b.path), b.format))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageBook {
    /// "djvu" or "comic"
    pub kind: String,
    /// each page's width and height (pixels for DjVu, the picture's for comics: 0 when not known yet)
    pub sizes: Vec<[i32; 2]>,
    /// DjVu's outline: [{t, p, c}]
    pub outline: serde_json::Value,
}

/// Opens a DjVu book or a comic for the reader.
#[tauri::command]
pub async fn page_book(app: AppHandle, id: i64) -> Result<PageBook, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, format) = book_path(&app, id)?;
        if format == "djvu" {
            let lane = djvu_doc(&path, id, 0)?;
            let d = lane.lock().unwrap();
            let sizes = (0..d.pages).map(|i| d.page_info(i).map_or([0, 0], |(w, h, _)| [w, h])).collect();
            Ok(PageBook { kind: "djvu".into(), sizes, outline: d.outline() })
        } else {
            let c = comic(&app, id, &path)?;
            // picture sizes are read from each picture's header (a few bytes), so two-page spreads can
            // tell a wide page from a narrow one
            let sizes = (0..c.len())
                .map(|i| match &c {
                    Comic::Dir { files } => image::image_dimensions(&files[i]).map_or([0, 0], |(w, h)| [w as i32, h as i32]),
                    Comic::Zip { .. } => [0, 0],
                })
                .collect();
            Ok(PageBook { kind: "comic".into(), sizes, outline: serde_json::json!([]) })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A DjVu page's hidden text (the OCR layer), or null.
#[tauri::command]
pub async fn djvu_text(app: AppHandle, id: i64, page: i32) -> Result<Option<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, _) = book_path(&app, id)?;
        // search reads every page: it takes the thumbnails' lane, so the page you read stays quick
        let lane = djvu_doc(&path, id, 1)?;
        let d = lane.lock().unwrap();
        Ok(d.text(page))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The book closed: its documents close too (a RAR stays unpacked for next time).
#[tauri::command]
pub fn page_book_closed(id: i64) {
    open_docs().lock().unwrap().retain(|((b, _), _)| *b != id);
    comics().lock().unwrap().remove(&id);
}

/// A PDF's cover, drawn from its first page by PDF.js in the page.
#[tauri::command]
pub fn pdf_cover(app: AppHandle, id: i64, png: Vec<u8>) -> Result<bool, String> {
    let lib = app.state::<Library>();
    let out = lib.covers_dir.join(format!("{id}.jpg"));
    let ok = !png.is_empty() && meta::save_cover(&png, &out).is_some();
    let conn = lib.db.0.lock().unwrap();
    if ok {
        let _ = db::set_cover(&conn, id, Some(&out.to_string_lossy()));
    }
    let _ = conn.execute("UPDATE books SET cover_tried = 1 WHERE id = ?1", [id]);
    Ok(ok)
}

/// PDFs without a cover that haven't been tried yet: the page draws their first pages.
#[tauri::command]
pub fn pdf_covers_todo(app: AppHandle) -> Vec<(i64, String)> {
    let lib = app.state::<Library>();
    let conn = lib.db.0.lock().unwrap();
    let Ok(mut st) = conn.prepare(
        "SELECT id, path FROM books WHERE format = 'pdf' AND cover IS NULL AND cover_tried = 0 AND missing = 0 ORDER BY opened_at DESC, added_at DESC LIMIT 400",
    ) else {
        return vec![];
    };
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)));
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

/// The cover of a DjVu book (its first page) or a comic (its first page), for the library.
pub fn cover_of(path: &Path, format: &str) -> Option<Vec<u8>> {
    match format {
        "djvu" => {
            let d = Djvu::open(path).ok()?;
            let (bytes, _) = d.render(0, 720, false).ok()?;
            Some(bytes)
        }
        "cbr" => {
            if is_zip(path) {
                let c = zip_pages(path).ok()?;
                return c.page(0).map(|x| x.0);
            }
            first_rar_page(path)
        }
        _ => None,
    }
}

/// A RAR comic's first page, read without unpacking it all: bsdtar lists it, then writes that one file out.
fn first_rar_page(path: &Path) -> Option<Vec<u8>> {
    use std::process::Command;
    #[cfg(windows)]
    let tar = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join("tar.exe");
    #[cfg(not(windows))]
    let tar = PathBuf::from("bsdtar");
    let run = |args: &[&std::ffi::OsStr]| {
        let mut cmd = Command::new(&tar);
        cmd.args(args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.output().ok().filter(|o| o.status.success()).map(|o| o.stdout)
    };
    let list = run(&["-tf".as_ref(), path.as_os_str()])?;
    let mut names: Vec<String> = String::from_utf8_lossy(&list).lines().map(String::from).filter(|n| is_page_name(n)).collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    let first = names.first()?;
    run(&["-xOf".as_ref(), path.as_os_str(), first.as_ref()]).filter(|b| !b.is_empty())
}

/// DjVu books and RAR comics found before covers were read for them (or added while a scan ran):
/// their first page becomes the cover, once.
pub fn fill_covers(app: &AppHandle) {
    let lib = app.state::<Library>();
    let todo: Vec<(i64, String, String)> = {
        let conn = lib.db.0.lock().unwrap();
        let Ok(mut st) = conn.prepare(
            "SELECT id, path, format FROM books WHERE format IN ('djvu', 'cbr') AND cover IS NULL AND cover_tried = 0 AND missing = 0",
        ) else {
            return;
        };
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    };
    let mut any = false;
    for (id, path, format) in todo {
        let out = lib.covers_dir.join(format!("{id}.jpg"));
        let cover = cover_of(Path::new(&path), &format).and_then(|b| meta::save_cover(&b, &out)).map(|_| out.to_string_lossy().to_string());
        let conn = lib.db.0.lock().unwrap();
        if cover.is_some() {
            any = true;
            let _ = db::set_cover(&conn, id, cover.as_deref());
        }
        let _ = conn.execute("UPDATE books SET cover_tried = 1 WHERE id = ?1", [id]);
    }
    if any {
        use tauri::Emitter;
        let _ = app.emit("library-changed", ());
    }
}

// ---------- the kpage protocol ----------

fn respond(status: StatusCode, body: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "max-age=3600")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap()
}

/// `kpage://localhost/<book id>/<page index>?w=<width>&t=1` (t: the thumbnails' lane).
pub fn handle(ctx: UriSchemeContext<'_, Wry>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let uri = req.uri().clone();
    std::thread::spawn(move || {
        let mut parts = uri.path().trim_start_matches('/').split('/');
        let id = parts.next().and_then(|x| x.parse::<i64>().ok());
        let page = parts.next().and_then(|x| x.parse::<usize>().ok());
        let q: HashMap<String, String> = uri
            .query()
            .unwrap_or("")
            .split('&')
            .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect();
        let width = q.get("w").and_then(|w| w.parse::<u32>().ok()).unwrap_or(1200);
        let thumb = q.get("t").map_or(false, |t| t == "1");
        let (Some(id), Some(page)) = (id, page) else {
            return responder.respond(respond(StatusCode::NOT_FOUND, vec![], "text/plain"));
        };
        let out = (|| -> Result<(Vec<u8>, String), String> {
            let (path, format) = book_path(&app, id)?;
            if format == "djvu" {
                let lane = djvu_doc(&path, id, thumb as u8)?;
                let d = lane.lock().unwrap();
                let (b, m) = d.render(page as i32, width, true)?;
                Ok((b, m.to_string()))
            } else {
                let c = comic(&app, id, &path)?;
                let (b, name) = c.page(page).ok_or("No such page")?;
                Ok((b, mime_of(&name).to_string()))
            }
        })();
        match out {
            Ok((b, m)) => responder.respond(respond(StatusCode::OK, b, &m)),
            Err(e) => responder.respond(respond(StatusCode::INTERNAL_SERVER_ERROR, e.into_bytes(), "text/plain")),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_sort_naturally() {
        let mut v = vec!["p10.jpg", "p2.jpg", "p1.jpg", "P3.png", "cover.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["cover.jpg", "p1.jpg", "p2.jpg", "P3.png", "p10.jpg"]);
    }

    #[test]
    fn page_names_skip_mac_files() {
        assert!(is_page_name("Issue 1/001.jpg"));
        assert!(!is_page_name("__MACOSX/Issue 1/._001.jpg"));
        assert!(!is_page_name("Issue 1/._001.jpg"));
        assert!(!is_page_name("ComicInfo.xml"));
    }

    /// Run with KATANA_DJVU_TEST=<a .djvu file>: opens it, draws page 1, reads its text and outline.
    #[test]
    fn a_real_djvu_opens() {
        let Ok(p) = std::env::var("KATANA_DJVU_TEST") else { return };
        let t = std::time::Instant::now();
        let d = Djvu::open(Path::new(&p)).expect("opens");
        assert!(d.pages > 0);
        let (w, h, dpi) = d.page_info(0).expect("page info");
        let open_ms = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let (bytes, mime) = d.render(0, 1200, true).expect("draws");
        let draw_ms = t.elapsed().as_millis();
        std::fs::write(std::env::temp_dir().join(format!("kdjvu-p1.{}", if mime == "image/png" { "png" } else { "jpg" })), &bytes).unwrap();
        let text = d.text(10).map(|v| v["text"].as_str().unwrap_or("").chars().take(120).collect::<String>());
        let outline = d.outline();
        eprintln!("pages {} size {w}x{h} dpi {dpi} open {open_ms} ms, draw {draw_ms} ms {} {} bytes; text p11: {:?}; outline items {}",
            d.pages, mime, bytes.len(), text, outline.as_array().map_or(0, |a| a.len()));
    }
}
