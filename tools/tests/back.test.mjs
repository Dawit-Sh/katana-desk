// npm test: Back's rules (src/lib/spots.ts): when a move is a step, how closing something by another way
// takes its step off, and the line beside the Back button.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_STEPS, dayName, sameSpot, stepsAfterMove, whereYouAre } from "../../src/lib/spots.ts";

const at = (over = {}) => ({
  page: "local",
  place: { folderId: null, sub: [] },
  journalDay: null,
  settingsAt: null,
  query: "",
  sheetOpen: false,
  selectedId: null,
  gSheet: false,
  gSelected: null,
  gFilter: { kind: "all", status: "any" },
  listSel: null,
  ...over,
});

test("going somewhere new keeps a step back to where you were", () => {
  const from = at();
  const steps = stepsAfterMove([], from, at({ page: "settings" }));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].spot, from);
});

test("staying put, or only moving the selection, is no step", () => {
  assert.deepEqual(stepsAfterMove([], at(), at()), []);
  // the arrow keys move the selection without opening anything
  assert.deepEqual(stepsAfterMove([], at({ selectedId: 1 }), at({ selectedId: 2 })), []);
  // with a book's page open, moving it to the next book is the same spot
  assert.deepEqual(stepsAfterMove([], at({ sheetOpen: true, selectedId: 1 }), at({ sheetOpen: true, selectedId: 2 })), []);
  // typing more of a search is the same search
  assert.deepEqual(stepsAfterMove([], at({ query: "ho" }), at({ query: "hole" })), []);
});

test("closing a book's page or clearing a search by hand takes its step off", () => {
  const library = at();
  const open = at({ sheetOpen: true, selectedId: 7 });
  const steps = stepsAfterMove([], library, open);
  assert.equal(steps.length, 1);
  assert.deepEqual(stepsAfterMove(steps, open, at({ selectedId: 7 })), []);

  const searching = stepsAfterMove([], library, at({ query: "hole" }));
  assert.deepEqual(stepsAfterMove(searching, at({ query: "hole" }), at()), []);
});

test("folders, Settings sections, lists, Journal days and Grimmory shelves each count", () => {
  assert.equal(sameSpot(at(), at({ place: { folderId: 1, sub: [] } })), false);
  assert.equal(sameSpot(at({ place: { folderId: 1, sub: ["a"] } }), at({ place: { folderId: 1, sub: ["a", "b"] } })), false);
  assert.equal(sameSpot(at({ page: "settings" }), at({ page: "settings", settingsAt: "keyboard" })), false);
  assert.equal(sameSpot(at({ page: "lists", listSel: 1 }), at({ page: "lists", listSel: 2 })), false);
  assert.equal(sameSpot(at({ page: "journal" }), at({ page: "journal", journalDay: "2026-11-22" })), false);
  assert.equal(sameSpot(at({ page: "grimmory" }), at({ page: "grimmory", gFilter: { kind: "shelf", id: 3, status: "any" } })), false);
});

test("only the newest steps are kept", () => {
  let steps = [];
  for (let i = 0; i < MAX_STEPS + 20; i++) steps = stepsAfterMove(steps, at({ listSel: i, page: "lists" }), at({ listSel: i + 1, page: "lists" }));
  assert.equal(steps.length, MAX_STEPS);
  assert.equal(steps[steps.length - 1].spot.listSel, MAX_STEPS + 19);
});

test("the line beside Back says where you are", () => {
  const around = {
    sections: [{ id: "general", name: "General" }, { id: "keyboard", name: "Keyboard" }],
    lists: [{ id: 4, name: "To read", createdAt: 0, updatedAt: 0, books: [] }],
    catalog: { books: [], libraries: [{ id: 2, name: "Fiction" }], shelves: [] },
    bookTitle: "The Hole",
  };
  assert.deepEqual(whereYouAre(at({ page: "settings", settingsAt: "keyboard" }), around), ["Settings", "Keyboard"]);
  assert.deepEqual(whereYouAre(at({ page: "settings" }), around), ["Settings", "General"]);
  assert.deepEqual(whereYouAre(at({ page: "lists" }), around), ["Lists", "To read"]);
  assert.deepEqual(whereYouAre(at({ page: "journal", journalDay: "2026-11-22" }), around), ["Journal", "22 November 2026"]);
  assert.deepEqual(whereYouAre(at({ page: "grimmory", gFilter: { kind: "library", id: 2, status: "any" }, gSheet: true }), around), ["Grimmory", "Fiction", "The Hole"]);
  // Local shows its own folder path: only a search or a book's page gets named
  assert.deepEqual(whereYouAre(at(), around), []);
  assert.deepEqual(whereYouAre(at({ query: "hole" }), around), ["Local", "Search"]);
  assert.deepEqual(whereYouAre(at({ sheetOpen: true }), around), ["Local", "The Hole"]);
  assert.equal(dayName("2026-01-05"), "5 January 2026");
});
