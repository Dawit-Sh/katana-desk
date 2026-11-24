// Back (his ask, 2026-11-24: "a back button for every action on the desktop"): ← Back in the title bar,
// beside the sidebar button (his pick: "The back button should be around here"), greyed out until
// there's somewhere to go back to; Alt ← and the mouse's own back button do the same.
import { useEffect } from "react";
import { useStore } from "../lib/store";
import { whereYouAre, type Spot } from "../lib/spots";
import { SECTIONS } from "../pages/OtherPages";

/** Alt ← outside a book, and the mouse's back button anywhere (in a book it's "back to where you were"). */
export function useBackKeys() {
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
}

/** ← Back, in the title bar; its tooltip names where it goes. */
export function BackButton() {
  const s = useStore();
  const top = s.backSteps[s.backSteps.length - 1];
  const to = (spot: Spot) => {
    const book =
      spot.page === "grimmory" && spot.gSheet
        ? s.catalog.books.find((b) => b.id === spot.gSelected)?.title ?? null
        : spot.page === "local" && spot.sheetOpen
          ? s.books.find((b) => b.id === spot.selectedId)?.title ?? null
          : null;
    const parts = whereYouAre(spot, { sections: SECTIONS, lists: s.lists, catalog: s.catalog, bookTitle: book });
    return parts.length ? parts.join(" › ") : "Local";
  };
  const title = !top ? "Back (nothing to go back to yet)" : "spot" in top ? `Back to ${to(top.spot)} (Alt ←)` : "Back (Alt ←)";
  return (
    <button type="button" className="tbback" onClick={s.goBack} disabled={!top} aria-label={title} title={title}>
      <i className="ms">arrow_back</i>
      <span>Back</span>
    </button>
  );
}
