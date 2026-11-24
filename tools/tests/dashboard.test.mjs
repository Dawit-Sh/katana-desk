// npm test: Local's reading dashboard (src/lib/dashboard.ts): which books are open or gone quiet, what a
// folder card lists, Reading next, new books, and the words for times.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUIET_DAYS, finished, inPlace, isScoped, leftText, nearText, newThisWeek, readingNext, reading, tileReading, whenText,
} from "../../src/lib/dashboard.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 24, 10, 0).getTime(); // Tuesday 24 Nov 2026, 10:00 AM
let next = 1;
const book = (over = {}) => ({
  id: next++, path: "", folderId: 1, relDir: "", format: "epub", title: "T", author: null, size: 1, cover: null,
  addedAt: NOW - 90 * DAY, openedAt: null, location: null, fraction: null, chapter: null, source: "local",
  grimmoryId: null, placeState: "clean", syncedAt: null, ...over,
});
const dash = (over = {}) => ({ books: [], aside: [], finished: [], ...over });

test("open books come last-opened first; untouched for 14 days they've gone quiet", () => {
  const a = book({ fraction: 0.41, openedAt: NOW - DAY });
  const b = book({ fraction: 0.68, openedAt: NOW - 2 * DAY });
  const q = book({ fraction: 0.12, openedAt: NOW - (QUIET_DAYS + 1) * DAY });
  const never = book({ fraction: 0.3, openedAt: null }); // a place from Grimmory, never opened here
  const r = reading([b, q, a, never], null, NOW);
  assert.deepEqual(r.open.map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(r.quiet.map((x) => x.id), [q.id, never.id]);
});

test("not started, finished, set aside and given-up books stay off", () => {
  const unread = book({ fraction: 0 });
  const done = book({ fraction: 1 });
  const readMarked = book({ fraction: 0.6, openedAt: NOW });
  const aside = book({ fraction: 0.5, openedAt: NOW });
  const r = reading([unread, done, readMarked, aside], dash({ aside: [aside.id], finished: [[readMarked.id, NOW]] }), NOW);
  assert.equal(r.open.length + r.quiet.length, 0);
});

test("inside a folder the band speaks of that folder, but not at the top of the only folder", () => {
  const one = [{ id: 1, path: "C:/Books", name: "Books", addedAt: 0 }];
  const two = [...one, { id: 2, path: "D:/Comics", name: "Comics", addedAt: 0 }];
  assert.equal(isScoped({ folderId: null, sub: [] }, two), false);
  assert.equal(isScoped({ folderId: 1, sub: [] }, one), false);
  assert.equal(isScoped({ folderId: 1, sub: [] }, two), true);
  assert.equal(isScoped({ folderId: 1, sub: ["Fiction"] }, one), true);
});

test("a folder card lists the books read under it, and only those", () => {
  const jn = book({ relDir: "Short novels", fraction: 0.41, openedAt: NOW - DAY });
  const deep = book({ relDir: "Fiction/Old", fraction: 0.2, openedAt: NOW - 2 * DAY });
  const lookalike = book({ relDir: "Fiction2", fraction: 0.5, openedAt: NOW - DAY }); // not inside Fiction
  const quiet = book({ relDir: "Fiction", fraction: 0.15, openedAt: NOW - 30 * DAY });
  const other = book({ folderId: 2, relDir: "Fiction", fraction: 0.5, openedAt: NOW });
  const r = reading([jn, deep, lookalike, quiet, other], null, NOW);
  assert.deepEqual(tileReading(r, { folderId: 1, sub: ["Fiction"] }).map((b) => b.id), [deep.id, quiet.id]);
  assert.deepEqual(tileReading(r, { folderId: 1, sub: ["Short novels"] }).map((b) => b.id), [jn.id]);
  assert.equal(inPlace(other, { folderId: 1, sub: [] }), false);
});

test("finished books come newest first", () => {
  const a = book(), b = book(), c = book();
  const f = finished([a, b, c], dash({ finished: [[a.id, 5], [b.id, 0], [c.id, 9]] }));
  assert.deepEqual(f.map((x) => x.book.id), [c.id, a.id, b.id]);
});

test("Reading next: the list's books here, in its order, without started or finished ones", () => {
  const a = book(), b = book({ grimmoryId: 77 }), c = book({ fraction: 0.3 }), d = book();
  const lists = [
    { id: 1, name: "Want to read", createdAt: 0, updatedAt: 0, books: [`b:${d.id}`] },
    { id: 2, name: " reading NEXT ", createdAt: 0, updatedAt: 0, books: [`g:77`, `b:${c.id}`, `b:${a.id}`, `b:${d.id}`, "g:999"] },
  ];
  const out = readingNext(lists, [a, b, c, d], dash({ finished: [[d.id, 1]] }));
  assert.deepEqual(out.map((x) => x.id), [b.id, a.id]);
  assert.deepEqual(readingNext([], [a], null), []);
});

test("new this week: what a folder check found lately, not the folder's first check", () => {
  const folders = [{ id: 1, path: "C:/Books", name: "Books", addedAt: NOW - 2 * DAY }];
  const first = book({ addedAt: NOW - 2 * DAY + 60_000, relDir: "Fiction" }); // the folder's first check
  const later = book({ addedAt: NOW - DAY, relDir: "Library/x" });
  const later2 = book({ addedAt: NOW - DAY + 5, relDir: "Library" });
  const fic = book({ addedAt: NOW - 3 * 3600_000, relDir: "Fiction" });
  const old = book({ addedAt: NOW - 8 * DAY, relDir: "Fiction" });
  const loose = book({ folderId: null, addedAt: NOW - DAY });
  const n = newThisWeek([first, later, later2, fic, old, loose], folders, NOW);
  assert.deepEqual(n.books.map((b) => b.id), [fic.id, later2.id, later.id, loose.id]);
  assert.deepEqual(n.by, [["Library", 2], ["Fiction", 1], ["Added one by one", 1]]);
});

test("time left in plain words", () => {
  assert.equal(leftText(200), "A few minutes left");
  assert.equal(leftText(41 * 60), "About 40 min left");
  assert.equal(leftText(3 * 3600 + 19 * 60), "About 3 h 20 min left");
  assert.equal(leftText(2 * 3600 + 57 * 60), "About 3 h left");
  assert.equal(nearText(14 * 60, 0.86), "15 min left");
  assert.equal(nearText(null, 0.92), "Nearly done");
  assert.equal(nearText(5 * 3600, 0.95), null);
  assert.equal(nearText(null, 0.5), null);
});

test("when, in 12-hour time and plain days", () => {
  assert.equal(whenText(new Date(2026, 10, 24, 8, 5).getTime(), NOW), "Today, 8:05 AM");
  assert.equal(whenText(new Date(2026, 10, 23, 21, 40).getTime(), NOW), "Yesterday, 9:40 PM");
  assert.equal(whenText(new Date(2026, 10, 22, 12, 0).getTime(), NOW), "Sunday");
  assert.equal(whenText(new Date(2026, 10, 9, 12, 0).getTime(), NOW), "9 Nov");
  assert.equal(whenText(new Date(2025, 11, 30, 12, 0).getTime(), NOW), "30 Dec 2025");
});
