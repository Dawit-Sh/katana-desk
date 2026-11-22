// The dictionaries (src-tauri/src/dict/), My words and review cards (src-tauri/src/words.rs).
import { invoke } from "@tauri-apps/api/core";

export type Sense = { gloss: string; example: string | null; tags: string[]; synonyms: string[]; sub: boolean };
export type Entry = {
  word: string;
  pos: string | null;
  ipa: string[];
  origin: string | null;
  senses: Sense[];
  similar: string[];
  /** the form looked up, when this entry is its headword */
  form: string | null;
};
export type StarEntry = { word: string; phonetic: string | null; text: string };
export type Found = {
  id: string;
  name: string;
  kind: "builtin" | "stardict";
  headword: string;
  entries: Entry[];
  texts: StarEntry[];
  edition: string;
};
export type Lookup = { word: string; found: Found[]; missing: string[]; broken: string[] };

export type DlProgress = {
  id: string;
  state: "queued" | "running" | "paused" | "waiting" | "unpacking" | "failed" | "done";
  done: number;
  total: number;
  error: string | null;
};
export type BuiltinState = {
  id: string;
  name: string;
  edition: string;
  installed: boolean;
  size: number;
  downloadSize: number;
  kept: number;
  licence: string;
  licenceUrl: string;
  credit: string;
  progress: DlProgress | null;
};
export type StarInfo = { id: string; name: string; path: string; words: number };
export type DictStatus = { url: string; defaultUrl: string; builtin: BuiltinState[]; stardict: StarInfo[] };

export type Word = {
  id: number;
  uuid: string;
  word: string;
  headword: string;
  bookId: number | null;
  bookTitle: string | null;
  bookAuthor: string | null;
  sentence: string | null;
  chapter: string | null;
  cfi: string | null;
  fraction: number | null;
  pageLabel: string | null;
  meaning: string | null;
  pos: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  reviewLevel: number;
  reviewDueAt: number | null;
  reviewedAt: number | null;
  learnedAt: number | null;
};
export type NewWord = {
  word: string;
  headword: string;
  bookId: number | null;
  sentence: string | null;
  chapter: string | null;
  cfi: string | null;
  fraction: number | null;
  pageLabel: string | null;
  meaning: string | null;
  pos: string | null;
};

/** A word on My words' graph: the saved word, where the layout put it, how far it is learned. */
export type GraphWord = Word & {
  bookKey: string;
  state: "learned" | "learning" | "new";
  /** another book's word that means the same as one of the book's (the one-book graph), drawn faint */
  ghost: boolean;
  reviews: number;
  lookedBack: number;
  x: number;
  y: number;
};
export type GraphBook = { key: string; bookId: number | null; title: string; author: string | null; x: number; y: number };
export type WordGraphData = { book: string | null; books: GraphBook[]; words: GraphWord[]; links: [number, number][]; synonyms: boolean };

export const dict = {
  lookup: (word: string) => invoke<Lookup>("dict_lookup", { word }),
  status: () => invoke<DictStatus>("dict_status"),
  refresh: () => invoke<DictStatus>("dict_refresh"),
  download: (id: string | null = null) => invoke<void>("dict_download", { id }),
  pause: (id: string) => invoke<void>("dict_pause", { id }),
  cancel: (id: string) => invoke<void>("dict_cancel", { id }),
  remove: (id: string) => invoke<DictStatus>("dict_remove", { id }),
  setUrl: (url: string) => invoke<DictStatus>("dict_set_url", { url }),
  addStarDict: (path: string) => invoke<DictStatus>("stardict_add", { path }),
  removeStarDict: (id: string) => invoke<DictStatus>("stardict_remove", { id }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
};

export const words = {
  list: (bookId: number | null = null) => invoke<Word[]>("words_list", { bookId }),
  /** every book's words (`book` null) or one book's (`b:<id>`), laid out, with the links between them */
  graph: (book: string | null) => invoke<WordGraphData>("words_graph", { book }),
  find: (word: string) => invoke<Word | null>("word_find", { word }),
  save: (w: NewWord) => invoke<Word>("word_save", { w }),
  remove: (id: number) => invoke<Word | null>("word_remove", { id }),
  restore: (w: Word) => invoke<Word>("word_restore", { w }),
  note: (id: number, note: string | null) => invoke<void>("word_note", { id, note }),
  fillMeanings: () => invoke<number>("words_fill_meanings"),
  due: (bookId: number | null, all: boolean) => invoke<Word[]>("review_due", { bookId, all }),
  answer: (id: number, known: boolean, first: boolean) => invoke<Word | null>("review_answer", { id, known, first }),
  exportTo: (path: string, bookId: number | null = null) => invoke<number>("words_export", { path, bookId }),
};

/** Learning events for the Journal: a mark or word gone back to, a word looked up. */
export const learning = {
  revisit: (detail: "highlight" | "note" | "bookmark" | "word", mark: string | null, bookId: number | null) =>
    invoke<void>("learning_log", { kind: "revisit", mark, bookId, detail }).catch(() => {}),
  lookup: (word: string, bookId: number | null) => invoke<void>("learning_log", { kind: "lookup", mark: word, bookId, detail: null }).catch(() => {}),
};

/** Where the word stands on its own in the text (not inside a longer word), any case; -1 if not. */
export function wordAt(text: string, word: string): number {
  const t = text.toLowerCase();
  const w = word.toLowerCase();
  if (!w || t.length !== text.length) return -1;
  const letter = /[\p{L}\p{N}]/u;
  for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) {
    if (!letter.test(t[i - 1] ?? "") && !letter.test(t[i + w.length] ?? "")) return i;
  }
  return -1;
}

export const isDue = (w: Word, at = Date.now()) => w.reviewDueAt == null || w.reviewDueAt <= at;

/** Wiktionary's page for a word, for Look it up online. */
export const onlineUrl = (word: string) => `https://en.wiktionary.org/wiki/${encodeURIComponent(word.trim().replace(/ /g, "_"))}`;

/** Saves My words as Markdown where he picks. Returns the path, or null when he cancelled. */
export async function exportWords(bookId: number | null = null): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const d = new Date();
  const name = `My words ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.md`;
  const path = await save({ defaultPath: name, filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (!path) return null;
  await words.exportTo(path, bookId);
  return path;
}

export const mb = (n: number) => (n >= 10e6 ? `${Math.round(n / 1e6)} MB` : `${(n / 1e6).toFixed(1)} MB`);

/** The sentence in `text` around the words at `at` (`len` long), at most about 260 characters. */
export function sentenceIn(text: string, at: number, len: number): string | null {
  if (at < 0) return null;
  // a sentence ends at . ! ? … (and a closing quote) followed by a space
  const ends = /[.!?…]+["'”’)\]]*\s/g;
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = ends.exec(text)) && m.index + m[0].length <= at) from = m.index + m[0].length;
  ends.lastIndex = at + len;
  m = ends.exec(text);
  const to = m ? m.index + m[0].trimEnd().length : text.length;
  let s = text.slice(from, to).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (s.length > 260) {
    // keep the word near the middle of a long sentence
    const word = text.slice(at, at + len);
    const i = s.indexOf(word);
    const a = Math.max(0, i - 120);
    const b = Math.min(s.length, i + len + 120);
    s = `${a > 0 ? "…" : ""}${s.slice(a, b).replace(/^\S*\s/, a > 0 ? "" : "$&").trim()}${b < s.length ? "…" : ""}`;
  }
  return s;
}

/**
 * The sentence a word sits in, from the page: the block the words are in, cut at sentence ends
 * around them, at most about 260 characters. Returns null when there's no text around.
 */
export function sentenceAround(range: Range): string | null {
  const start = range.startContainer;
  const el = (start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement)?.closest(
    "p, li, blockquote, dd, dt, td, th, h1, h2, h3, h4, h5, h6, div, section, body",
  );
  if (!el) return null;
  const text = el.textContent ?? "";
  let at = 0;
  try {
    const r = el.ownerDocument.createRange();
    r.setStart(el, 0);
    r.setEnd(range.startContainer, range.startOffset);
    at = r.toString().length;
  } catch {
    at = text.indexOf(range.toString());
  }
  return sentenceIn(text, at, range.toString().length);
}
