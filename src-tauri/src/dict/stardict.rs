//! StarDict dictionaries he adds himself (`.ifo` + `.idx` (or `.idx.gz`) + `.dict` or `.dict.dz`,
//! optionally `.syn`), read straight from where they are. The index is read once, the first time the
//! dictionary is asked; a `.dict.dz` made by dictzip is read chunk by chunk, any other gzip is
//! unpacked into memory once. Entries come back as plain text: HTML, Pango and XDXF markup are
//! reduced to text with their line breaks, never put into the page as markup.

use flate2::read::GzDecoder;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Default)]
pub struct Ifo {
    pub name: String,
    pub words: u64,
    pub offset_bits: u32,
    pub same_type: Option<String>,
}

pub fn read_ifo(path: &Path) -> Result<Ifo, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("The .ifo file couldn't be read: {e}"))?;
    let mut lines = text.lines();
    if !lines.next().unwrap_or("").contains("StarDict's dict ifo file") {
        return Err("This isn't a StarDict .ifo file.".into());
    }
    let mut ifo = Ifo { offset_bits: 32, ..Default::default() };
    for l in lines {
        if let Some((k, v)) = l.split_once('=') {
            match k.trim() {
                "bookname" => ifo.name = v.trim().to_string(),
                "wordcount" => ifo.words = v.trim().parse().unwrap_or(0),
                "idxoffsetbits" => ifo.offset_bits = v.trim().parse().unwrap_or(32),
                "sametypesequence" => ifo.same_type = Some(v.trim().to_string()).filter(|s| !s.is_empty()),
                _ => {}
            }
        }
    }
    if ifo.name.is_empty() {
        ifo.name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    }
    Ok(ifo)
}

/// The files beside the `.ifo`: (index, data).
pub fn files_of(ifo: &Path) -> Result<(PathBuf, PathBuf), String> {
    let stem = ifo.with_extension("");
    let with = |ext: &str| PathBuf::from(format!("{}.{ext}", stem.to_string_lossy()));
    let idx = [with("idx"), with("idx.gz")].into_iter().find(|p| p.exists()).ok_or("The .idx file beside the .ifo is missing.")?;
    let dict = [with("dict.dz"), with("dict")].into_iter().find(|p| p.exists()).ok_or("The .dict or .dict.dz file beside the .ifo is missing.")?;
    Ok((idx, dict))
}

enum Data {
    Plain(PathBuf),
    /// dictzip: chunk length, where each compressed chunk starts, and the file
    Chunks { path: PathBuf, chlen: u64, starts: Vec<u64> },
    Memory(Vec<u8>),
}

pub struct StarDict {
    pub name: String,
    ifo: Ifo,
    /// (word, offset, size), in the index's order
    index: Vec<(String, u64, u32)>,
    /// lowercase word -> positions in `index` (synonyms from `.syn` too)
    by_key: HashMap<String, Vec<u32>>,
    data: Mutex<(Data, Option<File>)>,
}

fn read_all(p: &Path) -> Result<Vec<u8>, String> {
    let mut f = File::open(p).map_err(|e| e.to_string())?;
    let mut buf = vec![];
    if p.extension().map_or(false, |e| e == "gz") {
        GzDecoder::new(f).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    } else {
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// Reads a dictzip header: the chunk length and where each chunk starts. None for a plain gzip.
fn dictzip(path: &Path) -> Option<(u64, Vec<u64>)> {
    let mut f = File::open(path).ok()?;
    let mut h = [0u8; 10];
    f.read_exact(&mut h).ok()?;
    if h[0] != 0x1f || h[1] != 0x8b || h[3] & 4 == 0 {
        return None;
    }
    let flags = h[3];
    let mut xl = [0u8; 2];
    f.read_exact(&mut xl).ok()?;
    let xlen = u16::from_le_bytes(xl) as usize;
    let mut extra = vec![0u8; xlen];
    f.read_exact(&mut extra).ok()?;
    let mut pos = 10 + 2 + xlen as u64;
    let (mut chlen, mut sizes) = (0u64, vec![]);
    let mut i = 0;
    while i + 4 <= extra.len() {
        let (si1, si2) = (extra[i], extra[i + 1]);
        let len = u16::from_le_bytes([extra[i + 2], extra[i + 3]]) as usize;
        let body = extra.get(i + 4..i + 4 + len)?;
        if si1 == b'R' && si2 == b'A' && body.len() >= 6 {
            chlen = u16::from_le_bytes([body[2], body[3]]) as u64;
            let count = u16::from_le_bytes([body[4], body[5]]) as usize;
            for c in 0..count {
                let o = 6 + c * 2;
                sizes.push(u16::from_le_bytes([*body.get(o)?, *body.get(o + 1)?]) as u64);
            }
        }
        i += 4 + len;
    }
    if chlen == 0 || sizes.is_empty() {
        return None;
    }
    // file name and comment, zero-terminated, then the header's CRC
    let skip_z = |f: &mut File, pos: &mut u64| -> Option<()> {
        let mut b = [0u8; 1];
        loop {
            f.read_exact(&mut b).ok()?;
            *pos += 1;
            if b[0] == 0 {
                return Some(());
            }
        }
    };
    if flags & 8 != 0 {
        skip_z(&mut f, &mut pos)?;
    }
    if flags & 16 != 0 {
        skip_z(&mut f, &mut pos)?;
    }
    if flags & 2 != 0 {
        pos += 2;
    }
    let mut starts = Vec::with_capacity(sizes.len() + 1);
    let mut at = pos;
    for s in sizes {
        starts.push(at);
        at += s;
    }
    starts.push(at);
    Some((chlen, starts))
}

fn parse_index(buf: &[u8], bits: u32) -> Vec<(String, u64, u32)> {
    let mut out = vec![];
    let mut i = 0;
    let off = if bits == 64 { 8 } else { 4 };
    while i < buf.len() {
        let Some(z) = buf[i..].iter().position(|&b| b == 0) else { break };
        let word = String::from_utf8_lossy(&buf[i..i + z]).to_string();
        i += z + 1;
        if i + off + 4 > buf.len() {
            break;
        }
        let offset = if off == 8 {
            u64::from_be_bytes(buf[i..i + 8].try_into().unwrap())
        } else {
            u32::from_be_bytes(buf[i..i + 4].try_into().unwrap()) as u64
        };
        i += off;
        let size = u32::from_be_bytes(buf[i..i + 4].try_into().unwrap());
        i += 4;
        out.push((word, offset, size));
    }
    out
}

impl StarDict {
    pub fn open(ifo_path: &Path) -> Result<StarDict, String> {
        let ifo = read_ifo(ifo_path)?;
        let (idx, dict) = files_of(ifo_path)?;
        let index = parse_index(&read_all(&idx)?, ifo.offset_bits);
        if index.is_empty() {
            return Err("The dictionary's index is empty.".into());
        }
        let mut by_key: HashMap<String, Vec<u32>> = HashMap::with_capacity(index.len());
        for (i, (w, _, _)) in index.iter().enumerate() {
            by_key.entry(super::morph::key_of(w)).or_default().push(i as u32);
        }
        // synonyms: word, then its entry's place in the index
        let syn = ifo_path.with_extension("syn");
        if let Ok(buf) = std::fs::read(&syn) {
            let mut i = 0;
            while i < buf.len() {
                let Some(z) = buf[i..].iter().position(|&b| b == 0) else { break };
                let w = String::from_utf8_lossy(&buf[i..i + z]).to_string();
                i += z + 1;
                if i + 4 > buf.len() {
                    break;
                }
                let n = u32::from_be_bytes(buf[i..i + 4].try_into().unwrap());
                i += 4;
                if (n as usize) < index.len() {
                    let v = by_key.entry(super::morph::key_of(&w)).or_default();
                    if !v.contains(&n) {
                        v.push(n);
                    }
                }
            }
        }
        let data = if dict.extension().map_or(false, |e| e == "dz") {
            match dictzip(&dict) {
                Some((chlen, starts)) => Data::Chunks { path: dict.clone(), chlen, starts },
                None => {
                    let mut buf = vec![];
                    GzDecoder::new(File::open(&dict).map_err(|e| e.to_string())?)
                        .read_to_end(&mut buf)
                        .map_err(|e| format!("The .dict.dz file couldn't be unpacked: {e}"))?;
                    Data::Memory(buf)
                }
            }
        } else {
            Data::Plain(dict.clone())
        };
        Ok(StarDict { name: ifo.name.clone(), ifo, index, by_key, data: Mutex::new((data, None)) })
    }

    pub fn words(&self) -> usize {
        self.index.len()
    }

    fn bytes(&self, offset: u64, size: u32) -> Option<Vec<u8>> {
        let mut g = self.data.lock().unwrap();
        let (data, file) = &mut *g;
        match data {
            Data::Memory(buf) => buf.get(offset as usize..offset as usize + size as usize).map(|b| b.to_vec()),
            Data::Plain(path) => {
                if file.is_none() {
                    *file = File::open(&path).ok();
                }
                let f = file.as_mut()?;
                f.seek(SeekFrom::Start(offset)).ok()?;
                let mut b = vec![0u8; size as usize];
                f.read_exact(&mut b).ok()?;
                Some(b)
            }
            Data::Chunks { path, chlen, starts } => {
                if file.is_none() {
                    *file = File::open(&path).ok();
                }
                let f = file.as_mut()?;
                let first = (offset / *chlen) as usize;
                let last = ((offset + size as u64).saturating_sub(1) / *chlen) as usize;
                let mut out = Vec::with_capacity(((last - first + 1) as u64 * *chlen) as usize);
                for c in first..=last {
                    let (a, b) = (*starts.get(c)?, *starts.get(c + 1)?);
                    f.seek(SeekFrom::Start(a)).ok()?;
                    let mut comp = vec![0u8; (b - a) as usize];
                    f.read_exact(&mut comp).ok()?;
                    let mut d = flate2::Decompress::new(false);
                    let mut plain = vec![0u8; *chlen as usize];
                    d.decompress(&comp, &mut plain, flate2::FlushDecompress::Sync).ok()?;
                    plain.truncate(d.total_out() as usize);
                    out.extend_from_slice(&plain);
                }
                let skip = (offset - first as u64 * *chlen) as usize;
                out.get(skip..skip + size as usize).map(|b| b.to_vec())
            }
        }
    }

    /// The entries for a key: (headword, phonetic, text), at most six.
    pub fn find(&self, key: &str) -> Vec<(String, Option<String>, String)> {
        let Some(ids) = self.by_key.get(key) else { return vec![] };
        let mut out = vec![];
        for &i in ids.iter().take(6) {
            let (w, off, size) = &self.index[i as usize];
            if let Some(b) = self.bytes(*off, *size) {
                let (ph, text) = fields(&b, self.ifo.same_type.as_deref());
                if !text.trim().is_empty() || ph.is_some() {
                    out.push((w.clone(), ph, text));
                }
            }
        }
        out
    }

    /// Looks a word up as the built-in dictionaries do: the word, then English endings.
    pub fn lookup(&self, word: &str) -> Option<(String, Vec<(String, Option<String>, String)>)> {
        let key = super::morph::key_of(word);
        if key.is_empty() {
            return None;
        }
        let found = self.find(&key);
        if !found.is_empty() {
            return Some((key, found));
        }
        for c in super::morph::candidates(&key) {
            let found = self.find(&c);
            if !found.is_empty() {
                return Some((c, found));
            }
        }
        None
    }
}

/// An entry's fields as (phonetic, text). With `sametypesequence` the types are given and the last
/// field runs to the end; without it each field starts with its type.
fn fields(b: &[u8], same: Option<&str>) -> (Option<String>, String) {
    let mut ph = None;
    let mut texts: Vec<String> = vec![];
    let mut take = |t: char, data: &[u8]| {
        let s = String::from_utf8_lossy(data).to_string();
        match t {
            't' => ph = Some(s.trim().to_string()).filter(|x| !x.is_empty()),
            'm' | 'l' | 'y' | 'k' => texts.push(s),
            'g' | 'x' | 'h' | 'w' | 'n' => texts.push(markup_to_text(&s)),
            _ => {}
        }
    };
    let mut i = 0;
    match same {
        Some(seq) => {
            let types: Vec<char> = seq.chars().collect();
            for (n, &t) in types.iter().enumerate() {
                let last = n == types.len() - 1;
                if t.is_ascii_uppercase() {
                    // binary with a size first, except the last
                    let len = if last { b.len() - i } else {
                        if i + 4 > b.len() { break }
                        let l = u32::from_be_bytes(b[i..i + 4].try_into().unwrap()) as usize;
                        i += 4;
                        l
                    };
                    i = (i + len).min(b.len());
                } else {
                    let end = if last { b.len() } else { b[i..].iter().position(|&c| c == 0).map_or(b.len(), |z| i + z) };
                    take(t, &b[i..end]);
                    i = (end + 1).min(b.len());
                }
            }
        }
        None => {
            while i < b.len() {
                let t = b[i] as char;
                i += 1;
                if t.is_ascii_uppercase() {
                    if i + 4 > b.len() { break }
                    let l = u32::from_be_bytes(b[i..i + 4].try_into().unwrap()) as usize;
                    i = (i + 4 + l).min(b.len());
                } else {
                    let end = b[i..].iter().position(|&c| c == 0).map_or(b.len(), |z| i + z);
                    take(t, &b[i..end]);
                    i = end + 1;
                }
            }
        }
    }
    (ph, texts.join("\n").trim().to_string())
}

/// Markup to plain text: breaks and block ends become new lines, tags go, entities are decoded.
pub fn markup_to_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let b = s.as_bytes();
    while i < b.len() {
        if b[i] == b'<' {
            if let Some(j) = s[i..].find('>') {
                let tag = s[i + 1..i + j].trim_start_matches('/').to_ascii_lowercase();
                let name: String = tag.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
                let lower = s[i..i + j].to_ascii_lowercase();
                // what's inside a script or style is never text
                if (name == "script" || name == "style") && !lower.starts_with("</") {
                    if let Some(k) = s[i..].to_ascii_lowercase().find(&format!("</{name}")) {
                        i += k;
                        continue;
                    }
                }
                if matches!(name.as_str(), "br" | "p" | "div" | "li" | "tr" | "dd" | "dt" | "h1" | "h2" | "h3" | "h4" | "blockquote" | "def" | "ex") {
                    out.push('\n');
                }
                i += j + 1;
                continue;
            }
        }
        if b[i] == b'&' {
            if let Some(j) = s[i..].find(';').filter(|&j| j <= 10) {
                let ent = &s[i + 1..i + j];
                let ch = match ent {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
                    _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                    _ => None,
                };
                if let Some(c) = ch {
                    out.push(c);
                    i += j + 1;
                    continue;
                }
            }
        }
        let c = s[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    // no runs of blank lines
    let mut text = String::new();
    let mut blank = 0;
    for l in out.lines() {
        let l = l.trim_end();
        if l.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        text.push_str(l);
        text.push('\n');
    }
    text.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    #[test]
    fn markup_becomes_text() {
        assert_eq!(markup_to_text("<b>iron</b>mongery<br>noun &amp; <i>hardware</i><script>x()</script>"), "ironmongery\nnoun & hardware");
        assert_eq!(markup_to_text("a&#233;&#x41;"), "aéA");
    }

    /// A dictzip file with tiny chunks, so an entry spans several of them.
    fn dictzip_bytes(data: &[u8], chlen: usize) -> Vec<u8> {
        let mut chunks = vec![];
        for c in data.chunks(chlen) {
            let mut z = flate2::Compress::new(Compression::default(), false);
            let mut out = vec![0u8; c.len() * 2 + 64];
            z.compress(c, &mut out, flate2::FlushCompress::Full).unwrap();
            out.truncate(z.total_out() as usize);
            chunks.push(out);
        }
        let mut ra = vec![b'R', b'A'];
        let body_len = 6 + chunks.len() * 2;
        ra.extend_from_slice(&(body_len as u16).to_le_bytes());
        ra.extend_from_slice(&1u16.to_le_bytes());
        ra.extend_from_slice(&(chlen as u16).to_le_bytes());
        ra.extend_from_slice(&(chunks.len() as u16).to_le_bytes());
        for c in &chunks {
            ra.extend_from_slice(&(c.len() as u16).to_le_bytes());
        }
        let mut f = vec![0x1f, 0x8b, 8, 4 | 8, 0, 0, 0, 0, 2, 3];
        f.extend_from_slice(&(ra.len() as u16).to_le_bytes());
        f.extend_from_slice(&ra);
        f.extend_from_slice(b"test.dict\0");
        for c in chunks {
            f.extend_from_slice(&c);
        }
        f
    }

    fn write_dict(dir: &Path, gz: u8) -> PathBuf {
        let entries = [("Ironmongery", "m", "Hardware sold by an ironmonger."), ("goose", "h", "<b>goose</b><br>a bird")];
        let mut idx = vec![];
        let mut dict = vec![];
        for (w, _, text) in entries {
            idx.extend_from_slice(w.as_bytes());
            idx.push(0);
            idx.extend_from_slice(&(dict.len() as u32).to_be_bytes());
            idx.extend_from_slice(&(text.len() as u32).to_be_bytes());
            dict.extend_from_slice(text.as_bytes());
        }
        let ifo = dir.join("test.ifo");
        std::fs::write(&ifo, "StarDict's dict ifo file\nversion=2.4.2\nwordcount=2\nbookname=Test dictionary\nsametypesequence=h\n").unwrap();
        std::fs::write(dir.join("test.idx"), &idx).unwrap();
        if gz == 1 {
            let mut z = GzEncoder::new(Vec::new(), Compression::default());
            z.write_all(&dict).unwrap();
            std::fs::write(dir.join("test.dict.dz"), z.finish().unwrap()).unwrap();
        } else if gz == 2 {
            std::fs::write(dir.join("test.dict.dz"), dictzip_bytes(&dict, 7)).unwrap();
        } else {
            std::fs::write(dir.join("test.dict"), &dict).unwrap();
        }
        ifo
    }

    #[test]
    fn reads_plain_and_gzipped_dictionaries() {
        // plain, gzip, dictzip
        for gz in [0u8, 1, 2] {
            let dir = std::env::temp_dir().join(format!("katana-stardict-{}-{gz}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let d = StarDict::open(&write_dict(&dir, gz)).unwrap();
            assert_eq!(d.name, "Test dictionary");
            let (h, e) = d.lookup("ironmongery").unwrap();
            assert_eq!(h, "ironmongery");
            assert_eq!(e[0].2, "Hardware sold by an ironmonger.");
            let (h, e) = d.lookup("gooses").unwrap();
            assert_eq!(h, "goose");
            assert_eq!(e[0].2, "goose\na bird");
            drop(d);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
