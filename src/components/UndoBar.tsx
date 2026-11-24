// The undo bar: what the last change was ("Highlight removed · Undo  Ctrl Z"), or what the last undo
// brought back ("Highlight back · Undo again  Ctrl Z · Redo  Ctrl Y"). It stays until the next change;
// the cross only hides it, the history stays. One per window, at the bottom (above the toasts in a book).
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { current, hide, redo, subscribe, undo } from "../lib/undo";
import { useStore } from "../lib/store";
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
