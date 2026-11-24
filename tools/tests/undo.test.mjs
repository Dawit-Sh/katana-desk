// npm test: the undo history (src/lib/undo.ts): undo, redo, redo cleared by a new change, several steps,
// the bar's words, and which key presses it takes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as u from "../../src/lib/undo.ts";

/** A thing with a value, and a step that changed it from `from` to `to`. */
function change(box, from, to, label = `set ${to}`) {
  box.v = to;
  u.record({ label, back: `back to ${from}`, detail: "a book", undo: () => void (box.v = from), redo: () => void (box.v = to) });
}

beforeEach(() => u.clear());

test("undo takes the last change back, redo does it again", async () => {
  const box = { v: 0 };
  change(box, 0, 1);
  assert.deepEqual(u.current(), { text: "set 1", detail: "a book", undone: false, canUndo: true, canRedo: false });
  assert.equal(await u.undo(), true);
  assert.equal(box.v, 0);
  assert.deepEqual(u.current(), { text: "back to 0", detail: "a book", undone: true, canUndo: false, canRedo: true });
  assert.equal(await u.redo(), true);
  assert.equal(box.v, 1);
  assert.deepEqual(u.current(), { text: "set 1", detail: "a book", undone: false, canUndo: true, canRedo: false });
  // nothing left to put back
  assert.equal(await u.redo(), false);
  assert.equal(box.v, 1);
});

test("each Ctrl Z goes one step further back, each Ctrl Y one step forward", async () => {
  const box = { v: 0 };
  change(box, 0, 1);
  change(box, 1, 2);
  change(box, 2, 3);
  await u.undo();
  assert.equal(box.v, 2);
  // more to undo: "Undo again"
  assert.equal(u.current().canUndo, true);
  await u.undo();
  await u.undo();
  assert.equal(box.v, 0);
  assert.equal(u.canUndo(), false);
  assert.equal(await u.undo(), false);
  await u.redo();
  await u.redo();
  assert.equal(box.v, 2);
  assert.equal(u.current().canRedo, true);
  await u.redo();
  assert.equal(box.v, 3);
  assert.equal(u.canRedo(), false);
});

test("a new change after an undo clears what could be put back", async () => {
  const box = { v: 0 };
  change(box, 0, 1);
  change(box, 1, 2);
  await u.undo();
  assert.equal(u.canRedo(), true);
  change(box, 1, 5);
  assert.equal(u.canRedo(), false);
  assert.equal(await u.redo(), false);
  assert.equal(box.v, 5);
  // the history before it is still there
  await u.undo();
  assert.equal(box.v, 1);
  await u.undo();
  assert.equal(box.v, 0);
});

test("fast presses run one after another, in order, even when a step waits", async () => {
  const seen = [];
  const slow = (name, ms) => () => new Promise((r) => setTimeout(() => (seen.push(name), r()), ms));
  u.record({ label: "a", back: "a back", undo: slow("undo a", 30), redo: slow("redo a", 1) });
  u.record({ label: "b", back: "b back", undo: slow("undo b", 30), redo: slow("redo b", 1) });
  // three presses before the first is done
  const all = [u.undo(), u.undo(), u.redo()];
  assert.deepEqual(await Promise.all(all), [true, true, true]);
  assert.deepEqual(seen, ["undo b", "undo a", "redo a"]);
  assert.equal(u.current().text, "a");
});

test("a step that fails says so and leaves the rest of the history", async () => {
  const box = { v: 0 };
  change(box, 0, 1);
  u.record({ label: "broken", back: "-", undo: () => Promise.reject(new Error("gone")), redo: () => {} });
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await u.undo(), false);
  } finally {
    console.error = err;
  }
  assert.equal(u.current().failed, true);
  assert.equal(u.current().text, "That couldn't be undone");
  assert.equal(u.current().canUndo, true);
  await u.undo();
  assert.equal(box.v, 0);
});

test("hide only hides the bar; the next undo shows it again", async () => {
  const box = { v: 0 };
  change(box, 0, 1);
  let told = 0;
  const off = u.subscribe(() => told++);
  u.hide();
  assert.equal(u.current(), null);
  await u.undo();
  assert.equal(u.current().text, "back to 0");
  assert.equal(told, 2);
  off();
});

/** A key press as the handlers see it. `target`: what has the focus (closest() as in the DOM). */
function key(k, mods = {}, target = null) {
  return {
    key: k,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: false,
    defaultPrevented: false,
    target,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}
const el = (sel, type) => ({ type, closest: (s) => (s.split(",").some((x) => x.trim().startsWith(sel)) ? { type } : null) });

test("Ctrl Z, Ctrl Y and Ctrl Shift Z are taken; a text box keeps its own; the first handler wins", async () => {
  const box = { v: 0 };
  change(box, 0, 1);
  assert.equal(u.undoKind(key("z", { ctrl: true })), "undo");
  assert.equal(u.undoKind(key("y", { ctrl: true })), "redo");
  assert.equal(u.undoKind(key("Z", { ctrl: true, shift: true })), "redo");
  assert.equal(u.undoKind(key("z")), null);
  assert.equal(u.undoKind(key("z", { ctrl: true, alt: true })), null);
  // in a note or a search, the box's own undo
  assert.equal(u.undoKey(key("z", { ctrl: true }, el("textarea"))), false);
  assert.equal(u.undoKey(key("z", { ctrl: true }, el("input", "search"))), false);
  assert.equal(box.v, 1);
  // a checkbox is no text box
  const e = key("z", { ctrl: true }, el("input", "checkbox"));
  assert.equal(u.undoKey(e), true);
  assert.equal(e.defaultPrevented, true);
  // a second handler seeing the same press leaves it
  assert.equal(u.undoKey(e), false);
  // the press's undo runs first; after it there's nothing more to undo
  assert.equal(await u.undo(), false);
  assert.equal(box.v, 0);
});

test("a step follows a thing whose id changed when it came back", () => {
  assert.equal(u.idNow("hl:abc", 5), 5);
  u.idIs("hl:abc", 9);
  assert.equal(u.idNow("hl:abc", 5), 9);
  assert.equal(u.idNow("hl:other", 5), 5);
});
