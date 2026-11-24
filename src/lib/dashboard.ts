// Local's reading dashboard (the band on top of Local, 2026-11-24): which books it shows, at Local's top
// and inside a folder, what each folder card lists, and the words for times. Pure, so `npm test` checks it.
import type { Book, Folder, List } from "./api";
import type { Place } from "./store";

export type Mark = { text: string; note: string | null; chapter: string | null; at: number };
/** What the band knows about a started book beyond the library (Rust: dashboard.rs). */
export type Extra = { id: number; mark: Mark | null; secsLeft: number | null; fromDevice: string | null };
export type Dash = { books: Extra[]; aside: number[]; finished: [number, number][] };
export type Reading = { open: Book[]; quiet: Book[] };

/** A book has gone quiet when it's open but hasn't been opened in this many days (his call, 2026-11-24). */
export const QUIET_DAYS = 14;
const DAY = 86_400_000;

export const started = (b: Book) => (b.fraction ?? 0) > 0.004 && (b.fraction ?? 0) < 0.995;

/** The band speaks of one folder inside a folder, but not at the top of the only folder (Local opens straight into it). */
export function isScoped(place: Place, folders: Folder[]): boolean {
  if (place.sub.length) return true;
  return place.folderId != null && folders.length > 1;
}

/** Whether a book is in a place: an added folder (and the folders under `sub`). */
export function inPlace(b: Book, place: Place): boolean {
  if (place.folderId == null) return true;
  if (b.folderId !== place.folderId) return false;
  if (!place.sub.length) return true;
  return (b.relDir + "/").startsWith(place.sub.join("/") + "/");
}

/** The books open now (last opened first), and the ones gone quiet. Finished, set aside and given-up books aren't here. */
export function reading(books: Book[], dash: Dash | null, now: number): Reading {
  const off = new Set(dash?.aside ?? []);
  const done = new Set((dash?.finished ?? []).map(([id]) => id));
  const all = books
    .filter((b) => started(b) && !off.has(b.id) && !done.has(b.id))
    .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
  const cut = now - QUIET_DAYS * DAY;
  return { open: all.filter((b) => (b.openedAt ?? 0) >= cut), quiet: all.filter((b) => (b.openedAt ?? 0) < cut) };
}

/** A folder card's books being read, open ones first. */
export const tileReading = (r: Reading, to: Place) => [...r.open, ...r.quiet].filter((b) => inPlace(b, to));

/** Finished books among these, newest first (a finish with no known day last). */
export function finished(books: Book[], dash: Dash | null): { book: Book; at: number }[] {
  const at = new Map(dash?.finished ?? []);
  return books
    .filter((b) => at.has(b.id))
    .map((b) => ({ book: b, at: at.get(b.id) ?? 0 }))
    .sort((a, b) => b.at - a.at);
}

/** Your list named "Reading next" (any case), the books here that aren't started or finished, in its order. */
export function readingNext(lists: List[], books: Book[], dash: Dash | null): Book[] {
  const list = lists.find((l) => l.name.trim().toLowerCase() === "reading next");
  if (!list) return [];
  const done = new Set((dash?.finished ?? []).map(([id]) => id));
  const byId = new Map(books.map((b) => [b.id, b]));
  const byG = new Map(books.filter((b) => b.grimmoryId != null).map((b) => [b.grimmoryId!, b]));
  const out: Book[] = [];
  for (const k of list.books) {
    const n = Number(k.slice(2));
    const b = k.startsWith("b:") ? byId.get(n) : k.startsWith("g:") ? byG.get(n) : undefined;
    if (b && !started(b) && !done.has(b.id) && (b.fraction ?? 0) < 0.995 && !out.includes(b)) out.push(b);
  }
  return out;
}

/**
 * Books the folder check found in the last 7 days, and how many in each folder. A folder's first check
 * (everything in it, when it was added) doesn't count as new.
 */
export function newThisWeek(books: Book[], folders: Folder[], now: number): { books: Book[]; by: [string, number][] } {
  const added = new Map(folders.map((f) => [f.id, f]));
  const fresh = books
    .filter((b) => {
      if (b.addedAt < now - 7 * DAY) return false;
      const f = b.folderId == null ? null : added.get(b.folderId);
      return !f || b.addedAt - f.addedAt > 10 * 60_000;
    })
    .sort((a, b) => b.addedAt - a.addedAt);
  const count = new Map<string, number>();
  for (const b of fresh) {
    const f = b.folderId == null ? null : added.get(b.folderId);
    const name = !f ? "Added one by one" : folders.length === 1 && b.relDir ? b.relDir.split("/")[0] : f.name;
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return { books: fresh, by: [...count.entries()].sort((a, b) => b[1] - a[1]) };
}

/** "About 3 h 20 min left", "About 40 min left", "A few minutes left". */
export function leftText(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins < 10) return "A few minutes left";
  if (mins < 60) return `About ${Math.round(mins / 5) * 5} min left`;
  let h = Math.floor(mins / 60);
  let m = Math.round((mins % 60) / 10) * 10;
  if (m === 60) { h += 1; m = 0; }
  return `About ${h} h${m ? ` ${m} min` : ""} left`;
}

/** The small chip on a book that's nearly done: "15 min left", or "Nearly done" when its pace isn't known yet. */
export function nearText(secs: number | null, fraction: number | null): string | null {
  if (secs != null && secs <= 30 * 60) return secs < 10 * 60 ? "A few minutes left" : `${Math.round(secs / 300) * 5} min left`;
  if (secs == null && (fraction ?? 0) >= 0.9) return "Nearly done";
  return null;
}

const time12 = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "Today, 9:40 PM", "Yesterday, 9:40 PM", "Sunday" (this past week), then "18 Nov" ("18 Nov 2025" in another year). */
export function whenText(ms: number, now: number): string {
  const d = new Date(ms);
  const t = new Date(now);
  const y = new Date(now);
  y.setDate(t.getDate() - 1);
  if (sameDay(d, t)) return `Today, ${time12(d)}`;
  if (sameDay(d, y)) return `Yesterday, ${time12(d)}`;
  if (now - ms < 6 * DAY && ms < now) return d.toLocaleDateString("en-GB", { weekday: "long" });
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (d.getFullYear() !== t.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
}

/** The same, to follow other words: "yesterday, 9:40 PM". */
export const whenLower = (ms: number, now: number) => whenText(ms, now).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase());

/** A highlight or note cut to a line or two. */
export const cut = (s: string, n = 180) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
