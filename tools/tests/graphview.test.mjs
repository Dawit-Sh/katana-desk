// npm test: the words graph's arithmetic (src/lib/graphview.ts) and where the app opens (src/lib/startpage.ts).
// Node runs the TypeScript files as they are (type stripping, Node 23.6 and later); no packages needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as gv from "../../src/lib/graphview.ts";
import { startPage } from "../../src/lib/startpage.ts";

test("a word is new until reviewed, learned from the week's step, learning in between (Android's rule)", () => {
  assert.equal(gv.wordState({ reviewedAt: null, reviewLevel: 0 }), "new");
  assert.equal(gv.wordState({ reviewedAt: 5, reviewLevel: 1 }), "learning");
  assert.equal(gv.wordState({ reviewedAt: 5, reviewLevel: 3 }), "learned");
  // Again sends it back to 0, but it has been reviewed
  assert.equal(gv.wordState({ reviewedAt: 5, reviewLevel: 0 }), "learning");
});

test("fitting a box fills the area and centres it", () => {
  const box = { left: -100, top: -50, right: 100, bottom: 50 };
  const cam = gv.fit(box, { x: 0, y: 0, w: 400, h: 400 }, 10);
  assert.equal(cam.s, 2);
  assert.equal(cam.tx, 200);
  assert.equal(cam.ty, 200);
  // never closer than the cap
  assert.equal(gv.fit(box, { x: 0, y: 0, w: 4000, h: 4000 }, 1.6).s, 1.6);
});

test("zooming round a point keeps that point still, within the limits", () => {
  const cam = { s: 1, tx: 10, ty: 20 };
  const z = gv.zoomAround(cam, 2, 110, 70, 0.1, 4);
  // the world point under (110, 70) before is still there after
  const wx = (110 - cam.tx) / cam.s;
  assert.equal(wx * z.s + z.tx, 110);
  assert.equal(gv.zoomAround(cam, 100, 0, 0, 0.1, 4).s, 4);
  assert.equal(gv.zoomAround(cam, 0.001, 0, 0, 0.1, 4).s, 0.1);
});

test("a move between two views goes evenly in zoom and lands exactly", () => {
  const a = { s: 1, tx: 0, ty: 0 };
  const b = { s: 4, tx: 100, ty: -40 };
  assert.deepEqual(gv.lerpCam(a, b, 1), b);
  assert.equal(gv.lerpCam(a, b, 0.5).s, 2);
  assert.equal(gv.ease(0), 0);
  assert.equal(gv.ease(1), 1);
});

test("words grow with their links and zoom, but never past 14 px", () => {
  assert.ok(gv.wordRadius(0, false, 0.3) < gv.wordRadius(0, false, 1));
  assert.ok(gv.wordRadius(3, true, 1) > gv.wordRadius(0, true, 1));
  assert.equal(gv.wordRadius(40, true, 1), 14);
  // a book zoomed far out is still a rectangle you can see and click
  assert.ok(gv.bookOnScreen(false, 0.01).w >= 7);
});

test("the zigzag starts and ends on the words, tapers, and draws in part of the way", () => {
  const full = gv.zigzag(0, 0, 100, 0, 3.2, 1);
  assert.deepEqual(full.slice(0, 2), [0, 0]);
  assert.deepEqual(full.slice(-2), [100, 0]);
  const ys = full.filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...ys.map(Math.abs)) <= 3.2 + 1e-9);
  // tapered: the first bend is smaller than the middle one
  assert.ok(Math.abs(ys[1]) < Math.abs(ys[Math.floor(ys.length / 2)]));
  const half = gv.zigzag(0, 0, 100, 0, 3.2, 0.5);
  assert.ok(half.length < full.length);
  assert.ok(half[half.length - 2] < 60);
});

test("the book's curve ends on the word", () => {
  const pts = gv.curvePoints(0, 0, 100, 50, 0.12, 1);
  assert.deepEqual(pts.slice(-2).map((v) => Math.round(v * 1000) / 1000), [100, 50]);
});

test("hovering finds the nearest word within reach", () => {
  const pts = [
    { x: 0, y: 0, r: 4 },
    { x: 30, y: 0, r: 4 },
  ];
  assert.equal(gv.nearest(pts, 26, 1, 12), 1);
  assert.equal(gv.nearest(pts, 200, 200, 12), -1);
});

test("Play: lines draw in first, zigzags after; the timeline jumps to a word; months are marked", () => {
  assert.deepEqual(gv.freshDraw(0), { line: 0, zig: 0 });
  assert.equal(gv.freshDraw(0.3).zig, 0);
  assert.equal(gv.freshDraw(1).line, 1);
  assert.equal(gv.freshDraw(1).zig, 1);
  assert.equal(gv.seekIndex(0, 34), 1);
  assert.equal(gv.seekIndex(0.5, 34), 17);
  assert.equal(gv.seekIndex(1, 34), 34);
  assert.deepEqual(gv.nextSpeed(1), 2);
  assert.deepEqual([1, 2, 4].map(gv.nextSpeed), [2, 4, 1]);
  const t = (m, d) => new Date(2026, m, d).getTime();
  assert.deepEqual(gv.monthTicks([t(7, 3), t(7, 20), t(8, 1), t(10, 2), t(10, 9)]), [2, 3]);
  assert.equal(gv.playLine(null, 34), "Play the links");
  assert.equal(gv.playLine(3, 34), "3 of 34");
});

test("dates, reviews and lists read plainly, no dashes", () => {
  const now = new Date(2026, 10, 22, 12).getTime();
  assert.equal(gv.dayMonth(new Date(2026, 7, 3).getTime(), now), "3 Aug");
  assert.equal(gv.dayMonth(new Date(2025, 7, 3).getTime(), now), "3 Aug 2025");
  assert.equal(gv.reviewsLine({ reviewedAt: null, reviewDueAt: null }, now), "Not reviewed yet");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(gv.reviewsLine({ reviewedAt: now - day, reviewDueAt: now + 7 * day }, now), "Reviewed 21 Nov · next in 7 days");
  assert.ok(gv.reviewsLine({ reviewedAt: now - day, reviewDueAt: now - 1 }, now).endsWith("due now"));
  assert.ok(gv.reviewsLine({ reviewedAt: now - day, reviewDueAt: now + day / 2 }, now).endsWith("next tomorrow"));
  assert.equal(gv.andList(["greedy"]), "greedy");
  assert.equal(gv.andList(["greedy", "covetous", "grasping"]), "greedy, covetous and grasping");
  for (const s of [gv.reviewsLine({ reviewedAt: now, reviewDueAt: now + day }, now), gv.playLine(2, 3), gv.andList(["a", "b"])]) assert.ok(!s.includes("—"));
});

test("the sentence is split round the word standing on its own, any case", () => {
  assert.deepEqual(gv.splitAtWord("A very stingy, avaricious person.", "Avaricious"), ["A very stingy, ", "avaricious", " person."]);
  // not inside a longer word
  assert.equal(gv.splitAtWord("Avariciousness is a vice.", "avaricious"), null);
});

test("the app never opens on a source that isn't connected", () => {
  assert.equal(startPage("grimmory", false), "local");
  assert.equal(startPage("grimmory", true), "grimmory");
  assert.equal(startPage(null, false), "local");
  assert.equal(startPage("auto", true), "grimmory");
  assert.equal(startPage("last", false), "local");
  assert.equal(startPage("journal", false), "journal");
  assert.equal(startPage("local", true), "local");
});
