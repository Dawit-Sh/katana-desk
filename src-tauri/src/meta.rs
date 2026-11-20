//! Reads a book file's title, author and cover without opening it in the reader.
//! EPUB: the OPF package. CBZ: the first picture. FB2: its title-info and coverpage.
//! Everything else: the file name, and a drawn cover in the library.

use md5::{Digest, Md5};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const FORMATS: &[&str] = &["epub", "mobi", "prc", "azw3", "azw", "fb2", "fbz", "cbz", "cbr", "pdf", "djvu", "djv"];

pub fn format_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if name.ends_with(".fb2.zip") {
        return Some("fbz".into());
    }
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    let ext = if ext == "djv" { "djvu".to_string() } else { ext };
    FORMATS.contains(&ext.as_str()).then_some(ext)
}

#[derive(Default)]
pub struct Meta {
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover: Option<Vec<u8>>,
}

pub fn title_from_name(path: &Path) -> String {
    let stem = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stem = stem
        .trim_end_matches(".zip")
        .rsplit_once('.')
        .map(|(a, _)| a.to_string())
        .unwrap_or(stem.clone());
    stem.replace('_', " ").trim().to_string()
}

pub fn read(path: &Path, format: &str) -> Meta {
    let r = match format {
        "epub" => epub(path),
        "cbz" => cbz(path),
        "fb2" => std::fs::read(path).ok().map(|b| fb2(&b)),
        "fbz" => fbz(path),
        "djvu" | "cbr" => Some(Meta { title: None, author: None, cover: crate::pages::cover_of(path, format) }),
        _ => None,
    };
    let mut m = r.unwrap_or_default();
    // a Calibre book folder (metadata.opf and cover.jpg beside the file) fills in what the file itself lacks
    if m.title.is_none() || m.cover.is_none() {
        if let Some(dir) = path.parent() {
            if m.title.is_none() || m.author.is_none() {
                if let Some(opf) = std::fs::read(dir.join("metadata.opf")).ok() {
                    let side = opf_meta(&opf);
                    m.title = m.title.or(side.title);
                    m.author = m.author.or(side.author);
                }
            }
            if m.cover.is_none() {
                m.cover = std::fs::read(dir.join("cover.jpg")).ok();
            }
        }
    }
    m
}

/// Title and first author from an OPF package (also Calibre's metadata.opf).
fn opf_meta(opf: &[u8]) -> Meta {
    let mut meta = Meta::default();
    let mut rd = Reader::from_reader(opf);
    rd.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut in_text: Option<&'static str> = None;
    let mut text = String::new();
    loop {
        match rd.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match local(e.name().as_ref()).as_str() {
                "title" if meta.title.is_none() => { in_text = Some("title"); text.clear(); }
                "creator" if meta.author.is_none() => { in_text = Some("creator"); text.clear(); }
                _ => {}
            },
            Ok(Event::Text(t)) if in_text.is_some() => {
                if let Ok(s) = t.decode() { text.push_str(&s); }
            }
            Ok(Event::GeneralRef(r)) if in_text.is_some() => text.push_str(entity(r.as_ref())),
            Ok(Event::End(_)) => {
                if let Some(which) = in_text.take() {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        if which == "title" { meta.title = Some(v) } else { meta.author = Some(v) }
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    meta
}

fn entity(r: &[u8]) -> &'static str {
    match r {
        b"amp" => "&",
        b"lt" => "<",
        b"gt" => ">",
        b"quot" => "\"",
        b"apos" => "'",
        _ => "",
    }
}

/// KOReader's partial MD5 (the one Grimmory matches books with): 1 KB samples at 256 B, 1 KB, 4 KB ... 1 GB.
pub fn partial_md5(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut hasher = Md5::new();
    let mut buf = vec![0u8; 1024];
    for i in -1i32..=10 {
        let offset: u64 = if i < 0 { 1024 >> 2 } else { 1024u64 << (2 * i) };
        if offset >= len {
            break;
        }
        f.seek(SeekFrom::Start(offset)).ok()?;
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn local(name: &[u8]) -> String {
    let s = String::from_utf8_lossy(name);
    match s.rsplit_once(':') {
        Some((_, l)) => l.to_string(),
        None => s.to_string(),
    }
}

fn attr(e: &quick_xml::events::BytesStart, key: &str) -> Option<String> {
    e.attributes().flatten().find(|a| local(a.key.as_ref()) == key).and_then(|a| {
        a.unescape_value().ok().map(|v| v.to_string())
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Joins a relative href onto the folder of the file it came from, inside the zip.
fn join(base_file: &str, href: &str) -> String {
    let href = percent_decode(href.split('#').next().unwrap_or(href));
    let mut parts: Vec<&str> = match base_file.rsplit_once('/') {
        Some((dir, _)) => dir.split('/').collect(),
        None => vec![],
    };
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn zip_read(z: &mut zip::ZipArchive<File>, name: &str) -> Option<Vec<u8>> {
    let real = if z.index_for_name(name).is_some() {
        name.to_string()
    } else {
        // some books differ in case between the manifest and the zip
        let lower = name.to_lowercase();
        z.file_names().find(|n| n.to_lowercase() == lower)?.to_string()
    };
    let mut f = z.by_name(&real).ok()?;
    let mut v = Vec::new();
    f.read_to_end(&mut v).ok()?;
    Some(v)
}

struct Item {
    id: String,
    href: String,
    media: String,
    props: String,
}

fn epub(path: &Path) -> Option<Meta> {
    let mut z = zip::ZipArchive::new(File::open(path).ok()?).ok()?;
    let container = zip_read(&mut z, "META-INF/container.xml")?;
    let mut opf_path = None;
    let mut rd = Reader::from_reader(container.as_slice());
    let mut buf = Vec::new();
    loop {
        match rd.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if local(e.name().as_ref()) == "rootfile" => {
                opf_path = attr(&e, "full-path");
                break;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    let opf_path = opf_path?;
    let opf = zip_read(&mut z, &opf_path)?;

    let mut meta = Meta::default();
    let mut items: Vec<Item> = Vec::new();
    let mut cover_id: Option<String> = None;
    let mut guide_cover: Option<String> = None;
    let mut in_text: Option<&'static str> = None;
    let mut text = String::new();
    let mut rd = Reader::from_reader(opf.as_slice());
    rd.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match rd.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let n = local(e.name().as_ref());
                match n.as_str() {
                    "title" if meta.title.is_none() => {
                        in_text = Some("title");
                        text.clear();
                    }
                    "creator" if meta.author.is_none() => {
                        in_text = Some("creator");
                        text.clear();
                    }
                    _ => handle_opf_tag(&e, &n, &mut items, &mut cover_id, &mut guide_cover),
                }
            }
            Ok(Event::Empty(e)) => {
                let n = local(e.name().as_ref());
                handle_opf_tag(&e, &n, &mut items, &mut cover_id, &mut guide_cover);
            }
            Ok(Event::Text(t)) if in_text.is_some() => {
                if let Ok(s) = t.decode() {
                    text.push_str(&s);
                }
            }
            Ok(Event::GeneralRef(r)) if in_text.is_some() => {
                // &amp; and friends inside a title
                let name = String::from_utf8_lossy(r.as_ref()).to_string();
                text.push_str(match name.as_str() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => "",
                });
            }
            Ok(Event::End(_)) => {
                if let Some(which) = in_text.take() {
                    let v = text.trim().to_string();
                    if !v.is_empty() {
                        if which == "title" {
                            meta.title = Some(v);
                        } else {
                            meta.author = Some(v);
                        }
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    let is_img = |i: &&Item| i.media.starts_with("image/");
    let pick = items
        .iter()
        .find(|i| i.props.split_whitespace().any(|p| p == "cover-image"))
        .or_else(|| {
            cover_id.as_ref().and_then(|c| {
                items.iter().find(|i| &i.id == c).or_else(|| items.iter().find(|i| &i.href == c))
            })
        })
        .filter(is_img)
        .or_else(|| {
            items
                .iter()
                .filter(is_img)
                .find(|i| i.id.to_lowercase().contains("cover") || i.href.to_lowercase().contains("cover"))
        });
    if let Some(item) = pick {
        meta.cover = zip_read(&mut z, &join(&opf_path, &item.href));
    } else if let Some(page) = guide_cover {
        // the guide points at a cover page; its first picture is the cover
        let page_path = join(&opf_path, &page);
        if let Some(html) = zip_read(&mut z, &page_path) {
            if let Some(src) = first_image_src(&html) {
                meta.cover = zip_read(&mut z, &join(&page_path, &src));
            }
        }
    }
    Some(meta)
}

fn handle_opf_tag(
    e: &quick_xml::events::BytesStart,
    n: &str,
    items: &mut Vec<Item>,
    cover_id: &mut Option<String>,
    guide_cover: &mut Option<String>,
) {
    match n {
        "item" => items.push(Item {
            id: attr(e, "id").unwrap_or_default(),
            href: attr(e, "href").unwrap_or_default(),
            media: attr(e, "media-type").unwrap_or_default(),
            props: attr(e, "properties").unwrap_or_default(),
        }),
        "meta" if attr(e, "name").as_deref() == Some("cover") => *cover_id = attr(e, "content"),
        "reference" if attr(e, "type").map(|t| t.to_lowercase()) == Some("cover".into()) => {
            *guide_cover = attr(e, "href")
        }
        _ => {}
    }
}

fn first_image_src(html: &[u8]) -> Option<String> {
    let mut rd = Reader::from_reader(html);
    let mut buf = Vec::new();
    loop {
        match rd.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let n = local(e.name().as_ref());
                if n == "img" {
                    if let Some(s) = attr(&e, "src") {
                        return Some(s);
                    }
                }
                if n == "image" {
                    if let Some(s) = attr(&e, "href") {
                        return Some(s);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
        buf.clear();
    }
}

fn is_image_name(n: &str) -> bool {
    let l = n.to_lowercase();
    [".jpg", ".jpeg", ".png", ".webp", ".gif"].iter().any(|e| l.ends_with(e))
}

fn cbz(path: &Path) -> Option<Meta> {
    let mut z = zip::ZipArchive::new(File::open(path).ok()?).ok()?;
    let mut names: Vec<String> = z.file_names().filter(|n| is_image_name(n)).map(String::from).collect();
    names.sort_by_key(|n| n.to_lowercase());
    let first = names.first()?.clone();
    Some(Meta { title: None, author: None, cover: zip_read(&mut z, &first) })
}

fn fbz(path: &Path) -> Option<Meta> {
    let mut z = zip::ZipArchive::new(File::open(path).ok()?).ok()?;
    let name = z.file_names().find(|n| n.to_lowercase().ends_with(".fb2"))?.to_string();
    let bytes = zip_read(&mut z, &name)?;
    Some(fb2(&bytes))
}

fn fb2(bytes: &[u8]) -> Meta {
    let mut meta = Meta::default();
    let mut rd = Reader::from_reader(bytes);
    rd.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut first = String::new();
    let mut last = String::new();
    let mut cover_ref: Option<String> = None;
    let mut binary_id: Option<String> = None;
    let mut binary = String::new();
    loop {
        match rd.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let n = local(e.name().as_ref());
                if n == "binary" {
                    binary_id = attr(&e, "id");
                    binary.clear();
                }
                stack.push(n);
            }
            Ok(Event::Empty(e)) => {
                let n = local(e.name().as_ref());
                if n == "image" && stack.iter().any(|s| s == "coverpage") && cover_ref.is_none() {
                    cover_ref = attr(&e, "href").map(|h| h.trim_start_matches('#').to_string());
                }
            }
            Ok(Event::Text(t)) => {
                let s = t.decode().map(|c| c.to_string()).unwrap_or_default();
                let in_title_info = stack.iter().any(|x| x == "title-info");
                match stack.last().map(String::as_str) {
                    Some("book-title") if in_title_info && meta.title.is_none() => meta.title = Some(s),
                    Some("first-name") if in_title_info && stack.iter().any(|x| x == "author") && first.is_empty() => first = s,
                    Some("last-name") if in_title_info && stack.iter().any(|x| x == "author") && last.is_empty() => last = s,
                    Some("binary") => binary.push_str(&s),
                    _ => {}
                }
            }
            Ok(Event::End(_)) => {
                if stack.pop().as_deref() == Some("binary") {
                    if binary_id.is_some() && binary_id == cover_ref {
                        meta.cover = b64(&binary);
                        break;
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    let name = format!("{first} {last}").trim().to_string();
    if !name.is_empty() {
        meta.author = Some(name);
    }
    meta
}

fn b64(s: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut map = [255u8; 256];
    for (i, c) in T.iter().enumerate() {
        map[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = map[c as usize];
        if v == 255 {
            continue;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Shrinks a cover to 360 px wide (twice the library's Large cover, for sharp screens) and saves it as JPEG.
pub fn save_cover(bytes: &[u8], out: &Path) -> Option<()> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = if img.width() > 360 { img.resize(360, 1080, image::imageops::FilterType::Lanczos3) } else { img };
    let rgb = img.to_rgb8();
    let mut f = File::create(out).ok()?;
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, 86);
    enc.encode_image(&rgb).ok()
}
