// Undo and redo, one history per window (a book in a window of its own has its own). A change that can be
// undone is recorded with what undoes it and what does it again, both through the same calls the app made,
// so the database, Grimmory sync and other windows stay right. Ctrl Z undoes the last change, again and
// again; Ctrl Y or Ctrl Shift Z puts it back. A new change after an undo clears what could be put back.
// No imports: the tests run this file as it is (tools/tests/undo.test.mjs).

export type Step = {
  /** what happened, on the bar: "Highlight removed" */
  label: string;
  /** what an undo brought back: "Highlight back" */
  back: string;
  /** what it was about (the words, the book, the list), shown after the label */
  detail?: string | null;
  undo: () => unknown;
  redo: () => unknown;
};

/** What the bar shows: the last change, or the last undo or redo. */
export type Bar = {
  text: string;
  detail: string | null;
  /** the last thing done was an undo ("Undo again" then) */
  undone: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** an undo or redo that didn't work */
  failed?: boolean;
};

const LIMIT = 100;
const past: Step[] = [];
const future: Step[] = [];
let bar: Bar | null = null;
let stamp = 0;
let queue: Promise<unknown> = Promise.resolve();
const subs = new Set<() => void>();

function show(b: Bar | null) {
  bar = b;
  subs.forEach((f) => f());
}

/** A change was made: it goes on the history, and what could be put back goes. */
export function record(s: Step) {
  stamp++;
  past.push(s);
  if (past.length > LIMIT) past.shift();
  future.length = 0;
  show({ text: s.label, detail: s.detail ?? null, undone: false, canUndo: true, canRedo: false });
}

/** Runs one undo or redo after any still running, so fast presses go one step each, in order. */
function step(from: Step[], to: Step[], back: boolean): Promise<boolean> {
  const run = queue.then(async () => {
    const s = from.pop();
    if (!s) return false;
    const at = stamp;
    try {
      await (back ? s.undo() : s.redo());
    } catch (e) {
      console.error(e);
      show({ text: back ? "That couldn't be undone" : "That couldn't be put back", detail: s.label, undone: back, canUndo: past.length > 0, canRedo: future.length > 0, failed: true });
      return false;
    }
    // a new change while this ran: it can't be put back after that change
    if (at === stamp) to.push(s);
    show({
      text: back ? s.back : s.label,
      detail: s.detail ?? null,
      undone: back,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
    });
    return true;
  });
  queue = run.catch(() => false);
  return run;
}

/** Undoes the last change (Ctrl Z). Resolves false when there was nothing to undo. */
export const undo = () => step(past, future, true);
/** Puts back the last change undone (Ctrl Y, Ctrl Shift Z). */
export const redo = () => step(future, past, false);

/** Hides the bar; the history stays. */
export const hide = () => show(null);
export const current = () => bar;
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;
export function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

/** Forgets everything (the tests). */
export function clear() {
  past.length = 0;
  future.length = 0;
  ids.clear();
  stamp++;
  show(null);
}

/** In a text box (a note, a search), Ctrl Z and Ctrl Y stay the box's own undo for its text. */
export function typingIn(t: EventTarget | null): boolean {
  const el = t as { closest?: (s: string) => unknown; type?: string; tagName?: string } | null;
  if (!el?.closest) return false;
  if (el.closest("textarea, select, [contenteditable]:not([contenteditable='false'])")) return true;
  const input = el.closest("input") as { type?: string } | null;
  return !!input && !/^(checkbox|radio|range|button|submit|reset|color|file|image)$/i.test(input.type ?? "");
}

type KeyLike = {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
};

/** "undo", "redo" or null for a key press. */
export function undoKind(e: KeyLike): "undo" | "redo" | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return null;
}

/** Ctrl Z, Ctrl Y and Ctrl Shift Z anywhere but a text box: undoes or puts back, and says it took the key.
 *  Every key handler that sees the key calls this; the first takes it (preventDefault), the rest see that. */
export function undoKey(e: KeyLike): boolean {
  const kind = undoKind(e);
  if (!kind || e.defaultPrevented || typingIn(e.target)) return false;
  e.preventDefault();
  if (kind === "undo") void undo();
  else void redo();
  return true;
}

// Ids that change when something comes back (a highlight or a list made again can get a new one, and a
// removed row's id can go to the next new one). Steps name things by what doesn't change, `hl:<uuid>`,
// `bm:<uuid>`, `list:<made at>`, and ask here for the id it has now.
const ids = new Map<string, number>();
/** The id `key` has now (`id`: the one it had when the step was recorded). */
export const idNow = (key: string, id: number) => ids.get(key) ?? id;
/** `key` came back as `id`. */
export const idIs = (key: string, id: number) => void ids.set(key, id);
