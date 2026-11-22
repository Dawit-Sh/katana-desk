import { useEffect, useRef, useState } from "react";
import { StatusPill } from "./StatusPill";
import { api, bookKey, grimmory, m7, READABLE, type Book } from "../lib/api";
import { fmtAgo, fmtDate, fmtSize, fmtWhen } from "../lib/format";
import { useStore } from "../lib/store";
import { Cover } from "./Cover";
import { coverForBook } from "./CoverDialog";
import { ListMenu } from "../pages/ListsPage";

/** The book's page at the side (400 px), opened by one click on a cover. */
export function BookSheet({ book }: { book: Book }) {
  const close = useStore((s) => s.closeSheet);
  const open = useStore((s) => s.open);
  const folders = useStore((s) => s.folders);
  const [menu, setMenu] = useState<false | "more" | "lists">(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setMenu(false), [book.id]);
  const onLists = useStore((s) => s.lists.filter((l) => l.books.includes(bookKey(book))).length);
  // the same file on Grimmory? Then its place syncs with the Fire (checked by partial MD5, once)
  const signedIn = useStore((s) => !!s.g?.signedIn);
  const gStatus = useStore((s) => (book.grimmoryId != null ? s.catalog.books.find((b) => b.id === book.grimmoryId)?.readStatus ?? null : null));
  const [gid, setGid] = useState<number | null>(book.grimmoryId);
  useEffect(() => {
    setGid(book.grimmoryId);
    if (book.grimmoryId != null || !signedIn || !READABLE.has(book.format)) return;
    let live = true;
    grimmory.match(book.id).then((id) => live && setGid(id)).catch(() => {});
    return () => {
      live = false;
    };
  }, [book.id, book.grimmoryId, book.format, signedIn]);
  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [menu]);

  const readable = READABLE.has(book.format);
  const frac = book.fraction ?? 0;
  const pct = Math.round(frac * 100);
  const folder = folders.find((f) => f.id === book.folderId);
  const where = folder ? [folder.name, ...(book.relDir ? book.relDir.split("/") : [])].join(" › ") : "Added one by one";
  const fileName = book.path.split(/[\\/]/).pop();
  const started = frac > 0.004;

  return (
    <aside className="sheet" aria-label={book.title}>
      <div className="shd">
        <span className="shl">On this PC · {fmtSize(book.size)}</span>
        <button type="button" aria-label="Close" title="Close (Esc)" onClick={close}><i className="ms">close</i></button>
      </div>
      <div className="shb">
        <div className="cvwrap">
          <Cover book={book} size="l" progress={false} />
          <button type="button" className="cvbtn" onClick={() => useStore.getState().setCoverFor(coverForBook(book))} title="Pick another cover, or your own picture">
            <i className="ms">image</i>Change cover
          </button>
        </div>
        <div className="rct">
          <span className="ti">{book.title}</span>
          {book.author && <span className="su">{book.author}</span>}
          <span className="su">{book.format.toUpperCase()} · Local</span>
          {readable && (
            <>
              <div className="pbar"><i style={{ width: `${pct}%` }} /></div>
              <span className="su">
                {started ? `${pct}%` : "Not started"}
                {started && book.chapter ? ` · ${book.chapter}` : ""}
              </span>
            </>
          )}
          {readable && <StatusPill gid={signedIn ? gid : null} status={gStatus} localId={book.id} started={started} />}
        </div>
      </div>
      <div className="acts2">
        <button
          type="button"
          className="pill fill wide"
          disabled={!readable}
          title={readable ? "Open (Enter or double-click)" : `${book.format.toUpperCase()} reading comes in a later version`}
          onClick={(e) => (e.ctrlKey ? m7.openWindow(book.id, null, book.title) : open(book.id))}
        >
          <i className="ms">menu_book</i>
          {!readable ? `${book.format.toUpperCase()} comes later` : started ? `Continue · ${pct}%` : "Start reading"}
        </button>
        <button type="button" className={`pill ${onLists ? "tone" : ""}`} onClick={() => setMenu((m) => (m === "lists" ? false : "lists"))} aria-expanded={menu === "lists"}>
          <i className="ms">checklist</i>{onLists ? `On ${onLists === 1 ? "a list" : `${onLists} lists`}` : "Add to a list"}
        </button>
        <button type="button" className="pill" onClick={() => setMenu((m) => (m === "more" ? false : "more"))} aria-expanded={menu === "more"}>
          <i className="ms">more_horiz</i>More
        </button>
        {menu === "lists" && (
          <div className="menu" ref={menuRef} style={{ left: 0, top: 96 }}>
            <ListMenu bookKey={bookKey(book)} />
          </div>
        )}
        {menu === "more" && (
          <div className="menu" ref={menuRef} style={{ right: 0, top: 96 }}>
            {readable && (
              <button type="button" onClick={() => { m7.openWindow(book.id, null, book.title); setMenu(false); }}>
                <i className="ms">open_in_new</i>Open in a new window
              </button>
            )}
            <button type="button" onClick={() => { useStore.getState().setCoverFor(coverForBook(book)); setMenu(false); }}>
              <i className="ms">image</i>Change cover…
            </button>
            <button type="button" onClick={() => { api.reveal(book.path); setMenu(false); }}>
              <i className="ms">folder_open</i>Show in File Explorer
            </button>
            <button type="button" onClick={() => { navigator.clipboard.writeText(book.path); setMenu(false); }}>
              <i className="ms">content_copy</i>Copy the file's path
            </button>
          </div>
        )}
      </div>
      <dl className="facts">
        <dt>Folder</dt><dd>{where}</dd>
        <dt>File</dt><dd>{fileName}</dd>
        <dt>Size</dt><dd>{fmtSize(book.size)}</dd>
        {book.openedAt && (<><dt>Last read</dt><dd>{fmtWhen(book.openedAt)}</dd></>)}
      </dl>
      <div className="row2" style={{ marginTop: "auto" }}>
        <span className="pill tone" style={{ height: 30, fontSize: 12.5 }} title={book.path}>
          <i className="ms">folder</i>On this PC
        </span>
        {gid != null && (
          <span className="pill tone" style={{ height: 30, fontSize: 12.5 }} title="The same file is on Grimmory: its reading place syncs with your other devices">
            <i className="ms">cloud_done</i>
            {book.placeState === "pending" ? "Place syncing…" : book.syncedAt ? `Synced ${fmtAgo(book.syncedAt)}` : "On Grimmory too"}
          </span>
        )}
        <span className="su">Added {fmtDate(book.addedAt)}</span>
      </div>
    </aside>
  );
}
