import { useEffect, useRef, useState } from "react";
import { api, grimmory, READABLE, type Book } from "../lib/api";
import { fmtAgo, fmtDate, fmtSize, fmtWhen } from "../lib/format";
import { useStore } from "../lib/store";
import { Cover } from "./Cover";

/** The book's page at the side (400 px), opened by one click on a cover. */
export function BookSheet({ book }: { book: Book }) {
  const close = useStore((s) => s.closeSheet);
  const open = useStore((s) => s.open);
  const folders = useStore((s) => s.folders);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => setMenu(false), [book.id]);
  // the same file on Grimmory? Then its place syncs with the Fire (checked by partial MD5, once)
  const signedIn = useStore((s) => !!s.g?.signedIn);
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
        <Cover book={book} size="l" progress={false} />
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
        </div>
      </div>
      <div className="acts2">
        <button
          type="button"
          className="pill fill wide"
          disabled={!readable}
          title={readable ? "Open (Enter or double-click)" : `${book.format.toUpperCase()} reading comes in a later version`}
          onClick={() => open(book.id)}
        >
          <i className="ms">menu_book</i>
          {!readable ? `${book.format.toUpperCase()} comes later` : started ? `Continue · ${pct}%` : "Start reading"}
        </button>
        <button type="button" className="pill" disabled title="Lists come in a later version">
          <i className="ms">checklist</i>Add to a list
        </button>
        <button type="button" className="pill" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
          <i className="ms">more_horiz</i>More
        </button>
        {menu && (
          <div className="menu" ref={menuRef} style={{ right: 0, top: 96 }}>
            <button type="button" onClick={() => { api.reveal(book.path); setMenu(false); }}>
              <i className="ms">folder_open</i>Show in File Explorer
            </button>
            <button type="button" onClick={() => { navigator.clipboard.writeText(book.path); setMenu(false); }}>
              <i className="ms">content_copy</i>Copy the file's path
            </button>
          </div>
        )}
      </div>
      <dl className="dl">
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
          <span className="pill tone" style={{ height: 30, fontSize: 12.5 }} title="The same file is on Grimmory: its reading place syncs with the Fire">
            <i className="ms">cloud_done</i>
            {book.placeState === "pending" ? "Place syncing…" : book.syncedAt ? `Synced ${fmtAgo(book.syncedAt)}` : "On Grimmory too"}
          </span>
        )}
        <span className="su">Added {fmtDate(book.addedAt)}</span>
      </div>
    </aside>
  );
}
