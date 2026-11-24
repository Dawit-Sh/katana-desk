// Back (the ← Back button at the top of every page, Alt ←, and the mouse's back button): the steps are kept
// in the store (`backSteps`, see store.ts, with the rules in spots.ts); this file has the panels' half.
import { useEffect, useRef } from "react";
import { useStore } from "./store";

/** While `open`, Back closes the panel (a review, two reads side by side); it leaves the steps when it closes. */
export function useBackClose(key: string, open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    useStore.getState().pushBack(key, () => latest.current());
    return () => useStore.getState().dropBack(key);
  }, [key, open]);
}
