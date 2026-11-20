// The reader's panels: they float over the page, and a pin docks them beside it (the page moves over).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Overlayer } from "foliate-js/overlayer.js";
import { fmtWhen } from "../lib/format";
import type { Bookmark } from "./marks";

// biome-ignore lint: foliate-js has no types
type FoliateView = HTMLElement & any;

export function Panel({
  side,
  title,
  sub,
  pinned,
  docked,
  width,
  onPin,
  onClose,
  children,
  label,
}: {
  side: "left" | "right";
  title: string;
  sub?: ReactNode;
  pinned: boolean;
  /** pinned and with room to dock (a narrow window keeps it floating) */
  docked: boolean;
  width: number;
  onPin: () => void;
  onClose: () => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <aside
      className={`fpanel ${docked ? "docked" : "glass"} ${side}`}
      style={{ width }}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="ph">
        <div className="pt">
          <b>{title}</b>
          {sub && <small>{sub}</small>}
        </div>
        <button
          type="button"
          className="pbtn"
          aria-label={pinned ? "Unpin the panel" : "Pin the panel"}
          title={pinned ? "Unpin: float it over the page again" : "Pin: dock it beside the page"}
          aria-pressed={pinned}
          onClick={onPin}
        >
          <i className={`ms ${pinned ? "f" : ""}`}>push_pin</i>
        </button>
        <button type="button" className="pbtn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <i className="ms">close</i>
        </button>
      </div>
      {children}
    </aside>
  );
}

export type TocItem = { label?: string; href?: string; subitems?: TocItem[] };

/** Contents: the book's chapters with their pages, the one you're in lit up. */
export function ContentsPanel({
  toc,
  current,
  pageOf,
  onGo,
}: {
  toc: TocItem[];
  current: string | null;
  pageOf: (href: string) => number | string | null;
  onGo: (href: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // the branches that hold the current chapter start open
  const holds = (it: TocItem): boolean => it.href === current || !!it.subitems?.some(holds);
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const walk = (items: TocItem[], path: string) =>
      items.forEach((it, i) => {
        const key = `${path}/${i}`;
        if (it.subitems?.length && holds(it)) s.add(key);
        if (it.subitems) walk(it.subitems, key);
      });
    walk(toc, "");
    return s;
  });
  useEffect(() => {
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "center" });
    // only when the panel opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rows = (items: TocItem[], depth: number, path: string): ReactNode =>
    items.map((it, i) => {
      const key = `${path}/${i}`;
      const kids = it.subitems?.length ? it.subitems : null;
      const isOpen = open.has(key);
      const page = it.href ? pageOf(it.href) : null;
      return (
        <div key={key} role="treeitem" aria-expanded={kids ? isOpen : undefined}>
          <div className={`trow ${it.href === current ? "on" : ""}`} style={{ paddingLeft: 12 + depth * 16 }}>
            {kids ? (
              <button
                type="button"
                className="tw"
                aria-label={isOpen ? "Fold" : "Unfold"}
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(key)) n.delete(key);
                    else n.add(key);
                    return n;
                  })
                }
              >
                <i className="ms">{isOpen ? "expand_more" : "chevron_right"}</i>
              </button>
            ) : (
              <span className="tw" />
            )}
            <button type="button" className="tl" onClick={() => it.href && onGo(it.href)} disabled={!it.href}>
              <span>{it.label?.trim() || "Untitled"}</span>
              {page != null && <small>{page}</small>}
            </button>
          </div>
          {kids && isOpen && <div role="group">{rows(kids, depth + 1, key)}</div>}
        </div>
      );
    });
  const flat = !toc.some((it) => it.subitems?.length);
  return (
    <div className={`toc ${flat ? "flat" : ""}`} role="tree" ref={listRef}>
      {toc.length ? rows(toc, 0, "") : <div className="empty">This book has no contents list.</div>}
    </div>
  );
}

type Hit = { cfi: string; excerpt: { pre: string; match: string; post: string }; n: number };
type Group = { label: string; hits: Hit[] };

/** Search in the book: every hit marked on the page, a counter, Enter for the next one. */
export function SearchPanel({
  view,
  initial,
  onQuery,
  onFirstJump,
  focusKey,
}: {
  view: FoliateView;
  initial: string;
  onQuery: (q: string) => void;
  /** the place before the first hit you go to (for "Back to p. N") */
  onFirstJump: () => void;
  /** changes when Ctrl F is pressed again, to focus the field */
  focusKey: number;
}) {
  const [q, setQ] = useState(initial);
  const [groups, setGroups] = useState<Group[]>([]);
  const [total, setTotal] = useState(0);
  const [cur, setCur] = useState(-1);
  const [progress, setProgress] = useState<number | null>(null);
  const [ran, setRan] = useState("");
  const run = useRef(0);
  const jumped = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  const search = async (query: string) => {
    const token = ++run.current;
    onQuery(query);
    setGroups([]);
    setTotal(0);
    setCur(-1);
    jumped.current = false;
    setRan(query);
    if (query.trim().length < 2) {
      view.clearSearch?.();
      setProgress(null);
      return;
    }
    setProgress(0);
    let n = 0;
    const found: Group[] = [];
    try {
      for await (const r of view.search({
        query: query.trim(),
        matchCase: false,
        matchDiacritics: false,
        matchWholeWords: false,
        draw: Overlayer.highlight,
        drawOptions: { color: "#f2c230" },
      })) {
        if (token !== run.current) return;
        if (r === "done") break;
        if (typeof r.progress === "number") setProgress(r.progress);
        if (r.subitems) {
          const g: Group = { label: r.label?.trim() || "", hits: r.subitems.map((s: Omit<Hit, "n">) => ({ ...s, n: n++ })) };
          found.push(g);
          setGroups([...found]);
          setTotal(n);
        }
      }
    } catch (e) {
      console.error(e);
    }
    if (token === run.current) setProgress(null);
  };

  // searching starts a moment after typing stops
  useEffect(() => {
    if (q === ran) return;
    const t = window.setTimeout(() => search(q), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // the hits stay marked until the panel closes
  useEffect(
    () => () => {
      run.current++;
      try {
        view.clearSearch?.();
        view.deselect?.();
      } catch {
        /* the book closed */
      }
    },
    [view],
  );

  const go = (i: number) => {
    if (!hits.length) return;
    const k = (i + hits.length) % hits.length;
    if (!jumped.current) {
      jumped.current = true;
      onFirstJump();
    }
    setCur(k);
    view.select(hits[k].cfi);
    document.getElementById(`hit-${k}`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <>
      <div className="sfield">
        <i className="ms">search</i>
        <input
          ref={inputRef}
          value={q}
          placeholder="Search this book"
          aria-label="Search this book"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (q !== ran) search(q);
              else go(e.shiftKey ? cur - 1 : cur + 1);
            }
          }}
        />
        {q && (
          <button type="button" className="clear" aria-label="Clear" onClick={() => setQ("")}>
            <i className="ms">close</i>
          </button>
        )}
      </div>
      <div className="scount">
        <span>
          {progress != null && <span className="spin" aria-hidden="true" />}
          {ran.trim().length < 2
            ? "Type two letters or more"
            : total === 0
              ? progress != null
                ? `Searching… ${Math.round(progress * 100)}%`
                : "No matches"
              : `${cur >= 0 ? `${(cur + 1).toLocaleString("en-US")} of ` : ""}${total.toLocaleString("en-US")} ${total === 1 ? "match" : "matches"}${progress != null ? ` · ${Math.round(progress * 100)}%` : ""}`}
        </span>
        <span className="grow" />
        <button type="button" className="pill sq" aria-label="Previous match" title="Previous match (Shift Enter)" disabled={!total} onClick={() => go(cur - 1)}>
          <i className="ms">keyboard_arrow_up</i>
        </button>
        <button type="button" className="pill sq" aria-label="Next match" title="Next match (Enter)" disabled={!total} onClick={() => go(cur + 1)}>
          <i className="ms">keyboard_arrow_down</i>
        </button>
      </div>
      <div className="hits">
        {groups.map((g, gi) => (
          <div key={gi}>
            {g.label && <div className="gl">{g.label}</div>}
            {g.hits.map((h) => (
              <button type="button" key={h.n} id={`hit-${h.n}`} className={`hit ${h.n === cur ? "on" : ""}`} onClick={() => go(h.n)}>
                {h.excerpt.pre}
                <mark>{h.excerpt.match}</mark>
                {h.excerpt.post}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/** Bookmarks in this book (the marks panel; highlights and words join it in milestones 4 and 5). */
export function MarksPanel({
  marks,
  here,
  hereLabel,
  fraction,
  onGo,
  onRemove,
}: {
  marks: Bookmark[];
  here: Set<number>;
  hereLabel: string;
  fraction: number;
  onGo: (b: Bookmark) => void;
  onRemove: (b: Bookmark) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? marks.filter((b) =>
        [b.title, b.note, b.excerpt, b.chapter, b.pageLabel ? `page ${b.pageLabel} p. ${b.pageLabel}` : ""]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      )
    : marks;
  // "You're here" sits between the bookmarks before and after this page
  const hereAt = shown.findIndex((b) => (b.fraction ?? 0) > fraction + 1e-9 && !here.has(b.id));
  const step = (dir: 1 | -1) => {
    const list = dir === 1 ? marks.filter((b) => (b.fraction ?? 0) > fraction + 1e-6 && !here.has(b.id)) : marks.filter((b) => (b.fraction ?? 0) < fraction - 1e-6 && !here.has(b.id));
    const b = dir === 1 ? list[0] : list[list.length - 1];
    if (b) onGo(b);
  };
  const row = (b: Bookmark) => (
    <div key={b.id} className={`mr ${here.has(b.id) ? "here" : ""}`}>
      <button type="button" className="mgo" onClick={() => onGo(b)}>
        <i className="ms f ribbon-ic">bookmark</i>
        <div>
          <span className="mt">{b.title || (b.pageLabel ? `p. ${b.pageLabel}` : `${Math.round((b.fraction ?? 0) * 100)}%`)}{b.chapter ? <em> · {b.chapter}</em> : null}</span>
          {b.excerpt && <q>{b.excerpt}</q>}
          <small>{fmtWhen(b.createdAt)}</small>
        </div>
      </button>
      <button type="button" className="pbtn del" aria-label="Remove the bookmark" title="Remove" onClick={() => onRemove(b)}>
        <i className="ms">delete</i>
      </button>
    </div>
  );
  return (
    <>
      <div className="tabs" role="tablist">
        <span className="on" role="tab" aria-selected="true">
          Bookmarks<em>{marks.length}</em>
        </span>
      </div>
      {marks.length > 3 && (
        <div className="sfield">
          <i className="ms">search</i>
          <input value={q} placeholder="Search bookmarks" aria-label="Search bookmarks" onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="mrows">
        {!marks.length && (
          <div className="empty">
            No bookmarks yet. Press <kbd>Ctrl</kbd> <kbd>B</kbd>, click the page's top corner or the ribbon button to mark a page.
          </div>
        )}
        {shown.map((b, i) => (
          <div key={b.id} style={{ display: "contents" }}>
            {i === hereAt && !needle && <div className="herel">You're here · {hereLabel}</div>}
            {row(b)}
          </div>
        ))}
        {hereAt === -1 && !needle && marks.length > 0 && !marks.some((b) => here.has(b.id)) && <div className="herel">You're here · {hereLabel}</div>}
      </div>
      {marks.length > 0 && (
        <div className="pfoot">
          <span className="grow" />
          <button type="button" className="pill sq" aria-label="Previous bookmark" title="Previous bookmark" onClick={() => step(-1)}>
            <i className="ms">chevron_left</i>
          </button>
          <button type="button" className="pill sq" aria-label="Next bookmark" title="Next bookmark" onClick={() => step(1)}>
            <i className="ms">chevron_right</i>
          </button>
        </div>
      )}
    </>
  );
}
