// Share as an image, the parts that are plain arithmetic: the card's proportions and colours, the crop that
// fills it with a picture, the quote set as large as fits, the cover's colours and the file name.
// No imports, so `npm test` (Node's own test runner) checks them without the app (tools/tests/).
// The rules are Katana's on Android 1.2.5 (QuoteCard.kt, QuoteCardBackdrop.kt, QuoteShareDialog.kt,
// QuoteImages.kt, LibraryCoverPalette.kt's coverSwatches and AppCoverColors.kt).

/** The card's colours: its ground, the quote, the book line under it and the accent (quote mark, Katana). */
export type CardColors = { ground: string; ink: string; secondary: string; accent: string };

export type CardShape = "square" | "tall";
export const CARD_WIDTH = 1080;
export const cardHeight = (shape: CardShape) => (shape === "tall" ? 1350 : 1080);

/** What the card can stand on: three colours, the book's cover colours, the cover itself, your own picture. */
export type Ground = "paper" | "dusk" | "teal" | "cover" | "coverPicture" | "photo";
export const isPicture = (g: Ground) => g === "coverPicture" || g === "photo";

export const PAPER: CardColors = { ground: "#f3efe4", ink: "#2a2620", secondary: "#6b655a", accent: "#3f7a82" };
export const DUSK: CardColors = { ground: "#2b2f36", ink: "#e8eaed", secondary: "#a9afb7", accent: "#63a7b0" };
export const TEAL: CardColors = { ground: "#2e4e54", ink: "#f4f8f8", secondary: "#c3d9dc", accent: "#a7dde2" };
/** White type over a darkened picture; the ground shows only if the picture can't be drawn. */
export const PICTURE: CardColors = { ground: "#1f1f1f", ink: "#ffffff", secondary: "rgba(255, 255, 255, 0.902)", accent: "#f3efe4" };

// Proportions of the card's width, from the 440-point design.
const P = (n: number) => n / 440;
export const CARD = {
  side: P(40),
  top: P(44),
  bottom: P(34),
  mark: P(72),
  markTopTrim: 0.62,
  quoteGap: P(16),
  quoteMax: P(34),
  quoteMin: P(18),
  quoteStep: P(1),
  quoteLineSpacing: 1.25,
  title: P(16),
  caption: P(14),
  kanji: P(20),
  brandGap: P(6),
  lineGap: P(4),
  shadow: P(3),
  shadowColor: "rgba(0, 0, 0, 0.549)",
} as const;

/** The picture's darkening: all over, then deeper from 60% of the height down to the foot. */
export const BACKDROP = {
  blurScale: 8,
  scrimBlurred: 0x52 / 255,
  scrimSharp: 0x70 / 255,
  footStart: 0.6,
  footBlurred: 0x80 / 255,
  footSharp: 0xc8 / 255,
} as const;

/**
 * The canvas blur (CSS px, a Gaussian's standard deviation) close to Android's: three passes of a radius-3
 * box blur at 1/8 of the card. One pass has a variance of ((2r + 1)² - 1) / 12 = 4, three passes 12.
 */
export const BLUR_SIGMA = Math.sqrt(3 * ((7 * 7 - 1) / 12));

/** The part of a `sw` x `sh` picture that fills a `w` x `h` card: centred, as large as fits. */
export function fillCrop(sw: number, sh: number, w: number, h: number) {
  const scale = Math.max(w / sw, h / sh);
  const cw = Math.min(sw, Math.max(1, Math.round(w / scale)));
  const ch = Math.min(sh, Math.max(1, Math.round(h / scale)));
  const x = Math.floor((sw - cw) / 2);
  const y = Math.floor((sh - ch) / 2);
  return { x, y, w: cw, h: ch };
}

/** Runs of spaces and line breaks made one space. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The quote's words, its line breaks kept but its runs of spaces made single. */
export const quoteBody = (q: string) =>
  q
    .trim()
    .split(/\r?\n/)
    .map(oneLine)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

const pad = (n: number) => String(n).padStart(2, "0");

/** The card's file name: the book's title and the moment (like Windows' own screenshots), safe on any disk. */
export function fileName(title: string, at: Date) {
  const name =
    oneLine(title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " "))
      .slice(0, 60)
      .replace(/[. ]+$/, "") || "Quote";
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${name} ${stamp}.png`;
}

/** `text` cut to fit `width` with "…" at its end (Android's TextUtils.ellipsize, END). */
export function ellipsize(text: string, width: number, measure: (s: string) => number) {
  if (measure(text) <= width) return text;
  const chars = [...text];
  let lo = 0;
  let hi = chars.length;
  // the most characters that still fit with the ellipsis
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join("").trimEnd() + "…") <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join("").trimEnd() + "…" : "";
}

/**
 * The lines `text` breaks into at `width`: its own line breaks kept, words wrapped greedily, a word too long
 * for a line broken between its characters (so a quote with no spaces, Japanese for one, wraps too).
 */
export function wrapLines(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      line = "";
      if (measure(word) <= width) {
        line = word;
        continue;
      }
      // a word wider than the line: as many characters as fit on each line
      let part = "";
      for (const ch of word) {
        if (part && measure(part + ch) > width) {
          out.push(part);
          part = "";
        }
        part += ch;
      }
      line = part;
    }
    out.push(line);
  }
  return out;
}

/** The quote face's metrics per pixel of size (the font's ascent and descent, as a canvas reports them). */
export type FaceMetrics = { ascent: number; descent: number };

export type FittedQuote = {
  /** the font size, in card pixels */
  size: number;
  lines: string[];
  /** from one line's baseline to the next */
  lineHeight: number;
  /** the first baseline below the top of the quote's room */
  ascent: number;
  height: number;
};

/** The layout's height: every line but the last gets the line spacing (Android's StaticLayout). */
const layoutHeight = (n: number, size: number, m: FaceMetrics) =>
  n ? (n - 1) * (m.ascent + m.descent) * size * CARD.quoteLineSpacing + (m.ascent + m.descent) * size : 0;

/**
 * The quote at the largest size, from 34 down to 18 points of a 440-point card, at which it fits a room of
 * `width` x `height`; at the smallest it is cut to the lines that fit, the last ending in "…".
 * `measure(text, size)` is the width of `text` in the quote's face at `size`.
 */
export function fitQuote(
  quote: string,
  cardWidth: number,
  width: number,
  height: number,
  m: FaceMetrics,
  measure: (text: string, size: number) => number,
): FittedQuote {
  const min = cardWidth * CARD.quoteMin;
  const step = cardWidth * CARD.quoteStep;
  const make = (size: number, lines: string[]): FittedQuote => ({
    size,
    lines,
    lineHeight: (m.ascent + m.descent) * size * CARD.quoteLineSpacing,
    ascent: m.ascent * size,
    height: layoutHeight(lines.length, size, m),
  });
  const max = cardWidth * CARD.quoteMax;
  for (let i = 0; ; i++) {
    const size = max - i * step;
    const at = (s: string) => measure(s, size);
    const lines = wrapLines(quote, width, at);
    const h = layoutHeight(lines.length, size, m);
    if (h <= height) return make(size, lines);
    if (size - step < min - 1e-6) {
      // the smallest size: as many lines as fit, the last cut with "…"
      const per = h / lines.length;
      const keep = Math.max(1, Math.floor(height / per));
      const shown = lines.slice(0, keep);
      if (keep < lines.length) {
        const cut = ellipsize(lines.slice(keep - 1).join(" "), width, at);
        shown[keep - 1] = cut.endsWith("…") ? cut : ellipsize(`${cut.trimEnd()} …`, width, at);
      }
      return make(size, shown);
    }
  }
}

// ---------- the cover's colours (LibraryCoverPalette.kt, AppCoverColors.kt) ----------

export type Swatches = { ambient: number; ambientSecond: number; accent: number | null };
type Hsl = { h: number; s: number; l: number };

export const rgbOf = (c: number) => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff] as const;
export const hexOf = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
export const parseColor = (s: string): number | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim()) ?? /^#?([0-9a-f]{3})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return parseInt(h, 16);
};

export function hslOf(c: number): Hsl {
  const [r, g, b] = rgbOf(c).map((x) => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = Math.min(1, Math.max(0, d / (1 - Math.abs(2 * l - 1))));
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const ch = (v: number) => Math.min(255, Math.max(0, Math.trunc((v + m) * 255)));
  return (ch(r1) << 16) | (ch(g1) << 8) | ch(b1);
}

/**
 * A cover's swatches from its pixels (RGBA, as a canvas gives them): the colours grouped into clusters of
 * near neighbours, the two largest as the ambient pair, and as the accent the most saturated cluster among
 * those neither too dark nor too light, weighted by its share of the cover. Null when no pixel is opaque.
 */
export function coverSwatches(rgba: ArrayLike<number>): Swatches | null {
  const N = 4096;
  const counts = new Int32Array(N);
  const red = new Float64Array(N);
  const green = new Float64Array(N);
  const blue = new Float64Array(N);
  let total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts[k]++;
    red[k] += r;
    green[k] += g;
    blue[k] += b;
    total++;
  }
  if (!total) return null;
  type Cluster = { r: number; g: number; b: number; count: number };
  const dist = (c: Cluster, r: number, g: number, b: number) => (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
  const clusters: Cluster[] = [];
  const buckets = [...counts.keys()].filter((k) => counts[k] > 0).sort((a, b) => counts[b] - counts[a] || a - b);
  for (const k of buckets) {
    const n = counts[k];
    // the bucket's mean, cut to whole numbers as Android's Long division does
    const r = Math.trunc(red[k] / n);
    const g = Math.trunc(green[k] / n);
    const b = Math.trunc(blue[k] / n);
    let near = clusters.find((c) => dist(c, r, g, b) <= 40 * 40);
    if (!near && clusters.length >= 16) near = clusters.reduce((a, c) => (dist(c, r, g, b) < dist(a, r, g, b) ? c : a));
    if (near) {
      const sum = near.count + n;
      near.r = (near.r * near.count + r * n) / sum;
      near.g = (near.g * near.count + g * n) / sum;
      near.b = (near.b * near.count + b * n) / sum;
      near.count = sum;
    } else clusters.push({ r, g, b, count: n });
  }
  clusters.sort((a, b) => b.count - a.count);
  const argb = (c: Cluster) =>
    (Math.min(255, Math.max(0, Math.trunc(c.r))) << 16) | (Math.min(255, Math.max(0, Math.trunc(c.g))) << 8) | Math.min(255, Math.max(0, Math.trunc(c.b)));
  const ambient = argb(clusters[0]);
  const ambientSecond = clusters[1] ? argb(clusters[1]) : ambient;
  let accent: number | null = null;
  let best = -1;
  for (const c of clusters) {
    if (c.count < total * 0.01) continue;
    const hsl = hslOf(argb(c));
    if (hsl.l < 0.22 || hsl.l > 0.78 || hsl.s < 0.25) continue;
    const score = hsl.s * hsl.s * Math.sqrt(Math.sqrt(c.count / total));
    if (score > best) {
      best = score;
      accent = argb(c);
    }
  }
  return { ambient, ambientSecond, accent };
}

function luminance(c: number) {
  const ch = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(c);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast between two opaque colours. */
export function contrast(a: number, b: number) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `fg` at `alpha` over `bg`. */
const over = (fg: number, alpha: number, bg: number) => {
  const f = rgbOf(fg);
  const g = rgbOf(bg);
  const mix = (i: number) => Math.round(f[i] * alpha + g[i] * (1 - alpha));
  return (mix(0) << 16) | (mix(1) << 8) | mix(2);
};

/**
 * The Cover colours card: Android's reader carries the cover's colours in its theme (the accent and a quiet
 * container of it), and the card takes the container as its ground, the text on it as its ink (72% for the
 * book line) and the accent for the mark. Dark: accent at L 0.75, container at L 0.30. Light: accent at
 * L 0.35, container at L 0.80. A cover with no usable accent takes the theme's (`fallback`).
 */
export function coverCardColors(sw: Swatches, dark: boolean, fallback: number): CardColors {
  const acc = sw.accent != null ? hslOf(sw.accent) : null;
  const accHsl = acc ? { h: acc.h, s: Math.min(acc.s, 0.85), l: dark ? 0.75 : 0.35 } : null;
  const onAcc = accHsl ? (dark ? hslToRgb({ ...accHsl, l: 0.14 }) : 0xffffff) : null;
  const coverAccent = accHsl && onAcc != null && contrast(hslToRgb(accHsl), onAcc) >= 4.5 ? hslToRgb(accHsl) : null;
  const accent = coverAccent ?? fallback;
  const a = hslOf(accent);
  const container = dark ? { h: a.h, s: Math.min(a.s, 0.4), l: 0.3 } : { h: a.h, s: Math.min(a.s, 0.5), l: 0.8 };
  const ground = hslToRgb(container);
  const ink = hslToRgb({ ...container, l: dark ? 0.92 : 0.2 });
  return { ground: hexOf(ground), ink: hexOf(ink), secondary: hexOf(over(ink, 0.72, ground)), accent: hexOf(accent) };
}
