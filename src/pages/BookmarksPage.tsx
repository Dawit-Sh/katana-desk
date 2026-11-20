// The Bookmarks page: one long list, every book with highlights, notes or bookmarks and its marks right under
// it, in reading order under their chapters. One search covers every mark of every book, one row of tabs
// filters them all. A mark opens the book there; Export saves a book's marks as Markdown.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cover } from "../components/Cover";
import { m7, type Book } from "../lib/api";
import { plural } from "../lib/format";
import { useStore } from "../lib/store";
import { MarkRows, Tabs, allMarks, inTab, logRevisit, matches, type Mark, type Tab } from "../reader/marklist";
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

type Data = { hl: Highlight[]; bm: Bookmark[]; sync: MarksSync | null };

export function BookmarksPage() {
  const open = useStore((s) => s.open);
  const [books, setBooks] = useState<MarkedBook[] | null>(null);
  const [data, setData] = useState<Record<number, Data>>({});
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Set<number> | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [msg, setMsg] = useState<{ id: number; text: string } | null>(null);
  const needle = q.trim().toLowerCase();
  const loaded = useRef(new Set<number>());

  const loadOne = useCallback(async (id: number) => {
    loaded.current.add(id);
    const [h, b, st] = await Promise.all([hls.list(id), bms.list(id), marksApi.syncState(id)]).catch(() => [[], [], null] as const);
    setData((d) => ({ ...d, [id]: { hl: h as Highlight[], bm: b as Bookmark[], sync: st as MarksSync | null } }));
  }, []);
  const loadAll = useCallback(async () => {
    const list = await marksApi.books().catch(() => [] as MarkedBook[]);
    setBooks(list);
    // a few books at a time, so a long list fills in from the top
    for (let i = 0; i < list.length; i += 6) await Promise.all(list.slice(i, i + 6).map((b) => loadOne(b.id)));
  }, [loadOne]);

  useEffect(() => {
    loadAll();
    const un = listen<number>("marks-changed", (e) => {
      marksApi
        .books()
        .then((list) => {
          setBooks(list);
          if (e.payload != null && list.some((b) => b.id === e.payload)) loadOne(e.payload);
          for (const b of list) if (!loaded.current.has(b.id)) loadOne(b.id);
        })
        .catch(() => {});
    });
    return () => {
      un.then((f) => f());
    };
  }, [loadAll, loadOne]);

  // search every mark of every book (and titles), a moment after typing stops
  useEffect(() => {
    if (!needle) return setHits(null);
    const t = setTimeout(() => marksApi.search(needle).then((ids) => setHits(new Set(ids))).catch(() => setHits(new Set())), 180);
    return () => clearTimeout(t);
  }, [needle]);

  const sections = useMemo(
    () =>
      (books ?? [])
        .filter((b) => !hits || hits.has(b.id))
        .map((b) => {
          const d = data[b.id];
          const all = d ? allMarks(d.hl, d.bm) : [];
          const titleHit = !!needle && `${b.title} ${b.author ?? ""}`.toLowerCase().includes(needle);
          const shown = all.filter((m) => inTab(m, tab) && (titleHit || matches(m, needle)));
          return { b, d, shown };
        })
        .filter((x) => !x.d || x.shown.length > 0),
    [books, hits, data, tab, needle],
  );
  const totals = useMemo(() => {
    let hl = 0;
    let bm = 0;
    let notes = 0;
    let all = 0;
    for (const d of Object.values(data)) {
      const a = allMarks(d.hl, d.bm);
      hl += d.hl.length;
      bm += d.bm.length;
      all += a.length;
      notes += a.filter((m) => inTab(m, "notes")).length;
    }
    return { all, highlights: hl, notes, bookmarks: bm };
  }, [data]);

  const onRemove = async (id: number, m: Mark) => {
    if (m.kind === "hl") await hls.remove(m.h.id).catch(() => {});
    else await bms.remove(m.b.id).catch(() => {});
    loadOne(id);
  };
  const onSaveBookmark = async (id: number, b: Bookmark, title: string | null, note: string | null) => {
    await bms.update(b.id, title, note).catch(() => {});
    loadOne(id);
  };
  const onExport = async (b: MarkedBook) => {
    try {
      const path = await exportMarkdown(b.id);
      if (path) setMsg({ id: b.id, text: `Saved ${path.split(/[\\/]/).pop()}` });
    } catch (e) {
      setMsg({ id: b.id, text: e instanceof Error ? e.message : String(e) });
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

  const nothing = needle ? `Nothing matches “${q.trim()}”.` : `No ${tab === "notes" ? "notes" : tab} yet.`;
  return (
    <div className="scroll bmlong">
      <div className="bmtop">
        <div className="sech">
          <span className="h">
            Bookmarks<span className="c">{books ? plural(books.length, "book") : ""}</span>
          </span>
          <div className="sfield">
            <i className="ms">search</i>
            <input value={q} placeholder="Search every mark" aria-label="Search every mark" onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button type="button" className="clear" aria-label="Clear" onClick={() => setQ("")}>
                <i className="ms">close</i>
              </button>
            )}
          </div>
        </div>
        <Tabs tab={tab} setTab={setTab} counts={totals} />
      </div>
      {books && !sections.length && <div className="bmmsg">{nothing}</div>}
      {sections.map(({ b, d, shown }) => (
        <section key={b.id} className="bmsec" aria-label={b.title}>
          <div className="bmhead">
            <Cover book={asBook(b)} size="m" progress={false} />
            <div className="rct">
              <span className="ti">{b.title}</span>
              <span className="su">
                {[b.author, counts(b), b.fraction ? `${Math.round(b.fraction * 100)}%` : "", d?.sync ? syncWords[d.sync] : ""].filter(Boolean).join(" · ")}
              </span>
              {msg?.id === b.id && <span className="su">{msg.text}</span>}
            </div>
            <button type="button" className="pill fill" onClick={(e) => (e.ctrlKey ? m7.openWindow(b.id, null, b.title) : open(b.id))}>
              <i className="ms">menu_book</i>
              {b.fraction ? "Continue" : "Read"}
            </button>
            <button type="button" className="pill" onClick={() => onExport(b)} title="Save this book's highlights, notes and bookmarks as a Markdown file">
              <i className="ms">download</i>Export
            </button>
          </div>
          {d ? (
            <MarkRows
              marks={shown}
              onGo={(m, ctrl) => {
                logRevisit(m);
                if (ctrl) m7.openWindow(b.id, m.cfi, b.title);
                else open(b.id, m.cfi);
              }}
              onRemove={(m) => onRemove(b.id, m)}
              onSaveBookmark={(bk, t, n) => onSaveBookmark(b.id, bk, t, n)}
              empty={`No ${tab === "all" ? "marks" : tab} in this book.`}
            />
          ) : (
            <div className="bmmsg">Loading…</div>
          )}
        </section>
      ))}
    </div>
  );
}
