// npm test: Share as an image's arithmetic (src/lib/quotecard.ts): the crop that fills the card, the quote set
// as large as fits, the file name, the cover's colours. The rules are Katana's on Android 1.2.5.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as qc from "../../src/lib/quotecard.ts";

test("a picture fills the card from its centre, as large as fits", () => {
  // a wide photo on a square card: its middle square
  assert.deepEqual(qc.fillCrop(4000, 3000, 1080, 1080), { x: 500, y: 0, w: 3000, h: 3000 });
  // a cover (2:3) on a tall card (4:5): its full width, cut top and bottom
  assert.deepEqual(qc.fillCrop(600, 900, 1080, 1350), { x: 0, y: 75, w: 600, h: 750 });
  // a small picture is stretched, never cropped to nothing
  const c = qc.fillCrop(10, 10, 1080, 1350);
  assert.equal(c.h, 10);
  assert.equal(c.w, 8);
  assert.ok(c.w >= 1 && c.h >= 1);
});

test("the card's sizes are the 440-point design's, at 1080 wide", () => {
  assert.equal(qc.cardHeight("square"), 1080);
  assert.equal(qc.cardHeight("tall"), 1350);
  assert.equal(Math.round(qc.CARD_WIDTH * qc.CARD.side), 98);
  assert.equal(Math.round(qc.CARD_WIDTH * qc.CARD.quoteMax), 83);
  assert.equal(Math.round(qc.CARD_WIDTH * qc.CARD.quoteMin), 44);
  // Android's three radius-3 box blurs at 1/8 come to a sigma of about 3.5
  assert.ok(Math.abs(qc.BLUR_SIGMA - 3.464) < 0.01);
});

// a face where every character is half its size wide, and ascent + descent = 1.2
const m = { ascent: 0.95, descent: 0.25 };
const measure = (s, size) => [...s].length * size * 0.5;

test("a short quote is set at the largest size", () => {
  const f = qc.fitQuote("I hope Mr. Bingley will like it, Lizzy.", 1080, 884, 500, m, measure);
  assert.ok(Math.abs(f.size - (1080 * 34) / 440) < 1e-9);
  assert.ok(f.height <= 500);
  assert.equal(f.lines.join(" "), "I hope Mr. Bingley will like it, Lizzy.");
  assert.ok(Math.abs(f.lineHeight - 1.2 * f.size * 1.25) < 1e-9);
});

test("a longer quote steps down until it fits, never under 18 points", () => {
  const long = "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. ".repeat(3);
  const f = qc.fitQuote(long, 1080, 884, 600, m, measure);
  assert.ok(f.size < (1080 * 34) / 440);
  assert.ok(f.size >= (1080 * 18) / 440 - 1e-6);
  assert.ok(f.height <= 600);
  for (const l of f.lines) assert.ok(measure(l, f.size) <= 884, l);
  // one size larger would not have fitted
  const up = f.size + 1080 / 440;
  const lines = qc.wrapLines(qc.quoteBody(long), 884, (s) => measure(s, up));
  assert.ok((lines.length - 1) * 1.2 * up * 1.25 + 1.2 * up > 600);
});

test("a quote too long even at 18 points is cut, the last line ending in …", () => {
  const long = "word ".repeat(2000);
  const f = qc.fitQuote(long, 1080, 884, 400, m, measure);
  assert.ok(Math.abs(f.size - (1080 * 18) / 440) < 1e-6);
  assert.ok(f.height <= 400 + 1e-6);
  assert.ok(f.lines.at(-1).endsWith("…"));
  assert.ok(measure(f.lines.at(-1), f.size) <= 884);
});

test("lines wrap at spaces, keep the quote's own breaks, and break a word too long for a line", () => {
  const w = (s) => s.length;
  assert.deepEqual(qc.wrapLines("aa bb cc", 5, w), ["aa bb", "cc"]);
  assert.deepEqual(qc.wrapLines("aa\n\nbb", 5, w), ["aa", "", "bb"]);
  assert.deepEqual(qc.wrapLines("abcdefghij", 4, w), ["abcd", "efgh", "ij"]);
  // Japanese has no spaces: it wraps between characters
  assert.deepEqual(qc.wrapLines("吾輩は猫である", 3, w), ["吾輩は", "猫であ", "る"]);
});

test("the quote's spaces are tidied, its paragraphs kept", () => {
  assert.equal(qc.quoteBody("  a   b \n\n\n\n c  "), "a b\n\nc");
  assert.equal(qc.oneLine(" Jane \n Austen "), "Jane Austen");
});

test("a line too long for the footer is cut with …", () => {
  const w = (s) => s.length;
  assert.equal(qc.ellipsize("Pride and Prejudice", 30, w), "Pride and Prejudice");
  assert.equal(qc.ellipsize("Pride and Prejudice", 10, w), "Pride and…");
});

test("the file name is the book's title and the moment, safe on Windows", () => {
  const at = new Date(2026, 10, 24, 21, 4, 33);
  assert.equal(qc.fileName("Pride and Prejudice", at), "Pride and Prejudice 2026-11-24 210433.png");
  assert.equal(qc.fileName('What: "is" <this>?', at), "What is this 2026-11-24 210433.png");
  assert.equal(qc.fileName("  ", at), "Quote 2026-11-24 210433.png");
  assert.equal(qc.fileName("Ends with a dot.", at), "Ends with a dot 2026-11-24 210433.png");
  assert.equal(qc.fileName("x".repeat(100), at), `${"x".repeat(60)} 2026-11-24 210433.png`);
});

/** RGBA pixels: [colour, count] pairs. */
const pixels = (...parts) => {
  const out = [];
  for (const [c, n] of parts) for (let i = 0; i < n; i++) out.push((c >> 16) & 255, (c >> 8) & 255, c & 255, 255);
  return out;
};

test("a cover's two main colours and its accent (Android's coverSwatches)", () => {
  // mostly navy, then cream, and a small coral sun
  const sw = qc.coverSwatches(pixels([0x1b2a4a, 600], [0xefe6d2, 300], [0xe8604c, 60]));
  assert.equal(sw.ambient, 0x1b2a4a);
  assert.equal(sw.ambientSecond, 0xefe6d2);
  assert.equal(sw.accent, 0xe8604c);
  // a grey cover has no accent
  assert.equal(qc.coverSwatches(pixels([0x777777, 100], [0x333333, 50])).accent, null);
  // nothing opaque: no swatches
  assert.equal(qc.coverSwatches([0, 0, 0, 0]), null);
});

test("the Cover colours card: a dark container of the accent, light words on it", () => {
  const sw = { ambient: 0x1b2a4a, ambientSecond: 0xefe6d2, accent: 0xe8604c };
  const dark = qc.coverCardColors(sw, true, 0xb7c7d9);
  const g = qc.parseColor(dark.ground);
  const ink = qc.parseColor(dark.ink);
  assert.ok(qc.contrast(g, ink) >= 7, `${dark.ground} / ${dark.ink}`);
  assert.ok(Math.abs(qc.hslOf(g).l - 0.3) < 0.01);
  // the accent keeps the cover's hue
  assert.ok(Math.abs(qc.hslOf(qc.parseColor(dark.accent)).h - qc.hslOf(0xe8604c).h) < 3);
  const light = qc.coverCardColors(sw, false, 0x405f6b);
  assert.ok(qc.hslOf(qc.parseColor(light.ground)).l > 0.75);
  // no accent on the cover: the theme's
  assert.equal(qc.coverCardColors({ ...sw, accent: null }, true, 0xb7c7d9).accent, "#b7c7d9");
});

test("colours go to HSL and back", () => {
  for (const c of [0x000000, 0xffffff, 0x3f7a82, 0xe8604c, 0x2b2f36]) {
    const back = qc.hslToRgb(qc.hslOf(c));
    for (const [a, b] of [[back >> 16, c >> 16], [(back >> 8) & 255, (c >> 8) & 255], [back & 255, c & 255]]) assert.ok(Math.abs(a - b) <= 1);
  }
  assert.equal(qc.hexOf(0x3f7a82), "#3f7a82");
  assert.equal(qc.parseColor(" #B7C7D9 "), 0xb7c7d9);
  assert.equal(qc.parseColor("#abc"), 0xaabbcc);
});
