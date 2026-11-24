import { useEffect, useRef, useState } from "react";
import { StatusPill } from "./StatusPill";
import { api, grimmory, gFormat, gReadable, m7, READABLE, type GBook } from "../lib/api";
import { fmtAgo, fmtDate, fmtMb, fmtWhen } from "../lib/format";
import { useStore } from "../lib/store";
import { GCover } from "./Cover";
import { coverForG } from "./CoverDialog";
import { ListMenu } from "../pages/ListsPage";
import { DlButtons, dlText, useProgressOf } from "../pages/GrimmoryPage";

/** A Grimmory book's page at the side (400 px): one click on a cover. */
export function GBookSheet({ book }: { book: GBook }) {
  const close = () => useStore.getState().gSelect(book.id, false);
  const openG = useStore((s) => s.openG);
  const d = useStore((s) => s.downloads[book.id]);
  const g = useStore((s) => s.g);
  const catalog = useStore((s) => s.catalog);
  const progressOf = useProgressOf();
  const p = progressOf(book);
  const [menu, setMenu] = useState<false | "more" | "lists">(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const onLists = useStore((s) => s.lists.filter((l) => l.books.includes(`g:${book.id}`)).length);
  useEffect(() => setMenu(false), [book.id]);
  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [menu]);
  // "Synced 2 min ago" ticks over while the page is open
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const readable = gReadable(book);
  const fmt = gFormat(book);
  const frac = p.fraction ?? 0;
  const pct = Math.round(frac * 100);
  const started = frac > 0.004;
  const here = p.local != null;
  const size = book.sizeKb ? book.sizeKb * 1024 : p.local?.size ?? 0;
  const coming = d && d.state !== "done" && d.state !== "none";
  const library = catalog.libraries.find((l) => l.id === book.libraryId)?.name;
  const shelves = catalog.shelves.filter((s) => s.bookIds.includes(book.id)).map((s) => s.name);
  const pages = book.pageCount ? `${book.pageCount} pages` : null;

  let action: React.ReactNode;
  if (!readable) {
    action = (
      <button type="button" className="pill fill wide" disabled title={book.fileType === "AUDIOBOOK" ? "Audiobooks play in Grimmory" : `${fmt} reading comes in a later version`}>
        <i className="ms">{book.fileType === "AUDIOBOOK" ? "headphones" : "menu_book"}</i>
        {book.fileType === "AUDIOBOOK" ? "Plays in Grimmory" : `${fmt} comes later`}
      </button>
    );
  } else if (coming) {
    const dp = d.total ? Math.round((d.done / d.total) * 100) : 0;
    action = (
      <button
        type="button"
        className="pill fill wide"
        title={d.state === "running" || d.state === "queued" ? "Getting the book from Grimmory. Click to pause." : "Go on"}
        onClick={() => (d.state === "running" || d.state === "queued" ? grimmory.pause(book.id) : grimmory.resume(book.id))}
      >
        <i className="ms">{d.state === "running" || d.state === "queued" ? "pause" : d.state === "failed" ? "refresh" : "play_arrow"}</i>
        {d.state === "running" ? `Getting the book · ${dp}%` : d.state === "queued" ? "Getting the book…" : d.state === "failed" ? "Try again" : `Go on · ${dp}%`}
      </button>
    );
  } else {
    action = (
      <button type="button" className="pill fill wide" onClick={() => openG(book.id)} title={here ? "Open (Enter or double-click)" : "Gets the book from Grimmory and opens it"}>
        <i className="ms">{here ? "menu_book" : "download"}</i>
        {started ? `Continue · ${pct}%` : here ? "Start reading" : "Get and read"}
      </button>
    );
  }

  let syncPill: React.ReactNode = null;
  if (p.local) {
    const waiting = p.local.placeState === "pending";
    syncPill = (
      <span className="pill tone" style={{ height: 30, fontSize: 12.5 }} title="This book's reading place is synced with Grimmory">
        <i className="ms">{waiting ? (g?.reach === "offline" ? "cloud_off" : "cloud_upload") : "cloud_done"}</i>
        {waiting ? (g?.reach === "offline" ? "Place waits for Grimmory" : "Place syncing…") : p.local.syncedAt ? `Synced ${fmtAgo(p.local.syncedAt)}` : "On this PC"}
      </span>
    );
  } else if (!coming) {
    syncPill = (
      <span className="pill tone" style={{ height: 30, fontSize: 12.5 }} title="On Grimmory; it comes to this PC when you open it">
        <i className="ms">cloud</i>On Grimmory
      </span>
    );
  }

  return (
    <aside className="sheet" aria-label={book.title}>
      <div className="shd">
        <span className="shl">{here ? "On this PC" : "On Grimmory"}{size ? ` · ${fmtMb(size)}` : ""}</span>
        <button type="button" aria-label="Close" title="Close (Esc)" onClick={close}><i className="ms">close</i></button>
      </div>
      <div className="shb">
        <div className="cvwrap">
          <GCover book={book} size="l" />
          <button type="button" className="cvbtn" onClick={() => useStore.getState().setCoverFor(coverForG(book))} title="Pick another cover, or your own picture (Grimmory's stays as it is)">
            <i className="ms">image</i>Change cover
          </button>
        </div>
        <div className="rct">
          <span className="ti">{book.title}</span>
          {book.authors && <span className="su">{book.authors}</span>}
          <span className="su">{[fmt, pages, "Grimmory"].filter(Boolean).join(" · ")}</span>
          {readable && (
            <>
              <div className="pbar"><i style={{ width: `${pct}%` }} /></div>
              <span className="su">
                {started ? (frac >= 0.995 ? "Finished" : `${pct}%`) : "Not started"}
                {started && p.local?.chapter ? ` · ${p.local.chapter}` : ""}
              </span>
            </>
          )}
          <StatusPill gid={book.id} status={book.readStatus} localId={p.local?.id ?? null} started={started} title={book.title} />
        </div>
      </div>
      <div className="acts2">
        {action}
        <button type="button" className={`pill ${onLists ? "tone" : ""}`} onClick={() => setMenu((m) => (m === "lists" ? false : "lists"))} aria-expanded={menu === "lists"}>
          <i className="ms">checklist</i>{onLists ? `On ${onLists === 1 ? "a list" : `${onLists} lists`}` : "Add to a list"}
        </button>
        <button type="button" className="pill" onClick={() => setMenu((m) => (m === "more" ? false : "more"))} aria-expanded={menu === "more"}>
          <i className="ms">more_horiz</i>More
        </button>
        {menu === "lists" && (
          <div className="menu" ref={menuRef} style={{ left: 0, top: 96 }}>
            <ListMenu bookKey={`g:${book.id}`} />
          </div>
        )}
        {menu === "more" && (
          <div className="menu" ref={menuRef} style={{ right: 0, top: 96 }}>
            {p.local && READABLE.has(p.local.format) && (
              <button type="button" onClick={() => { m7.openWindow(p.local!.id, null, book.title); setMenu(false); }}>
                <i className="ms">open_in_new</i>Open in a new window
              </button>
            )}
            <button type="button" onClick={() => { useStore.getState().setCoverFor(coverForG(book)); setMenu(false); }}>
              <i className="ms">image</i>Change cover…
            </button>
            {!here && !coming && (
              <button type="button" onClick={() => { grimmory.download(book.id, false); setMenu(false); }}>
                <i className="ms">download</i>Download to this PC
              </button>
            )}
            {p.local && (
              <button type="button" onClick={() => { api.reveal(p.local!.path); setMenu(false); }}>
                <i className="ms">folder_open</i>Show in File Explorer
              </button>
            )}
            <button type="button" onClick={() => { navigator.clipboard.writeText(`${g?.url ?? ""}/book/${book.id}`); setMenu(false); }}>
              <i className="ms">link</i>Copy its Grimmory link
            </button>
          </div>
        )}
      </div>
      {coming && (
        <div className="dlrow">
          <div className="top">
            <span className="su">{dlText(d)}</span>
            <span className="row2" style={{ gap: 2, flexWrap: "nowrap" }}><DlButtons d={d} /></span>
          </div>
          <div className="pbar"><i style={{ width: `${d.total ? Math.round((d.done / d.total) * 100) : 0}%` }} /></div>
        </div>
      )}
      <dl className="facts">
        {book.series && (<><dt>Series</dt><dd>{book.series}{book.seriesNumber != null ? ` · ${book.seriesNumber}` : ""}</dd></>)}
        {library && (<><dt>Library</dt><dd>{library}</dd></>)}
        {shelves.length > 0 && (<><dt>Shelves</dt><dd>{shelves.join(", ")}</dd></>)}
        {book.publisher && (<><dt>Publisher</dt><dd>{book.publisher}</dd></>)}
        {book.published && (<><dt>Published</dt><dd>{book.published.slice(0, 4)}</dd></>)}
        {book.language && (<><dt>Language</dt><dd>{book.language}</dd></>)}
        {book.categories && (<><dt>Genres</dt><dd>{book.categories}</dd></>)}
        {book.fileName && (<><dt>File</dt><dd>{book.fileName}</dd></>)}
        {p.when && (<><dt>Last read</dt><dd>{fmtWhen(p.when)}</dd></>)}
      </dl>
      <div className="row2" style={{ marginTop: "auto" }}>
        {syncPill}
        {book.addedOn && <span className="su">Added {fmtDate(book.addedOn)}</span>}
      </div>
    </aside>
  );
}
