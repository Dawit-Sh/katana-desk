// npm test: the share card's picture effects (src/lib/cardeffects.ts), as in
// Universe/projects/katana/2026-11-24-card-effects.md (the same rules as Katana on Android).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fx from "../../src/lib/cardeffects.ts";

const flat = (w, h, r, g, b) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([r, g, b, 255], i * 4);
  return px;
};
const isInk = (px, i, ink) => px[i] === ink[0] && px[i + 1] === ink[1] && px[i + 2] === ink[2];

test("dither turns a mid grey into about half dark and half light ink, nothing else", () => {
  const w = 60;
  const px = flat(w, w, 128, 128, 128);
  fx.dither(px, w, w);
  let dark = 0;
  for (let i = 0; i < px.length; i += 4) {
    assert.ok(isInk(px, i, fx.INK_DARK) || isInk(px, i, fx.INK_LIGHT));
    if (isInk(px, i, fx.INK_DARK)) dark++;
  }
  const share = dark / (w * w);
  assert.ok(share > 0.35 && share < 0.65, `dark share ${share}`);
  // black and white stay solid
  const black = flat(8, 8, 0, 0, 0);
  fx.dither(black, 8, 8);
  assert.ok(isInk(black, 0, fx.INK_DARK) && isInk(black, black.length - 4, fx.INK_DARK));
});

test("halftone: a black cell gets a full dot, a white one none", () => {
  const cell = fx.HALFTONE_CELL;
  const px = new Uint8ClampedArray(cell * 2 * cell * 4);
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell * 2; x++) {
    const v = x < cell ? 0 : 255;
    px.set([v, v, v, 255], (y * cell * 2 + x) * 4);
  }
  const dots = fx.halftoneDots(px, cell * 2, cell);
  assert.equal(dots.length, 1);
  assert.equal(dots[0].r, cell / 2);
  assert.equal(dots[0].x, cell / 2);
});

test("grain is the same every time, keeps grey grey and stays in range", () => {
  const a = flat(40, 40, 200, 100, 50);
  const b = flat(40, 40, 200, 100, 50);
  fx.grain(a);
  fx.grain(b);
  assert.deepEqual(a, b);
  const g = flat(10, 10, 128, 128, 128);
  fx.grain(g);
  for (let i = 0; i < g.length; i += 4) {
    assert.equal(g[i], g[i + 1]);
    assert.ok(Math.abs(g[i] - 128) <= 28);
  }
});

test("mono is grey with a little more contrast; duotone runs from deep blue to sand", () => {
  const m = flat(1, 1, 255, 255, 255);
  fx.mono(m);
  assert.deepEqual([...m.slice(0, 3)], [255, 255, 255]);
  const m2 = flat(1, 1, 100, 100, 100);
  fx.mono(m2);
  assert.equal(m2[0], Math.round((100 - 128) * 1.15 + 128));
  const d0 = flat(1, 1, 0, 0, 0);
  fx.duotone(d0);
  assert.deepEqual([...d0.slice(0, 3)], [...fx.DUO_SHADOW]);
  const d1 = flat(1, 1, 255, 255, 255);
  fx.duotone(d1);
  assert.deepEqual([...d1.slice(0, 3)], [...fx.DUO_HIGHLIGHT]);
});

test("pixel fills each block with its mean colour", () => {
  const w = fx.PIXEL_BLOCK;
  const px = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < w * w; i++) px.set(i % 2 ? [0, 0, 0, 255] : [200, 100, 50, 255], i * 4);
  fx.pixelate(px, w, w);
  for (let i = 0; i < px.length; i += 4) assert.deepEqual([...px.slice(i, i + 3)], [100, 50, 25]);
});

test("the effects are listed in the chips' order, Blur among them", () => {
  assert.deepEqual(fx.EFFECTS.map((e) => e.name), ["None", "Blur", "Dither", "Halftone", "Grain", "Mono", "Duotone", "Pixel"]);
});
