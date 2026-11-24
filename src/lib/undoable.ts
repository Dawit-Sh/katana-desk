// The changes Ctrl Z undoes (the history is src/lib/undo.ts). Each one makes the change through the app's
// own calls, then records how to undo it and do it again through the same calls, so the database,
// Grimmory sync and other windows stay right; marks and words also tell every window (marks-changed,
// words-changed) so readers, the Bookmarks page and My words show it. Lists, covers, folders and statuses
// are told by the Rust side (lists-changed, covers-changed, library-changed).
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api, covers, grimmory, lists as listApi, type Folder, type List } from "./api";
import { words as wordsApi, type Word } from "./words";
import { hls, marks as bms, type Bookmark, type Colour, type Highlight, type Style } from "../reader/marks";
import { idIs, idNow, record } from "./undo";
import { useStore, type CoverTarget } from "./store";
import { plural } from "./format";

const marksChanged = (bookId: number) => void emit("marks-changed", bookId).catch(() => {});
const wordsChanged = () => void emit("words-changed").catch(() => {});

/** Words on the bar, in quotes and not too long. */
const quote = (s: string | null | undefined) => {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return `“${t.length > 140 ? `${t.slice(0, 139)}…` : t}”`;
};
const clean = (s: string | null | undefined) => s?.trim() || null;

// ---------- highlights and bookmarks ----------

/** A highlight or a bookmark (a Mark of the marks lists will do). */
export type MarkRef = { kind: "hl"; h: Highlight } | { kind: "bm"; b: Bookmark };
/** One taken away: what it was, and the read it belonged to (the removal answers it). */
type Gone = { m: MarkRef; read: number | null };

const keyOf = (m: MarkRef) => (m.kind === "hl" ? `hl:${m.h.uuid}` : `bm:${m.b.uuid}`);
const idOf = (m: MarkRef) => idNow(keyOf(m), m.kind === "hl" ? m.h.id : m.b.id);
const bookOf = (m: MarkRef) => (m.kind === "hl" ? m.h.bookId : m.b.bookId);

async function take(g: Gone) {
  const read = g.m.kind === "hl" ? await hls.remove(idOf(g.m)) : await bms.remove(idOf(g.m));
  if (g.read == null) g.read = read ?? null;
}
async function putBack(g: Gone) {
  const back = g.m.kind === "hl" ? await hls.restore(g.m.h, g.read) : await bms.restore(g.m.b, g.read);
  idIs(keyOf(g.m), back.id);
}
async function takeAll(list: Gone[]) {
  for (const g of list) await take(g);
  new Set(list.map((g) => bookOf(g.m))).forEach(marksChanged);
}
async function putBackAll(list: Gone[]) {
  for (const g of list) await putBack(g);
  new Set(list.map((g) => bookOf(g.m))).forEach(marksChanged);
}

const what = (m: MarkRef) =>
  m.kind === "bm" ? "Bookmark" : clean(m.h.note) ? "Highlight and note" : "Highlight";
const detailOf = (m: MarkRef) =>
  m.kind === "hl" ? quote(m.h.text) : clean(m.b.title) ?? quote(m.b.excerpt) ?? (m.b.pageLabel ? `p. ${m.b.pageLabel}` : null);

/** Removes highlights and bookmarks at once, as one change. `where`: the book's title (several marks). */
export async function removeMarks(marks: MarkRef[], where: string | null = null) {
  if (!marks.length) return;
  const list: Gone[] = marks.map((m) => ({ m, read: null }));
  const done: Gone[] = [];
  try {
    for (const g of list) {
      await take(g);
      done.push(g);
    }
  } finally {
    new Set(list.map((g) => bookOf(g.m))).forEach(marksChanged);
    if (done.length) {
      const one = done.length === 1 ? done[0].m : null;
      record({
        label: one ? `${what(one)} removed` : `${plural(done.length, "mark")} removed`,
        back: one ? `${what(one)} back` : `${plural(done.length, "mark")} back`,
        detail: one ? detailOf(one) : where,
        undo: () => putBackAll(done),
        redo: () => takeAll(done),
      });
    }
  }
}
export const removeHighlight = (h: Highlight) => removeMarks([{ kind: "hl", h }]);

/**
 * A highlight or bookmark just made (already saved by the caller): Ctrl Z takes it off again, Ctrl Y puts it
 * back (his note, 2026-11-24: "if you want to remove the highlight, Control+Z").
 */
export function markAdded(m: MarkRef) {
  const g: Gone = { m, read: null };
  record({
    label: m.kind === "bm" ? "Bookmarked" : "Highlighted",
    back: m.kind === "bm" ? "Bookmark taken off" : "Highlight taken off",
    detail: detailOf(m),
    undo: () => takeAll([g]),
    redo: () => putBackAll([g]),
  });
}
export const removeBookmark = (b: Bookmark) => removeMarks([{ kind: "bm", b }]);
export const removeMark = (m: MarkRef) => removeMarks([m]);

/** What changed on a note: added, removed or changed (null: the same). */
function noteChange(before: string | null | undefined, after: string | null | undefined) {
  const a = clean(before);
  const b = clean(after);
  if (a === b) return null;
  if (!a) return { label: "Note added", back: "Note taken off" };
  if (!b) return { label: "Note removed", back: "Note back" };
  return { label: "Note changed", back: "Note put back" };
}

/** A highlight's colour, style or note changed (already saved by the caller): recorded, and told. */
export function highlightChanged(h: Highlight, color: Colour, style: Style, note: string | null) {
  const note1 = noteChange(h.note, note);
  const changes = [
    h.color !== color && { label: "Colour changed", back: "Colour put back" },
    h.style !== style && { label: "Style changed", back: "Style put back" },
    note1,
  ].filter((x): x is { label: string; back: string } => !!x);
  const words = changes.length > 1 ? { label: "Highlight changed", back: "Highlight put back" } : changes[0];
  marksChanged(h.bookId);
  if (!words) return;
  const set = async (c: Colour, s: Style, n: string | null) => {
    const r = await hls.update(idNow(`hl:${h.uuid}`, h.id), c, s, n);
    if (!r) throw new Error("That highlight isn't there any more");
    marksChanged(h.bookId);
  };
  record({
    ...words,
    detail: quote(h.text),
    undo: () => set(h.color, h.style, h.note ?? null),
    redo: () => set(color, style, note),
  });
}

/** A bookmark named or given a note: saved, recorded, told. */
export async function editBookmark(b: Bookmark, title: string | null, note: string | null) {
  await bms.update(b.id, title, note);
  marksChanged(b.bookId);
  const renamed = clean(b.title) !== clean(title);
  const note1 = noteChange(b.note, note);
  const words = renamed && note1 ? { label: "Bookmark changed", back: "Bookmark put back" } : renamed ? { label: "Bookmark renamed", back: "Name put back" } : note1;
  if (!words) return;
  const set = async (t: string | null, n: string | null) => {
    await bms.update(idNow(`bm:${b.uuid}`, b.id), t, n);
    marksChanged(b.bookId);
  };
  record({
    ...words,
    // where it is (its name is what changed)
    detail: quote(b.excerpt) ?? (b.pageLabel ? `p. ${b.pageLabel}` : null),
    undo: () => set(b.title, b.note),
    redo: () => set(title, note),
  });
}

// ---------- My words ----------

/** A word taken out of My words (already, by the caller): recorded, and told. */
export function wordRemoved(gone: Word) {
  wordsChanged();
  record({
    label: "Word taken out of My words",
    back: "Word back in My words",
    detail: quote(gone.word),
    undo: async () => {
      await wordsApi.restore(gone);
      wordsChanged();
    },
    redo: async () => {
      await wordsApi.remove(gone.id);
      wordsChanged();
    },
  });
}
/** A word just saved to My words (already, by the caller): Ctrl Z takes it out again, Ctrl Y puts it back. */
export function wordAdded(w: Word) {
  let now = w;
  record({
    label: "Saved to My words",
    back: "Word taken out of My words",
    detail: quote(w.word),
    undo: async () => {
      await wordsApi.remove(now.id);
      wordsChanged();
    },
    redo: async () => {
      now = await wordsApi.restore(now);
      wordsChanged();
    },
  });
}
/** Takes a word out of My words, as a change Ctrl Z undoes. Answers the word as it was. */
export async function removeWord(w: Word) {
  const gone = await wordsApi.remove(w.id);
  if (gone) wordRemoved(gone);
  return gone;
}

// ---------- lists ----------

/** A list is named by when it was made (Undo makes it again with that, and a new id). */
const listKey = (l: List) => `list:${l.createdAt}`;
const listId = (l: List) => idNow(listKey(l), l.id);

/** A book's title by its list key (`b:<id>` or `g:<id>`), for the bar. */
function titleOf(key: string) {
  const st = useStore.getState();
  const id = Number(key.slice(2));
  if (key.startsWith("b:")) return st.books.find((b) => b.id === id)?.title ?? null;
  return st.catalog.books.find((b) => b.id === id)?.title ?? st.books.find((b) => b.grimmoryId === id)?.title ?? null;
}

export async function removeList(l: List) {
  await listApi.remove(l.id);
  let kept = l;
  record({
    label: "List removed",
    back: "List back",
    detail: `“${l.name}”`,
    undo: async () => idIs(listKey(l), await listApi.restore(kept)),
    redo: async () => {
      const id = listId(l);
      // as it is now (books added since come back with it next time)
      kept = (await listApi.all().catch(() => [] as List[])).find((x) => x.id === id) ?? kept;
      await listApi.remove(id);
    },
  });
}

export async function takeOffList(l: List, book: string) {
  await listApi.take(l.id, book);
  record({
    label: `Taken off “${l.name}”`,
    back: `Back on “${l.name}”`,
    detail: titleOf(book),
    undo: () => listApi.add(listId(l), book),
    redo: () => listApi.take(listId(l), book),
  });
}

export async function addToList(l: List, book: string) {
  await listApi.add(l.id, book);
  record({
    label: `Added to “${l.name}”`,
    back: `Taken off “${l.name}”`,
    detail: titleOf(book),
    undo: () => listApi.take(listId(l), book),
    redo: () => listApi.add(listId(l), book),
  });
}

// ---------- covers ----------

type Pic = { bytes: Uint8Array; source: string };

/** The custom cover a book has now (its picture and where it came from), or null. */
async function coverNow(key: string): Promise<Pic | null> {
  const c = (await covers.custom()).find((x) => x.key === key);
  if (!c) return null;
  return { bytes: new Uint8Array(await covers.file(c.path)), source: c.source ?? "" };
}
const putCover = (key: string, p: Pic | null) => (p ? covers.save(key, p.bytes, p.source).then(() => {}) : covers.reset(key));

/** A new cover (framed in Change cover): the one before is kept to put back. */
export async function saveCover(t: CoverTarget, jpeg: Uint8Array, source: string) {
  const before = await coverNow(t.key).catch(() => null);
  await covers.save(t.key, jpeg, source);
  record({
    label: "Cover changed",
    back: before ? "Cover put back" : "Original cover back",
    detail: t.title,
    undo: () => putCover(t.key, before),
    redo: () => putCover(t.key, { bytes: jpeg, source }),
  });
}

/** Back to the original cover: yours is kept to put back. */
export async function resetCover(t: CoverTarget) {
  const before = await coverNow(t.key).catch(() => null);
  await covers.reset(t.key);
  if (!before) return;
  record({
    label: "Original cover back",
    back: "Your cover back",
    detail: t.title,
    undo: () => putCover(t.key, before),
    redo: () => covers.reset(t.key),
  });
}

// ---------- Local folders ----------

/** A folder taken off Local (the files stay where they are). Undo adds it again: its books come back. */
export async function removeFolder(f: Folder) {
  await api.removeFolder(f.id);
  record({
    label: "Folder taken off Local",
    back: "Folder back in Local",
    detail: f.name,
    undo: async () => {
      await api.addPaths([f.path]);
      if (!(await api.library()).folders.some((x) => x.path === f.path)) throw new Error("That folder isn't there any more");
    },
    redo: async () => {
      const now = (await api.library()).folders.find((x) => x.path === f.path);
      if (now) await api.removeFolder(now.id);
    },
  });
}

// ---------- reading status ----------

/** What a status change can change here besides the status (reads.rs StatusMarks). */
export type StatusMarks = { finishedAt: number | null; read: number };
/** A copy of the book on this PC as it was before a status changed it: its place (Unread clears it), the
 *  day it was finished (Read sets it, Unread clears it) and its current read (Re-reading starts one). */
export type Placed = { id: number; location: string | null; fraction: number | null; chapter: string | null; marks: StatusMarks | null };
export const statusMarks = (id: number) => invoke<StatusMarks>("book_status_marks", { id });
export type StatusChange = {
  /** the Grimmory book (its status is Grimmory's), or null: a book only on this PC */
  gid: number | null;
  localId: number | null;
  title: string;
  from: string | null;
  to: string;
  /** a status's name on screen ("Won't read") */
  name: (s: string) => string;
  places: Placed[];
};

/** Sets a status the way the status menu does; `places`: put the places back that it cleared. */
async function setStatus(c: StatusChange, status: string | null, places: Placed[] | null) {
  if (c.gid != null) {
    if (status == null) throw new Error("Grimmory can't take a status off");
    if (status === "RE_READING" && c.localId != null) await invoke("book_new_read", { bookId: c.localId }).catch(() => {});
    await grimmory.setStatus(c.gid, status);
  } else if (c.localId != null) {
    await invoke("book_set_status", { id: c.localId, status: status ?? "" });
  }
  for (const p of places ?? []) {
    if (p.location) {
      const b = await api.book(p.id).catch(() => null);
      if (b && b.location !== p.location) await api.saveProgress(p.id, p.location, p.fraction ?? 0, p.chapter, null, true);
    }
    if (p.marks) await invoke("book_status_put_back", { id: p.id, m: p.marks });
  }
  const st = useStore.getState();
  st.reload().catch(() => {});
  st.reloadCatalog().catch(() => {});
  // the status pills showing this book read it again
  window.dispatchEvent(new CustomEvent("katana-status", { detail: { gid: c.gid, localId: c.localId } }));
}

/** A status set in the status menu (already, by the menu): recorded. A Grimmory book that had none
 *  can't go back to none, so that one isn't. */
export function statusChanged(c: StatusChange) {
  if (c.from === c.to || (c.gid != null && c.from == null)) return;
  record({
    label: `Status set to ${c.name(c.to)}`,
    back: c.from ? `Status back to ${c.name(c.from)}` : "Status taken off",
    detail: c.title,
    undo: () => setStatus(c, c.from, c.places),
    redo: () => setStatus(c, c.to, null),
  });
}

// ---------- Local's reading dashboard ----------

/** The reading band reads its books again after a set aside, an undo or a redo (src/components/ReadingBand.tsx). */
const asideChanged = () => window.dispatchEvent(new Event("katana-aside"));

/** Set aside on Local's reading band: off the band until the book is opened again, and Paused on Grimmory for
 *  a Grimmory book. Undo puts it back on the band, and its Grimmory status back to what it was. */
export async function setAside(b: { id: number; title: string; grimmoryId: number | null }) {
  const was = b.grimmoryId != null ? useStore.getState().catalog.books.find((g) => g.id === b.grimmoryId)?.readStatus ?? null : null;
  const on = async () => {
    await api.setAside(b.id, true);
    if (b.grimmoryId != null) await grimmory.setStatus(b.grimmoryId, "PAUSED").catch(() => {});
    asideChanged();
  };
  await on();
  record({
    label: "Set aside",
    back: "Back on the reading band",
    detail: b.title,
    undo: async () => {
      await api.setAside(b.id, false);
      if (b.grimmoryId != null && was && was !== "PAUSED") await grimmory.setStatus(b.grimmoryId, was).catch(() => {});
      asideChanged();
    },
    redo: on,
  });
}
