// The Bookmarks page: every book with highlights, notes or bookmarks on the left (search covers every
// mark of every book), the picked book's marks on the right, in reading order under their chapters.
// A mark opens the book there; Export saves the book's marks as Markdown.
import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cover } from "../components/Cover";
import type { Book } from "../lib/api";
import { plural } from "../lib/format";
import { useStore } from "../lib/store";
import { MarkRows, Tabs, allMarks, inTab, matches, type Mark, type Tab } from "../reader/marklist";
import { exportMarkdown, hls, marks as bms, marksApi, type Bookmark, type Highlight, type MarkedBook, type MarksSync } from "../reader/marks";

const counts = (b: MarkedBook) =>
  [b.bookmarks ? plural(b.bookmarks, "bookmark") : "", b.highlights ? plural(b.highlights, "highlight") : "", b.notes ? plural(b.notes, "note") : ""]
    .filter(Boolean)
    .join(" · ");

const asBook = (b: MarkedBook) => ({ ...b, path: "", folderId: null, relDir: "", size: 0, addedAt: 0, openedAt: null, location: null, chapter: null, source: "local", placeState: "clean", syncedAt: null }) as Book;

const syncWords: Record<MarksSync, string> = {
  synced: "synced with Grimmory",
  waiting: "changes wait to go to Grimmory",
  local: "on this PC",
  format: "on this PC (this format doesn't sync)",
};

export function BookmarksPage() {
  const open = useStore((s) => s.open);
  const [books, setBooks] = useState<MarkedBook[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Set<number> | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [hl, setHl] = useState<Highlight[]>([]);
  const [bm, setBm] = useState<Bookmark[]>([]);
  const [sync, setSync] = useState<MarksSync | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();

  const loadBooks = useCallback(() => marksApi.books().then(setBooks).catch(() => setBooks([])), []);
  const loadMarks = useCallback(async (id: number) => {
    const [h, b, st] = await Promise.all([hls.list(id), bms.list(id), marksApi.syncState(id)]).catch(() => [[], [], null] as const);
    setHl(h as Highlight[]);
    setBm(b as Bookmark[]);
    setSync(st as MarksSync | null);
  }, []);

  useEffect(() => {
    loadBooks();
    const un = listen<number>("marks-changed", (e) => {
      loadBooks();
      setPicked((p) => {
        if (p != null && p === e.payload) loadMarks(p);
        return p;
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, [loadBooks, loadMarks]);

  // search every mark of every book (and titles), a moment after typing stops
  useEffect(() => {
    if (!needle) return setHits(null);
    const t = setTimeout(() => marksApi.search(needle).then((ids) => setHits(new Set(ids))).catch(() => setHits(new Set())), 180);
    return () => clearTimeout(t);
  }, [needle]);

  const shownBooks = useMemo(() => (books ?? []).filter((b) => !hits || hits.has(b.id)), [books, hits]);
  const current = shownBooks.find((b) => b.id === picked) ?? shownBooks[0] ?? null;

  useEffect(() => {
    if (current) loadMarks(current.id);
    else {
      setHl([]);
      setBm([]);
    }
  }, [current?.id, loadMarks]);

  const all = useMemo(() => allMarks(hl, bm), [hl, bm]);
  const tabCounts = { all: all.length, highlights: hl.length, notes: all.filter((m) => inTab(m, "notes")).length, bookmarks: bm.length };
  // a search that matched the book's title shows all its marks
  const titleHit = current && needle && `${current.title} ${current.author ?? ""}`.toLowerCase().includes(needle);
  const shown = all.filter((m) => inTab(m, tab) && (titleHit || matches(m, needle)));

  const refresh = () => {
    if (current) loadMarks(current.id);
    loadBooks();
  };
  const onRemove = async (m: Mark) => {
    if (m.kind === "hl") await hls.remove(m.h.id).catch(() => {});
    else await bms.remove(m.b.id).catch(() => {});
    refresh();
  };
  const onSaveBookmark = async (b: Bookmark, title: string | null, note: string | null) => {
    await bms.update(b.id, title, note).catch(() => {});
    refresh();
  };
  const onExport = async () => {
    if (!current) return;
    try {
      const path = await exportMarkdown(current.id);
      if (path) setMsg(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setMsg(null), 3000);
  };

  if (books && !books.length)
    return (
      <div className="scroll">
        <div className="soon">
          <i className="ms">bookmarks</i>
          <b>No marks yet</b>
          <p>
            Highlights, notes and bookmarks from every book show here. In a book, select words to highlight them, or press <kbd>Ctrl</kbd> <kbd>B</kbd> to mark a page.
          </p>
        </div>
      </div>
    );

  return (
    <div className="bmpage">
      <div className="bmleft">
        <div className="sfield">
          <i className="ms">search</i>
          <input value={q} placeholder="Search every mark" aria-label="Search every mark" onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button type="button" className="clear" aria-label="Clear" onClick={() => setQ("")}>
              <i className="ms">close</i>
            </button>
          )}
        </div>
        <div className="mrows">
          {shownBooks.map((b) => (
            <button key={b.id} type="button" className={`mr book ${current?.id === b.id ? "here" : ""}`} onClick={() => setPicked(b.id)}>
              <Cover book={asBook(b)} size="m" progress={false} />
              <div>
                <span className="bn">{b.title}</span>
                <small>{counts(b)}</small>
              </div>
            </button>
          ))}
          {books && !shownBooks.length && <div className="empty">Nothing matches “{q.trim()}”.</div>}
        </div>
      </div>
      {current && (
        <div className="bmright">
          <div className="bmhead">
            <Cover book={asBook(current)} size="m" progress={false} />
            <div className="rct">
              <span className="ti">{current.title}</span>
              <span className="su">
                {[current.author, current.fraction ? `${Math.round(current.fraction * 100)}%` : "", sync ? syncWords[sync] : ""].filter(Boolean).join(" · ")}
              </span>
            </div>
            <button type="button" className="pill fill" onClick={() => open(current.id)}>
              <i className="ms">menu_book</i>
              {current.fraction ? "Continue" : "Read"}
            </button>
            <button type="button" className="pill" onClick={onExport} title="Save this book's highlights, notes and bookmarks as a Markdown file">
              <i className="ms">download</i>Export
            </button>
          </div>
          {msg && <div className="bmmsg">{msg}</div>}
          <Tabs tab={tab} setTab={setTab} counts={tabCounts} />
          <MarkRows
            marks={shown}
            onGo={(m) => open(current.id, m.cfi)}
            onRemove={onRemove}
            onSaveBookmark={onSaveBookmark}
            empty={needle ? "Nothing in this book matches." : tab === "notes" ? "No notes in this book yet." : `No ${tab === "all" ? "marks" : tab} in this book yet.`}
          />
        </div>
      )}
    </div>
  );
}
