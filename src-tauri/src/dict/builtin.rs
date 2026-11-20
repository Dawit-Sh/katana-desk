//! The built-in dictionaries (Wiktionary, WordNet): SQLite files made once by
//! `tools/build-dictionary.py`, read here read-only. One shape for both (see the tool's notes):
//! `entries` with a zlib'd JSON body, `keys` lowercase headword -> entries, `forms` form -> headword.

use super::morph::{candidates, key_of};
use flate2::read::ZlibDecoder;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

pub const FORMAT: i64 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sense {
    pub gloss: String,
    pub example: Option<String>,
    pub tags: Vec<String>,
    pub synonyms: Vec<String>,
    /// a narrower meaning of the sense before it
    pub sub: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub word: String,
    pub pos: Option<String>,
    pub ipa: Vec<String>,
    pub origin: Option<String>,
    pub senses: Vec<Sense>,
    pub similar: Vec<String>,
    /// the form looked up, when this entry is its headword ("running" for "run")
    pub form: Option<String>,
}

#[derive(Deserialize, Default)]
struct Body {
    p: Option<String>,
    #[serde(default)]
    i: Vec<String>,
    e: Option<String>,
    #[serde(default)]
    s: Vec<BodySense>,
    #[serde(default)]
    y: Vec<String>,
}
#[derive(Deserialize, Default)]
struct BodySense {
    g: String,
    x: Option<String>,
    #[serde(default)]
    t: Vec<String>,
    #[serde(default)]
    y: Vec<String>,
    sub: Option<u8>,
}

pub struct Builtin {
    pub edition: String,
    conn: Mutex<Connection>,
}

impl Builtin {
    pub fn open(path: &Path) -> Result<Builtin, String> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|e| e.to_string())?;
        let meta = |k: &str| -> Option<String> {
            conn.query_row("SELECT value FROM meta WHERE key = ?1", [k], |r| r.get(0)).optional().ok().flatten()
        };
        let format: i64 = meta("format").and_then(|f| f.parse().ok()).unwrap_or(0);
        if format != FORMAT {
            return Err(format!("This dictionary file is format {format}; this version of Katana Desk reads {FORMAT}."));
        }
        meta("id").ok_or("This isn't a Katana Desk dictionary.")?;
        let edition = meta("edition").unwrap_or_default();
        Ok(Builtin { edition, conn: Mutex::new(conn) })
    }

    fn entries_for(&self, conn: &Connection, key: &str, form: Option<&str>) -> Vec<Entry> {
        let mut st = match conn.prepare_cached("SELECT e.word, e.pos, e.body FROM keys k JOIN entries e ON e.id = k.entry WHERE k.key = ?1 ORDER BY k.entry LIMIT 12") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = st.query_map([key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Vec<u8>>(2)?)));
        let mut out = vec![];
        for (word, pos, body) in rows.into_iter().flatten().flatten() {
            let mut json = String::new();
            if ZlibDecoder::new(&body[..]).read_to_string(&mut json).is_err() {
                continue;
            }
            let b: Body = serde_json::from_str(&json).unwrap_or_default();
            out.push(Entry {
                word,
                pos: b.p.or(pos),
                ipa: b.i,
                origin: b.e,
                senses: b
                    .s
                    .into_iter()
                    .map(|s| Sense { gloss: s.g, example: s.x, tags: s.t, synonyms: s.y, sub: s.sub.unwrap_or(0) == 1 })
                    .collect(),
                similar: b.y,
                form: form.map(String::from),
            });
        }
        out
    }

    /// The headwords a form belongs to, the likeliest kind only (inflections before spellings and
    /// abbreviations), at most three.
    fn lemmas_for(&self, conn: &Connection, key: &str) -> Vec<String> {
        // the likeliest first: an inflection before a spelling, then the word with the most to say
        // ("ran" is the past of "run" far more often than of the dialect "rin")
        let mut st = match conn.prepare_cached(
            "SELECT f.lemma, f.rank FROM forms f WHERE f.form = ?1 ORDER BY f.rank,
               (SELECT COALESCE(SUM(length(e.body)), 0) FROM keys k JOIN entries e ON e.id = k.entry WHERE k.key = f.lemma) DESC, f.lemma",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows: Vec<(String, i64)> = st.query_map([key], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.flatten().collect()).unwrap_or_default();
        let best = rows.first().map(|r| r.1).unwrap_or(0);
        rows.into_iter().filter(|r| r.1 == best).map(|r| r.0).take(3).collect()
    }

    /// How much a dictionary says about a headword (its entries' packed size): common words say a lot.
    fn weight(&self, conn: &Connection, key: &str) -> i64 {
        conn.query_row("SELECT COALESCE(SUM(length(e.body)), 0) FROM keys k JOIN entries e ON e.id = k.entry WHERE k.key = ?1", [key], |r| r.get(0))
            .unwrap_or(0)
    }

    /// Looks a word up: the word itself, then the headword its form belongs to (geese -> goose), then
    /// headwords from English endings (clutching -> clutch). Returns the headword shown and the entries.
    pub fn lookup(&self, word: &str) -> Option<(String, Vec<Entry>)> {
        let key = key_of(word);
        if key.is_empty() {
            return None;
        }
        let conn = self.conn.lock().unwrap();
        let mut entries = self.entries_for(&conn, &key, None);
        // the word as written first ("me" before the symbol "ME"), then lowercase words, then names
        let written = word.trim().trim_matches(|c: char| !c.is_alphanumeric());
        entries.sort_by_key(|e| if e.word == written { 0 } else if e.word == e.word.to_lowercase() { 1 } else { 2 });
        // a form that has its own entry and is also an inflection ("saw", "lay"): both, the headword after
        let lemmas = self.lemmas_for(&conn, &key);
        if !entries.is_empty() {
            if let Some(l) = lemmas.first().filter(|l| !entries.iter().any(|e| key_of(&e.word) == **l)) {
                let more: Vec<Entry> = self.entries_for(&conn, l, Some(&key)).into_iter().take(3).collect();
                // only names and abbreviations under this spelling ("RAN", "Ran"), or a thin entry
                // beside a full one ("ran", a sailor's word, beside "run"): the word in the sentence
                // is the inflection, so its headword comes first
                let thin = self.weight(&conn, l) > 3 * self.weight(&conn, &key);
                if !more.is_empty() && (thin || entries.iter().all(|e| e.word != e.word.to_lowercase())) {
                    let l = l.clone();
                    entries.splice(0..0, more);
                    return Some((l, entries));
                }
                entries.extend(more);
            }
            return Some((key, entries));
        }
        for l in &lemmas {
            entries.extend(self.entries_for(&conn, l, Some(&key)));
        }
        if !entries.is_empty() {
            return Some((lemmas[0].clone(), entries));
        }
        for c in candidates(&key) {
            let mut found = self.entries_for(&conn, &c, Some(&key));
            if found.is_empty() {
                // the stem may itself be a form ("lying" -> "lie" is listed, "studied" -> "study")
                if let Some(l) = self.lemmas_for(&conn, &c).first() {
                    found = self.entries_for(&conn, l, Some(&key));
                    if !found.is_empty() {
                        return Some((l.clone(), found));
                    }
                }
                continue;
            }
            return Some((c, found));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::path::PathBuf;
    use std::io::Write;

    fn pack(v: serde_json::Value) -> Vec<u8> {
        let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
        z.write_all(v.to_string().as_bytes()).unwrap();
        z.finish().unwrap()
    }

    /// A tiny dictionary in the tool's shape.
    fn sample(dir: &Path) -> PathBuf {
        let p = dir.join("sample.sqlite");
        let _ = std::fs::remove_file(&p);
        let c = Connection::open(&p).unwrap();
        c.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE entries (id INTEGER PRIMARY KEY, word TEXT NOT NULL, pos TEXT, body BLOB NOT NULL);
             CREATE TABLE keys (key TEXT NOT NULL, entry INTEGER NOT NULL, PRIMARY KEY (key, entry)) WITHOUT ROWID;
             CREATE TABLE forms (form TEXT NOT NULL, lemma TEXT NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (form, lemma)) WITHOUT ROWID;
             INSERT INTO meta VALUES ('format', '1'), ('id', 'sample'), ('name', 'Sample');",
        )
        .unwrap();
        let add = |id: i64, w: &str, pos: &str, g: &str| {
            c.execute("INSERT INTO entries VALUES (?1, ?2, ?3, ?4)", rusqlite::params![id, w, pos, pack(serde_json::json!({"p": pos, "s": [{"g": g}], "i": ["/x/"]}))]).unwrap();
            c.execute("INSERT INTO keys VALUES (?1, ?2)", rusqlite::params![w.to_lowercase(), id]).unwrap();
        };
        add(1, "goose", "noun", "A bird.");
        add(2, "run", "verb", "To move fast.");
        add(3, "saw", "noun", "A tool for cutting.");
        add(4, "see", "verb", "To perceive with the eyes.");
        add(5, "clutch", "verb", "To grip.");
        add(6, "RAN", "noun", "Radio access network.");
        add(7, "ME", "symbol", "Earth mass.");
        add(8, "me", "pron", "The speaker, as an object.");
        c.execute_batch(
            "INSERT INTO forms VALUES ('geese', 'goose', 0), ('ran', 'run', 0), ('ran', 'radio access network', 2), ('saw', 'see', 0);",
        )
        .unwrap();
        p
    }

    #[test]
    fn finds_words_their_forms_and_endings() {
        let dir = std::env::temp_dir().join(format!("katana-dict-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let d = Builtin::open(&sample(&dir)).unwrap();
        let (h, e) = d.lookup("Geese,").unwrap();
        assert_eq!(h, "goose");
        assert_eq!(e[0].senses[0].gloss, "A bird.");
        assert_eq!(e[0].form.as_deref(), Some("geese"));
        // "ran" has its own (abbreviation) entry, and is the past of "run": both, the verb first
        let (h, e) = d.lookup("ran").unwrap();
        assert_eq!(h, "run");
        assert_eq!(e[0].word, "run");
        assert_eq!(e[1].word, "RAN");
        let (h, e) = d.lookup("clutching").unwrap();
        assert_eq!(h, "clutch");
        assert_eq!(e.len(), 1);
        let (_, e) = d.lookup("saw").unwrap();
        assert_eq!(e[0].word, "saw");
        assert_eq!(e[1].word, "see");
        assert!(d.lookup("xyzzy").is_none());
        // the word as written comes before a symbol spelled the same
        let (_, e) = d.lookup("me").unwrap();
        assert_eq!(e[0].word, "me");
        drop(d);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
