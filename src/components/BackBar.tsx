// The ← Back button at the top of every page (his ask, 2026-11-24: "a back button for every action on the
// desktop"): it shows once there's somewhere to go back to, with where you are beside it.
import { useEffect } from "react";
import { useStore } from "../lib/store";
import { spotOf, whereYouAre } from "../lib/spots";
import { SECTIONS } from "../pages/OtherPages";

export function BackBar() {
  const s = useStore();
  const can = s.backSteps.length > 0;

  // the mouse's own back button, and Alt ← outside a book (in a book, Alt ← is "back to where you were")
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3) return;
      e.preventDefault();
      const st = useStore.getState();
      if (st.readingId != null) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", altKey: true, bubbles: true }));
      } else {
        st.goBack();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (!(e.altKey && !e.ctrlKey && e.key === "ArrowLeft") || st.readingId != null) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      st.goBack();
    };
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!can) return null;
  const book =
    s.page === "grimmory" && s.gSheet
      ? s.catalog.books.find((b) => b.id === s.gSelected)?.title ?? null
      : s.page === "local" && s.sheetOpen
        ? s.books.find((b) => b.id === s.selectedId)?.title ?? null
        : null;
  const parts = whereYouAre(spotOf(s), { sections: SECTIONS, lists: s.lists, catalog: s.catalog, bookTitle: book });
  return (
    <div className="backbar">
      <button type="button" className="backbtn" onClick={s.goBack} title="Back (Alt ←, or the mouse's back button)">
        <i className="ms">arrow_back</i>
        Back
      </button>
      {parts.length > 0 && (
        <span className="where" aria-label="Where you are">
          {parts.map((p, i) => (
            <span key={i}>
              {i > 0 && <span className="sep"> › </span>}
              {i === parts.length - 1 ? <b>{p}</b> : p}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
