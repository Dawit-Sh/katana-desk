// Grimmory: the library on the Zima, kept on this PC (signed in once, synced in the background).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { grimmory, gFormat, gReadable, m7, READABLE, type Book, type Dl, type GBook } from "../lib/api";
import { fmtAgo, fmtDate, fmtMb, fmtTime, fmtWhen, plural } from "../lib/format";
import { useStore, type GFilter, type GSort } from "../lib/store";
import { GCover } from "../components/Cover";
import { GBookSheet } from "../components/GBookSheet";

const STEP = 120;

const byTitle = (a: GBook, b: GBook) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

/** How far through: this PC's place for a book that's here, Grimmory's otherwise. */
export function useProgressOf() {
  const books = useStore((s) => s.books);
  const byId = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  return useCallback(
    (g: GBook): { fraction: number | null; local: Book | null; when: number | null } => {
      const local = g.localId != null ? byId.get(g.localId) ?? null : null;
      const lf = local?.fraction ?? null;
      const when = Math.max(local?.openedAt ?? 0, g.lastRead ?? 0) || null;
      return { fraction: lf != null && lf > 0 ? lf : g.progress, local, when };
    },
    [byId],
  );
}

const statusOf = (f: number | null) => (f == null || f <= 0.004 ? "unread" : f >= 0.995 ? "read" : "reading");

const label = (f: number | null, readable: boolean, fmt: string) => {
  if (!readable) return fmt;
  if (f == null || f <= 0) return "Not started";
  if (f >= 0.995) return "Finished";
  const p = Math.round(f * 100);
  return p < 1 ? "Just started" : `${p}%`;
};

export function SignIn() {
  const g = useStore((s) => s.g);
  const setG = useStore((s) => s.setG);
  const [url, setUrl] = useState(g?.url ?? "http://192.168.100.100:6060");
  const [user, setUser] = useState(g?.user ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const st = await grimmory.signIn(url, user, password);
      setPassword("");
      setG(st);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="signin" onSubmit={submit}>
      <div className="hd">
        <i className="ms">cloud</i>
        <b>{g?.signedOut ? "Sign in to Grimmory again" : "Sign in to Grimmory"}</b>
        <p>
          {g?.signedOut
            ? "Grimmory signed this PC out. Your books and places here are safe; sign in to sync again."
            : "Your whole library on the Zima, with the reading place shared with the Fire. Your password goes to Grimmory once and isn't kept."}
        </p>
      </div>
      <label className="field">Server
        <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoComplete="url" />
      </label>
      <label className="field">Username
        <input value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} autoComplete="username" autoFocus={!user} />
      </label>
      <label className="field">Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!user} />
      </label>
      {error && <div className="err" role="alert">{error}</div>}
      <button type="submit" className="pill fill" disabled={busy || !user.trim() || !password}>
        <i className={`ms ${busy ? "spin" : ""}`}>{busy ? "progress_activity" : "login"}</i>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

/** One small pill for where the library stands; click to sync now. */
function SyncPill() {
  const g = useStore((s) => s.g)!;
  const total = useStore((s) => s.catalog.books.length);
  const [checking, setChecking] = useState(false);
  if (g.reach === "offline") {
    return (
      <button
        type="button"
        className="pill tone"
        disabled={checking}
        title={`Grimmory (${g.url}) can't be reached. Katana Desk looks again by itself; click to look now.`}
        onClick={async () => {
          setChecking(true);
          await grimmory.check().catch(() => {});
          setChecking(false);
        }}
      >
        <i className={`ms ${checking ? "spin" : ""}`}>{checking ? "progress_activity" : "cloud_off"}</i>
        {checking ? "Looking for Grimmory…" : g.waiting ? `Offline · ${plural(g.waiting, "place")} waiting` : "Offline · Try again"}
      </button>
    );
  }
  const text = g.syncing
    ? g.syncTotal > 100 && total < g.syncTotal
      ? `Getting your library · ${g.syncDone.toLocaleString("en-US")} of ${g.syncTotal.toLocaleString("en-US")}`
      : "Syncing…"
    : g.waiting
      ? `${plural(g.waiting, "place")} waiting to sync`
      : `Synced${g.lastSync ? ` · ${fmtTime(g.lastSync)}` : ""}`;
  return (
    <button
      type="button"
      className="pill tone"
      disabled={g.syncing}
      title={g.lastError ? `The last sync didn't finish: ${g.lastError}` : "Library and reading places synced with Grimmory. Click to sync now."}
      onClick={() => grimmory.sync(false).catch(() => {})}
    >
      <i className={`ms ${g.syncing ? "spin" : ""}`}>{g.syncing ? "progress_activity" : g.lastError ? "sync_problem" : "cloud_done"}</i>
      {text}
    </button>
  );
}

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [open, close]);
  return ref;
}

const SORTS: { id: GSort; name: string }[] = [
  { id: "lastRead", name: "Last read" },
  { id: "added", name: "Recently added" },
  { id: "title", name: "Title" },
  { id: "author", name: "Author" },
];

function SortPill() {
  const { gSort, setGSort } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className="pill" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className="ms">sort</i>{SORTS.find((s) => s.id === gSort)?.name}
      </button>
      {open && (
        <div className="menu" style={{ left: 0, top: 40 }}>
          {SORTS.map((s) => (
            <button type="button" key={s.id} className={gSort === s.id ? "on" : ""} onClick={() => { setGSort(s.id); setOpen(false); }}>
              <i className="ms">{gSort === s.id ? "check" : ""}</i>{s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUSES: { id: GFilter["status"]; name: string; icon: string }[] = [
  { id: "any", name: "Any", icon: "auto_stories" },
  { id: "reading", name: "Reading", icon: "local_library" },
  { id: "unread", name: "Not started", icon: "book" },
  { id: "read", name: "Finished", icon: "task_alt" },
];

function FilterPill() {
  const { gFilter, setGFilter, catalog } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const pick = (f: Partial<GFilter>) => setGFilter({ ...gFilter, ...f });
  const on = (kind: GFilter["kind"], id?: number) => gFilter.kind === kind && gFilter.id === id;
  const active = gFilter.kind !== "all" || gFilter.status !== "any";
  const shelves = catalog.shelves.filter((s) => s.kind === "shelf");
  const magic = catalog.shelves.filter((s) => s.kind === "magic");
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className={`pill ${active ? "tone" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className="ms">filter_list</i>Filters
      </button>
      {open && (
        <div className="menu wide" style={{ left: 0, top: 40 }}>
          <div className="mh">How far</div>
          {STATUSES.map((s) => (
            <button type="button" key={s.id} className={gFilter.status === s.id ? "on" : ""} onClick={() => pick({ status: s.id })}>
              <i className="ms">{s.icon}</i>{s.name}
            </button>
          ))}
          <div className="mh">Libraries</div>
          <button type="button" className={on("all") ? "on" : ""} onClick={() => pick({ kind: "all", id: undefined })}>
            <i className="ms">cloud</i>All of Grimmory
          </button>
          {catalog.libraries.map((l) => (
            <button type="button" key={`l${l.id}`} className={on("library", l.id) ? "on" : ""} onClick={() => pick({ kind: "library", id: l.id })}>
              <i className="ms">library_books</i>{l.name}
            </button>
          ))}
          {shelves.length > 0 && <div className="mh">Shelves</div>}
          {shelves.map((s) => (
            <button type="button" key={`s${s.id}`} className={on("shelf", s.id) ? "on" : ""} onClick={() => pick({ kind: "shelf", id: s.id })}>
              <i className="ms">shelves</i>{s.name}
            </button>
          ))}
          {magic.length > 0 && <div className="mh">Magic shelves</div>}
          {magic.map((s) => (
            <button type="button" key={`m${s.id}`} className={on("magic", s.id) ? "on" : ""} onClick={() => pick({ kind: "magic", id: s.id })}>
              <i className="ms">auto_awesome</i>{s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DownloadsPill() {
  const downloads = useStore((s) => s.downloads);
  const books = useStore((s) => s.catalog.books);
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const list = Object.values(downloads).filter((d) => d.state !== "done");
  if (!list.length) return null;
  const going = list.filter((d) => d.state === "running" || d.state === "queued").length;
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className="pill" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <i className="ms">download</i>Downloads · {list.length}
      </button>
      {open && (
        <div className="menu wide" style={{ left: 0, top: 40 }}>
          <div className="mh">{going ? `${plural(going, "book")} coming` : "Downloads"}</div>
          {list.map((d) => <DlItem key={d.bookId} d={d} title={books.find((b) => b.id === d.bookId)?.title ?? `Book ${d.bookId}`} />)}
        </div>
      )}
    </div>
  );
}

export const dlText = (d: Dl) => {
  const bytes = d.total ? `${fmtMb(d.done)} of ${fmtMb(d.total)}` : d.done ? fmtMb(d.done) : "";
  switch (d.state) {
    case "queued":
      return "Waiting its turn";
    case "running":
      return bytes || "Starting…";
    case "paused":
      return `Paused${bytes ? ` · ${bytes}` : ""}`;
    case "waiting":
      return `Waiting for Grimmory${bytes ? ` · ${bytes}` : ""}`;
    case "failed":
      return d.error ?? "Didn't download";
    default:
      return "";
  }
};

export function DlButtons({ d }: { d: Dl }) {
  return (
    <>
      {(d.state === "running" || d.state === "queued") && (
        <button type="button" className="ib" title="Pause (it goes on from here later)" onClick={() => grimmory.pause(d.bookId)}>
          <i className="ms">pause</i>
        </button>
      )}
      {(d.state === "paused" || d.state === "waiting") && (
        <button type="button" className="ib" title="Go on" onClick={() => grimmory.resume(d.bookId)}>
          <i className="ms">play_arrow</i>
        </button>
      )}
      {d.state === "failed" && (
        <button type="button" className="ib" title="Try again" onClick={() => grimmory.resume(d.bookId)}>
          <i className="ms">refresh</i>
        </button>
      )}
      <button type="button" className="ib" title="Stop and forget this download" onClick={() => grimmory.cancel(d.bookId)}>
        <i className="ms">close</i>
      </button>
    </>
  );
}

function DlItem({ d, title }: { d: Dl; title: string }) {
  const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
  return (
    <div className="dli">
      <div className="row2">
        <b>{title}</b>
        <span className="row2" style={{ flex: "none", gap: 2 }}><DlButtons d={d} /></span>
      </div>
      <div className="pbar" style={{ margin: 0 }}><i style={{ width: `${pct}%` }} /></div>
      <span className="su">{dlText(d)}</span>
    </div>
  );
}

/** Ctrl+click: the book in a window of its own, when its file is on this PC (else its page). */
function ctrlOpen(b: GBook) {
  const st = useStore.getState();
  const local = b.localId != null ? st.books.find((x) => x.id === b.localId) : undefined;
  if (local && READABLE.has(local.format)) m7.openWindow(local.id, null, b.title);
  else st.gSelect(b.id);
}

function ContinueRow({ books }: { books: GBook[] }) {
  const progressOf = useProgressOf();
  const gSelect = useStore((s) => s.gSelect);
  const openG = useStore((s) => s.openG);
  const recent = useMemo(
    () =>
      books
        .map((b) => ({ b, p: progressOf(b) }))
        .filter(({ p }) => p.when && p.fraction != null && p.fraction > 0.004 && p.fraction < 0.995)
        .sort((a, b) => (b.p.when ?? 0) - (a.p.when ?? 0))
        .slice(0, 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [books, progressOf],
  );
  if (!recent.length) return null;
  return (
    <div className="cards">
      {recent.map(({ b, p }, i) => {
        const pct = Math.round((p.fraction ?? 0) * 100);
        const sub = [b.authors, p.local?.chapter].filter(Boolean).join(" · ");
        return (
          <button
            type="button"
            key={b.id}
            className={`rcard ${i ? "small" : ""}`}
            onClick={(e) => (e.ctrlKey ? ctrlOpen(b) : gSelect(b.id))}
            onDoubleClick={() => gReadable(b) && openG(b.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              useStore.getState().setMenu({ x: e.clientX, y: e.clientY, g: b });
            }}
            title="One click shows the book's page; a double-click opens it"
          >
            <GCover book={b} size={i ? "s" : "m"} />
            <div className="rct">
              <span className="ov">{i ? fmtWhen(p.when!) : `Continue reading · ${fmtWhen(p.when!).replace(/^(Today|Yesterday)/, (w) => w.toLowerCase())}`}</span>
              <span className="ti">{b.title}</span>
              <span className="su">{i ? `${pct}%` : sub || `${pct}%`}</span>
              {!i && <div className="pbar"><i style={{ width: `${pct}%` }} /></div>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function GCard({ b, selected }: { b: GBook; selected: boolean }) {
  const gSelect = useStore((s) => s.gSelect);
  const openG = useStore((s) => s.openG);
  const d = useStore((s) => s.downloads[b.id]);
  const progressOf = useProgressOf();
  const p = progressOf(b);
  const readable = gReadable(b);
  const coming = d && d.state !== "done" && d.state !== "none";
  return (
    <div
      className={`bk ${selected ? "sel" : ""}`}
      data-id={b.id}
      tabIndex={selected ? 0 : -1}
      onClick={(e) => (e.ctrlKey ? ctrlOpen(b) : gSelect(b.id))}
      onDoubleClick={() => readable && openG(b.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        useStore.getState().setMenu({ x: e.clientX, y: e.clientY, g: b });
      }}
      title={b.authors ? `${b.title} · ${b.authors}` : b.title}
    >
      <GCover book={b} progress={p.fraction} />
      <div className="bt">
        <span>{b.title}</span>
        <button type="button" aria-label="The book's page" onClick={(e) => { e.stopPropagation(); gSelect(b.id); }}>
          <i className="ms">more_horiz</i>
        </button>
      </div>
      <div className="bm">{coming ? dlText(d) : label(p.fraction, readable, gFormat(b))}</div>
    </div>
  );
}

function GRow({ b, selected }: { b: GBook; selected: boolean }) {
  const gSelect = useStore((s) => s.gSelect);
  const openG = useStore((s) => s.openG);
  const progressOf = useProgressOf();
  const p = progressOf(b);
  const readable = gReadable(b);
  return (
    <div
      className={`lrow bk-row ${selected ? "sel" : ""}`}
      data-id={b.id}
      tabIndex={selected ? 0 : -1}
      onClick={(e) => (e.ctrlKey ? ctrlOpen(b) : gSelect(b.id))}
      onDoubleClick={() => readable && openG(b.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        useStore.getState().setMenu({ x: e.clientX, y: e.clientY, g: b });
      }}
    >
      <GCover book={b} size="s" />
      <div style={{ minWidth: 0 }}>
        <div className="t1">{b.title}</div>
        <div className="su">{b.series ? `${b.series}${b.seriesNumber != null ? ` #${b.seriesNumber}` : ""}` : gFormat(b)}</div>
      </div>
      <span className="su">{b.authors ?? ""}</span>
      <span className="su">{label(p.fraction, readable, gFormat(b))}</span>
      <span className="su">{p.when ? fmtWhen(p.when) : b.addedOn ? `Added ${fmtDate(b.addedOn)}` : ""}</span>
    </div>
  );
}

function search(books: GBook[], q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return books.filter((b) => {
    const hay = `${b.title} ${b.authors ?? ""} ${b.series ?? ""} ${b.tags ?? ""} ${b.categories ?? ""} ${b.publisher ?? ""} ${b.fileName ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Arrow keys between covers (rows in the list), Space shows the book's page, Enter opens it, Esc closes the page. */
function useKeys(ref: React.RefObject<HTMLDivElement | null>, books: GBook[]) {
  const { gSelected, gSheet, gSelect, openG, readingId } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readingId != null) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape" && gSheet) return gSelect(gSelected, false);
      const cards = [...(ref.current?.querySelectorAll<HTMLElement>("[data-id]") ?? [])];
      if (!cards.length) return;
      const idx = cards.findIndex((c) => Number(c.dataset.id) === gSelected);
      const book = books.find((b) => b.id === gSelected);
      if (e.key === "Enter" && book) {
        e.preventDefault();
        if (gReadable(book)) openG(book.id);
        return;
      }
      if (e.key === " " && book) {
        e.preventDefault();
        gSelect(book.id, !gSheet);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
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
          const rows = cards.map((c, i) => ({ i, r: c.getBoundingClientRect() })).filter(({ r: q }) => (down ? q.top > r.top + 4 : q.top < r.top - 4));
          if (rows.length) {
            const top = down ? Math.min(...rows.map((x) => x.r.top)) : Math.max(...rows.map((x) => x.r.top));
            next = rows
              .filter((x) => Math.abs(x.r.top - top) < 4)
              .reduce((a, b) => (Math.abs(b.r.left - r.left) < Math.abs(a.r.left - r.left) ? b : a)).i;
          }
        }
      }
      gSelect(Number(cards[next].dataset.id), gSheet);
      cards[next].focus({ preventScroll: true });
      cards[next].scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref, books, gSelected, gSheet, gSelect, openG, readingId]);
}

export function GrimmoryPage() {
  const { g, catalog, gSort, gFilter, gView, setGView, gSelected, gSheet, query, reloadCatalog } = useStore();
  const progressOf = useProgressOf();
  const gridRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(STEP);
  const [signIn, setSignIn] = useState(false);

  useEffect(() => {
    if (g?.signedIn) reloadCatalog().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g?.signedIn]);

  const filtered = useMemo(() => {
    let list = catalog.books;
    if (gFilter.kind === "library") list = list.filter((b) => b.libraryId === gFilter.id);
    if (gFilter.kind === "shelf" || gFilter.kind === "magic") {
      const ids = new Set(catalog.shelves.find((s) => s.kind === gFilter.kind && s.id === gFilter.id)?.bookIds ?? []);
      list = list.filter((b) => ids.has(b.id));
    }
    if (gFilter.status !== "any") list = list.filter((b) => statusOf(progressOf(b).fraction) === gFilter.status);
    if (query.trim()) list = search(list, query);
    const sorted = [...list];
    if (gSort === "title") sorted.sort(byTitle);
    else if (gSort === "author") sorted.sort((a, b) => (a.authors ?? "￿").localeCompare(b.authors ?? "￿") || byTitle(a, b));
    else if (gSort === "added") sorted.sort((a, b) => (b.addedOn ?? 0) - (a.addedOn ?? 0));
    else sorted.sort((a, b) => (progressOf(b).when ?? 0) - (progressOf(a).when ?? 0) || (b.addedOn ?? 0) - (a.addedOn ?? 0));
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, gFilter, gSort, query, progressOf]);

  useEffect(() => setShown(STEP), [gFilter, gSort, query, gView]);
  // more covers as you scroll
  useEffect(() => {
    const el = moreRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && setShown((n) => n + STEP), { rootMargin: "1200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length, shown]);

  const visible = filtered.slice(0, shown);
  useKeys(gridRef, visible);
  const selected = catalog.books.find((b) => b.id === gSelected);

  // signed out by Grimmory: the books already here stay readable, with a way to sign in again
  const keepShowing = !!g?.signedOut && catalog.books.length > 0;
  if (!g?.signedIn && !keepShowing) {
    return (
      <div className="scroll">
        <SignIn />
      </div>
    );
  }
  if (!g) return null;

  const filterName =
    gFilter.kind === "library"
      ? catalog.libraries.find((l) => l.id === gFilter.id)?.name
      : gFilter.kind === "shelf" || gFilter.kind === "magic"
        ? catalog.shelves.find((s) => s.kind === gFilter.kind && s.id === gFilter.id)?.name
        : null;
  const statusName = STATUSES.find((s) => s.id === gFilter.status && s.id !== "any")?.name;
  const heading = query.trim() ? `Matching “${query.trim()}”` : [filterName ?? "All titles", statusName].filter(Boolean).join(" · ");
  const loading = catalog.books.length === 0;

  return (
    <>
      <div className={`scroll ${gSheet && selected ? "with-sheet" : ""}`}>
        {!g.signedIn && signIn && <SignIn />}
        {!query.trim() && gFilter.kind === "all" && <ContinueRow books={catalog.books} />}
        <div className="sech">
          <span className="h">
            {heading}
            <span className="c">{filtered.length.toLocaleString("en-US")}</span>
          </span>
          <div className="pills">
            {g.signedIn ? (
              <SyncPill />
            ) : (
              <button type="button" className="pill tone" onClick={() => setSignIn((v) => !v)} title="Grimmory signed this PC out. Books already on this PC still open.">
                <i className="ms">cloud_off</i>Signed out · Sign in
              </button>
            )}
            <DownloadsPill />
            <FilterPill />
            <SortPill />
            <span className="seg" role="radiogroup" aria-label="View">
              <button type="button" role="radio" aria-checked={gView === "grid"} className={gView === "grid" ? "on" : ""} title="Covers" onClick={() => setGView("grid")}>
                <i className="ms">grid_view</i>
              </button>
              <button type="button" role="radio" aria-checked={gView === "list"} className={gView === "list" ? "on" : ""} title="List" onClick={() => setGView("list")}>
                <i className="ms">view_list</i>
              </button>
            </span>
          </div>
        </div>
        {loading ? (
          <div className="empty">
            <i className={`ms big ${g.syncing ? "spin" : ""}`}>{g.syncing ? "progress_activity" : "cloud_sync"}</i>
            <b>{g.syncing ? "Getting your library" : g.reach === "offline" ? "Grimmory can't be reached" : "Your library comes next"}</b>
            <p>
              {g.syncing
                ? "Books show as they arrive. After this first time, only changes are fetched."
                : g.lastError ?? "Katana Desk fetches your Grimmory library once and keeps it on this PC."}
            </p>
          </div>
        ) : !filtered.length ? (
          <div className="glabel">Nothing here{query.trim() ? ` matches “${query.trim()}”` : ""}.</div>
        ) : gView === "grid" ? (
          <div className="grid" ref={gridRef}>
            {visible.map((b) => <GCard key={b.id} b={b} selected={b.id === gSelected} />)}
          </div>
        ) : (
          <div className="rows" ref={gridRef}>
            {visible.map((b) => <GRow key={b.id} b={b} selected={b.id === gSelected} />)}
          </div>
        )}
        {shown < filtered.length && <div className="more" ref={moreRef} />}
        {g.lastSync && !g.syncing && (
          <div className="su" style={{ textAlign: "center", padding: 8 }}>
            {g.url.replace(/^https?:\/\//, "")} · synced {fmtAgo(g.lastSync)}
          </div>
        )}
      </div>
      {gSheet && selected && <GBookSheet book={selected} />}
    </>
  );
}
