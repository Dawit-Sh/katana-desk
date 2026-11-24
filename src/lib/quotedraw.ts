// Share as an image, drawing: the quote card on a canvas at its full size (1080 wide), the way Katana 1.2.5
// draws it on Android (QuoteCard.kt, QuoteCardBackdrop.kt). The arithmetic is in quotecard.ts.
import { loadUiFonts } from "../reader/prefs";
import { DITHER_SCALE, INK_DARK, INK_LIGHT, dither, duotone, grain, halftoneDots, mono, pixelate, type Effect } from "./cardeffects";
import {
  BACKDROP,
  BLUR_SIGMA,
  CARD,
  CARD_WIDTH,
  cardHeight,
  coverSwatches,
  ellipsize,
  fillCrop,
  fitQuote,
  oneLine,
  quoteBody,
  type CardColors,
  type CardShape,
  type Swatches,
} from "./quotecard";

/** Literata for the quote and its mark; the app's own face (Manrope) for the captions. */
const QUOTE_FACE = '"Literata Variable", Literata, Georgia, serif';
const UI_FACE = '"Manrope Variable", Manrope, "Segoe UI", sans-serif';
/** 刀 isn't in Manrope: a Japanese face draws it. */
const KANJI_FACE = '"Yu Gothic UI", "Yu Gothic", Meiryo, "Microsoft YaHei UI", sans-serif';
const BRAND = "Katana";
const KANJI = "刀";

export type CardText = { quote: string; title: string; author: string | null };
/** A picture behind the quote: the book's cover or your own, filling the card, with an effect (Blur, Dither…). */
export type Backdrop = { image: ImageBitmap; effect: Effect };

/**
 * Loads the card's faces for these words. True when Literata's italic is there (it always is, it ships
 * with the app; false only if the font file couldn't be read, and the card then falls back to Georgia).
 */
export async function cardFontsReady(t: CardText) {
  loadUiFonts();
  const words = `${t.title} ${t.author ?? ""} ${BRAND}`;
  await Promise.all([
    document.fonts.load(`italic 400 80px ${QUOTE_FACE}`, t.quote || "a"),
    document.fonts.load(`700 80px ${QUOTE_FACE}`, "“"),
    document.fonts.load(`700 40px ${UI_FACE}`, words),
    document.fonts.load(`400 40px ${UI_FACE}`, words),
    document.fonts.load(`700 40px ${KANJI_FACE}`, KANJI),
  ]).catch(() => {});
  return document.fonts.check('italic 400 80px "Literata Variable"', "a");
}

const canvasOf = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/** The picture's crop at 1/8 of the card, softened: Android's three box-blur passes, as one Gaussian. */
function softened(image: ImageBitmap, w: number, h: number) {
  const sw = Math.max(1, Math.floor(w / BACKDROP.blurScale));
  const sh = Math.max(1, Math.floor(h / BACKDROP.blurScale));
  const crop = fillCrop(image.width, image.height, w, h);
  const small = canvasOf(sw, sh);
  const sc = small.getContext("2d")!;
  sc.imageSmoothingQuality = "high";
  sc.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, sw, sh);
  // the edges carried outwards first, so the blur doesn't darken them (Android's blur repeats the edge)
  const p = Math.ceil(BLUR_SIGMA * 3);
  const padded = canvasOf(sw + 2 * p, sh + 2 * p);
  const pc = padded.getContext("2d")!;
  pc.imageSmoothingEnabled = false;
  pc.drawImage(small, p, p);
  pc.drawImage(small, 0, 0, 1, sh, 0, p, p, sh);
  pc.drawImage(small, sw - 1, 0, 1, sh, p + sw, p, p, sh);
  pc.drawImage(small, 0, 0, sw, 1, p, 0, sw, p);
  pc.drawImage(small, 0, sh - 1, sw, 1, p, p + sh, sw, p);
  pc.drawImage(small, 0, 0, 1, 1, 0, 0, p, p);
  pc.drawImage(small, sw - 1, 0, 1, 1, p + sw, 0, p, p);
  pc.drawImage(small, 0, sh - 1, 1, 1, 0, p + sh, p, p);
  pc.drawImage(small, sw - 1, sh - 1, 1, 1, p + sw, p + sh, p, p);
  const out = canvasOf(sw, sh);
  const oc = out.getContext("2d")!;
  oc.filter = `blur(${BLUR_SIGMA}px)`;
  oc.drawImage(padded, -p, -p);
  return out;
}

/** The picture cropped to fill a `w` × `h` canvas (smoothed), and its pixels. */
function cropped(image: ImageBitmap, w: number, h: number) {
  const out = canvasOf(w, h);
  const oc = out.getContext("2d", { willReadFrequently: true })!;
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = "high";
  const c = fillCrop(image.width, image.height, w, h);
  oc.drawImage(image, c.x, c.y, c.w, c.h, 0, 0, w, h);
  return { out, oc, data: oc.getImageData(0, 0, w, h) };
}

const rgb = (c: readonly number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/** The picture with its effect, at the card's size (see cardeffects.ts and the shared spec). */
function withEffect(image: ImageBitmap, effect: Effect, w: number, h: number): HTMLCanvasElement {
  if (effect === "blur") return softened(image, w, h);
  if (effect === "dither") {
    const sw = Math.max(1, Math.round(w / DITHER_SCALE));
    const sh = Math.max(1, Math.round(h / DITHER_SCALE));
    const small = cropped(image, sw, sh);
    dither(small.data.data, sw, sh);
    small.oc.putImageData(small.data, 0, 0);
    const out = canvasOf(w, h);
    const oc = out.getContext("2d")!;
    oc.imageSmoothingEnabled = false;
    oc.drawImage(small.out, 0, 0, w, h);
    return out;
  }
  const full = cropped(image, w, h);
  if (effect === "halftone") {
    const dots = halftoneDots(full.data.data, w, h);
    full.oc.fillStyle = rgb(INK_LIGHT);
    full.oc.fillRect(0, 0, w, h);
    full.oc.fillStyle = rgb(INK_DARK);
    full.oc.beginPath();
    for (const d of dots) {
      full.oc.moveTo(d.x + d.r, d.y);
      full.oc.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    }
    full.oc.fill();
    return full.out;
  }
  if (effect === "grain") grain(full.data.data);
  else if (effect === "mono") mono(full.data.data);
  else if (effect === "duotone") duotone(full.data.data);
  else if (effect === "pixel") pixelate(full.data.data, w, h);
  if (effect !== "none") full.oc.putImageData(full.data, 0, 0);
  return full.out;
}

const effectCache = new WeakMap<ImageBitmap, Map<string, HTMLCanvasElement>>();
function withEffectOnce(image: ImageBitmap, effect: Effect, w: number, h: number) {
  let m = effectCache.get(image);
  if (!m) effectCache.set(image, (m = new Map()));
  const k = `${effect} ${w}x${h}`;
  let c = m.get(k);
  if (!c) m.set(k, (c = withEffect(image, effect, w, h)));
  return c;
}

/** The picture cropped to fill the card, with its effect, then darkened so white text reads. */
function drawBackdrop(ctx: CanvasRenderingContext2D, b: Backdrop, w: number, h: number) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(withEffectOnce(b.image, b.effect, w, h), 0, 0, w, h);
  // None keeps today's sharp darkening (a cover's own title can show through); every effect the softer one
  const sharp = b.effect === "none";
  ctx.fillStyle = `rgba(0, 0, 0, ${sharp ? BACKDROP.scrimSharp : BACKDROP.scrimBlurred})`;
  ctx.fillRect(0, 0, w, h);
  // deeper at the foot, where the book line sits; deepest on a sharp picture, where a cover's own title often is
  const top = h * BACKDROP.footStart;
  const g = ctx.createLinearGradient(0, top, 0, h);
  g.addColorStop(0, "rgba(0, 0, 0, 0)");
  g.addColorStop(1, `rgba(0, 0, 0, ${sharp ? BACKDROP.footSharp : BACKDROP.footBlurred})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, top, w, h - top);
}

/**
 * Draws the card on `canvas` (sized to the shape): a quote mark in the accent, the quote in Literata italic
 * as large as fits, then the book and its author on the left and 刀 Katana on the right.
 */
export function drawCard(canvas: HTMLCanvasElement, t: CardText, colors: CardColors, shape: CardShape, backdrop: Backdrop | null) {
  const W = CARD_WIDTH;
  const H = cardHeight(shape);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = colors.ground;
  ctx.fillRect(0, 0, W, H);
  if (backdrop) drawBackdrop(ctx, backdrop, W, H);

  // over a picture every line gets a soft shadow, so it reads on light patches too (Android's shadow
  // radius r is a blur of sigma r / sqrt(3) + 0.5; a canvas's shadowBlur is twice the sigma)
  const r = backdrop ? W * CARD.shadow : 0;
  ctx.shadowColor = r ? CARD.shadowColor : "transparent";
  ctx.shadowBlur = r ? 2 * (r * 0.57735 + 0.5) : 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = r / 2;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  let face = "";
  const setFont = (font: string) => {
    if (font !== face) ctx.font = face = font;
  };
  const use = (font: string, color: string) => {
    setFont(font);
    ctx.fillStyle = color;
  };
  const metrics = (font: string) => {
    setFont(font);
    const m = ctx.measureText("Hg");
    return { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
  };
  const width = (s: string) => ctx.measureText(s).width;

  const side = W * CARD.side;
  const top = W * CARD.top;
  const textWidth = W - side * 2;

  // the quote mark
  const markFont = `700 ${W * CARD.mark}px ${QUOTE_FACE}`;
  const mm = metrics(markFont);
  const markTop = top + mm.ascent * CARD.markTopTrim;
  use(markFont, colors.accent);
  ctx.fillText("“", side, markTop);

  // the footer, bottom up: the author, the title, and the mark on the right
  const captionSize = W * CARD.caption;
  const titleFont = `700 ${W * CARD.title}px ${UI_FACE}`;
  const authorFont = `400 ${captionSize}px ${UI_FACE}`;
  const brandFont = `700 ${captionSize}px ${UI_FACE}`;
  const kanjiFont = `700 ${W * CARD.kanji}px ${KANJI_FACE}`;
  const baseline = H - W * CARD.bottom;
  use(brandFont, colors.accent);
  const brandW = width(BRAND);
  use(kanjiFont, colors.accent);
  const kanjiW = width(KANJI);
  const gap = W * CARD.brandGap;
  const brandWidth = brandW + kanjiW + gap;
  const footerTextWidth = Math.max(1, textWidth - brandWidth - gap);
  const am = metrics(authorFont);
  const tm = metrics(titleFont);
  let footerTop = baseline + am.descent;
  const author = t.author?.trim() ? oneLine(t.author) : "";
  if (author) {
    use(authorFont, colors.secondary);
    ctx.fillText(ellipsize(author, footerTextWidth, width), side, baseline);
    footerTop = baseline - am.ascent;
  }
  const titleBaseline = author ? footerTop - tm.descent - W * CARD.lineGap : baseline;
  use(titleFont, colors.ink);
  ctx.fillText(ellipsize(oneLine(t.title), footerTextWidth, width), side, titleBaseline);
  footerTop = titleBaseline - tm.ascent;
  const brandX = W - side - brandWidth;
  use(kanjiFont, colors.accent);
  ctx.fillText(KANJI, brandX, baseline);
  use(brandFont, colors.accent);
  ctx.fillText(BRAND, brandX + kanjiW + gap, baseline);

  // the quote, as large as fits between the mark and the footer
  const quoteTop = markTop + mm.descent + W * CARD.quoteGap;
  const roomH = footerTop - W * CARD.quoteGap - quoteTop;
  const at100 = metrics(`italic 400 100px ${QUOTE_FACE}`);
  const quoteFont = (size: number) => `italic 400 ${size}px ${QUOTE_FACE}`;
  const fitted = fitQuote(quoteBody(t.quote), W, textWidth, roomH, { ascent: at100.ascent / 100, descent: at100.descent / 100 }, (s, size) => {
    setFont(quoteFont(size));
    return width(s);
  });
  use(quoteFont(fitted.size), colors.ink);
  fitted.lines.forEach((line, i) => ctx.fillText(line, side, quoteTop + fitted.ascent + i * fitted.lineHeight));
  ctx.restore();
  return fitted;
}

/** The card as a PNG. */
export const cardPng = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("The image couldn't be made."))), "image/png"));

/** A cover picture's colours: read from a small copy, 60 x 90 like Android's. */
export function swatchesOfImage(image: ImageBitmap): Swatches | null {
  const c = canvasOf(60, 90);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, 60, 90);
  return coverSwatches(ctx.getImageData(0, 0, 60, 90).data);
}

/** A drawn cover's colours (a book with no cover picture): its gradient, read the same way. */
export function swatchesOfDrawn(from: string, to: string): Swatches | null {
  const c = canvasOf(60, 90);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  // CSS's 160deg across a 60 x 90 box
  const a = (160 * Math.PI) / 180;
  const len = Math.abs(60 * Math.sin(a)) + Math.abs(90 * Math.cos(a));
  const dx = (Math.sin(a) * len) / 2;
  const dy = (-Math.cos(a) * len) / 2;
  const g = ctx.createLinearGradient(30 - dx, 45 - dy, 30 + dx, 45 + dy);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 60, 90);
  return coverSwatches(ctx.getImageData(0, 0, 60, 90).data);
}

/** A picture's bytes as an image the canvas can draw, the right way up (a photo's EXIF rotation applied). */
export async function decodePicture(bytes: ArrayBuffer | Blob) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That isn't a picture Katana Desk can read.");
  }
}
