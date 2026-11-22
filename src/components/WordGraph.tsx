// My words as a graph (the Graph view of My words), as Katana draws it on Android and the words-graph canvas
// has it for the desk: each book with the words saved from it around it, a curved line from each word to its
// book, and words of the same meaning joined by a tapered zigzag, within and across books. Every book: books
// are small rectangles zoomed out and their covers zoomed in. One book: its cover in the middle, its words
// round it, other books' words of the same meaning faint further out.
//
// The layout comes from the backend (words_graph, worked out off the main thread, the same each time); this
// draws it on a canvas, only when something changed or moves. Wheel or pinch to zoom, drag to pan, hover a
// word to light up its synonyms, click it for its card, double-click to fly to it, click a book for its
// words, Esc or a click on nothing closes the card. Play the links brings the words in as they were saved.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { bookKey as libKey, fileUrl, gcoverUrl, type Book } from "../lib/api";
import { dict, words as wordsApi, type GraphBook, type GraphWord, type WordGraphData } from "../lib/words";
import { Cover, paletteOf } from "./Cover";
import { Spinner } from "./Spinner";
import * as gv from "../lib/graphview";

type Props = {
  /** the header's book filter: every book, or one (its id in the library) */
  book: number | "all";
  /** the header's search: words that don't match fade */
  query: string;
  /** bumped by Enter in the search: fly to the first word that matches */
  seek: number;
  /** bumped whenever My words changed (saved, reviewed, taken out) */
  version: number;
  /** false while a dialog (the review cards) is over the page: Esc is its */
  active: boolean;
  onAllBooks: () => void;
  onOpen: (w: GraphWord) => void;
  onReview: (w: GraphWord) => void;
};

/** The graph with everything the drawing and the card look up. */
type Model = {
  data: WordGraphData;
  bookMode: boolean;
  byId: Map<number, GraphWord>;
  synOf: Map<number, number[]>;
  /** the book's (or every book's) words in the order they were saved: Play's order */
  order: GraphWord[];
  orderIndex: Map<number, number>;
  ghosts: GraphWord[];
  books: Map<string, GraphBook>;
  box: gv.Box;
  ticks: number[];
};

function buildModel(data: WordGraphData): Model {
  const byId = new Map(data.words.map((w) => [w.id, w]));
  const synOf = new Map<number, number[]>();
  for (const [a, b] of data.links) {
    synOf.set(a, [...(synOf.get(a) ?? []), b]);
    synOf.set(b, [...(synOf.get(b) ?? []), a]);
  }
  const order = data.words.filter((w) => !w.ghost).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  return {
    data,
    bookMode: data.book != null,
    byId,
    synOf,
    order,
    orderIndex: new Map(order.map((w, i) => [w.id, i])),
    ghosts: data.words.filter((w) => w.ghost),
    books: new Map(data.books.map((b) => [b.key, b])),
    box: gv.boundsOf([...data.words, ...data.books], 70),
    ticks: gv.monthTicks(order.map((w) => w.createdAt)),
  };
}

/** The theme's colours and faces, read from the page (they change with the theme). */
type Look = {
  learned: string;
  learning: string;
  newStroke: string;
  canvas: string;
  edge: string;
  edgeHi: string;
  zig: string;
  zigHi: string;
  label: string;
  labelStrong: string;
  shadow: string;
  bookFont: string;
  uiFont: string;
};

function readLook(el: HTMLElement): Look {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    learned: v("--k-pri", "#b7c7d9"),
    learning: v("--g-learning", "#e4b8a7"),
    newStroke: v("--k-out", "#98a2ad"),
    canvas: v("--k-canvas", "#0b0d0f"),
    edge: v("--k-outv", "#4e5660"),
    edgeHi: v("--k-out", "#98a2ad"),
    zig: v("--g-synl", "rgba(183,199,217,.55)"),
    zigHi: v("--k-on", "#e7eaee"),
    label: v("--k-var", "#c8d0d8"),
    labelStrong: v("--k-on", "#e7eaee"),
    shadow: v("--k-shadow", "rgba(0,0,0,.5)"),
    bookFont: v("--font-book", "serif"),
    uiFont: v("--font-ui", "sans-serif"),
  };
}

/** One frame's inputs. */
type Frame = {
  m: Model;
  cam: gv.Cam;
  w: number;
  h: number;
  look: Look;
  sel: number | null;
  hov: number | null;
  hovBook: string | null;
  filter: gv.StateFilter;
  matches: Set<number> | null;
  ghostsOn: boolean;
  /** the words Play has brought in so far; null shows every word */
  shown: Set<number> | null;
  freshId: number | null;
  /** how far the word just brought in has drawn its lines, 0..1; 1 when nothing is drawing */
  fresh: number;
  freshAge: number;
  bornAt: number;
  now: number;
  drift: boolean;
  cover: (b: GraphBook) => HTMLImageElement | null;
};

/** Where the last frame drew the words and books, for hovering and clicking. */
type Drawn = { words: { id: number; x: number; y: number; r: number }[]; books: { key: string; x: number; y: number; w: number; h: number }[] };

const backOut = (t: number) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

const polyline = (path: Path2D, pts: number[]) => {
  path.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A cover drawn from the book's colours and title, for books without a picture (as the library draws them). */
function drawnCover(ctx: CanvasRenderingContext2D, b: GraphBook, x: number, y: number, w: number, h: number, look: Look) {
  const [c1, c2, ct] = paletteOf(b.title, b.author);
  const g = ctx.createLinearGradient(x, y, x + w * 0.5, y + h);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  roundRect(ctx, x, y, w, h, 2);
  ctx.fillStyle = g;
  ctx.fill();
  if (w < 30) return;
  const pad = w * 0.09;
  const size = Math.max(5, w * 0.11);
  ctx.fillStyle = ct;
  ctx.font = `600 ${size}px ${look.bookFont}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const lines = wrap(ctx, b.title, w - 2 * pad, 4);
  lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad + i * size * 1.2));
  if (w >= 56 && b.author) {
    ctx.font = `${Math.max(5, w * 0.065)}px ${look.uiFont}`;
    ctx.globalAlpha *= 0.85;
    ctx.fillText(wrap(ctx, b.author, w - 2 * pad, 1)[0] ?? "", x + pad, y + h - pad - w * 0.08);
    ctx.globalAlpha /= 0.85;
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else {
      out.push(line);
      line = word;
      if (out.length === max) break;
    }
  }
  if (out.length < max && line) out.push(line);
  if (out.length === max && text.length > out.join(" ").length) out[max - 1] = gv.shortTitle(out[max - 1], Math.max(2, out[max - 1].length - 1));
  return out;
}

const widths = new Map<string, number>();
/** A name's width in the font set now, measured once. */
function textWidth(ctx: CanvasRenderingContext2D, text: string): number {
  const k = `${ctx.font}|${text}`;
  let w = widths.get(k);
  if (w == null) {
    w = ctx.measureText(text).width;
    if (widths.size > 4000) widths.clear();
    widths.set(k, w);
  }
  return w;
}

/** Draws one frame; returns where the words and books went. */
function drawGraph(ctx: CanvasRenderingContext2D, f: Frame): Drawn {
  const { m, cam, look } = f;
  const bookMode = m.bookMode;
  const sx = (x: number) => x * cam.s + cam.tx;
  const sy = (y: number) => y * cam.s + cam.ty;
  // the spotlight: the word hovered or picked and its synonyms; the rest fade. While Play runs the graph
  // stays lit as it grows (as on Android), and the word just in shows its name and its synonyms' names.
  const focus = f.hov ?? f.sel;
  const hi = new Set<number>();
  if (focus != null) {
    hi.add(focus);
    for (const o of m.synOf.get(focus) ?? []) hi.add(o);
  }
  const named = new Set<number>(hi);
  if (f.freshId != null) {
    named.add(f.freshId);
    for (const o of m.synOf.get(f.freshId) ?? []) named.add(o);
  }
  // faded: outside the spotlight, or not what the state filter or the search keeps (the spotlight wins)
  const isDim = (w: GraphWord) =>
    !hi.has(w.id) && ((focus != null) || (f.filter !== "all" && w.state !== f.filter) || (f.matches != null && !f.matches.has(w.id)));
  const drawn: Drawn = { words: [], books: [] };

  // where each word is on screen now: drifting a pixel or two, popping in when the graph first shows
  const pts = new Map<number, { x: number; y: number; r: number; pop: number }>();
  const place = (w: GraphWord) => {
    if (w.ghost) {
      if (!f.ghostsOn) return;
      if (f.shown && !(m.synOf.get(w.id) ?? []).some((o) => f.shown!.has(o))) return;
    } else if (f.shown && !f.shown.has(w.id)) return;
    let x = sx(w.x);
    let y = sy(w.y);
    const i = m.orderIndex.get(w.id) ?? m.order.length;
    if (f.drift) {
      const hh = ((w.id * 7919) % 1000) / 1000;
      const dur = 5 + hh * 4;
      const k = 0.5 - 0.5 * Math.cos(Math.PI * (f.now / 1000 / dur + hh * 6));
      x += (hh - 0.5) * 3 * k;
      y += (((hh * 3) % 1) - 0.5) * 3 * k;
    }
    const pop = f.shown ? 1 : backOut((f.now - f.bornAt - Math.min(i * 22, 700)) / 550);
    const r = gv.wordRadius((m.synOf.get(w.id) ?? []).length, bookMode, cam.s) * pop;
    pts.set(w.id, { x, y, r, pop });
  };
  m.order.forEach(place);
  m.ghosts.forEach(place);

  // lines: a curve from each word to its book, a zigzag between synonyms
  const P = {
    plain: new Path2D(),
    plainDim: new Path2D(),
    plainHi: new Path2D(),
    zig: new Path2D(),
    zigDim: new Path2D(),
    zigHi: new Path2D(),
    fresh: new Path2D(),
    freshZig: new Path2D(),
  };
  const draws = gv.freshDraw(f.fresh);
  m.order.forEach((w, i) => {
    const p = pts.get(w.id);
    const b = m.books.get(w.bookKey);
    if (!p || !b || p.pop <= 0) return;
    const bx = sx(b.x);
    const by = sy(b.y);
    if (!gv.onScreen(bx, by, p.x, p.y, f.w, f.h)) return;
    const bend = i % 2 === 0 ? 0.12 : -0.12;
    if (w.id === f.freshId && f.fresh < 1) {
      polyline(P.fresh, gv.curvePoints(bx, by, p.x, p.y, bend, draws.line));
      return;
    }
    const target = w.id === focus ? P.plainHi : isDim(w) ? P.plainDim : P.plain;
    const [mx, my] = gv.curveControl(bx, by, p.x, p.y, bend);
    target.moveTo(bx, by);
    target.quadraticCurveTo(mx, my, p.x, p.y);
  });
  for (const [a, b] of m.data.links) {
    const pa = pts.get(a);
    const pb = pts.get(b);
    if (!pa || !pb || pa.pop <= 0 || pb.pop <= 0) continue;
    if (!gv.onScreen(pa.x, pa.y, pb.x, pb.y, f.w, f.h)) continue;
    if ((a === f.freshId || b === f.freshId) && f.fresh < 1) {
      if (draws.zig > 0) polyline(P.freshZig, gv.zigzag(pa.x, pa.y, pb.x, pb.y, 3.2, draws.zig));
      continue;
    }
    const wa = m.byId.get(a)!;
    const wb = m.byId.get(b)!;
    const target = a === focus || b === focus ? P.zigHi : isDim(wa) || isDim(wb) ? P.zigDim : P.zig;
    polyline(target, gv.zigzag(pa.x, pa.y, pb.x, pb.y, 3.2, 1));
  }
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const stroke = (path: Path2D, color: string, width: number, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke(path);
  };
  stroke(P.plainDim, look.edge, 1.05, 0.13);
  stroke(P.zigDim, look.zig, 1.25, 0.13);
  stroke(P.plain, look.edge, 1.05);
  stroke(P.zig, look.zig, 1.25);
  stroke(P.plainHi, look.edgeHi, 1.7);
  stroke(P.zigHi, look.zigHi, 1.8);
  stroke(P.fresh, look.edgeHi, 1.7);
  stroke(P.freshZig, look.zigHi, 1.8);
  ctx.globalAlpha = 1;

  // books: rectangles zoomed out, covers zoomed in, the title under them
  const size = gv.bookOnScreen(bookMode, cam.s);
  const coversOn = size.h >= gv.COVER_MIN_HEIGHT;
  const titles = bookMode || cam.s >= gv.BOOK_TITLE_SCALE;
  const focusBooks = new Set([...hi].map((id) => m.byId.get(id)?.bookKey));
  const selBook = f.sel != null ? m.byId.get(f.sel)?.bookKey : null;
  const shownBooks = f.shown ? new Set(m.order.filter((w) => f.shown!.has(w.id)).map((w) => w.bookKey)) : null;
  for (const b of m.data.books) {
    if (shownBooks && !shownBooks.has(b.key)) continue;
    const cx = sx(b.x);
    const cy = sy(b.y);
    const left = cx - size.w / 2;
    const top = cy - size.h / 2;
    if (!gv.onScreen(left, top, left + size.w, top + size.h + 20, f.w, f.h)) continue;
    drawn.books.push({ key: b.key, x: left, y: top, w: size.w, h: size.h });
    const dim = focus != null && !focusBooks.has(b.key);
    ctx.globalAlpha = dim ? 0.4 : 1;
    ctx.save();
    ctx.shadowColor = look.shadow;
    ctx.shadowBlur = coversOn ? 14 : 8;
    ctx.shadowOffsetY = coversOn ? 4 : 1;
    const img = coversOn ? f.cover(b) : null;
    if (img) {
      roundRect(ctx, left, top, size.w, size.h, 2);
      ctx.fillStyle = look.canvas;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.clip();
      // the picture fills the 2:3 frame, cut at the edges like a cover in the library
      const ir = img.naturalWidth / img.naturalHeight;
      const fr = size.w / size.h;
      const dw = ir > fr ? size.h * ir : size.w;
      const dh = ir > fr ? size.h : size.w / ir;
      ctx.drawImage(img, left + (size.w - dw) / 2, top + (size.h - dh) / 2, dw, dh);
    } else if (coversOn) {
      drawnCover(ctx, b, left, top, size.w, size.h, look);
    } else {
      const [c1, c2] = paletteOf(b.title, b.author);
      const g = ctx.createLinearGradient(left, top, left + size.w * 0.5, top + size.h);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      roundRect(ctx, left, top, size.w, size.h, 1.5);
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = dim ? 0.4 : 1;
    if (selBook === b.key || f.hovBook === b.key) {
      roundRect(ctx, left - 3, top - 3, size.w + 6, size.h + 6, 4);
      ctx.strokeStyle = look.zigHi;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (titles) {
      ctx.font = `500 10.5px ${look.uiFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const t = gv.shortTitle(b.title);
      ctx.lineWidth = 3;
      ctx.strokeStyle = look.canvas;
      ctx.strokeText(t, cx, top + size.h + 5);
      ctx.fillStyle = look.label;
      ctx.fillText(t, cx, top + size.h + 5);
    }
  }
  ctx.globalAlpha = 1;

  // words: learned filled in the accent with a soft glow, learning filled in the second colour, new hollow
  const all = [...m.order, ...m.ghosts];
  for (const w of all) {
    const p = pts.get(w.id);
    if (!p || p.r <= 0 || !gv.onScreen(p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r + 24, f.w, f.h)) continue;
    drawn.words.push({ id: w.id, x: p.x, y: p.y, r: p.r });
    const alpha = isDim(w) ? 0.16 : w.ghost ? 0.55 : 1;
    if (w.state === "learned" && alpha === 1) {
      ctx.fillStyle = look.learned;
      ctx.globalAlpha = 0.1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = w.state === "learned" ? look.learned : w.state === "learning" ? look.learning : look.canvas;
    ctx.fill();
    if (w.state === "new") {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.r - 0.75), 0, Math.PI * 2);
      ctx.strokeStyle = look.newStroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  // names over the dots and lines: in one book always, zoomed in for every book, and on the words lit up.
  // The lit-up words' names first, then learned words and the most linked; a name that would sit on one
  // already drawn waits until zooming in makes room (the lit-up ones always show).
  const labelsOn = (id: number) => bookMode || cam.s >= gv.LABEL_SCALE || named.has(id);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const fs = bookMode ? 13.5 : 12;
  const must = (w: GraphWord) => named.has(w.id);
  const rank = (w: GraphWord) => (must(w) ? 0 : isDim(w) ? 3 : w.state === "learned" ? 1 : 2) * 1000 - (m.synOf.get(w.id) ?? []).length;
  const taken: { l: number; t: number; r: number; b: number }[] = [];
  for (const w of [...all].sort((a, b) => rank(a) - rank(b))) {
    const p = pts.get(w.id);
    if (!p || p.pop < 0.6 || !labelsOn(w.id) || !gv.onScreen(p.x - 60, p.y, p.x + 60, p.y + 24, f.w, f.h)) continue;
    const strong = w.state === "learned" || named.has(w.id);
    const bold = w.id === f.sel || w.id === f.hov;
    ctx.font = `${w.ghost ? "italic " : ""}${bold ? 600 : 400} ${fs}px ${look.bookFont}`;
    const y = p.y + p.r + 4;
    const half = textWidth(ctx, w.word) / 2 + 2;
    const box = { l: p.x - half, t: y, r: p.x + half, b: y + fs * 1.25 };
    if (!must(w) && taken.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) continue;
    taken.push(box);
    ctx.globalAlpha = isDim(w) ? 0.16 : w.ghost ? 0.7 : 1;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = look.canvas;
    ctx.strokeText(w.word, p.x, y);
    ctx.fillStyle = strong ? look.labelStrong : look.label;
    ctx.fillText(w.word, p.x, y);
    if (w.ghost) {
      // a small chip in the colour of the book it comes from
      const tw = ctx.measureText(w.word).width;
      ctx.fillStyle = paletteOf(w.bookTitle ?? "", w.bookAuthor)[0];
      roundRect(ctx, p.x + tw / 2 + 5, y + fs * 0.3, 6, 9, 1);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  // the picked word's ring, and the ring that spreads from a word Play just brought in
  if (f.sel != null && pts.has(f.sel)) {
    const p = pts.get(f.sel)!;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 3.5, 0, Math.PI * 2);
    ctx.strokeStyle = look.zigHi;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  if (f.freshId != null && pts.has(f.freshId) && f.freshAge < 1) {
    const p = pts.get(f.freshId)!;
    ctx.globalAlpha = 0.9 * (1 - f.freshAge);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 3 + 16 * f.freshAge, 0, Math.PI * 2);
    ctx.strokeStyle = look.zigHi;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  return drawn;
}

const ZIG_ICON = "M0 5L2.75 2L5.5 8L8.25 2L11 8L13.75 2L16.5 8L19.25 2L22 5";
const Zig = () => (
  <svg className="zg" viewBox="0 0 22 10" aria-hidden="true">
    <path d={ZIG_ICON} />
  </svg>
);
const Dot = ({ state }: { state: gv.WordState }) => <i className={`gd ${state}`} />;

const FILTERS: [gv.StateFilter, string][] = [
  ["all", "All"],
  ["learned", "Learned"],
  ["learning", "Learning"],
  ["new", "New"],
];

/** Where the graph was looked at from when the page was left (Open in book, another page): back the same. */
let remembered: { key: string; cam: gv.Cam; sel: number | null; size: string } | null = null;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function WordGraph(p: Props) {
  const books = useStore((s) => s.books);
  const catalog = useStore((s) => s.catalog.books);
  const customCovers = useStore((s) => s.customCovers);
  const key = p.book === "all" ? null : `b:${p.book}`;
  const [data, setData] = useState<WordGraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    wordsApi
      .graph(key)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [key, p.version]);
  const m = useMemo(() => (data ? buildModel(data) : null), [data]);

  const [filter, setFilter] = useState<gv.StateFilter>("all");
  const [ghostsOn, setGhostsOn] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [hov, setHov] = useState<number | null>(null);
  const [hovBook, setHovBook] = useState<string | null>(null);
  const [playIndex, setPlayIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [held, setHeld] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [zoomPct, setZoomPct] = useState(100);
  const [dragging, setDragging] = useState(false);

  const panel = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const cam = useRef<gv.Cam>({ s: 1, tx: 0, ty: 0 });
  const tween = useRef<{ from: gv.Cam; to: gv.Cam; start: number; dur: number } | null>(null);
  const wheelTo = useRef<gv.Cam | null>(null);
  const userMoved = useRef(false);
  const fittedFor = useRef<string | null>(null);
  const dirty = useRef(true);
  const drawnRef = useRef<Drawn>({ words: [], books: [] });
  const lookRef = useRef<Look | null>(null);
  const bornAt = useRef(performance.now());
  const freshAt = useRef(0);
  const imgs = useRef(new Map<string, HTMLImageElement>());
  const drag = useRef<{ x: number; y: number; from: gv.Cam; moved: boolean } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; from: gv.Cam; cx: number; cy: number } | null>(null);
  const suppressClick = useRef(false);

  // Play the links: which words are in so far and the one just in
  const shown = useMemo(() => (m && playIndex != null ? new Set(m.order.slice(0, playIndex).map((w) => w.id)) : null), [m, playIndex]);
  const freshId = m && playIndex ? m.order[playIndex - 1]?.id ?? null : null;
  const active = playIndex != null;
  const needle = p.query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!m || !needle) return null;
    return new Set(
      m.data.words
        .filter((w) => w.word.toLowerCase().includes(needle) || w.headword.toLowerCase().includes(needle) || (w.meaning ?? "").toLowerCase().includes(needle))
        .map((w) => w.id),
    );
  }, [m, needle]);
  const selWord = sel != null ? m?.byId.get(sel) ?? null : null;
  const cardWord = selWord ?? (m?.bookMode && playing && freshId != null ? m.byId.get(freshId) ?? null : null);

  // the latest of everything the frame reads, for the drawing loop
  const ui = useRef({ sel, hov, hovBook, filter, matches, ghostsOn, shown, freshId, playing, speed });
  ui.current = { sel, hov, hovBook, filter, matches, ghostsOn, shown, freshId, playing, speed };
  const model = useRef(m);
  model.current = m;
  useEffect(() => {
    dirty.current = true;
  }, [m, sel, hov, hovBook, filter, matches, ghostsOn, shown, freshId, books, customCovers]);

  const booksById = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  const catalogById = useMemo(() => new Map(catalog.map((g) => [g.id, g])), [catalog]);
  const libraryBook = useCallback((b: { bookId: number | null }): Book | null => (b.bookId != null ? booksById.get(b.bookId) ?? null : null), [booksById]);
  const coverSrc = useCallback(
    (b: GraphBook): string | null => {
      const book = libraryBook(b);
      if (!book) return null;
      const custom = customCovers[libKey(book)] ?? (book.grimmoryId != null ? customCovers[`g:${book.grimmoryId}`] : undefined) ?? customCovers[`b:${book.id}`];
      const pic = custom ?? book.cover;
      if (pic) return fileUrl(pic);
      const g = book.grimmoryId != null ? catalogById.get(book.grimmoryId) : undefined;
      return g ? gcoverUrl(g.id, g.coverV) : null;
    },
    [libraryBook, customCovers, catalogById],
  );
  const coverRef = useRef(coverSrc);
  coverRef.current = coverSrc;
  const coverImg = useCallback((b: GraphBook): HTMLImageElement | null => {
    const src = coverRef.current(b);
    if (!src) return null;
    let img = imgs.current.get(src);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.onload = () => {
        dirty.current = true;
      };
      img.src = src;
      imgs.current.set(src, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }, []);

  /** The part of the panel a view fits into: clear of the chips on top, the controls below, a card at the side. */
  const area = useCallback((cardOpen: boolean): gv.Area => {
    const { w, h } = size.current;
    // the card floats over the graph on every book, and on one book too in a narrow window
    const over = !model.current?.bookMode || window.innerWidth <= 1100;
    const right = cardOpen && over ? 344 : 0;
    return { x: 28, y: 60, w: Math.max(60, w - 56 - right), h: Math.max(60, h - 60 - 76) };
  }, []);
  const fitAll = useCallback(() => (model.current ? gv.fit(model.current.box, area(false), 1.6) : cam.current), [area]);
  const minScale = useCallback(() => gv.clamp(fitAll().s * 0.6, gv.MIN_SCALE, 0.8), [fitAll]);
  const moveTo = useCallback((to: gv.Cam, dur = 450) => {
    tween.current = { from: { ...cam.current }, to, start: performance.now(), dur: reducedMotion() ? 1 : dur };
    wheelTo.current = null;
    dirty.current = true;
  }, []);

  // a new graph (another book, or the first): fit it, words pop in
  useEffect(() => {
    if (!m) return;
    const id = m.data.book ?? "all";
    if (fittedFor.current !== id && size.current.w > 0) {
      fittedFor.current = id;
      tween.current = null;
      setPlaying(false);
      setPlayIndex(null);
      const back = remembered?.key === id && remembered.size === `${size.current.w}x${size.current.h}` ? remembered : null;
      remembered = null;
      if (back) {
        // back from the book (or another page): the same view, the same word picked, no pop-in
        cam.current = back.cam;
        userMoved.current = true;
        bornAt.current = performance.now() - 5000;
        setSel(back.sel != null && m.byId.has(back.sel) ? back.sel : null);
      } else {
        cam.current = fitAll();
        userMoved.current = false;
        bornAt.current = performance.now();
        setSel(null);
      }
    }
    if (sel != null && !m.byId.has(sel)) setSel(null);
    dirty.current = true;
  }, [m]); // eslint-disable-line react-hooks/exhaustive-deps

  // the canvas follows the panel's size (and the screen's pixel density)
  useEffect(() => {
    const el = panel.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: r.width, h: r.height, dpr };
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      cv.style.width = `${r.width}px`;
      cv.style.height = `${r.height}px`;
      const mm = model.current;
      if (mm) {
        const id = mm.data.book ?? "all";
        const back = fittedFor.current !== id && remembered?.key === id && remembered.size === `${r.width}x${r.height}` ? remembered : null;
        if (back) {
          remembered = null;
          fittedFor.current = id;
          cam.current = back.cam;
          userMoved.current = true;
          bornAt.current = performance.now() - 5000;
          if (back.sel != null && mm.byId.has(back.sel)) setSel(back.sel);
        } else if (fittedFor.current !== id || !userMoved.current) {
          if (fittedFor.current !== id) bornAt.current = performance.now();
          fittedFor.current = id;
          cam.current = fitAll();
        }
      }
      dirty.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitAll]);

  // leaving the page keeps the view for coming back
  const selRef = useRef(sel);
  selRef.current = sel;
  useEffect(
    () => () => {
      if (fittedFor.current && userMoved.current)
        remembered = { key: fittedFor.current, cam: { ...cam.current }, sel: selRef.current, size: `${size.current.w}x${size.current.h}` };
    },
    [],
  );

  // the theme's colours, again whenever the theme changes
  useEffect(() => {
    const read = () => {
      if (panel.current) lookRef.current = readLook(panel.current);
      dirty.current = true;
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-tone", "style", "class"] });
    return () => mo.disconnect();
  }, []);

  // the drawing loop: a frame when something changed or moves, a slow drift at about 30 frames a second
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const drift = !reducedMotion();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const mm = model.current;
      const cv = canvas.current;
      const look = lookRef.current;
      if (!mm || !cv || !look || size.current.w === 0 || document.hidden) return;
      let camMoving = false;
      const tw = tween.current;
      if (tw) {
        const t = (now - tw.start) / tw.dur;
        cam.current = t >= 1 ? tw.to : gv.lerpCam(tw.from, tw.to, gv.ease(t));
        if (t >= 1) tween.current = null;
        camMoving = true;
      } else if (wheelTo.current) {
        const to = wheelTo.current;
        const next = gv.lerpCam(cam.current, to, 0.32);
        const done = Math.abs(next.s / to.s - 1) < 0.002 && Math.abs(next.tx - to.tx) < 0.3 && Math.abs(next.ty - to.ty) < 0.3;
        cam.current = done ? to : next;
        if (done) wheelTo.current = null;
        camMoving = true;
      }
      const u = ui.current;
      const freshDur = gv.FRESH_MS / u.speed;
      const freshProgress = u.freshId != null && u.playing ? gv.clamp((now - freshAt.current) / freshDur, 0, 1) : 1;
      const freshAge = u.freshId != null && u.playing ? gv.clamp((now - freshAt.current) / 1100, 0, 1) : 1;
      const popping = !u.shown && now - bornAt.current < 1400;
      const animating = camMoving || freshProgress < 1 || freshAge < 1 || popping;
      if (!dirty.current && !animating && !(drift && now - last > 33)) return;
      last = now;
      dirty.current = false;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const { w, h, dpr } = size.current;
      const t0 = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawnRef.current = drawGraph(ctx, {
        m: mm,
        cam: cam.current,
        w,
        h,
        look,
        sel: u.sel,
        hov: u.hov,
        hovBook: u.hovBook,
        filter: u.filter,
        matches: u.matches,
        ghostsOn: u.ghostsOn,
        shown: u.shown,
        freshId: u.freshId,
        fresh: freshProgress,
        freshAge,
        bornAt: bornAt.current,
        now,
        drift,
        cover: coverImg,
      });
      // test builds: how long the last frame took to draw (checked with a few hundred words)
      if (import.meta.env.DEV) (window as unknown as { __graphMs: number[] }).__graphMs = [...((window as unknown as { __graphMs?: number[] }).__graphMs ?? []).slice(-199), performance.now() - t0];
      const pct = Math.round((cam.current.s / fitAll().s) * 100);
      setZoomPct((z) => (z === pct ? z : pct));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [coverImg, fitAll]);

  // the words lit up by the picked word stay in view beside its card: a pan, and a zoom out only if needed
  const bringIntoView = useCallback(
    (id: number) => {
      const mm = model.current;
      const w = mm?.byId.get(id);
      if (!mm || !w) return;
      const pts = [w, ...(mm.synOf.get(id) ?? []).map((o) => mm.byId.get(o)!).filter(Boolean)];
      const a = area(true);
      const c = cam.current;
      const inside = pts.every((q) => {
        const x = q.x * c.s + c.tx;
        const y = q.y * c.s + c.ty;
        return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;
      });
      if (inside) return;
      const box = gv.boundsOf(pts, 40);
      const s = Math.min(c.s, gv.fit(box, a, 1.4).s);
      const cx = (box.left + box.right) / 2;
      const cy = (box.top + box.bottom) / 2;
      moveTo({ s, tx: a.x + a.w / 2 - cx * s, ty: a.y + a.h / 2 - cy * s });
    },
    [area, moveTo],
  );
  // fly to a word (double-click, Enter in the search): close enough for the names to show, with its
  // synonyms in view when they fit at that size
  const flyTo = useCallback(
    (id: number) => {
      const mm = model.current;
      const w = mm?.byId.get(id);
      if (!mm || !w) return;
      const a = area(true);
      const pts = [w, ...(mm.synOf.get(id) ?? []).map((o) => mm.byId.get(o)!).filter(Boolean)];
      const box = gv.boundsOf(pts, 40);
      const fitted = gv.fit(box, a, 1.4);
      userMoved.current = true;
      if (fitted.s >= gv.LABEL_SCALE) return moveTo(fitted, 600);
      const s = gv.LABEL_SCALE;
      moveTo({ s, tx: a.x + a.w / 2 - w.x * s, ty: a.y + a.h / 2 - w.y * s }, 600);
    },
    [area, moveTo],
  );
  const pick = useCallback(
    (id: number | null) => {
      setSel(id);
      if (id != null) bringIntoView(id);
    },
    [bringIntoView],
  );

  // Enter in the search: the first word that matches, picked and flown to
  useEffect(() => {
    if (!p.seek || !m || !matches?.size) return;
    const first = m.data.words.find((w) => matches.has(w.id));
    if (first) {
      setSel(first.id);
      flyTo(first.id);
    }
  }, [p.seek]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes the card (before anything else on the page)
  useEffect(() => {
    if (!p.active || sel == null) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      e.preventDefault();
      e.stopPropagation();
      setSel(null);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [p.active, sel]);

  // Play: a word about every second (2x, 4x), waiting while the window is hidden; one more beat after the
  // last, then every word shows again
  useEffect(() => {
    const on = () => setHeld(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  useEffect(() => {
    if (!playing || held || !m) return;
    const n = m.order.length;
    const at = playIndex ?? 0;
    const t = window.setTimeout(
      () => {
        if (at >= n) {
          setPlaying(false);
          setPlayIndex(null);
          return;
        }
        freshAt.current = performance.now();
        setPlayIndex(at + 1);
      },
      at === 0 ? 150 : gv.PLAY_STEP_MS / speed,
    );
    return () => clearTimeout(t);
  }, [playing, held, playIndex, speed, m]);
  const togglePlay = () => {
    if (!m) return;
    if (playing) return setPlaying(false);
    if (playIndex == null || playIndex >= m.order.length) {
      setSel(null);
      setHov(null);
      setPlayIndex(0);
      moveTo(fitAll(), 600);
      userMoved.current = false;
    }
    setPlaying(true);
  };

  // pointer: drag to pan, two fingers to pinch, hover for the spotlight
  const hitAt = (x: number, y: number) => {
    const d = drawnRef.current;
    const i = gv.nearest(d.words, x, y, 12);
    if (i >= 0) return { word: d.words[i].id, book: null };
    const b = d.books.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    return { word: null, book: b?.key ?? null };
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = panel.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const at = local(e);
    touches.current.set(e.pointerId, at);
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), from: { ...cam.current }, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      drag.current = null;
      return;
    }
    drag.current = { x: at.x, y: at.y, from: { ...cam.current }, moved: false };
    suppressClick.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const at = local(e);
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, at);
    const pz = pinch.current;
    if (pz && touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const z = gv.zoomAround(pz.from, d / Math.max(1, pz.d), pz.cx, pz.cy, minScale(), gv.MAX_SCALE);
      cam.current = { ...z, tx: z.tx + (a.x + b.x) / 2 - pz.cx, ty: z.ty + (a.y + b.y) / 2 - pz.cy };
      tween.current = null;
      wheelTo.current = null;
      userMoved.current = true;
      suppressClick.current = true;
      dirty.current = true;
      return;
    }
    const dr = drag.current;
    if (dr) {
      const dx = at.x - dr.x;
      const dy = at.y - dr.y;
      if (!dr.moved && Math.hypot(dx, dy) > 4) {
        dr.moved = true;
        suppressClick.current = true;
        setHov(null);
        setDragging(true);
      }
      if (dr.moved) {
        cam.current = { s: dr.from.s, tx: dr.from.tx + dx, ty: dr.from.ty + dy };
        tween.current = null;
        wheelTo.current = null;
        userMoved.current = true;
        dirty.current = true;
      }
      return;
    }
    if (e.pointerType !== "mouse") return;
    const hit = hitAt(at.x, at.y);
    if (hit.word !== hov) setHov(hit.word);
    const bk = m?.bookMode ? null : hit.book;
    if (bk !== hovBook) setHovBook(bk);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    drag.current = null;
    setDragging(false);
  };
  const onClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (e.detail >= 2) return;
    const at = local(e);
    const hit = hitAt(at.x, at.y);
    if (hit.word != null) pick(sel === hit.word ? null : hit.word);
    else if (hit.book && m && !m.bookMode) {
      // a book: its words and cover fill the view
      const own = m.order.filter((w) => w.bookKey === hit.book);
      const b = m.books.get(hit.book)!;
      userMoved.current = true;
      moveTo(gv.fit(gv.boundsOf([...own, b], 70), area(sel != null), 1.6));
    } else setSel(null);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const at = local(e);
    const hit = hitAt(at.x, at.y);
    if (hit.word != null) {
      setSel(hit.word);
      flyTo(hit.word);
    }
  };
  // the wheel (and a touchpad's pinch, which comes as the wheel with Ctrl) zooms round the pointer, smoothly
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".gcard, .gctl")) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
      const r = el.getBoundingClientRect();
      const base = wheelTo.current ?? tween.current?.to ?? cam.current;
      tween.current = null;
      wheelTo.current = gv.zoomAround(base, factor, e.clientX - r.left, e.clientY - r.top, minScale(), gv.MAX_SCALE);
      userMoved.current = true;
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [minScale]);

  const zoomBy = (factor: number) => {
    const { w, h } = size.current;
    userMoved.current = true;
    moveTo(gv.zoomAround(tween.current?.to ?? cam.current, factor, w / 2, h / 2, minScale(), gv.MAX_SCALE), 300);
  };
  const showAll = () => {
    userMoved.current = false;
    moveTo(fitAll());
  };

  // the pronunciation and, for a word saved before the dictionaries came, its meaning
  const [extra, setExtra] = useState<{ id: number; ipa: string | null; meaning: string | null } | null>(null);
  useEffect(() => {
    if (!cardWord) return;
    let live = true;
    dict
      .lookup(cardWord.headword || cardWord.word)
      .then((r) => {
        const e = r.found.find((f) => f.kind === "builtin")?.entries[0];
        if (live) setExtra({ id: cardWord.id, ipa: e?.ipa[0] ?? null, meaning: e?.senses[0]?.gloss ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cardWord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="wg"><div className="wgpanel"><p className="wgerr">The graph didn't load: {error}</p></div></div>;

  const empty = m != null && m.order.length === 0;
  const counts = (scope: GraphWord[]) => ({
    learned: scope.filter((w) => w.state === "learned").length,
    learning: scope.filter((w) => w.state === "learning").length,
    new: scope.filter((w) => w.state === "new").length,
  });
  const oneBook = m?.bookMode ? m.data.books[0] ?? null : null;
  const caption = (() => {
    if (!m || freshId == null) return null;
    const w = m.byId.get(freshId)!;
    const before = (m.synOf.get(freshId) ?? [])
      .map((o) => m.byId.get(o)!)
      .filter((o) => o && !o.ghost && shown?.has(o.id) && (m.orderIndex.get(o.id) ?? 0) < (m.orderIndex.get(w.id) ?? 0))
      .map((o) => o.word);
    return { w, before };
  })();
  const n = m?.order.length ?? 0;
  const ghostCount = m?.ghosts.length ?? 0;

  const card = (w: GraphWord, side: boolean) => {
    const same = (m!.synOf.get(w.id) ?? []).map((o) => m!.byId.get(o)!).filter(Boolean);
    const meaning = w.meaning ?? (extra?.id === w.id ? extra.meaning : null);
    const ipa = extra?.id === w.id ? extra.ipa : null;
    const split = w.sentence ? gv.splitAtWord(w.sentence, w.word) : null;
    const inLibrary = libraryBook(w) != null && !!w.cfi;
    const [c1, c2] = paletteOf(w.bookTitle ?? "", w.bookAuthor);
    return (
      <div className={`gcard ${side ? "side" : "float"}`} role="dialog" aria-label={w.word}>
        <div className="ch">
          <div className="cwb">
            <div className="cw">{w.word}</div>
            {ipa && <div className="cpr">{ipa}</div>}
          </div>
          <span className="tag">
            <Dot state={w.state} />
            {gv.STATE_NAME[w.state]}
          </span>
          {!playing && (
            <button type="button" className="x" aria-label="Close" title="Close (Esc)" onClick={() => setSel(null)}>
              <i className="ms">close</i>
            </button>
          )}
        </div>
        <div className="cbody">
          {meaning && <p className="cmean">{meaning}</p>}
          {w.sentence && (
            <p className="cq">
              {split ? (
                <>
                  {split[0]}
                  <b>{split[1]}</b>
                  {split[2]}
                </>
              ) : (
                w.sentence
              )}
            </p>
          )}
          <div className="cmeta">
            <span className="mini" style={{ background: `linear-gradient(160deg, ${c1}, ${c2})` }} />
            <span>
              {[w.bookTitle, w.pageLabel ? `p. ${w.pageLabel}` : null, `saved ${gv.dayMonth(w.createdAt)}`].filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="cnums">
            <div>
              <b>{w.reviews}</b>
              {w.reviews === 1 ? "review" : "reviews"}
            </div>
            <div>
              <b>{w.lookedBack}</b>looked back
            </div>
            <div>
              <b>{same.length}</b>same meaning
            </div>
          </div>
          <small className="crev">{gv.reviewsLine(w)}</small>
          <div className="csh">
            <Zig />
            Same meaning
          </div>
          {same.length ? (
            <div className="cchips">
              {same.map((o) => (
                <button key={o.id} type="button" className="cchip" title={o.bookTitle ? `${o.word}, from ${o.bookTitle}` : o.word} onClick={() => pick(o.id)}>
                  <Dot state={o.state} />
                  <span className="cs">{o.word}</span>
                  {o.bookKey !== w.bookKey && o.bookTitle && <span className="cbk">{o.bookTitle}</span>}
                </button>
              ))}
            </div>
          ) : (
            <p className="none">None yet. When you save a word that means the same, the two are joined here.</p>
          )}
        </div>
        <div className="cact">
          <button
            type="button"
            className="pill fill"
            disabled={!inLibrary}
            title={inLibrary ? "Open the book at this sentence" : "Its book isn't in your library on this PC"}
            onClick={() => p.onOpen(w)}
          >
            <i className="ms">menu_book</i>Open in book
          </button>
          <button type="button" className="pill tone" onClick={() => p.onReview(w)}>
            <i className="ms">style</i>Review
          </button>
        </div>
      </div>
    );
  };

  const summary = () => {
    if (!m || !oneBook) return null;
    const c = counts(m.order);
    const lb = libraryBook(oneBook);
    return (
      <div className="gcard side sum">
        <div className="sumh">
          {lb ? (
            <Cover book={lb} size="m" progress={false} />
          ) : (
            <span className="sumcv" style={{ background: `linear-gradient(160deg, ${paletteOf(oneBook.title, oneBook.author)[0]}, ${paletteOf(oneBook.title, oneBook.author)[1]})` }} />
          )}
          <div className="sumt">
            <b>{oneBook.title}</b>
            <small>{[oneBook.author, `${n} ${n === 1 ? "word" : "words"} saved`].filter(Boolean).join(" · ")}</small>
          </div>
        </div>
        <div className="srows">
          {(["learned", "learning", "new"] as gv.WordState[]).map((s) => (
            <div key={s} className="srow">
              <Dot state={s} />
              {gv.STATE_NAME[s]}
              <b>{c[s]}</b>
            </div>
          ))}
        </div>
        <p className="tip">Hover a word to light up the words that mean the same. Click it for its meaning and sentence. Play the links to watch them meet, in the order you saved them.</p>
      </div>
    );
  };

  const desc = m ? `Graph of ${m.order.length} words from ${m.bookMode ? oneBook?.title ?? "one book" : `${m.data.books.length} ${m.data.books.length === 1 ? "book" : "books"}`}` : "Graph of your words";

  return (
    <div className={`wg ${m?.bookMode ? "book" : ""}`}>
      <div className={`wgpanel ${hov != null || hovBook ? "point" : ""} ${dragging ? "grabbing" : ""}`} ref={panel}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={desc}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            setHov(null);
            setHovBook(null);
          }}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
        />
        {!m && (
          <div className="wgwait">
            <Spinner />
          </div>
        )}
        {empty && (
          <div className="wgempty">
            <i className="ms">hub</i>
            <b>Your words, as a graph</b>
            <p>
              Double-click a word while you read, or select it and press <kbd>L</kbd>, then Save to My words. Each word you save joins its book here, and words
              that mean the same are linked, across books too.
            </p>
          </div>
        )}
        {m && !empty && (
          <>
            <div className="gctl gtl">
              {m.bookMode && (
                <button type="button" className="pill glass" onClick={p.onAllBooks} title="Every book's words">
                  <i className="ms">hub</i>All books
                </button>
              )}
              {m.bookMode && ghostCount > 0 && !active && (
                <button
                  type="button"
                  className={`pill glass ${ghostsOn ? "on" : ""}`}
                  aria-pressed={ghostsOn}
                  title="Words from other books that mean the same"
                  onClick={() => setGhostsOn(!ghostsOn)}
                >
                  Other books
                </button>
              )}
              {!active && (
                <div className="gseg" role="radiogroup" aria-label="Show">
                  {FILTERS.map(([f, label]) => (
                    <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                      {f !== "all" && <Dot state={f} />}
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {caption && (
              <div className="gtc" key={caption.w.id}>
                <div className="gcap">
                  <span className="cdt">{gv.dayMonth(caption.w.createdAt)}</span>
                  <span className="cwd">{caption.w.word}</span>
                  {caption.w.bookTitle && <span>from {caption.w.bookTitle}</span>}
                  {caption.before.length > 0 && (
                    <>
                      <Zig />
                      <span>same meaning as {gv.andList(caption.before)}</span>
                    </>
                  )}
                </div>
              </div>
            )}
            {!active && (
              <div className="gctl gbl">
                <div className="gleg">
                  <span>
                    <Dot state="learned" />
                    Learned
                  </span>
                  <span>
                    <Dot state="learning" />
                    Learning
                  </span>
                  <span>
                    <Dot state="new" />
                    New
                  </span>
                  <span>
                    <Zig />
                    Same meaning
                  </span>
                </div>
              </div>
            )}
            <div className="gctl gbr">
              <div className="gplay">
                <button type="button" className="pb" aria-label={playing ? "Pause" : "Play the links"} title={playing ? "Pause" : "Words come in the order you saved them"} onClick={togglePlay}>
                  <i className="ms">{playing ? "pause" : "play_arrow"}</i>
                </button>
                {!active && <span className="pl">Play the links</span>}
                {active && (
                  <>
                    <button
                      type="button"
                      className="ptrack"
                      aria-label="Timeline: click to jump"
                      title="Click to jump"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        freshAt.current = performance.now();
                        setSel(null);
                        setPlayIndex(gv.seekIndex((e.clientX - r.left) / r.width, n));
                      }}
                    >
                      {m.ticks.map((t) => (
                        <b key={t} style={{ left: `${(t / Math.max(1, n)) * 100}%` }} />
                      ))}
                      <i style={{ width: `${((playIndex ?? 0) / Math.max(1, n)) * 100}%` }} />
                    </button>
                    <span className="pl num">{gv.playLine(playIndex, n)}</span>
                    <button type="button" className="spd" aria-label={`Speed ${speed} times`} title="Speed" onClick={() => setSpeed(gv.nextSpeed(speed))}>
                      {speed}×
                    </button>
                  </>
                )}
              </div>
              <div className="gz">
                <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.5)}>
                  <i className="ms">zoom_out</i>
                </button>
                <span className="lv">{zoomPct}%</span>
                <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.5)}>
                  <i className="ms">zoom_in</i>
                </button>
                <button type="button" aria-label="Show everything" title="Show everything" onClick={showAll}>
                  <i className="ms">fit_screen</i>
                </button>
              </div>
            </div>
            {!m.bookMode && selWord && card(selWord, false)}
          </>
        )}
      </div>
      {m?.bookMode && !empty && (cardWord ? card(cardWord, true) : summary())}
    </div>
  );
}
