import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../lib/api";
import icon from "../assets/katana-icon.svg";

const win = getCurrentWindow();

/** Windows-shaped 46 px caption buttons. Holding the mouse on Maximise opens Windows' Snap layouts. */
export function CaptionButtons() {
  const [max, setMax] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => {
    const check = () => win.isMaximized().then(setMax);
    check();
    const un = win.onResized(check);
    return () => {
      un.then((f) => f());
    };
  }, []);
  return (
    <div className="caps">
      <button type="button" aria-label="Minimise" title="Minimise" onClick={() => win.minimize()}>
        <svg viewBox="0 0 10 10"><path d="M0 5.5h10" /></svg>
      </button>
      <button
        type="button"
        aria-label={max ? "Restore" : "Maximise"}
        title={max ? "Restore" : "Maximise"}
        onClick={() => {
          clearTimeout(timer.current);
          win.toggleMaximize();
        }}
        onMouseEnter={() => {
          timer.current = window.setTimeout(() => win.setFocus().then(() => api.snapOverlay()), 620);
        }}
        onMouseLeave={() => clearTimeout(timer.current)}
      >
        {max ? (
          <svg viewBox="0 0 10 10"><path d="M2.5 2.5V.5h7v7h-2" /><rect x=".5" y="2.5" width="7" height="7" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1.5" /></svg>
        )}
      </button>
      <button type="button" className="close" aria-label="Close" title="Close" onClick={() => win.close()}>
        <svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" /></svg>
      </button>
    </div>
  );
}

type Props = {
  onFold: () => void;
  foldIcon: string;
  foldLabel: string;
  query: string;
  setQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
};

export function TitleBar({ onFold, foldIcon, foldLabel, query, setQuery, searchRef }: Props) {
  // empty parts of the bar move the window; a double-click maximises (Tauri's drag region does both)
  return (
    <header className="tb" data-tauri-drag-region>
      <button type="button" className="tbi" aria-label={foldLabel} title={foldLabel} onClick={onFold}>
        <i className="ms">{foldIcon}</i>
      </button>
      <img className="appicon" src={icon} alt="" data-tauri-drag-region draggable={false} />
      <span className="appname" data-tauri-drag-region>
        Katana<em data-tauri-drag-region>刀</em>
      </span>
      <div className="grow" data-tauri-drag-region />
      <label className="search">
        <i className="ms">search</i>
        <input
          ref={searchRef}
          value={query}
          placeholder="Search your books"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
          }}
        />
        {query ? (
          <button type="button" className="clear" aria-label="Clear the search" onClick={() => setQuery("")}>
            <i className="ms">close</i>
          </button>
        ) : (
          <kbd>Ctrl K</kbd>
        )}
      </label>
      <div className="grow" data-tauri-drag-region />
      <CaptionButtons />
    </header>
  );
}
