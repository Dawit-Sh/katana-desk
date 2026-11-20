// The Bookmarks page: one long list, every book with highlights, notes or bookmarks and its marks right under
// it, in reading order under their chapters. One search covers every mark of every book, one row of tabs
// filters them all. A mark opens the book there; Export saves a book's marks as Markdown.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { ReadsDiff, type Reads } from "./ReadsDiff";
import { Cover } from "../components/Cover";
import { m7, type Book } from "../lib/api";
const readsApi = {
  get: (bookId: number) => invoke<Reads>("book_reads", { bookId }),
  start: (bookId: number) => invoke<number>("book_new_read", { bookId }),
};
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

type Data = { hl: Highlight[]; bm: Bookmark[]; sync: MarksSync | null; reads: Reads | null };

export function BookmarksPage() {
  const open = useStore((s) => s.open);
  const [books, setBooks] = useState<MarkedBook[] | null>(null);
  const [data, setData] = useState<Record<number, Data>>({});
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Set<number> | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [msg, setMsg] = useState<{ id: number; text: string } | null>(null);
  // folded books (kept), the read each book shows (0: every read), the book being compared
  const [folded, setFolded] = useState<Set<number>>(new Set());
  const [readOf, setReadOf] = useState<Record<number, number>>({});
  const [diffFor, setDiffFor] = useState<number | null>(null);
  useEffect(() => {
    api.getSetting("bookmarks.folded").then((v) => v && setFolded(new Set(JSON.parse(v) as number[]))).catch(() => {});
  }, []);
  const fold = (id: number) =>
    setFolded((f) => {
      const n = new Set(f);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      api.setSetting("bookmarks.folded", JSON.stringify([...n])).catch(() => {});
      return n;
    });
  const needle = q.trim().toLowerCase();
  const loaded = useRef(new Set<number>());

  const loadOne = useCallback(async (id: number) => {
    loaded.current.add(id);
    const [h, b, st, rd] = await Promise.all([hls.list(id), bms.list(id), marksApi.syncState(id), readsApi.get(id).catch(() => null)]).catch(
      () => [[], [], null, null] as const,
    );
    setData((d) => ({ ...d, [id]: { hl: h as Highlight[], bm: b as Bookmark[], sync: st as MarksSync | null, reads: rd as Reads | null } }));
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
          const rn = readOf[b.id] ?? 0;
          const inRead = (m: Mark) => !rn || !d?.reads || (m.kind === "hl" ? d.reads.hl[m.h.id] ?? 1 : d.reads.bm[m.b.id] ?? 1) === rn;
          const shown = all.filter((m) => inTab(m, tab) && inRead(m) && (titleHit || matches(m, needle)));
          return { b, d, shown };
        })
        .filter((x) => !x.d || x.shown.length > 0 || (readOf[x.b.id] ?? 0) > 0),
    [books, hits, data, tab, needle, readOf],
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
        <section key={b.id} className={`bmsec ${folded.has(b.id) ? "folded" : ""}`} aria-label={b.title}>
          <div className="bmhead">
            <button
              type="button"
              className="ib fold"
              aria-expanded={!folded.has(b.id)}
              aria-label={folded.has(b.id) ? `Show ${b.title}'s marks` : `Fold ${b.title}'s marks`}
              title={folded.has(b.id) ? "Show the marks" : "Fold"}
              onClick={() => fold(b.id)}
            >
              <i className="ms">{folded.has(b.id) ? "chevron_right" : "expand_more"}</i>
            </button>
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
          {!folded.has(b.id) && d?.reads && (
            <div className="readbar">
              {d.reads.reads.length > 1 && (
                <span className="seg" role="radiogroup" aria-label="Which read">
                  {[0, ...d.reads.reads.map((r) => r.n)].map((n) => (
                    <button
                      type="button"
                      key={n}
                      role="radio"
                      aria-checked={(readOf[b.id] ?? 0) === n}
                      className={(readOf[b.id] ?? 0) === n ? "on" : ""}
                      onClick={() => setReadOf((r) => ({ ...r, [b.id]: n }))}
                      title={n ? `The marks of read ${n}` : "The marks of every read"}
                    >
                      {n ? `Read ${n}` : "Every read"}
                    </button>
                  ))}
                </span>
              )}
              {d.reads.reads.length > 1 && (
                <button type="button" className="pill tone" onClick={() => setDiffFor(b.id)} title="Two reads side by side: what stood out each time">
                  <i className="ms">compare</i>Compare reads
                </button>
              )}
              <button
                type="button"
                className="pill ghost"
                title={`Marks made from now on go to read ${d.reads.current + 1}, so this read's stay as they are`}
                onClick={async () => {
                  const n = await readsApi.start(b.id).catch(() => null);
                  if (n) setMsg({ id: b.id, text: n > d.reads!.current ? `Read ${n} started: new marks go there` : `Read ${n} has no marks yet, so it's still the current read` });
                  setTimeout(() => setMsg(null), 3500);
                  loadOne(b.id);
                }}
              >
                <i className="ms">replay</i>New read
              </button>
              <small className="readnow">New marks go to read {d.reads.current}</small>
            </div>
          )}
          {folded.has(b.id) ? null : d ? (
            <div className="bmscroll">
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
            </div>
          ) : (
            <div className="bmmsg">Loading…</div>
          )}
        </section>
      ))}
      {diffFor != null && data[diffFor]?.reads && (
        <ReadsDiff
          title={books?.find((x) => x.id === diffFor)?.title ?? ""}
          reads={data[diffFor].reads!}
          hl={data[diffFor].hl}
          bm={data[diffFor].bm}
          onClose={() => setDiffFor(null)}
        />
      )}
    </div>
  );
}
