import { useEffect, useMemo, useRef } from "react";
import { Spinner } from "../components/Spinner";
import { SyncPill } from "../components/SyncPill";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, BOOK_EXTENSIONS, m7, READABLE, type Book } from "../lib/api";
import { fmtTime, plural, progressLabel } from "../lib/format";
import { useStore } from "../lib/store";
import { listing, search } from "../lib/tree";
import { inPlace, isScoped, reading, tileReading } from "../lib/dashboard";
import { Cover, Peek } from "../components/Cover";
import { BookSheet } from "../components/BookSheet";
import { ReadingBand, useDash } from "../components/ReadingBand";
import "../styles/dashboard.css";

export async function addFolder() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Add a folder of books" });
  if (typeof dir === "string") await api.addPaths([dir]);
}

export async function addBooks() {
  const files = await openDialog({
    multiple: true,
    title: "Add books",
    filters: [{ name: "Books", extensions: BOOK_EXTENSIONS }],
  });
  if (Array.isArray(files) && files.length) await api.addPaths(files);
  return Array.isArray(files) ? files : [];
}

function StatusPill() {
  const scan = useStore((s) => s.scan);
  const folders = useStore((s) => s.folders);
  const title =
    (folders.length ? folders.map((f) => f.path).join(" and ") + " are" : "Your folders are") +
    " checked when Katana Desk starts and while it's open. Click to check now.";
  return (
    <button type="button" className="pill tone" title={title} onClick={() => api.scanNow()} disabled={scan.scanning}>
      {scan.scanning ? <Spinner /> : <i className="ms">folder</i>}
      {scan.scanning
        ? scan.total > 50
          ? `Checking folders · ${scan.done.toLocaleString("en-US")} of ${scan.total.toLocaleString("en-US")}`
          : "Checking folders…"
        : `Folders up to date${scan.lastScan ? ` · ${fmtTime(scan.lastScan)}` : ""}`}
    </button>
  );
}

function BookCard({ book, selected }: { book: Book; selected: boolean }) {
  const select = useStore((s) => s.select);
  const open = useStore((s) => s.open);
  const readable = READABLE.has(book.format);
  return (
    <div
      className={`bk ${selected ? "sel" : ""}`}
      data-id={book.id}
      tabIndex={selected ? 0 : -1}
      onClick={(e) => (e.ctrlKey && readable ? m7.openWindow(book.id, null, book.title) : select(book.id))}
      onDoubleClick={() => readable && open(book.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        useStore.getState().setMenu({ x: e.clientX, y: e.clientY, local: book });
      }}
      title={book.author ? `${book.title} · ${book.author}` : book.title}
    >
      <Cover book={book} />
      <div className="bt">
        <span>{book.title}</span>
        <button type="button" aria-label="The book's page" onClick={(e) => { e.stopPropagation(); select(book.id); }}>
          <i className="ms">more_horiz</i>
        </button>
      </div>
      <div className={`ba ${book.author ? "" : "unk"}`}>{book.author ?? "Author unknown"}</div>
      <div className="bm">{progressLabel(book.fraction, readable, book.format)}</div>
    </div>
  );
}

/** Arrow keys move between covers (up and down by rows), Space shows the book's page, Enter opens it. */
function useGridKeys(gridRef: React.RefObject<HTMLDivElement | null>, books: Book[]) {
  const { selectedId, sheetOpen, select, open, closeSheet, readingId } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readingId != null) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape" && sheetOpen) return closeSheet();
      const cards = [...(gridRef.current?.querySelectorAll<HTMLElement>(".bk") ?? [])];
      if (!cards.length) return;
      const idx = cards.findIndex((c) => Number(c.dataset.id) === selectedId);
      const book = books.find((b) => b.id === selectedId);
      if (e.key === "Enter" && book) {
        e.preventDefault();
        if (READABLE.has(book.format)) open(book.id);
        return;
      }
      if (e.key === " " && book) {
        e.preventDefault();
        sheetOpen ? closeSheet() : select(book.id, true);
        return;
      }
      const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
      if (!arrows.includes(e.key)) return;
      e.preventDefault();
      let next = idx < 0 ? 0 : idx;
      if (idx >= 0) {
        if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
        if (e.key === "ArrowRight") next = Math.min(cards.length - 1, idx + 1);
        if (e.key === "Home") next = 0;
        if (e.key === "End") next = cards.length - 1;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const r = cards[idx].getBoundingClientRect();
          const down = e.key === "ArrowDown";
          const rows = cards
            .map((c, i) => ({ i, r: c.getBoundingClientRect() }))
            .filter(({ r: q }) => (down ? q.top > r.top + 4 : q.top < r.top - 4));
          if (rows.length) {
            const rowTop = down ? Math.min(...rows.map((x) => x.r.top)) : Math.max(...rows.map((x) => x.r.top));
            const row = rows.filter((x) => Math.abs(x.r.top - rowTop) < 4);
            next = row.reduce((a, b) => (Math.abs(b.r.left - r.left) < Math.abs(a.r.left - r.left) ? b : a)).i;
          }
        }
      }
      const id = Number(cards[next].dataset.id);
      select(id, sheetOpen);
      cards[next].focus({ preventScroll: true });
      cards[next].scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gridRef, books, selectedId, sheetOpen, select, open, closeSheet, readingId]);
}

export function LocalPage() {
  const { folders, books: all, place, goPlace, selectedId, sheetOpen, query, loaded } = useStore();
  // books downloaded from Grimmory show on the Grimmory page
  const books = useMemo(() => all.filter((b) => b.source === "local"), [all]);
  const gridRef = useRef<HTMLDivElement>(null);
  const l = useMemo(() => listing(folders, books, place), [folders, books, place]);
  const found = useMemo(() => (query.trim() ? search(books, query) : null), [books, query]);
  const shown = found ?? l.books;
  useGridKeys(gridRef, shown);
  const selected = books.find((b) => b.id === selectedId);
  const empty = loaded && folders.length === 0 && books.length === 0;

  // the reading band: all of Local at its top, the folder you're in inside one
  const [dash, reloadDash] = useDash();
  const r = useMemo(() => reading(books, dash, Date.now()), [books, dash]);
  const at = useMemo(
    () => ({ folderId: place.folderId ?? (folders.length === 1 ? folders[0].id : null), sub: place.sub }),
    [place, folders],
  );
  const scoped = isScoped(at, folders);
  const here = useMemo(() => (scoped ? books.filter((b) => inPlace(b, at)) : books), [books, at, scoped]);
  const rHere = useMemo(() => (scoped ? reading(here, dash, Date.now()) : r), [scoped, here, dash, r]);
  const scopeName = scoped ? (at.sub.length ? at.sub[at.sub.length - 1] : folders.find((f) => f.id === at.folderId)?.name ?? "") : null;
  const quiet = useMemo(() => new Set(r.quiet.map((b) => b.id)), [r]);

  return (
    <>
      <div className={`scroll ${sheetOpen && selected ? "with-sheet" : ""}`}>
        <div className="sech">
          <span className="h">
            Local
            <span className="c">
              {plural(books.length, "book")}
              {folders.length ? ` in ${plural(folders.length, "folder")}` : ""}
            </span>
          </span>
          <div className="pills">
            <SyncPill otherwise={folders.length > 0 && <StatusPill />} />
            <button type="button" className="pill fill" onClick={addFolder}><i className="ms">create_new_folder</i>Add a folder</button>
            <button type="button" className="pill" onClick={addBooks}><i className="ms">add</i>Add books</button>
          </div>
        </div>

        {empty ? (
          <div className="empty">
            <i className="ms big">folder_open</i>
            <b>Add the folders where your books live</b>
            <p>Katana Desk shows them as they are on disk, checks them every time it starts and while it's open, and never moves or changes a file. You can also drop books and folders anywhere in this window.</p>
            <div className="pills" style={{ justifyContent: "center", marginTop: 6 }}>
              <button type="button" className="pill fill" onClick={addFolder}><i className="ms">create_new_folder</i>Add a folder</button>
              <button type="button" className="pill" onClick={addBooks}><i className="ms">add</i>Add books</button>
            </div>
          </div>
        ) : found ? (
          <>
            <div className="glabel">{found.length ? `${plural(found.length, "book")} matching “${query.trim()}”` : `Nothing matches “${query.trim()}”`}</div>
            <div className="grid" ref={gridRef}>
              {found.map((b) => <BookCard key={b.id} book={b} selected={b.id === selectedId} />)}
            </div>
          </>
        ) : (
          <>
            <nav className="crumbs" aria-label="Folder path">
              {l.crumbs.map((c, i) => (
                <span key={i} style={{ display: "contents" }}>
                  {i > 0 && <i className="ms">chevron_right</i>}
                  {c.to ? (
                    <button type="button" onClick={() => goPlace(c.to!)}>{c.label}</button>
                  ) : (
                    <span className="here">{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
            <ReadingBand books={here} r={rHere} dash={dash} reload={reloadDash} folders={folders} scope={scopeName} />
            {l.tiles.length > 0 && (
              <>
                <div className="glabel">Folders<span className="gc">{l.tiles.length.toLocaleString("en-US")}</span></div>
                <div className="folders">
                  {l.tiles.map((t) => {
                    // the books being read in this folder peek out of it, and are listed under its name
                    const tr = tileReading(r, t.to);
                    const peeks = [...tr, ...t.peek.filter((p) => !tr.includes(p))].slice(0, 2);
                    const pct = (b: Book) => Math.round((b.fraction ?? 0) * 100);
                    const tip = tr.length ? ` · reading ${tr.map((b) => `${b.title} ${pct(b)}%`).join(", ")}` : "";
                    return (
                      <button type="button" className="fbtn" key={t.name} onClick={() => goPlace(t.to)} title={`Open ${t.name}${tip}`}>
                        <span className="fold">
                          <span className="back" />
                          {peeks[0] && <Peek book={peeks[0]} side="a" progress={tr.includes(peeks[0])} />}
                          {peeks[1] && <Peek book={peeks[1]} side="b" progress={tr.includes(peeks[1])} />}
                          <span className="front" />
                        </span>
                        <span className="fname">{t.name}</span>
                        <span className="fcount">{t.count}</span>
                        {tr.length > 0 && (
                          <span className="frl">
                            {tr.slice(0, 2).map((b) => (
                              <span className={`r ${quiet.has(b.id) ? "q" : ""}`} key={b.id}>
                                <span className="rl"><span>{b.title}</span><span>{pct(b)}%</span></span>
                                <span className="pbar"><i style={{ width: `${pct(b)}%` }} /></span>
                              </span>
                            ))}
                            {tr.length > 2 && <span className="more">+{tr.length - 2} more</span>}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {l.label && <div className="glabel">{l.label}</div>}
            <div className="grid" ref={gridRef}>
              {l.books.map((b) => <BookCard key={b.id} book={b} selected={b.id === selectedId} />)}
            </div>
          </>
        )}
      </div>
      {sheetOpen && selected && <BookSheet book={selected} />}
    </>
  );
}
