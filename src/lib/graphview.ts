// My words' graph, the parts that are plain arithmetic: the camera (fit, zoom round a point, moves between two
// views), the sizes words and books are drawn at, the curve and zigzag lines, hits, and the words Play shows.
// No imports, so `npm test` (Node's own test runner) checks them without the app (tools/tests/).
// The rules are Katana's on Android (WordGraphDraw.kt, WordGraphView.kt, WordGraphEdges.kt).

export type WordState = "learned" | "learning" | "new";
export type StateFilter = "all" | WordState;

/** World point (x, y) shows at (x * s + tx, y * s + ty) on screen. */
export type Cam = { s: number; tx: number; ty: number };
export type Box = { left: number; top: number; right: number; bottom: number };
/** The part of the panel a view fits into (clear of the chips, the controls and a card). */
export type Area = { x: number; y: number; w: number; h: number };

export const MIN_SCALE = 0.08;
export const MAX_SCALE = 4;
/** Names show from this scale (every book), and always in one book. */
export const LABEL_SCALE = 0.7;
/** Book titles show under the books from this scale. */
export const BOOK_TITLE_SCALE = 0.45;
/** A book's rectangle turns into its cover once it is this tall on screen. */
export const COVER_MIN_HEIGHT = 36;

/** Android's rule: never reviewed, new; at the week's step (level 3) or past it, learned; else learning. */
export function wordState(w: { reviewedAt: number | null; reviewLevel: number }): WordState {
  if (w.reviewedAt == null && w.reviewLevel <= 0) return "new";
  return w.reviewLevel >= 3 ? "learned" : "learning";
}

export const STATE_NAME: Record<WordState, string> = { learned: "Learned", learning: "Learning", new: "New" };

export function boundsOf(points: { x: number; y: number }[], margin: number): Box {
  if (!points.length) return { left: -margin, top: -margin, right: margin, bottom: margin };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { left: left - margin, top: top - margin, right: right + margin, bottom: bottom + margin };
}

/** `box` filling `area`, no closer than `maxScale`. */
export function fit(box: Box, area: Area, maxScale: number): Cam {
  const bw = Math.max(1, box.right - box.left);
  const bh = Math.max(1, box.bottom - box.top);
  const s = Math.max(MIN_SCALE, Math.min(Math.max(1, area.w) / bw, Math.max(1, area.h) / bh, maxScale));
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  return { s, tx: area.x + area.w / 2 - cx * s, ty: area.y + area.h / 2 - cy * s };
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** `cam` zoomed by `factor` round the screen point (cx, cy), within min..max. */
export function zoomAround(cam: Cam, factor: number, cx: number, cy: number, min: number, max: number): Cam {
  const s = clamp(cam.s * factor, min, max);
  const f = s / cam.s;
  return { s, tx: cx - (cx - cam.tx) * f, ty: cy - (cy - cam.ty) * f };
}

/** A view part of the way from `a` to `b` (the scale moves evenly in steps of zoom, not in pixels). */
export function lerpCam(a: Cam, b: Cam, t: number): Cam {
  return { s: a.s * Math.pow(b.s / a.s, t), tx: a.tx + (b.tx - a.tx) * t, ty: a.ty + (b.ty - a.ty) * t };
}

/** Fast out, slow in, as Material's standard curve. */
export function ease(t: number): number {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/** A word's circle on screen: bigger with more words of the same meaning, bigger zoomed in and in one book. */
export function wordRadius(degree: number, bookMode: boolean, scale: number): number {
  const r = bookMode ? 6.5 + degree * 1.5 : scale >= LABEL_SCALE ? 4.6 + degree * 1.25 : 2.8 + degree * 0.6;
  return Math.min(r, 14);
}

/** A book's size in the graph's own units: bigger in one book, where it is the middle of everything. */
export function bookSize(bookMode: boolean): { w: number; h: number } {
  return bookMode ? { w: 64, h: 96 } : { w: 34, h: 51 };
}

/** A book on screen: its world size scaled, never smaller than a small rectangle you can still see and click. */
export function bookOnScreen(bookMode: boolean, scale: number): { w: number; h: number } {
  const b = bookSize(bookMode);
  const w = Math.max(7, b.w * scale);
  return { w, h: w * 1.5 };
}

export function shortTitle(title: string, n = 22): string {
  return title.length <= n ? title : `${title.slice(0, n - 1).trimEnd()}…`;
}

/** The control point of the curve from a book to a word (`bend` sideways, alternating so lines fan out). */
export function curveControl(ax: number, ay: number, bx: number, by: number, bend: number): [number, number] {
  return [(ax + bx) / 2 - (by - ay) * bend, (ay + by) / 2 + (bx - ax) * bend];
}

/** Points along the book's curve, up to `t` of the way (for a line drawing in). */
export function curvePoints(ax: number, ay: number, bx: number, by: number, bend: number, t: number, steps = 16): number[] {
  const [mx, my] = curveControl(ax, ay, bx, by, bend);
  const out = [ax, ay];
  for (let s = 1; s <= steps; s++) {
    const u = (clamp(t, 0, 1) * s) / steps;
    const v = 1 - u;
    out.push(v * v * ax + 2 * v * u * mx + u * u * bx, v * v * ay + 2 * v * u * my + u * u * by);
  }
  return out;
}

/** The synonym line: a zigzag that tapers at both ends, up to `t` of the way. Flat [x, y, x, y ...]. */
export function zigzag(ax: number, ay: number, bx: number, by: number, amp: number, t: number): number[] {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const n = Math.max(4, Math.round(len / (amp * 2.8)));
  const px = -dy / len;
  const py = dx / len;
  const last = Math.min(n - 1, Math.floor(n * clamp(t, 0, 1)));
  const out = [ax, ay];
  for (let i = 1; i <= last; i++) {
    const f = i / n;
    const o = (i % 2 === 1 ? 1 : -1) * amp * Math.pow(Math.sin(Math.PI * f), 0.4);
    out.push(ax + dx * f + px * o, ay + dy * f + py * o);
  }
  if (t >= 1) out.push(bx, by);
  return out;
}

/** Whether the box from (x1, y1) to (x2, y2) reaches a w x h screen, with a margin for glows and names. */
export function onScreen(x1: number, y1: number, x2: number, y2: number, w: number, h: number, margin = 80): boolean {
  return Math.max(x1, x2) >= -margin && Math.max(y1, y2) >= -margin && Math.min(x1, x2) <= w + margin && Math.min(y1, y2) <= h + margin;
}

/** The nearest of `points` (screen) to (x, y) within `reach` (or its own radius), else -1. */
export function nearest(points: { x: number; y: number; r: number }[], x: number, y: number, reach: number): number {
  let best = -1;
  let bestD = Infinity;
  points.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= Math.max(reach, p.r) && d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

// ---------- Play the links ----------

export const PLAY_STEP_MS = 1000;
/** How long a word's lines take to draw in at 1x: the line from the book, then the zigzags. */
export const FRESH_MS = 900;
export const LINE_FIRST = 1.6;
export const ZIG_DELAY = 0.45;

export const nextSpeed = (s: number) => (s === 1 ? 2 : s === 2 ? 4 : 1);

/** How far the book's line (`line`) and the zigzags (`zig`) of a word just brought in have drawn, 0..1. */
export function freshDraw(progress: number): { line: number; zig: number } {
  return { line: Math.min(1, progress * LINE_FIRST), zig: clamp((progress - ZIG_DELAY) / (1 - ZIG_DELAY), 0, 1) };
}

/** Where a click on the timeline lands: word 1 to n. */
export function seekIndex(fraction: number, n: number): number {
  return clamp(Math.round(fraction * n), 1, Math.max(1, n));
}

/** The timeline's month marks: the places in the play order where a new month starts (never the first). */
export function monthTicks(times: number[]): number[] {
  const out: number[] = [];
  let prev = "";
  times.forEach((t, i) => {
    const d = new Date(t);
    const m = `${d.getFullYear()}-${d.getMonth()}`;
    if (i > 0 && m !== prev) out.push(i);
    prev = m;
  });
  return out;
}

/** "12 of 34" while Play runs or waits, "Play the links" before. */
export function playLine(index: number | null, total: number): string {
  return index == null ? "Play the links" : `${index} of ${total}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Aug", with the year when it isn't this year's. */
export function dayMonth(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const y = new Date(now).getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== y ? ` ${d.getFullYear()}` : ""}`;
}

const DAY = 24 * 60 * 60 * 1000;

/** "Not reviewed yet", or "Reviewed 3 Nov · next in 7 days" (or tomorrow, or due now). */
export function reviewsLine(w: { reviewedAt: number | null; reviewDueAt: number | null }, now = Date.now()): string {
  if (w.reviewedAt == null) return "Not reviewed yet";
  const due = w.reviewDueAt;
  let next: string;
  if (due == null || due <= now) next = "due now";
  else {
    const days = Math.max(1, Math.ceil((due - now) / DAY));
    next = days === 1 ? "next tomorrow" : `next in ${days} days`;
  }
  return `Reviewed ${dayMonth(w.reviewedAt, now)} · ${next}`;
}

/** "and" between the last two: "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The sentence split round the word (any case, standing on its own), for the word set in bold; null if it isn't there. */
export function splitAtWord(sentence: string, word: string): [string, string, string] | null {
  const t = sentence.toLowerCase();
  const w = word.toLowerCase();
  if (!w || t.length !== sentence.length) return null;
  const letter = /[\p{L}\p{N}]/u;
  for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) {
    if (!letter.test(t[i - 1] ?? "") && !letter.test(t[i + w.length] ?? "")) {
      return [sentence.slice(0, i), sentence.slice(i, i + w.length), sentence.slice(i + w.length)];
    }
  }
  return null;
}
