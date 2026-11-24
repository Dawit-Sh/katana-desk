// The undo bar: what the last change was ("Highlight removed · Undo  Ctrl Z"), or what the last undo
// brought back ("Highlight back · Undo again  Ctrl Z · Redo  Ctrl Y"). It stays until the next change;
// the cross only hides it, the history stays. One per window, at the bottom (above the toasts in a book).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { current, hide, redo, subscribe, undo } from "../lib/undo";
import { statusChanged, statusMarks } from "../lib/undoable";
import { useStore } from "../lib/store";
import { STATUSES, statusName } from "./StatusPill";
import "../styles/undo.css";

export function UndoBar() {
  const bar = useSyncExternalStore(subscribe, current);
  const inBook = useStore((s) => s.readingId != null || s.bookWindow);
  if (!bar) return null;
  return createPortal(
    <div className={`ubar ${inBook ? "inbook" : ""} ${bar.failed ? "failed" : ""}`} role="status" aria-live="polite">
      <span className="ut">
        <b>{bar.text}</b>
        {bar.detail && <span className="ud"> · {bar.detail}</span>}
      </span>
      {bar.canUndo && (
        <button type="button" className="pill tone" onClick={() => void undo()} title="Undo the last change">
          {bar.undone ? "Undo again" : "Undo"}
          <kbd>Ctrl Z</kbd>
        </button>
      )}
      {bar.canRedo && (
        <button type="button" className="pill tone" onClick={() => void redo()} title="Put it back again (Ctrl Y or Ctrl Shift Z)">
          Redo
          <kbd>Ctrl Y</kbd>
        </button>
      )}
      <button type="button" className="ux" aria-label="Hide" title="Hide (Ctrl Z still works)" onClick={hide}>
        <i className="ms">close</i>
      </button>
    </div>,
    document.body,
  );
}

/** Around a book's status pill (StatusPill): a status picked in its menu goes on the undo history once
 *  it's set. The pill marks the status it has (aria-checked) and lists them in STATUSES' order. */
export function StatusUndo({ gid, localId, title, children }: { gid: number | null; localId: number | null; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  // an undo or redo of this book's status: the pill is made again, so it reads the status again
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ gid: number | null; localId: number | null }>).detail;
      if ((d.localId != null && d.localId === localId) || (d.gid != null && d.gid === gid)) setShown((n) => n + 1);
    };
    window.addEventListener("katana-status", on);
    return () => window.removeEventListener("katana-status", on);
  }, [gid, localId]);
  const onClickCapture = (e: React.MouseEvent) => {
    const item = (e.target as Element).closest?.('[role="menuitemradio"]') as HTMLButtonElement | null;
    const menu = item?.closest('[role="menu"]');
    if (!item || !menu || item.disabled) return;
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
    const to = STATUSES[items.indexOf(item)]?.id;
    const was = items.findIndex((x) => x.getAttribute("aria-checked") === "true");
    const from = was >= 0 ? (STATUSES[was]?.id ?? null) : null;
    if (!to || to === from) return;
    // the copies here as they are before it (asked now, ahead of the menu's own call): their places,
    // finished days and reads, which Undo puts back
    const copies = useStore.getState().books.filter((b) => b.id === localId || (gid != null && b.grimmoryId === gid));
    const before = Promise.all(copies.map((b) => statusMarks(b.id).catch(() => null)));
    const started = Date.now();
    const look = async () => {
      if (ref.current?.querySelector(".err")) return; // it didn't go through
      const now =
        gid != null
          ? (useStore.getState().catalog.books.find((b) => b.id === gid)?.readStatus ?? null)
          : await invoke<string | null>("book_status", { id: localId }).catch(() => null);
      if (now === to) {
        const marks = await before;
        const places = copies.map((b, i) => ({ id: b.id, location: b.location, fraction: b.fraction, chapter: b.chapter, marks: marks[i] }));
        return statusChanged({ gid, localId, title, from, to, places, name: (s) => statusName(s)?.name ?? s });
      }
      if (Date.now() - started < 15_000) setTimeout(look, 200);
    };
    setTimeout(look, 150);
  };
  return (
    <span className="stundo" ref={ref} onClickCapture={onClickCapture} key={shown}>
      {children}
    </span>
  );
}
