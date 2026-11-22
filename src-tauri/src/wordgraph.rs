//! My words as a graph (the Graph view of My words): each book with the words saved from it around it,
//! and words of the same meaning joined. The same model as Katana on Android (`WordGraph.kt`), so a
//! library looks the same on both:
//!
//! - **Synonyms** are two saved words that share a WordNet sense group (a synset), their base forms
//!   included ("grasping" also counts as grasp, "ran" as run), or the same word saved twice. The groups come
//!   from `resources/katana-synonyms-en.sqlite`, built from Katana's English pack by
//!   `tools/build-dictionary.py synonyms`, so it works before (and without) the downloaded dictionaries.
//! - **The layout** is a small force simulation that settles (words pushed apart, pulled to their book,
//!   synonyms pulled together), started from steady positions, in f32 as on Android: the same words always
//!   land in the same places. It runs off the main thread (a blocking task), a few ms for a few hundred words.

use crate::words::{Word, LEARNED_LEVEL};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::f32::consts::PI;
use std::path::Path;

// ---------- how far a word is learned ----------

/// Android's rule: never reviewed, new; at the week's step or past it (I know it three times in a row),
/// learned; reviewed but not there yet (or sent back with Again), learning.
pub fn state_of(w: &Word) -> &'static str {
    if w.reviewed_at.is_none() && w.review_level <= 0 {
        "new"
    } else if w.review_level >= LEARNED_LEVEL {
        "learned"
    } else {
        "learning"
    }
}

// ---------- WordNet's sense groups ----------

/// The synonym index: WordNet's sense groups and irregular forms, opened read-only.
pub struct Senses {
    conn: Connection,
}

const PARTS: [&str; 4] = ["n", "v", "a", "r"];

/// WordNet's detachment rules ("morphy") per part of speech, as Katana's `WordForms` has them.
fn rules(part: &str) -> &'static [(&'static str, &'static str)] {
    match part {
        "n" => &[("s", ""), ("ses", "s"), ("xes", "x"), ("zes", "z"), ("ches", "ch"), ("shes", "sh"), ("men", "man"), ("ies", "y")],
        "v" => &[("s", ""), ("ies", "y"), ("es", "e"), ("es", ""), ("ed", "e"), ("ed", ""), ("ing", "e"), ("ing", "")],
        "a" => &[("er", ""), ("est", ""), ("er", "e"), ("est", "e")],
        _ => &[],
    }
}

/// The word as the index keys it, as Katana's `WordForms.normalize` does: straight apostrophes, no
/// punctuation round it, no possessive, single spaces, lowercase.
pub fn normalize(text: &str) -> String {
    const EDGE: &str = ".,;:!?\"'()[]{}\u{201c}\u{201d}-\u{2014}\u{2013}*_";
    let t = text.replace(['\u{2019}', '\u{2018}'], "'").replace('_', " ");
    let t = t.trim().trim_matches(|c: char| EDGE.contains(c));
    let t = t.strip_suffix("'s").unwrap_or(t);
    t.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// The base forms `form` may come from as `part`, in morphy's order: the irregular forms first, then each
/// rule's result; never `form` itself.
pub fn bases(form: &str, part: &str, irregular: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let ruled = rules(part).iter().filter_map(|(suffix, ending)| {
        (form.len() > suffix.len()).then(|| form.strip_suffix(suffix)).flatten().map(|stem| format!("{stem}{ending}"))
    });
    for b in irregular.iter().cloned().chain(ruled) {
        if !b.is_empty() && b != form && !out.contains(&b) {
            out.push(b);
        }
    }
    out
}

impl Senses {
    pub fn open(path: &Path) -> rusqlite::Result<Senses> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        Ok(Senses { conn })
    }

    fn groups_of_exact(&self, word: &str) -> rusqlite::Result<Vec<i64>> {
        let mut st = self.conn.prepare_cached("SELECT synset FROM senses WHERE word = ?1")?;
        let rows = st.query_map([word], |r| r.get(0))?;
        rows.collect()
    }

    fn irregular(&self, form: &str, part: &str) -> rusqlite::Result<Vec<String>> {
        let mut st = self.conn.prepare_cached("SELECT lemma FROM exceptions WHERE form = ?1 AND pos = ?2")?;
        let rows = st.query_map([form, part], |r| r.get(0))?;
        rows.collect()
    }

    /// The sense groups of `text`: the word's own, and those of the base forms it may be an inflection of.
    /// Empty when WordNet doesn't know it.
    pub fn groups(&self, text: &str) -> rusqlite::Result<BTreeSet<i64>> {
        let form = normalize(text);
        let mut out = BTreeSet::new();
        if form.is_empty() {
            return Ok(out);
        }
        out.extend(self.groups_of_exact(&form)?);
        for part in PARTS {
            let irregular = self.irregular(&form, part)?;
            for base in bases(&form, part, &irregular) {
                out.extend(self.groups_of_exact(&base)?);
            }
        }
        Ok(out)
    }

    /// Every saved word's groups, by word id: the word as saved and its headword (the dictionary's base form).
    pub fn of_words(&self, words: &[Word]) -> HashMap<i64, BTreeSet<i64>> {
        let mut cache: HashMap<String, BTreeSet<i64>> = HashMap::new();
        let mut out = HashMap::new();
        for w in words {
            let mut all = BTreeSet::new();
            for text in [&w.word, &w.headword] {
                let key = normalize(text);
                if !cache.contains_key(&key) {
                    let g = self.groups(&key).unwrap_or_default();
                    cache.insert(key.clone(), g);
                }
                all.extend(cache[&key].iter().copied());
            }
            if !all.is_empty() {
                out.insert(w.id, all);
            }
        }
        out
    }
}

/// The saved words that mean the same: two words sharing a sense group, or the same word saved twice
/// (any case). Each pair once, the smaller id first, in a steady order.
pub fn synonym_links(words: &[Word], groups: &HashMap<i64, BTreeSet<i64>>) -> Vec<(i64, i64)> {
    let mut by_group: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
    let mut by_text: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for w in words {
        if let Some(gs) = groups.get(&w.id) {
            for g in gs {
                by_group.entry(*g).or_default().push(w.id);
            }
        }
        by_text.entry(w.word.trim().to_lowercase()).or_default().push(w.id);
    }
    let mut links: BTreeSet<(i64, i64)> = BTreeSet::new();
    for same in by_text.values().chain(by_group.values()) {
        for i in 0..same.len() {
            for j in i + 1..same.len() {
                let (a, b) = (same[i].min(same[j]), same[i].max(same[j]));
                if a != b {
                    links.insert((a, b));
                }
            }
        }
    }
    links.into_iter().collect()
}

// ---------- the model the page draws ----------

/// The key a word's book goes by on the graph: its book in the library, or its title when it has none.
pub fn book_key(w: &Word) -> String {
    match w.book_id {
        Some(id) => format!("b:{id}"),
        None => format!("t:{}", w.book_title.clone().unwrap_or_default()),
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BookNode {
    pub key: String,
    pub book_id: Option<i64>,
    pub title: String,
    pub author: Option<String>,
    pub x: f32,
    pub y: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WordNode {
    #[serde(flatten)]
    pub word: Word,
    pub book_key: String,
    pub state: &'static str,
    /// another book's word that means the same as one of the book's (one-book graph only), drawn faint
    pub ghost: bool,
    pub reviews: i64,
    pub looked_back: i64,
    pub x: f32,
    pub y: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    /// the one book shown, or none for every book
    pub book: Option<String>,
    pub books: Vec<BookNode>,
    /// the words shown, newest first, then the ghosts
    pub words: Vec<WordNode>,
    pub links: Vec<[i64; 2]>,
    /// whether the synonym index could be read (no links but the same word otherwise)
    pub synonyms: bool,
}

/// The words in the order they were saved, the oldest first (Play the links brings them in this way).
pub fn play_order(words: &[Word]) -> Vec<Word> {
    let mut v = words.to_vec();
    v.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    v
}

/// Builds the graph of `all` saved words: every book's for no `book`, else that book's words with the
/// other books' words that mean the same as ghosts. `counts` are each word's (reviews, looks back) by uuid.
pub fn build(all: &[Word], groups: &HashMap<i64, BTreeSet<i64>>, book: Option<&str>, counts: &HashMap<String, (i64, i64)>, synonyms: bool) -> Graph {
    let mut newest_first = all.to_vec();
    newest_first.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    let all_links = synonym_links(&newest_first, groups);
    let node = |w: &Word, ghost: bool, p: (f32, f32)| {
        let (reviews, looked_back) = counts.get(&w.uuid).copied().unwrap_or((0, 0));
        WordNode { word: w.clone(), book_key: book_key(w), state: state_of(w), ghost, reviews, looked_back, x: p.0, y: p.1 }
    };
    let book_node = |w: &Word, p: (f32, f32)| BookNode {
        key: book_key(w),
        book_id: w.book_id,
        title: w.book_title.clone().unwrap_or_else(|| "A book".into()),
        author: w.book_author.clone(),
        x: p.0,
        y: p.1,
    };
    match book {
        None => {
            // books in the order their first word was saved
            let order = play_order(&newest_first);
            let mut books: Vec<(String, &Word)> = vec![];
            for w in &order {
                let k = book_key(w);
                if !books.iter().any(|(bk, _)| *bk == k) {
                    books.push((k, w));
                }
            }
            let keys: Vec<String> = books.iter().map(|(k, _)| k.clone()).collect();
            let place = layout::every_book(&keys, &order.iter().map(|w| (w.id, book_key(w))).collect::<Vec<_>>(), &all_links);
            Graph {
                book: None,
                books: books.iter().map(|(k, w)| book_node(w, place.books[k])).collect(),
                words: newest_first.iter().map(|w| node(w, false, place.words[&w.id])).collect(),
                links: all_links.iter().map(|(a, b)| [*a, *b]).collect(),
                synonyms,
            }
        }
        Some(key) => {
            let shown: Vec<&Word> = newest_first.iter().filter(|w| book_key(w) == key).collect();
            let shown_ids: HashSet<i64> = shown.iter().map(|w| w.id).collect();
            let links: Vec<(i64, i64)> = all_links.iter().copied().filter(|(a, b)| shown_ids.contains(a) || shown_ids.contains(b)).collect();
            let ghost_ids: HashSet<i64> = links.iter().flat_map(|(a, b)| [*a, *b]).filter(|id| !shown_ids.contains(id)).collect();
            let ghosts: Vec<&Word> = newest_first.iter().filter(|w| ghost_ids.contains(&w.id)).collect();
            let order = play_order(&shown.iter().map(|w| (*w).clone()).collect::<Vec<_>>());
            let place = layout::one_book(key, &order.iter().map(|w| w.id).collect::<Vec<_>>(), &ghosts.iter().map(|w| w.id).collect::<Vec<_>>(), &links);
            let books = shown.first().map(|w| vec![book_node(w, place.books[key])]).unwrap_or_default();
            Graph {
                book: Some(key.to_string()),
                books,
                words: shown
                    .iter()
                    .map(|w| node(w, false, place.words[&w.id]))
                    .chain(ghosts.iter().map(|w| node(w, true, place.words[&w.id])))
                    .collect(),
                links: links.iter().map(|(a, b)| [*a, *b]).collect(),
                synonyms,
            }
        }
    }
}

/// Each word's reviews and looks back (a jump to its sentence from My words or the marks panel), by uuid.
pub fn counts(conn: &Connection) -> rusqlite::Result<HashMap<String, (i64, i64)>> {
    let mut out: HashMap<String, (i64, i64)> = HashMap::new();
    let mut st = conn.prepare(
        "SELECT ref, SUM(kind = 'review'), SUM(kind = 'revisit' AND detail = 'word') FROM learning
          WHERE ref IS NOT NULL AND (kind = 'review' OR (kind = 'revisit' AND detail = 'word')) GROUP BY ref",
    )?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?;
    for r in rows.flatten() {
        out.insert(r.0, (r.1, r.2));
    }
    Ok(out)
}

/// The synonym index next to the app (its resources), or none when it can't be read.
pub fn open_senses(path: Option<&Path>) -> Option<Senses> {
    let p = path?;
    if !p.exists() {
        return None;
    }
    Senses::open(p).ok().filter(|s| s.conn.query_row("SELECT 1 FROM senses LIMIT 1", [], |r| r.get::<_, i64>(0)).optional().ok().flatten().is_some())
}

// ---------- the layout ----------

pub mod layout {
    use super::PI;
    use std::collections::{HashMap, HashSet};

    const TAU: f32 = 2.0 * PI;
    const GOLDEN_ANGLE: f32 = 2.399_963_2;
    const MIN_RING: f32 = 110.0;
    const RING_SPACING: f32 = 30.0;
    const BOOK_SPACING: f32 = 2.6;
    const GHOST_DISTANCE: f32 = 1.75;
    const WORD_TO_BOOK: f32 = 0.06;
    const SYNONYM_SPRING: f32 = 0.008;
    const BOOK_SYNONYM_SPRING: f32 = 0.01;
    const GHOST_SPRING: f32 = 0.06;
    const SYNONYM_REST: f32 = 190.0;
    const BOOK_SYNONYM_REST: f32 = 150.0;
    const GHOST_REST: f32 = 105.0;
    const BOOK_MASS: f32 = 5.0;
    const GHOST_SPREAD: f32 = 0.5;
    const GHOST_FAN: usize = 3;

    /// Where a layout put the books (by key) and the words (by id).
    pub struct Placement {
        pub books: HashMap<String, (f32, f32)>,
        pub words: HashMap<i64, (f32, f32)>,
    }

    /// The ring a book's words sit on: wider for more words, so their names have room.
    pub fn ring_radius(count: usize) -> f32 {
        MIN_RING.max(count as f32 * RING_SPACING / TAU)
    }

    #[derive(Clone, PartialEq, Eq, Hash)]
    enum Id {
        Book(String),
        Word(i64),
    }

    /// Every book, each with its words around it; books spread out on a spiral, the first saved-from in
    /// the middle. `words` are (id, book key) in the order they were saved.
    pub fn every_book(books: &[String], words: &[(i64, String)], links: &[(i64, i64)]) -> Placement {
        let mut by_book: HashMap<&str, Vec<i64>> = HashMap::new();
        for (id, b) in words {
            by_book.entry(b.as_str()).or_default().push(*id);
        }
        let widest = books.iter().map(|b| ring_radius(by_book.get(b.as_str()).map_or(0, |v| v.len()))).fold(MIN_RING, f32::max);
        let mut sim = Sim::default();
        let mut anchors: HashMap<&str, (f32, f32)> = HashMap::new();
        for (i, b) in books.iter().enumerate() {
            let r = widest * BOOK_SPACING * (i as f32).sqrt();
            let a = i as f32 * GOLDEN_ANGLE;
            let at = (r * a.cos(), r * a.sin());
            anchors.insert(b.as_str(), at);
            sim.add(Id::Book(b.clone()), at, BOOK_MASS, true, false);
        }
        let ids: HashSet<i64> = words.iter().map(|(id, _)| *id).collect();
        for b in books {
            let in_book = by_book.get(b.as_str()).cloned().unwrap_or_default();
            let c = anchors[b.as_str()];
            let ring = ring_radius(in_book.len());
            for (k, id) in in_book.iter().enumerate() {
                let a = -PI / 2.0 + k as f32 * TAU / in_book.len().max(1) as f32;
                sim.add(Id::Word(*id), (c.0 + ring * a.cos(), c.1 + ring * a.sin()), 1.0, false, false);
                sim.link(&Id::Word(*id), &Id::Book(b.clone()), ring, WORD_TO_BOOK);
            }
        }
        for (a, b) in links {
            if ids.contains(a) && ids.contains(b) {
                sim.link(&Id::Word(*a), &Id::Word(*b), SYNONYM_REST, SYNONYM_SPRING);
            }
        }
        sim.run();
        sim.placement()
    }

    /// One book in the middle, its words around it, and other books' synonyms of them a little further out.
    pub fn one_book(book: &str, words: &[i64], ghosts: &[i64], links: &[(i64, i64)]) -> Placement {
        let mut sim = Sim::default();
        sim.add(Id::Book(book.to_string()), (0.0, 0.0), BOOK_MASS, false, true);
        let ring = ring_radius(words.len()) + RING_SPACING;
        for (k, id) in words.iter().enumerate() {
            let a = -PI / 2.0 + k as f32 * TAU / words.len().max(1) as f32;
            sim.add(Id::Word(*id), (ring * a.cos(), ring * a.sin()), 1.0, false, false);
            sim.link(&Id::Word(*id), &Id::Book(book.to_string()), ring, WORD_TO_BOOK);
        }
        let shown: HashSet<i64> = words.iter().copied().collect();
        // other books' synonyms start further out, each near the word it means the same as
        for (k, g) in ghosts.iter().enumerate() {
            let partner = links.iter().find(|(a, b)| (a == g && shown.contains(b)) || (b == g && shown.contains(a))).map(|(a, b)| if a == g { *b } else { *a });
            let near = partner.and_then(|p| sim.pos(&Id::Word(p)));
            let a = match near {
                Some((x, y)) => y.atan2(x) + ((k % GHOST_FAN) as f32 - 1.0) * GHOST_SPREAD,
                None => k as f32 * GOLDEN_ANGLE,
            };
            sim.add(Id::Word(*g), (ring * GHOST_DISTANCE * a.cos(), ring * GHOST_DISTANCE * a.sin()), 1.0, false, false);
        }
        let ghost_ids: HashSet<i64> = ghosts.iter().copied().collect();
        for (a, b) in links {
            if shown.contains(a) && shown.contains(b) {
                sim.link(&Id::Word(*a), &Id::Word(*b), BOOK_SYNONYM_REST, BOOK_SYNONYM_SPRING);
            } else if ghost_ids.contains(a) || ghost_ids.contains(b) {
                sim.link(&Id::Word(*a), &Id::Word(*b), GHOST_REST, GHOST_SPRING);
            }
        }
        sim.run();
        sim.placement()
    }

    const MAX_STEPS: f32 = 320.0;
    const MIN_STEPS: i32 = 80;
    const STEP_BUDGET_NODES: f32 = 150.0;
    const NEAR_ZERO: f32 = 0.01;
    const CUTOFF_SQUARED: f32 = 160_000.0;
    const MAX_PUSH: f32 = 9.0;
    const PUSH: f32 = 2_100.0;
    const COOLING_FLOOR: f32 = 0.4;
    const ANCHOR_PULL: f32 = 0.03;
    const DAMPING: f32 = 0.6;
    const MAX_SPEED: f32 = 14.0;

    /// The force simulation: repulsion within a cut-off, springs on links, books held near their anchors.
    #[derive(Default)]
    struct Sim {
        ids: Vec<Id>,
        index: HashMap<Id, usize>,
        x: Vec<f32>,
        y: Vec<f32>,
        ax: Vec<f32>,
        ay: Vec<f32>,
        mass: Vec<f32>,
        anchored: Vec<bool>,
        fixed: Vec<bool>,
        links: Vec<(usize, usize, f32, f32)>,
    }

    impl Sim {
        fn add(&mut self, id: Id, at: (f32, f32), mass: f32, anchored: bool, fixed: bool) {
            if self.index.contains_key(&id) {
                return;
            }
            self.index.insert(id.clone(), self.ids.len());
            self.ids.push(id);
            self.x.push(at.0);
            self.y.push(at.1);
            self.ax.push(at.0);
            self.ay.push(at.1);
            self.mass.push(mass);
            self.anchored.push(anchored);
            self.fixed.push(fixed);
        }

        fn link(&mut self, a: &Id, b: &Id, rest: f32, k: f32) {
            if let (Some(&i), Some(&j)) = (self.index.get(a), self.index.get(b)) {
                self.links.push((i, j, rest, k));
            }
        }

        fn pos(&self, id: &Id) -> Option<(f32, f32)> {
            self.index.get(id).map(|&i| (self.x[i], self.y[i]))
        }

        fn run(&mut self) {
            let n = self.ids.len();
            if n == 0 {
                return;
            }
            let mut vx = vec![0f32; n];
            let mut vy = vec![0f32; n];
            // fewer steps for big graphs: the pairs grow with the square of the words
            let share = (STEP_BUDGET_NODES / n as f32) * (STEP_BUDGET_NODES / n as f32);
            let steps = ((MAX_STEPS * share.min(1.0)) as i32).clamp(MIN_STEPS, MAX_STEPS as i32);
            for step in 0..steps {
                let cooling = 1.0 - step as f32 / steps as f32;
                self.repel(&mut vx, &mut vy, cooling);
                self.pull(&mut vx, &mut vy);
                self.step(&mut vx, &mut vy);
            }
        }

        fn repel(&self, vx: &mut [f32], vy: &mut [f32], cooling: f32) {
            let n = self.ids.len();
            for i in 0..n {
                for j in i + 1..n {
                    let dx = self.x[j] - self.x[i];
                    let dy = self.y[j] - self.y[i];
                    let d2 = dx * dx + dy * dy + NEAR_ZERO;
                    if d2 > CUTOFF_SQUARED {
                        continue;
                    }
                    let d = d2.sqrt();
                    let f = MAX_PUSH.min(PUSH / d2) * (COOLING_FLOOR + cooling);
                    let fx = dx / d * f;
                    let fy = dy / d * f;
                    vx[i] -= fx / self.mass[i];
                    vy[i] -= fy / self.mass[i];
                    vx[j] += fx / self.mass[j];
                    vy[j] += fy / self.mass[j];
                }
            }
        }

        fn pull(&self, vx: &mut [f32], vy: &mut [f32]) {
            for &(i, j, rest, k) in &self.links {
                let dx = self.x[j] - self.x[i];
                let dy = self.y[j] - self.y[i];
                let d = (dx * dx + dy * dy).sqrt().max(1.0);
                let f = k * (d - rest);
                vx[i] += dx / d * f / self.mass[i];
                vy[i] += dy / d * f / self.mass[i];
                vx[j] -= dx / d * f / self.mass[j];
                vy[j] -= dy / d * f / self.mass[j];
            }
        }

        fn step(&mut self, vx: &mut [f32], vy: &mut [f32]) {
            for i in 0..self.ids.len() {
                if self.fixed[i] {
                    vx[i] = 0.0;
                    vy[i] = 0.0;
                    continue;
                }
                if self.anchored[i] {
                    vx[i] += (self.ax[i] - self.x[i]) * ANCHOR_PULL;
                    vy[i] += (self.ay[i] - self.y[i]) * ANCHOR_PULL;
                }
                vx[i] *= DAMPING;
                vy[i] *= DAMPING;
                let v = (vx[i] * vx[i] + vy[i] * vy[i]).sqrt();
                if v > MAX_SPEED {
                    vx[i] *= MAX_SPEED / v;
                    vy[i] *= MAX_SPEED / v;
                }
                self.x[i] += vx[i];
                self.y[i] += vy[i];
            }
        }

        fn placement(&self) -> Placement {
            let mut books = HashMap::new();
            let mut words = HashMap::new();
            for (i, id) in self.ids.iter().enumerate() {
                match id {
                    Id::Book(k) => {
                        books.insert(k.clone(), (self.x[i], self.y[i]));
                    }
                    Id::Word(w) => {
                        words.insert(*w, (self.x[i], self.y[i]));
                    }
                }
            }
            Placement { books, words }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(id: i64, book: i64, text: &str, at: i64) -> Word {
        Word {
            id,
            uuid: format!("u{id}"),
            word: text.into(),
            headword: text.to_lowercase(),
            book_id: Some(book),
            book_title: Some(format!("Book {book}")),
            book_author: None,
            sentence: None,
            chapter: None,
            cfi: None,
            fraction: None,
            page_label: None,
            meaning: None,
            pos: None,
            note: None,
            created_at: at,
            updated_at: at,
            review_level: 0,
            review_due_at: None,
            reviewed_at: None,
            learned_at: None,
        }
    }

    // A Christmas Carol (1), Moby-Dick (2), Pride and Prejudice (3), as Katana's WordGraphTest has them
    fn library() -> Vec<Word> {
        vec![
            word(1, 1, "covetous", 1),
            word(2, 1, "grasping", 2),
            word(3, 1, "solitary", 3),
            word(4, 2, "avaricious", 4),
            word(5, 2, "leviathan", 5),
            word(6, 3, "haughty", 6),
            word(7, 3, "dreary", 7),
            word(8, 2, "Dreary", 8),
        ]
    }

    fn groups() -> HashMap<i64, BTreeSet<i64>> {
        // as the index would answer: covetous, grasping and avaricious share "greedy" (10)
        [(1, vec![10, 11]), (2, vec![10]), (4, vec![10, 12]), (3, vec![20]), (6, vec![30]), (5, vec![40]), (7, vec![50]), (8, vec![50])]
            .into_iter()
            .map(|(id, g)| (id, g.into_iter().collect()))
            .collect()
    }

    fn senses() -> Senses {
        Senses::open(&Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/katana-synonyms-en.sqlite")).expect("the synonym index is in resources/")
    }

    #[test]
    fn a_word_is_new_until_reviewed_learned_from_the_weeks_step_learning_between() {
        let mut w = word(1, 1, "covetous", 1);
        assert_eq!(state_of(&w), "new");
        w.reviewed_at = Some(5);
        w.review_level = 1;
        assert_eq!(state_of(&w), "learning");
        w.review_level = 3;
        assert_eq!(state_of(&w), "learned");
        // Again sends it back to 0, but it has been reviewed: learning, not new
        w.review_level = 0;
        w.learned_at = Some(5);
        assert_eq!(state_of(&w), "learning");
    }

    #[test]
    fn words_sharing_a_sense_group_link_across_books_each_pair_once() {
        let links = synonym_links(&library(), &groups());
        assert!(links.contains(&(1, 2)) && links.contains(&(1, 4)) && links.contains(&(2, 4)));
        assert!(!links.iter().any(|(a, b)| *a == 6 || *b == 6));
        assert!(links.iter().all(|(a, b)| a < b));
        let set: BTreeSet<_> = links.iter().collect();
        assert_eq!(set.len(), links.len());
    }

    #[test]
    fn the_same_word_saved_twice_links_whatever_its_case() {
        assert_eq!(synonym_links(&library(), &HashMap::new()), vec![(7, 8)]);
        assert!(synonym_links(&library()[..2], &HashMap::new()).is_empty());
    }

    #[test]
    fn the_index_joins_words_of_the_same_meaning_base_forms_included() {
        let s = senses();
        let g = |w: &str| s.groups(w).unwrap();
        assert!(!g("covetous").is_disjoint(&g("avaricious")), "covetous ~ avaricious");
        assert!(!g("greedy").is_disjoint(&g("grasping")), "greedy ~ grasping");
        // irregular and regular forms count as their base
        assert!(g("ran").is_superset(&g("run")));
        assert!(g("geese").is_superset(&g("goose")));
        assert!(!g("houses").is_empty() && g("houses").is_superset(&g("house")));
        assert!(!g("Gloomier.").is_empty(), "punctuation and case don't matter");
        assert!(g("xqzzv").is_empty());
        assert_eq!(normalize("  Scrooge\u{2019}s, "), "scrooge");
    }

    #[test]
    fn real_words_from_the_index_link_on_the_graph() {
        let s = senses();
        let mut lib = library();
        lib.push(word(9, 3, "gloomy", 9));
        let gs = s.of_words(&lib);
        let links = synonym_links(&lib, &gs);
        assert!(links.contains(&(1, 4)), "covetous and avaricious: {links:?}");
        assert!(links.contains(&(7, 9)), "dreary and gloomy: {links:?}");
        assert!(links.contains(&(7, 8)));
    }

    #[test]
    fn every_books_graph_has_every_word_and_book_placed_the_same_each_time() {
        let mut shuffled = library();
        shuffled.reverse();
        shuffled.swap(1, 5);
        let a = build(&library(), &groups(), None, &HashMap::new(), true);
        let b = build(&shuffled, &groups(), None, &HashMap::new(), true);
        assert_eq!(a.words.len(), 8);
        assert_eq!(a.books.iter().map(|b| b.key.as_str()).collect::<Vec<_>>(), vec!["b:1", "b:2", "b:3"]);
        for (x, y) in a.words.iter().zip(b.words.iter()) {
            assert_eq!((x.word.id, x.x, x.y), (y.word.id, y.x, y.y));
        }
        for (x, y) in a.books.iter().zip(b.books.iter()) {
            assert_eq!((x.x, x.y), (y.x, y.y));
        }
        assert!(a.words.iter().all(|w| !w.ghost));
        // newest first, as the list shows them
        assert_eq!(a.words[0].word.id, 8);
    }

    #[test]
    fn the_layout_settles_words_near_their_book_nothing_piled_up_or_flung_away() {
        let g = build(&library(), &groups(), None, &HashMap::new(), true);
        for w in &g.words {
            let b = g.books.iter().find(|b| b.key == w.book_key).unwrap();
            let d = ((w.x - b.x).powi(2) + (w.y - b.y).powi(2)).sqrt();
            assert!((40.0..=400.0).contains(&d), "{} is {d} from its book", w.word.word);
            assert!(w.x.is_finite() && w.y.is_finite());
        }
        for i in 0..g.words.len() {
            for j in i + 1..g.words.len() {
                let (a, b) = (&g.words[i], &g.words[j]);
                assert!(((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt() > 8.0);
            }
        }
    }

    #[test]
    fn one_book_shows_its_words_round_it_and_other_books_synonyms_as_ghosts() {
        let g = build(&library(), &groups(), Some("b:1"), &HashMap::new(), true);
        let shown: Vec<i64> = g.words.iter().filter(|w| !w.ghost).map(|w| w.word.id).collect();
        assert_eq!(shown, vec![3, 2, 1]);
        let ghosts: Vec<i64> = g.words.iter().filter(|w| w.ghost).map(|w| w.word.id).collect();
        assert_eq!(ghosts, vec![4]);
        assert_eq!(g.books.len(), 1);
        assert_eq!((g.books[0].x, g.books[0].y), (0.0, 0.0));
        let ids: HashSet<i64> = g.words.iter().map(|w| w.word.id).collect();
        assert!(g.links.iter().all(|[a, b]| ids.contains(a) && ids.contains(b)));
    }

    #[test]
    fn a_big_library_still_lays_out_every_point_finite() {
        let many: Vec<Word> = (0..300).map(|i| word(i, i % 12, &format!("word{i}"), i)).collect();
        let gs: HashMap<i64, BTreeSet<i64>> = many.iter().map(|w| (w.id, [w.id % 40].into_iter().collect())).collect();
        let t = std::time::Instant::now();
        let g = build(&many, &gs, None, &HashMap::new(), true);
        assert!(t.elapsed().as_secs_f32() < 3.0, "took {:?}", t.elapsed());
        assert_eq!(g.words.len(), 300);
        assert!(g.words.iter().all(|w| w.x.is_finite() && w.y.is_finite()));
        let xs: Vec<f32> = g.words.iter().map(|w| w.x).collect();
        assert!(xs.iter().cloned().fold(f32::MIN, f32::max) - xs.iter().cloned().fold(f32::MAX, f32::min) > 100.0);
    }

    #[test]
    fn play_brings_the_words_in_as_they_were_saved_the_oldest_first() {
        let order: Vec<i64> = play_order(&[word(2, 1, "b", 5), word(1, 1, "a", 5), word(3, 1, "c", 1)]).iter().map(|w| w.id).collect();
        assert_eq!(order, vec![3, 1, 2]);
    }

    #[test]
    fn counts_come_from_the_learning_log() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::words::SCHEMA_V5).unwrap();
        for (kind, r, d) in [("review", "u1", None), ("review", "u1", None), ("revisit", "u1", Some("word")), ("revisit", "u1", Some("highlight")), ("lookup", "u1", None)] {
            conn.execute("INSERT INTO learning (at, day, kind, ref, detail) VALUES (1, '2026-11-22', ?1, ?2, ?3)", rusqlite::params![kind, r, d]).unwrap();
        }
        assert_eq!(counts(&conn).unwrap().get("u1"), Some(&(2, 1)));
    }
}
