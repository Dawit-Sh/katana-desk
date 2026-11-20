// Ctrl K, search everything (milestone 7, call 13): books here and on Grimmory, authors, highlights,
// notes, bookmarks and My words, in every format. ↑ ↓ move, Enter opens, Ctrl Enter (or Ctrl+click)
// opens a book in a window of its own, Esc closes. Type > for commands.
import { useEffect, useMemo, useRef, useState } from "react";
import { grimmory, m7, type Hit } from "../lib/api";
import { learning } from "../lib/words";
import { useStore, type Page } from "../lib/store";
import { addBooks, addFolder } from "../pages/LocalPage";

type Item = {
  key: string;
  icon: string;
  title: string;
  sub?: string;
  right?: string;
  color?: string | null;
  quote?: boolean;
  /** `newWindow`: Ctrl was held */
  run: (newWindow: boolean) => void;
};
type Group = { name: string; items: Item[] };

const COLOURS: Record<string, string> = { yellow: "#FACC15", green: "#4ADE80", blue: "#38BDF8", pink: "#F472B6", orange: "#FB923C" };

function close() {
  useStore.getState().setPalette(false);
}

/** Leaves the reader (in the main window) for a library page. */
function goPage(p: Page) {
  const st = useStore.getState();
  if (st.readingId != null && !st.bookWindow) st.closeReader();
  st.go(p);
}

function openBook(id: number, at: string | null, title: string, newWindow: boolean) {
  const st = useStore.getState();
  if (newWindow || st.bookWindow) m7.openWindow(id, at, title);
  else st.open(id, at);
}

function hitItem(h: Hit): Item {
  const st = useStore.getState();
  switch (h.kind) {
    case "book":
      return {
        key: `b${h.id}`,
        icon: h.format === "pdf" || h.format === "djvu" ? "picture_as_pdf" : h.format === "cbz" || h.format === "cbr" ? "photo_library" : "menu_book",
        title: h.title,
        sub: h.sub,
        right: "Open",
        run: (nw) => openBook(h.id, null, h.title, nw),
      };
    case "gbook":
      return {
        key: `g${h.id}`,
        icon: "cloud",
        title: h.title,
        sub: h.sub,
        right: "Its page",
        run: () => {
          goPage("grimmory");
          st.gSelect(h.id, true);
        },
      };
    case "author":
      return {
        key: `a${h.title}`,
        icon: "person",
        title: h.title,
        sub: h.sub,
        right: "Their books",
        run: () => {
          const s2 = useStore.getState();
          if (s2.readingId != null && !s2.bookWindow) s2.closeReader();
          s2.setQuery(h.title);
        },
      };
    case "word":
      return {
        key: `w${h.id}`,
        icon: "dictionary",
        title: h.title,
        sub: h.sub,
        right: h.bookId != null && h.at ? "The sentence" : "My words",
        run: (nw) => {
          learning.revisit("word", h.uuid, h.bookId);
          if (h.bookId != null && h.at && useStore.getState().books.some((b) => b.id === h.bookId)) openBook(h.bookId, h.at, h.sub, nw);
          else goPage("words");
        },
      };
    default: {
      const detail = h.kind === "bookmark" ? "bookmark" : h.kind === "note" ? "note" : "highlight";
      return {
        key: `${h.kind[0]}${h.id}`,
        icon: h.kind === "bookmark" ? "bookmark" : h.kind === "note" ? "edit_note" : "format_ink_highlighter",
        title: h.title,
        sub: h.sub,
        quote: h.kind === "highlight",
        color: h.kind === "bookmark" ? null : COLOURS[h.color ?? "yellow"],
        right: "Go there",
        run: (nw) => {
          learning.revisit(detail, h.uuid, h.bookId);
          if (h.bookId != null) openBook(h.bookId, h.at, h.sub.split(" · ")[0], nw);
        },
      };
    }
  }
}

function commands(): Item[] {
  const st = useStore.getState();
  const pages: [Page, string, string][] = [
    ["grimmory", "cloud", "Grimmory"],
    ["local", "folder", "Local"],
    ["lists", "checklist", "Lists"],
    ["bookmarks", "bookmarks", "Bookmarks"],
    ["words", "dictionary", "My words"],
    ["journal", "history", "Journal"],
    ["settings", "settings", "Settings"],
  ];
  const out: Item[] = pages.map(([p, icon, name]) => ({ key: `p${p}`, icon, title: `Go to ${name}`, run: () => goPage(p) }));
  out.push(
    { key: "keys", icon: "keyboard", title: "Keyboard map", right: "?", run: () => st.setKeymap(true) },
    { key: "folder", icon: "create_new_folder", title: "Add a folder to Local", run: () => addFolder() },
    { key: "books", icon: "add", title: "Add books to Local", run: () => addBooks() },
    { key: "tg", icon: "dark_mode", title: "Theme: Graphite", run: () => st.setThemePref("graphite") },
    { key: "tp", icon: "light_mode", title: "Theme: Paper", run: () => st.setThemePref("paper") },
    { key: "ts", icon: "contrast", title: "Theme: Follow Windows", run: () => st.setThemePref("system") },
  );
  if (st.g?.signedIn) out.push({ key: "sync", icon: "sync", title: "Sync with Grimmory now", run: () => grimmory.sync(false).catch(() => {}) });
  return out;
}

export function Palette() {
  const books = useStore((s) => s.books);
  const [q, setQ] = useState(useStore.getState().query);
  const [found, setFound] = useState<{ q: string; groups: Group[] } | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mouse = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const cmd = q.trimStart().startsWith(">");
  useEffect(() => {
    const text = q.trim();
    if (cmd || !text) return;
    let live = true;
    const t = window.setTimeout(() => {
      m7.search(text)
        .then((f) => {
          if (!live) return;
          const g: Group[] = [];
          if (f.books.length) g.push({ name: "Books", items: f.books.map(hitItem) });
          if (f.marks.some((m) => m.kind !== "bookmark")) g.push({ name: "Highlights and notes", items: f.marks.filter((m) => m.kind !== "bookmark").map(hitItem) });
          if (f.marks.some((m) => m.kind === "bookmark")) g.push({ name: "Bookmarks", items: f.marks.filter((m) => m.kind === "bookmark").map(hitItem) });
          if (f.words.length) g.push({ name: "My words", items: f.words.map(hitItem) });
          if (f.authors.length) g.push({ name: "Authors", items: f.authors.map(hitItem) });
          setFound({ q: text, groups: g });
          setActive(0);
        })
        .catch(() => {});
    }, 70);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, cmd]);

  const groups: Group[] = useMemo(() => {
    if (cmd) {
      const f = q.trim().slice(1).trim().toLowerCase();
      const items = commands().filter((c) => !f || c.title.toLowerCase().includes(f));
      return items.length ? [{ name: "Commands", items }] : [];
    }
    if (!q.trim()) {
      const recent = books
        .filter((b) => b.openedAt)
        .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
        .slice(0, 6)
        .map((b) =>
          hitItem({ kind: "book", id: b.id, bookId: b.id, title: b.title, sub: [b.author, b.format.toUpperCase(), b.fraction ? `${Math.round(b.fraction * 100)}%` : null].filter(Boolean).join(" · "), at: null, format: b.format, color: null, count: 0, uuid: null }),
        );
      return recent.length ? [{ name: "Recently read", items: recent }] : [];
    }
    return found?.groups ?? [];
  }, [cmd, q, found, books]);
  const flat = groups.flatMap((g) => g.items);
  const cur = Math.min(active, flat.length - 1);

  useEffect(() => {
    listRef.current?.querySelector(".it.on")?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const run = (it: Item | undefined, newWindow: boolean) => {
    if (!it) return;
    close();
    it.run(newWindow);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      mouse.current = false;
      const n = flat.length;
      if (n) setActive((a) => (Math.min(a, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      run(flat[cur], e.ctrlKey);
    } else if ((e.key === "k" || e.key === "K") && e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  let n = -1;
  const searching = q.trim() && !cmd && found?.q !== q.trim();
  return (
    <div className="pal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pal" role="dialog" aria-label="Search everything" onKeyDown={onKey}>
        <label className="pf">
          <i className="ms">{cmd ? "terminal" : "search"}</i>
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder="Search books, authors, highlights, notes, bookmarks, words"
            spellCheck={false}
            aria-label="Search everything"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="pal-list"
          />
          <kbd>Esc</kbd>
        </label>
        <div className="pal-list" id="pal-list" role="listbox" ref={listRef}>
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name}>
              <div className="grpn">{g.name}</div>
              {g.items.map((it) => {
                n++;
                const i = n;
                return (
                  <button
                    type="button"
                    key={it.key}
                    role="option"
                    aria-selected={i === cur}
                    className={`it ${i === cur ? "on" : ""}`}
                    onMouseMove={() => {
                      if (!mouse.current) {
                        mouse.current = true;
                        return;
                      }
                      if (i !== cur) setActive(i);
                    }}
                    onClick={(e) => run(it, e.ctrlKey)}
                    title={it.right === "Open" ? "Enter to open · Ctrl Enter in a new window" : undefined}
                  >
                    <i className="ms" style={it.color ? { color: it.color } : undefined}>{it.icon}</i>
                    <div>
                      {it.quote ? <q>{it.title}</q> : <span className="tt">{it.title}</span>}
                      {it.sub && <small>{it.sub}</small>}
                    </div>
                    {it.right && <span className="r">{i === cur ? (it.right === "?" ? "?" : `Enter · ${it.right}`) : it.right === "?" ? "?" : ""}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!groups.length && (
            <div className="pal-empty">
              {searching ? "Looking…" : cmd ? "No command matches." : q.trim() ? `Nothing matches “${q.trim()}”.` : "Type to search your books, highlights, notes, bookmarks and words."}
            </div>
          )}
        </div>
        <div className="pk">
          <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Ctrl Enter</kbd> new window</span>
          <span>Type <kbd>&gt;</kbd> for commands</span>
        </div>
      </div>
    </div>
  );
}
