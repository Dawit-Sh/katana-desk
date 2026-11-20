// Where a page book's pages come from: PDF.js (https://github.com/mozilla/pdf.js) draws PDFs in the
// page; DjVu pages (drawn by DjVuLibre in Rust) and comic pages come from the kpage protocol
// (src-tauri/src/pages.rs). The reader (PageReader.tsx) sees one shape for all three.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { fileUrl } from "../lib/api";

/** A run of words on a page, as fractions of the page (top left 0,0): its box and the angle it runs at. */
export type Run = { s: number; e: number; x: number; y: number; w: number; h: number; a: number };
/** A page's words: the text (runs set apart by spaces and line breaks) and where each run sits. */
export type PageText = { str: string; runs: Run[] };
/** Contents: page index from 0, or null when the item points nowhere in this file. */
export type Outline = { title: string; page: number | null; items: Outline[] };

export interface PageSource {
  kind: "pdf" | "djvu" | "comic";
  count: number;
  /** each page's size in CSS px at 100% */
  sizes: { w: number; h: number }[];
  /** whether pages can have words (comics can't) */
  hasText: boolean;
  outline: Outline[];
  /** a PDF's own page labels ("xiv", "12"), when it has them */
  labels: string[] | null;
  /** draws page `i` `cssW` px wide; a canvas or an image */
  draw(i: number, cssW: number, dpr: number, thumb?: boolean): { el: Promise<HTMLCanvasElement | HTMLImageElement>; cancel: () => void };
  text(i: number): Promise<PageText | null>;
  /** sizes found after opening (a PDF's pages are measured in the background) */
  onSizes?: (cb: (sizes: { w: number; h: number }[]) => void) => void;
  close(): void;
}

// ---------- PDF ----------

let pdfjsLib: typeof import("pdfjs-dist") | null = null;
export async function pdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const [lib, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  pdfjsLib = lib;
  return lib;
}

/** Options every PDF opens with: fonts, character maps and decoders from public/pdfjs, ranges read as needed. */
export const pdfOpts = (url: string) => ({
  url,
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
  isEvalSupported: false,
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 262144,
});

const CSS_PER_PT = 96 / 72;

async function pdfOutline(doc: PDFDocumentProxy): Promise<Outline[]> {
  const raw = await doc.getOutline().catch(() => null);
  if (!raw) return [];
  const walk = async (items: typeof raw): Promise<Outline[]> => {
    const out: Outline[] = [];
    for (const it of items) {
      let page: number | null = null;
      try {
        const dest = typeof it.dest === "string" ? await doc.getDestination(it.dest) : it.dest;
        if (Array.isArray(dest) && dest[0] != null) {
          page = typeof dest[0] === "object" ? await doc.getPageIndex(dest[0]) : Number(dest[0]);
        }
      } catch {
        page = null;
      }
      out.push({ title: (it.title ?? "").trim() || "Untitled", page, items: it.items?.length ? await walk(it.items) : [] });
    }
    return out;
  };
  return walk(raw);
}

/** A PDF page's words, from PDF.js's text content, as runs on the page. */
async function pdfText(page: PDFPageProxy, Util: typeof import("pdfjs-dist").Util): Promise<PageText | null> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  let str = "";
  const runs: Run[] = [];
  let prev: { x2: number; y: number; h: number; eol: boolean } | null = null;
  for (const item of tc.items) {
    if (!("str" in item)) continue;
    const t = item.str;
    if (!t) {
      if (item.hasEOL && str && !str.endsWith("\n")) str += "\n";
      continue;
    }
    const tx = Util.transform(vp.transform, item.transform);
    const h = Math.hypot(tx[2], tx[3]);
    if (h <= 0) continue;
    const a = Math.atan2(tx[1], tx[0]);
    const asc = h * 0.85;
    const x = a === 0 ? tx[4] : tx[4] + asc * Math.sin(a);
    const y = a === 0 ? tx[5] - asc : tx[5] - asc * Math.cos(a);
    const w = item.width;
    // set apart from the run before: a line break, or a space across a gap on the same line
    if (prev && str && !/\s$/.test(str) && !/^\s/.test(t)) {
      if (prev.eol) str += "\n";
      else if (Math.abs(y - prev.y) > prev.h * 0.6) str += "\n";
      else if (x - prev.x2 > h * 0.15) str += " ";
    } else if (prev?.eol && str && !str.endsWith("\n")) str += "\n";
    const s = str.length;
    str += t;
    runs.push({ s, e: str.length, x: x / vp.width, y: y / vp.height, w: w / vp.width, h: h / vp.height, a });
    prev = { x2: x + w, y, h, eol: !!item.hasEOL };
  }
  return runs.length ? { str, runs } : null;
}

export async function openPdf(path: string): Promise<PageSource> {
  const lib = await pdfjs();
  const doc = await lib.getDocument(pdfOpts(fileUrl(path))).promise;
  const first = await doc.getPage(1);
  const v1 = first.getViewport({ scale: 1 });
  const count = doc.numPages;
  const sizes = Array.from({ length: count }, () => ({ w: v1.width * CSS_PER_PT, h: v1.height * CSS_PER_PT }));
  const pages = new Map<number, Promise<PDFPageProxy>>([[0, Promise.resolve(first)]]);
  const getPage = (i: number) => {
    let p = pages.get(i);
    if (!p) {
      p = doc.getPage(i + 1);
      pages.set(i, p);
    }
    return p;
  };
  const [outline, labels] = await Promise.all([pdfOutline(doc), doc.getPageLabels().catch(() => null)]);
  const texts = new Map<number, Promise<PageText | null>>();
  let closed = false;
  const sizesCb: { f: ((s: { w: number; h: number }[]) => void) | null } = { f: null };
  // every page's size, measured in the background: most PDFs have one size, some don't
  (async () => {
    const out = sizes.slice();
    let differs = false;
    for (let i = 1; i < count && !closed; i += 40) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(40, count - i) }, (_, k) => doc.getPage(i + k + 1).then((p) => p.getViewport({ scale: 1 })).catch(() => null)),
      );
      batch.forEach((v, k) => {
        if (!v) return;
        const s = { w: v.width * CSS_PER_PT, h: v.height * CSS_PER_PT };
        if (Math.abs(s.w - out[i + k].w) > 0.5 || Math.abs(s.h - out[i + k].h) > 0.5) differs = true;
        out[i + k] = s;
      });
    }
    if (differs && !closed) sizesCb.f?.(out);
  })();
  return {
    kind: "pdf",
    count,
    sizes,
    hasText: true,
    outline,
    labels: labels && labels.some((l, i) => l && l !== String(i + 1)) ? labels : null,
    onSizes: (cb) => (sizesCb.f = cb),
    draw(i, cssW, dpr) {
      let task: { cancel: () => void; promise: Promise<void> } | null = null;
      let cancelled = false;
      const el = (async () => {
        const page = await getPage(i);
        if (cancelled) throw new Error("cancelled");
        const base = page.getViewport({ scale: 1 });
        const scale = (cssW / base.width) * dpr;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(vp.width));
        canvas.height = Math.max(1, Math.floor(vp.height));
        const ctx = canvas.getContext("2d", { alpha: false })!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        task = page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<PDFPageProxy["render"]>[0]);
        await task.promise;
        return canvas;
      })();
      return {
        el,
        cancel: () => {
          cancelled = true;
          try {
            task?.cancel();
          } catch {
            /* done already */
          }
        },
      };
    },
    text(i) {
      let t = texts.get(i);
      if (!t) {
        t = getPage(i)
          .then((p) => pdfText(p, lib.Util))
          .catch(() => null);
        texts.set(i, t);
      }
      return t;
    },
    close() {
      closed = true;
      doc.destroy().catch(() => {});
    },
  };
}

// ---------- DjVu and comics (Rust, the kpage protocol) ----------

type PageBook = { kind: "djvu" | "comic"; sizes: [number, number][]; outline: { t: string; p: number; c: unknown[] }[] };
type DjvuText = { w: number; h: number; r: number; text: string; words: number[] };

const kpageBase = () => convertFileSrc("", "kpage");

/** Byte offsets in UTF-8 to string indices. */
function byteIndex(str: string): (b: number) => number {
  const map: number[] = [];
  let b = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i)!;
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    for (let k = 0; k < n; k++) map[b + k] = i;
    b += n;
    if (c >= 0x10000) i++;
  }
  map[b] = str.length;
  return (x) => map[x] ?? str.length;
}

function djvuRuns(t: DjvuText): PageText | null {
  const at = byteIndex(t.text);
  const runs: Run[] = [];
  const turn = (fu: number, fv: number): [number, number] =>
    t.r === 1 ? [fv, 1 - fu] : t.r === 2 ? [1 - fu, 1 - fv] : t.r === 3 ? [1 - fv, fu] : [fu, fv];
  for (let k = 0; k + 6 < t.words.length; k += 7) {
    const [, s, e, x0, y0, x1, y1] = t.words.slice(k, k + 7);
    // pixels from the stored page's bottom left: to fractions from its top left, then the page's own turn
    const a = turn(x0 / t.w, 1 - y1 / t.h);
    const b = turn(x1 / t.w, 1 - y0 / t.h);
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    runs.push({ s: at(s), e: at(e), x, y, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), a: 0 });
  }
  return runs.length ? { str: t.text, runs } : null;
}

const toOutline = (items: PageBook["outline"]): Outline[] =>
  items.map((x) => ({ title: x.t || "Untitled", page: x.p >= 0 ? x.p : null, items: toOutline((x.c ?? []) as PageBook["outline"]) }));

export async function openKpage(bookId: number): Promise<PageSource> {
  const b = await invoke<PageBook>("page_book", { id: bookId });
  const djvu = b.kind === "djvu";
  // DjVu: pixels at the page's dpi; shown at 100% they'd be huge, so a page is laid out as a printed page
  // (its dpi read as 150, a comfortable reading size); comics: the picture's own size, 2:3 until it loads
  const sizes = b.sizes.map(([w, h]) => (w > 0 && h > 0 ? (djvu ? { w: (w * 96) / 300, h: (h * 96) / 300 } : { w, h }) : { w: 1000, h: 1500 }));
  const texts = new Map<number, Promise<PageText | null>>();
  const base = kpageBase();
  return {
    kind: djvu ? "djvu" : "comic",
    count: b.sizes.length,
    sizes,
    hasText: djvu,
    outline: toOutline(b.outline),
    labels: null,
    draw(i, cssW, dpr, thumb) {
      // drawn widths come in steps, so a small zoom change reuses what's drawn
      const px = Math.max(100, Math.ceil((cssW * dpr) / 160) * 160);
      const img = new Image();
      img.decoding = "async";
      img.draggable = false;
      let cancelled = false;
      const el = new Promise<HTMLImageElement>((resolve, reject) => {
        img.onload = () => (cancelled ? reject(new Error("cancelled")) : resolve(img));
        img.onerror = () => reject(new Error("This page couldn't be drawn."));
        img.src = `${base}${bookId}/${i}?w=${djvu ? px : 0}${thumb ? "&t=1" : ""}`;
      });
      return {
        el,
        cancel: () => {
          cancelled = true;
          if (!img.complete) img.src = "";
        },
      };
    },
    text(i) {
      if (!djvu) return Promise.resolve(null);
      let t = texts.get(i);
      if (!t) {
        t = invoke<DjvuText | null>("djvu_text", { id: bookId, page: i })
          .then((x) => (x ? djvuRuns(x) : null))
          .catch(() => null);
        texts.set(i, t);
      }
      return t;
    },
    close() {
      invoke("page_book_closed", { id: bookId }).catch(() => {});
    },
  };
}

export async function openPageSource(bookId: number, format: string, path: string): Promise<PageSource> {
  return format === "pdf" ? openPdf(path) : openKpage(bookId);
}

/** Page books: read in the page view instead of foliate-js. */
export const PAGE_FORMATS = new Set(["pdf", "djvu", "cbz", "cbr"]);

// ---------- places ----------

/** A page's place: `page:12` (pages from 1, as Grimmory counts them). */
export const pagePlace = (page: number) => `page:${page + 1}`;
/** Words on a page: `page:12:340-388` (from and to in the page's text). */
export const wordsPlace = (page: number, s: number, e: number) => `page:${page + 1}:${s}-${e}`;
/** A place's page index (from 0), and its words' range, or null for what isn't a page place. */
export function parsePlace(p: string | null | undefined): { page: number; s: number | null; e: number | null } | null {
  const m = /^page:(\d+)(?::(\d+)-(\d+))?$/.exec(p ?? "");
  if (!m) return null;
  return { page: Number(m[1]) - 1, s: m[2] != null ? Number(m[2]) : null, e: m[3] != null ? Number(m[3]) : null };
}
