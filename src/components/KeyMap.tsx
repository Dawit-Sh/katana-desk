// The keyboard map (milestone 7): every key and mouse move Katana Desk knows, opened with ? or Ctrl /
// anywhere, and shown in Settings › Keyboard. Only keys that work are listed.
import { useEffect, useRef } from "react";
import { useStore } from "../lib/store";

type Row = { what: string; keys: (string | string[])[] };
type Section = { name: string; rows: Row[] };

/** A key, or keys pressed together ("Ctrl K"); several in a list are alternatives. */
export const SECTIONS: Section[] = [
  {
    name: "Anywhere",
    rows: [
      { what: "Search everything (books, authors, highlights, notes, bookmarks, words)", keys: ["Ctrl K"] },
      { what: "Commands", keys: ["Ctrl K", ">"] },
      { what: "Open a file", keys: ["Ctrl O"] },
      { what: "Settings", keys: ["Ctrl ,"] },
      { what: "This keyboard map", keys: ["?", "Ctrl /"] },
      { what: "App size (outside a book)", keys: ["Ctrl +", "Ctrl −", "Ctrl 0"] },
      { what: "Full screen", keys: ["F11"] },
    ],
  },
  {
    name: "Library",
    rows: [
      { what: "Move between covers", keys: [["←", "→", "↑", "↓"]] },
      { what: "First and last cover", keys: [["Home", "End"]] },
      { what: "Show the book's page", keys: ["Space", "a click"] },
      { what: "Open the book", keys: ["Enter", "a double-click"] },
      { what: "Open it in a window of its own", keys: ["Ctrl+click"] },
      { what: "Change cover, a new window, add to a list", keys: ["right-click a cover"] },
      { what: "Add books and folders to Local", keys: ["drop them anywhere"] },
    ],
  },
  {
    name: "Turning pages",
    rows: [
      { what: "Next page", keys: ["→", "Space", "Page Down"] },
      { what: "Previous page", keys: ["←", "Shift Space", "Page Up"] },
      { what: "A few lines (Scroll) or the next page", keys: [["↑", "↓"]] },
      { what: "First and last page (PDF, DjVu, comics)", keys: ["Home", "End"] },
      { what: "Turn with the mouse", keys: ["the wheel", "a click in the page's outer fifth"] },
      { what: "Back to where you were (after a jump)", keys: ["Alt ←"] },
    ],
  },
  {
    name: "In a book",
    rows: [
      { what: "Search the book", keys: ["Ctrl F"] },
      { what: "Next and previous match", keys: ["Enter", "Shift Enter"] },
      { what: "Bookmark this page", keys: ["Ctrl B", "a click in its top corner"] },
      { what: "Text size (EPUB) or zoom (PDF, DjVu, comics)", keys: ["Ctrl +", "Ctrl −", "Ctrl 0"] },
      { what: "Zoom a page", keys: ["Ctrl and the wheel"] },
      { what: "Close a card, then a panel, then the book", keys: ["Esc"] },
    ],
  },
  {
    name: "Selected text",
    rows: [
      { what: "Highlight", keys: ["H"] },
      { what: "Highlight in a colour", keys: [["1", "2", "3", "4", "5"]] },
      { what: "Highlight with a note", keys: ["N"] },
      { what: "Look it up", keys: ["L", "a double-click on a word"] },
      { what: "Copy", keys: ["C", "Ctrl C"] },
      { what: "Remove the highlight whose card is open", keys: ["Delete"] },
    ],
  },
  {
    name: "Review cards",
    rows: [
      { what: "Show the meaning", keys: ["Space"] },
      { what: "Again, or I know it", keys: ["1", "2"] },
      { what: "Stop", keys: ["Esc"] },
    ],
  },
  {
    name: "Search everything",
    rows: [
      { what: "Move, open", keys: [["↑", "↓"], "Enter"] },
      { what: "Open in a window of its own", keys: ["Ctrl Enter", "Ctrl+click"] },
    ],
  },
];

function Keys({ k }: { k: string | string[] }) {
  if (Array.isArray(k)) return <span className="km-k">{k.map((x) => <kbd key={x}>{x}</kbd>)}</span>;
  if (/^[a-z]/.test(k)) return <span className="km-m">{k}</span>; // a mouse move, in words
  return <kbd>{k}</kbd>;
}

export function KeyList() {
  return (
    <div className="km-list">
      {SECTIONS.map((s) => (
        <section key={s.name}>
          <h3>{s.name}</h3>
          {s.rows.map((r) => (
            <div className="km-row" key={r.what}>
              <span>{r.what}</span>
              <span className="km-keys">
                {r.keys.map((k, i) => (
                  <span key={i} style={{ display: "contents" }}>
                    {i > 0 && <span className="km-or">or</span>}
                    <Keys k={k} />
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function KeyMap() {
  const close = () => useStore.getState().setKeymap(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?" || (e.ctrlKey && (e.key === "/" || e.code === "Slash"))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="pal-scrim km-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="km" role="dialog" aria-label="Keyboard map" tabIndex={-1} ref={box}>
        <div className="km-hd">
          <div>
            <b>Keyboard and mouse</b>
            <small>Press ? or Ctrl / anywhere to see this again</small>
          </div>
          <button type="button" className="ib" aria-label="Close" title="Close (Esc)" onClick={close}>
            <i className="ms">close</i>
          </button>
        </div>
        <KeyList />
      </div>
    </div>
  );
}
