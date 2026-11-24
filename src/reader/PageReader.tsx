// The page view: PDFs (PDF.js), DjVu (DjVuLibre) and comics (CBZ, CBR) as pages. Zoom, Fit width or
// Fit page, Scroll / One page / Two pages (and right to left for comics), all drawn as pictures in the
// top bar; a side panel with Pages (thumbnails, find hits per page), Contents and Marks; find with every
// match marked and a counter; highlights, underlines and notes pinned on the page, in the same marks
// tables as EPUB; bookmarks (Ctrl B, a page's corner, the ribbon); Look up; Back to p. N; the reading
// place, synced with Grimmory by page.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api, grimmory, type Book, type Offer } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { CaptionButtons } from "../components/TitleBar";
import { ContentsPanel, MarksPanel, Panel, type TocItem } from "./panels";
import { COLOURS, PDF_HEX, exportMarkdown, hls, marks as marksApi, marksApi as marksSync, pdfAnnots, type Annot, type Bookmark, type Colour, type Highlight, type Style } from "./marks";
import { HighlightCard, SelectionCard, copyText, type Anchor } from "./cards";
import { logRevisit, type Mark } from "./marklist";
import { WordCard, type WordAsk } from "./WordCard";
import { Review } from "../components/Review";
import { learning, sentenceIn, words as wordsApi, type Word } from "../lib/words";
import { editBookmark, highlightChanged, removeBookmark, removeHighlight, removeMarks, wordRemoved as recordWordRemoved } from "../lib/undoable";
import { PageView, roughBox, type Box, type Hit, type Pen } from "./PageView";
import { openPageSource, pagePlace, parsePlace, wordsPlace, type Outline, type PageSource, type PageText } from "./pagesrc";
import "./reader.css";
import "./pages.css";

type Fit = "width" | "page" | null;
type Mode = "scroll" | "one" | "two";
/** the page pictures' colours: as they are, inverted (light on dark), sepia or dimmed */
type Tint = "none" | "invert" | "sepia" | "dim";
type View = { fit: Fit; zoom: number; mode: Mode; rtl: boolean; tint?: Tint };
const TINTS: { id: Tint; name: string; title: string }[] = [
  { id: "none", name: "As it is", title: "The pages as they are" },
  { id: "invert", name: "Invert", title: "Light text on a dark page" },
  { id: "sepia", name: "Sepia", title: "Warm paper" },
  { id: "dim", name: "Dim", title: "A darker page for the evening" },
];
type SideTab = "pages" | "toc" | "marks";
type Sel = { page: number; s: number; e: number; text: string; anchor: Anchor };
type Card = { id: number; anchor: Anchor; editing: boolean };
type Toast = { text: string; undo?: () => void };
type Look = { color: Colour; style: Style };
type Back = { page: number; label: string };

const SIDE_W = 320;
const MIN_PAGE = 520;
const BARS_IDLE_MS = 2000;
const GAP = 16;
const TOP = 60;
const BOTTOM = 72;
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

const defaultView = (kind: PageSource["kind"]): View =>
  kind === "comic" ? { fit: "page", zoom: 1, mode: "two", rtl: false } : { fit: "width", zoom: 1, mode: "scroll", rtl: false };

const syncText = (s: string, comic: boolean, pdf = false) =>
  s === "synced"
    ? comic
      ? "Bookmarks sync with Grimmory."
      : pdf
        ? "Highlights, drawings and bookmarks sync with Grimmory's PDF reader."
        : "Bookmarks sync with Grimmory. Highlights stay on this PC."
    : s === "waiting"
      ? "Changes wait to go to Grimmory."
      : s === "format"
        ? "This format's marks stay on this PC."
        : "Highlights and bookmarks stay on this PC.";

/** The page's first words, for a bookmark. */
function firstWords(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= 160) return t || null;
  const cut = t.slice(0, 160);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 100 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** Pages shown together: one per row, or two side by side (the first page and wide pages alone, like a printed book). */
function rowsOf(count: number, mode: Mode, sizes: { w: number; h: number }[]): number[][] {
  if (mode !== "two") return Array.from({ length: count }, (_, i) => [i]);
  const rows: number[][] = [];
  let i = 0;
  const wide = (k: number) => sizes[k] && sizes[k].w > sizes[k].h * 1.1;
  if (count) rows.push([i++]);
  while (i < count) {
    if (wide(i) || i + 1 >= count || wide(i + 1)) rows.push([i++]);
    else {
      rows.push([i, i + 1]);
      i += 2;
    }
  }
  return rows;
}

/** Contents as the shared contents panel wants it: each item's place is "page|n". */
function tocOf(outline: Outline[]): { toc: TocItem[]; flat: { href: string; page: number }[] } {
  let n = 0;
  const flat: { href: string; page: number }[] = [];
  const walk = (items: Outline[]): TocItem[] =>
    items.map((it) => {
      const href = it.page != null ? `${it.page}|${n++}` : undefined;
      if (href && it.page != null) flat.push({ href, page: it.page });
      return { label: it.title, href, subitems: it.items.length ? walk(it.items) : undefined };
    });
  return { toc: walk(outline), flat };
}

/** The pictures in the top bar: how the page fits, how pages are laid out. */
const FitPic = ({ k }: { k: "width" | "page" }) => (
  <span className="frm">
    <i className={k === "width" ? "w" : "p"} />
  </span>
);
const ModePic = ({ k }: { k: Mode }) => (
  <span className="frm">
    {k === "scroll" ? <i className="s" /> : k === "one" ? <i className="p" /> : (
      <>
        <i className="p" />
        <i className="p" />
      </>
    )}
  </span>
);

export function PageReader({ book, onClose, startAt }: { book: Book; onClose: () => void; startAt?: string | null }) {
  const rdRef = useRef<HTMLDivElement>(null);
  const scRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<PageSource | null>(null);
  const srcRef = useRef(src);
  srcRef.current = src;
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [sizesV, setSizesV] = useState(0);
  const [view, setViewState] = useState<View>({ fit: "width", zoom: 1, mode: "scroll", rtl: false });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [page, setPage] = useState(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [winW, setWinW] = useState(window.innerWidth);
  const acted = useRef(false);
  const lastTurn = useRef(Date.now());
  /** pages turned since the last reading tick, for the Journal's pages an hour */
  const turns = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const comic = book.format === "cbz" || book.format === "cbr";

  // side panel, bars, marks
  const [side, setSide] = useState<SideTab | null>(null);
  const [pinned, setPinned] = useState(false);
  const [bars, setBars] = useState(true);
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const [hl, setHl] = useState<Highlight[]>([]);
  // a PDF's drawings (Grimmory's pen, its highlights, Katana's pen) and Katana's pen itself
  const [annots, setAnnots] = useState<Annot[]>([]);
  const [draw, setDraw] = useState<{ color: Colour; erase: boolean } | null>(null);
  const hlRef = useRef(hl);
  hlRef.current = hl;
  const [hlV, setHlV] = useState(0);
  const [back, setBack] = useState<Back | null>(null);
  const backRef = useRef(back);
  backRef.current = back;
  const [sel, setSel] = useState<Sel | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [card, setCard] = useState<Card | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  const [look, setLook] = useState<Look>({ color: "yellow", style: "highlight" });
  const lookRef = useRef(look);
  lookRef.current = look;
  const [pen, setPen] = useState(false);
  const [tintOpen, setTintOpen] = useState(false);
  const penRef = useRef(pen);
  penRef.current = pen;
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef(0);
  const [word, setWord] = useState<WordAsk | null>(null);
  const [bookWords, setBookWords] = useState<Word[]>([]);
  const [review, setReview] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [lost, setLost] = useState<{ highlights: number; bookmarks: number } | null>(null);
  const [syncLine, setSyncLine] = useState<string | null>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });

  // find
  const [find, setFind] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const hitsRef = useRef(hits);
  hitsRef.current = hits;
  const [hitAt, setHitAt] = useState(-1);
  const [searching, setSearching] = useState<{ done: number; total: number } | null>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findRun = useRef(0);

  const count = src?.count ?? 0;
  const dock = !!side && pinned && winW - SIDE_W >= MIN_PAGE;
  const offL = dock ? SIDE_W : 0;
  const floating = !!side && !dock;

  // ---------- the bars fade after 2 s of a still mouse ----------
  const barTimer = useRef(0);
  const overBars = useRef(false);
  const keep = useRef(false);
  keep.current = floating || !!offer || !!sel || !!card || !!word || review || !!lost || find || state !== "ready";
  const poke = useCallback(() => {
    setBars(true);
    clearTimeout(barTimer.current);
    barTimer.current = window.setTimeout(() => {
      if (!overBars.current && !keep.current) setBars(false);
    }, BARS_IDLE_MS);
  }, []);
  const hideBars = useCallback(() => {
    if (!overBars.current && !keep.current) {
      clearTimeout(barTimer.current);
      setBars(false);
    }
  }, []);
  useEffect(() => {
    if (keep.current) setBars(true);
    else poke();
  }, [floating, offer, state, poke, lost, word, review, find]);

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), t.undo ? 6000 : 2600);
  }, []);

  // ---------- the view: prefs per book ----------
  const setView = useCallback(
    (patch: Partial<View>) => {
      const v = { ...viewRef.current, ...patch };
      viewRef.current = v;
      setViewState(v);
      api.setSetting(`pageview.${book.id}`, JSON.stringify(v)).catch(() => {});
      api.setSetting(`pageview.default.${comic ? "comic" : "page"}`, JSON.stringify(v)).catch(() => {});
    },
    [book.id, comic],
  );

  // ---------- layout ----------
  const rows = useMemo(() => rowsOf(count, view.mode, sizes), [count, view.mode, sizes]);
  const rowOfPage = useMemo(() => {
    const m: number[] = [];
    rows.forEach((r, k) => r.forEach((p) => (m[p] = k)));
    return m;
  }, [rows]);
  const curRow = rowOfPage[page] ?? 0;
  const availW = Math.max(100, area.w - 2 * GAP);
  const availH = Math.max(100, area.h - TOP - BOTTOM);
  const rowSize = useCallback(
    (r: number[]) => ({
      w: r.reduce((a, p) => a + (sizes[p]?.w ?? 0), 0) + GAP * (r.length - 1),
      h: Math.max(...r.map((p) => sizes[p]?.h ?? 0)),
    }),
    [sizes],
  );
  // the zoom: Fit width / Fit page from the row you're on (in Scroll, from the book's usual page, so it
  // doesn't change as you scroll past an odd one); otherwise the zoom picked
  const typical = useMemo(() => {
    if (!sizes.length) return { w: 1, h: 1 };
    const tally = new Map<string, number>();
    for (const s of sizes.slice(0, 400)) {
      const k = `${Math.round(s.w)}x${Math.round(s.h)}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0].split("x").map(Number);
    const s = sizes.find((x) => Math.round(x.w) === best) ?? sizes[0];
    return s;
  }, [sizes]);
  const zoom = useMemo(() => {
    if (!sizes.length) return 1;
    const ref = view.mode === "scroll" ? { w: typical.w, h: typical.h } : rowSize(rows[curRow] ?? [0]);
    if (view.fit === "width") return availW / Math.max(1, ref.w);
    if (view.fit === "page") return Math.min(availW / Math.max(1, ref.w), availH / Math.max(1, ref.h));
    return view.zoom;
  }, [sizes, view, typical, rows, curRow, availW, availH, rowSize]);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // where each row sits (Scroll); one row at a time otherwise
  const layout = useMemo(() => {
    const tops: number[] = [];
    let y = TOP;
    let maxW = 0;
    for (const r of rows) {
      const s = rowSize(r);
      tops.push(y);
      y += s.h * zoom + GAP;
      maxW = Math.max(maxW, s.w * zoom);
    }
    return { tops, total: y - GAP + BOTTOM, maxW };
  }, [rows, rowSize, zoom]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const rowH = (k: number) => (rowSize(rows[k] ?? [])?.h ?? 0) * zoom;

  // ---------- where you are ----------
  const labelOf = useCallback((p: number) => src?.labels?.[p] || String(p + 1), [src]);
  const chapterOf = useMemo(() => {
    const flat = tocOf(src?.outline ?? []).flat;
    return (p: number) => {
      let best: { href: string; page: number } | null = null;
      for (const f of flat) if (f.page <= p && (!best || f.page >= best.page)) best = f;
      return best;
    };
  }, [src]);
  const toc = useMemo(() => tocOf(src?.outline ?? []), [src]);
  const titleOfHref = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (items: TocItem[]) => items.forEach((it) => (it.href && m.set(it.href, it.label ?? ""), it.subitems && walk(it.subitems)));
    walk(toc.toc);
    return m;
  }, [toc]);
  const chapterTitle = (p: number) => {
    const c = chapterOf(p);
    return c ? titleOfHref.get(c.href)?.trim() || null : null;
  };

  // ---------- going places ----------
  const scrollAnchor = useRef<{ row: number; within: number } | null>(null);
  const applying = useRef(false);
  const scrollToRow = useCallback((k: number, within = 0, boxY: number | null = null) => {
    const sc = scRef.current;
    const L = layoutRef.current;
    if (!sc || L.tops[k] == null) return;
    const h = (rowsRef.current[k] ? rowSizeRef.current(rowsRef.current[k]).h : 0) * zoomRef.current;
    let top = L.tops[k] - TOP + within * h;
    // words to show: put them a third of the way down
    if (boxY != null) top = L.tops[k] + boxY * h - sc.clientHeight * 0.33;
    applying.current = true;
    sc.scrollTop = Math.max(0, top);
    scrollAnchor.current = { row: k, within: Math.max(0, (sc.scrollTop - (L.tops[k] - TOP)) / Math.max(1, h)) };
    requestAnimationFrame(() => (applying.current = false));
  }, []);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const rowSizeRef = useRef(rowSize);
  rowSizeRef.current = rowSize;
  const rowOfPageRef = useRef(rowOfPage);
  rowOfPageRef.current = rowOfPage;

  /** Shows page `p` (from 0); `boxY`: a place on it (fraction from its top) to bring into view.
   *  `reading`: he moved there (it's reading, and the place goes to Grimmory); not when the book opens. */
  const show = useCallback(
    (p: number, boxY: number | null = null, reading = true) => {
      const s = srcRef.current;
      if (!s) return;
      if (reading) {
        acted.current = true;
        lastTurn.current = Date.now();
        turns.current++;
      }
      const n = Math.max(0, Math.min(s.count - 1, p));
      setPage(n);
      pageRef.current = n;
      const k = rowOfPageRef.current[n] ?? 0;
      if (viewRef.current.mode === "scroll") scrollToRow(k, 0, boxY);
      else {
        const sc = scRef.current;
        if (sc) {
          // a zoomed-in page: down to the words, else to its top
          requestAnimationFrame(() => {
            if (boxY != null && sc.scrollHeight > sc.clientHeight) {
              sc.scrollTop = Math.max(0, TOP + boxY * rowH(k) - sc.clientHeight * 0.33);
            } else sc.scrollTop = 0;
          });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollToRow],
  );

  const placeNow = useCallback((): Back => ({ page: pageRef.current, label: `p. ${labelOf(pageRef.current)}` }), [labelOf]);
  const jumpFrom = useCallback(() => {
    setBack(placeNow());
    acted.current = true;
  }, [placeNow]);
  const jumpTo = useCallback(
    (p: number, boxY: number | null = null) => {
      jumpFrom();
      show(p, boxY);
    },
    [jumpFrom, show],
  );
  const goBack = useCallback(() => {
    const b = backRef.current;
    if (!b) return;
    setBack(placeNow());
    acted.current = true;
    show(b.page);
  }, [placeNow, show]);

  /** One row on (or back), in One page and Two pages; a screen in Scroll. */
  const turn = useCallback(
    (dir: 1 | -1) => {
      lastTurn.current = Date.now();
      acted.current = true;
      setSel(null);
      setCard(null);
      setWord(null);
      const sc = scRef.current;
      if (viewRef.current.mode === "scroll") {
        if (sc) sc.scrollBy({ top: dir * sc.clientHeight * 0.9 });
        return;
      }
      const k = (rowOfPageRef.current[pageRef.current] ?? 0) + dir;
      const r = rowsRef.current[k];
      if (!r) return;
      show(r[0]);
    },
    [show],
  );

  // ---------- open ----------
  useEffect(() => {
    let cancelled = false;
    let opened: PageSource | null = null;
    (async () => {
      try {
        const [s, own, def, list, hlist, lk, pin] = await Promise.all([
          openPageSource(book.id, book.format, book.path),
          api.getSetting(`pageview.${book.id}`).catch(() => null),
          api.getSetting(`pageview.default.${comic ? "comic" : "page"}`).catch(() => null),
          marksApi.list(book.id).catch(() => [] as Bookmark[]),
          hls.list(book.id).catch(() => [] as Highlight[]),
          api.getSetting("reader.hlLook").catch(() => null),
          api.getSetting("reader.pinLeft").catch(() => null),
        ]);
        opened = s;
        if (cancelled) {
          s.close();
          return;
        }
        let v = defaultView(s.kind);
        for (const j of [def, own]) {
          try {
            if (j) v = { ...v, ...(JSON.parse(j) as Partial<View>) };
          } catch {
            /* the default */
          }
        }
        if (s.kind !== "comic") v.rtl = false;
        viewRef.current = v;
        setViewState(v);
        setPinned(pin === "1");
        try {
          const l = lk ? (JSON.parse(lk) as Look) : null;
          if (l?.color && l?.style) setLook(l);
        } catch {
          /* the default look */
        }
        setMarks(list);
        marksRef.current = list;
        setHl(hlist);
        hlRef.current = hlist;
        setSizes(s.sizes);
        s.onSizes?.((ns) => {
          if (!cancelled) {
            setSizes(ns);
            setSizesV((n) => n + 1);
          }
        });
        srcRef.current = s;
        setSrc(s);
        // a Grimmory book (or a Local copy) opens at Grimmory's page when that's the latest read
        const place = await grimmory.openPlace(book.id).catch(() => null);
        if (cancelled) return;
        const location = place ? place.location : book.location;
        const fraction = place ? place.fraction : book.fraction;
        let p = 0;
        const n = Number(location);
        if (location && Number.isInteger(n) && n >= 1) p = Math.min(s.count, n) - 1;
        else if (fraction && fraction > 0) p = Math.max(0, Math.min(s.count - 1, Math.ceil(fraction * s.count) - 1));
        setPage(p);
        pageRef.current = p;
        pendingShow.current = { page: p, boxY: null };
        if (place?.offer) setOffer(place.offer);
        setState("ready");
        api.markOpened(book.id).catch(() => {});
        reloadMarks();
        marksSync
          .sync(book.id)
          .then(() => marksSync.lost(book.id))
          .then((l) => !cancelled && setLost(l))
          .catch(() => {});
        if (startAt) {
          const sp = parsePlace(startAt);
          if (sp) {
            setBack({ page: p, label: `p. ${s.labels?.[p] || p + 1}` });
            pendingShow.current = { page: sp.page, boxY: null, s: sp.s ?? null };
          }
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      opened?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // the first place is shown once the page area has its size
  const pendingShow = useRef<{ page: number; boxY: number | null; s?: number | null } | null>(null);
  useLayoutEffect(() => {
    const p = pendingShow.current;
    if (!p || state !== "ready" || !area.w || !area.h || !sizes.length) return;
    pendingShow.current = null;
    // the place the book opens at isn't reading; a mark opened from the Bookmarks page is a jump
    const jump = p.s !== undefined;
    show(p.page, p.boxY, jump);
    if (p.s != null) {
      srcRef.current?.text(p.page).then((t) => {
        const b = roughBox(t, p.s!);
        if (b) show(p.page, b.y, jump);
      });
    }
  }, [state, area, sizes, show]);

  // Scroll: after a zoom or a re-layout, the place you were reading stays where it was
  useLayoutEffect(() => {
    if (view.mode !== "scroll" || state !== "ready" || pendingShow.current) return;
    const a = scrollAnchor.current;
    if (a) scrollToRow(a.row, a.within);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, view.mode, sizesV, rows.length]);

  // One page / Two pages: a new mode starts at the page you were on
  useEffect(() => {
    if (state === "ready") show(pageRef.current, null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.mode]);

  // ---------- the place is saved (and goes to Grimmory) ----------
  const saveTimer = useRef(0);
  const save = useCallback(() => {
    const s = srcRef.current;
    if (!s) return Promise.resolve();
    const p = pageRef.current;
    return api.saveProgress(book.id, String(p + 1), (p + 1) / s.count, chapterTitle(p), null, acted.current).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, chapterOf]);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (state !== "ready") return;
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveRef.current(), 600);
  }, [page, state]);

  // ---------- scrolling: the page you're on ----------
  const onScroll = () => {
    const sc = scRef.current;
    if (!sc) return;
    setScrollTop(sc.scrollTop);
    if (viewRef.current.mode !== "scroll") return;
    const L = layoutRef.current;
    const probe = sc.scrollTop + sc.clientHeight * 0.3;
    let lo = 0;
    let hi = L.tops.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (L.tops[mid] <= probe) lo = mid;
      else hi = mid - 1;
    }
    const k = lo;
    const r = rowsRef.current[k];
    if (r && !applying.current) {
      const h = rowSizeRef.current(r).h * zoomRef.current;
      scrollAnchor.current = { row: k, within: Math.max(0, (sc.scrollTop - (L.tops[k] - TOP)) / Math.max(1, h)) };
      if (r[0] !== pageRef.current) {
        acted.current = true;
        lastTurn.current = Date.now();
        turns.current++;
        pageRef.current = r[0];
        setPage(r[0]);
      }
    }
  };

  // ---------- zoom ----------
  const zoomBy = useCallback(
    (dir: 1 | -1) => {
      const z = zoomRef.current;
      const next = dir > 0 ? ZOOMS.find((x) => x > z + 0.001) ?? ZOOMS[ZOOMS.length - 1] : [...ZOOMS].reverse().find((x) => x < z - 0.001) ?? ZOOMS[0];
      setView({ fit: null, zoom: next });
    },
    [setView],
  );

  // ---------- bookmarks ----------
  const shownPages = useMemo(() => (view.mode === "scroll" ? [page] : rows[curRow] ?? [page]), [view.mode, page, rows, curRow]);
  const markedPages = useMemo(() => {
    const m = new Map<number, Bookmark[]>();
    for (const b of marks) {
      const p = parsePlace(b.cfi);
      if (p) m.set(p.page, [...(m.get(p.page) ?? []), b]);
    }
    return m;
  }, [marks]);
  const here = useMemo(() => new Set(shownPages.flatMap((p) => (markedPages.get(p) ?? []).map((b) => b.id))), [shownPages, markedPages]);

  const toggleMark = useCallback(
    async (p: number = pageRef.current) => {
      const s = srcRef.current;
      if (!s) return;
      const on = marksRef.current.filter((b) => parsePlace(b.cfi)?.page === p);
      if (on.length) {
        await removeMarks(on.map((b) => ({ kind: "bm" as const, b })), book.title).catch(() => {});
        const ids = new Set(on.map((b) => b.id));
        setMarks(marksRef.current.filter((b) => !ids.has(b.id)));
        return;
      }
      const t = await s.text(p).catch(() => null);
      try {
        const b = await marksApi.add(book.id, pagePlace(p), p / s.count, labelOf(p), chapterTitle(p), firstWords(t?.str));
        setMarks([...marksRef.current.filter((x) => x.id !== b.id), b].sort((a, c) => (a.fraction ?? 0) - (c.fraction ?? 0)));
      } catch (e) {
        console.error(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [book.id, labelOf, chapterOf],
  );
  const removeMark = async (b: Bookmark) => {
    await removeBookmark(b).catch(() => {});
    setMarks(marksRef.current.filter((x) => x.id !== b.id));
  };
  const saveBookmark = async (b: Bookmark, title: string | null, note: string | null) => {
    await editBookmark(b, title, note).catch(() => {});
    setMarks(marksRef.current.map((x) => (x.id === b.id ? { ...x, title, note, updatedAt: Date.now() } : x)));
  };

  // ---------- highlights ----------
  const layers = useRef(new Map<number, HTMLDivElement>());
  const onLayer = useCallback((i: number, el: HTMLDivElement | null) => {
    if (el) layers.current.set(i, el);
    else layers.current.delete(i);
  }, []);
  const anchorOfRect = (r: DOMRect | { left: number; right: number; top: number; bottom: number }): Anchor => {
    const box = rdRef.current!.getBoundingClientRect();
    return { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top };
  };
  // ---------- PDF drawings, and highlights going to Grimmory's PDF reader ----------
  const isPdf = book.format === "pdf";
  const annotsByPage = useMemo(() => {
    const m = new Map<number, Annot[]>();
    for (const a of annots) m.set(a.page, [...(m.get(a.page) ?? []), a]);
    return m;
  }, [annots]);
  const syncTimer = useRef(0);
  const syncPdf = useCallback(
    (delay = 2500) => {
      if (!isPdf) return;
      clearTimeout(syncTimer.current);
      syncTimer.current = window.setTimeout(() => {
        pdfAnnots.sync(book.id).catch(() => {});
      }, delay);
    },
    [isPdf, book.id],
  );
  useEffect(() => () => clearTimeout(syncTimer.current), []);
  const reloadAnnots = useCallback(() => {
    if (isPdf) pdfAnnots.list(book.id).then(setAnnots).catch(() => {});
  }, [isPdf, book.id]);
  // the words' boxes of each highlight, in PDF points, once per highlight (they go up with it)
  const rectsSent = useRef(new Map<number, string>());
  const sizesNow = useRef(sizes);
  sizesNow.current = sizes;
  const onRects = useCallback(
    (h: Highlight, b: Box[]) => {
      if (!isPdf) return;
      const p = parsePlace(h.cfi);
      const sz = p ? sizesNow.current[p.page] : null;
      if (!p || !sz) return;
      const W = sz.w * 0.75;
      const H = sz.h * 0.75;
      const rects = b.map((x) => [x.x * W, x.y * H, x.w * W, x.h * H].map((v) => Math.round(v * 100) / 100) as [number, number, number, number]);
      const key = JSON.stringify(rects);
      if (rectsSent.current.get(h.id) === key) return;
      rectsSent.current.set(h.id, key);
      pdfAnnots.rects(h.id, rects).then(() => syncPdf()).catch(() => {});
    },
    [isPdf, syncPdf],
  );
  const inkPen: Pen | null = useMemo(() => (draw ? { color: PDF_HEX[draw.color], width: 2, erase: draw.erase } : null), [draw]);
  const onStroke = useCallback(
    (page: number, pts: { x: number; y: number }[]) => {
      if (!draw) return;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const x1 = Math.min(...xs) - 1;
      const y1 = Math.min(...ys) - 1;
      const data = {
        type: 15,
        id: crypto.randomUUID(),
        pageIndex: page,
        rect: { origin: { x: x1, y: y1 }, size: { width: Math.max(...xs) + 1 - x1, height: Math.max(...ys) + 1 - y1 } },
        inkList: [{ points: pts }],
        strokeColor: PDF_HEX[draw.color],
        color: PDF_HEX[draw.color],
        opacity: 1,
        strokeWidth: 2,
        author: "Katana Desk",
      };
      setAnnots((a) => [...a, { aid: data.id, page, kind: "ink", data: { annotation: data } }]);
      pdfAnnots
        .add(book.id, data)
        .then(() => syncPdf())
        .catch(() => reloadAnnots());
    },
    [draw, book.id, syncPdf, reloadAnnots],
  );
  const onErase = useCallback(
    (aid: string) => {
      setAnnots((a) => a.filter((x) => x.aid !== aid));
      pdfAnnots.remove(aid).then(() => syncPdf()).catch(() => reloadAnnots());
    },
    [syncPdf, reloadAnnots],
  );
  // a highlight added, recoloured or removed here goes to Grimmory a moment later
  useEffect(() => {
    syncPdf();
  }, [hl, syncPdf]);

  const hlByPage = useMemo(() => {
    const m = new Map<number, Highlight[]>();
    for (const h of hl) {
      const p = parsePlace(h.cfi);
      if (p) m.set(p.page, [...(m.get(p.page) ?? []), h]);
    }
    return m;
  }, [hl]);

  const clearSelection = () => {
    try {
      document.getSelection()?.removeAllRanges();
    } catch {
      /* gone */
    }
    setSel(null);
  };

  /** The selected words on a page: which page, and where in its text. */
  const readSelection = (): Sel | null => {
    const s = document.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return null;
    const range = s.getRangeAt(0);
    const offset = (node: Node, off: number, end: boolean): { page: number; at: number } | null => {
      const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)) as HTMLElement | null;
      const pg = el?.closest?.("[data-page]") as HTMLElement | null;
      if (!pg) return null;
      const page = Number(pg.dataset.page);
      const span = el?.closest?.("span[data-s]") as HTMLElement | null;
      if (span) return { page, at: Number(span.dataset.s) + (node.nodeType === Node.TEXT_NODE ? off : off > 0 ? Number(span.dataset.e) - Number(span.dataset.s) : 0) };
      const layer = pg.querySelector(".ptl");
      if (!layer) return null;
      const kids = [...layer.children] as HTMLElement[];
      if (el === layer && kids[off]) return { page, at: Number(kids[off].dataset.s) };
      // outside the words: the start or the end of the page's text
      const last = kids[kids.length - 1];
      return { page, at: end ? Number(last?.dataset.e ?? 0) : Number(kids[0]?.dataset.s ?? 0) };
    };
    const a = offset(range.startContainer, range.startOffset, false);
    let b = offset(range.endContainer, range.endOffset, true);
    if (!a) return null;
    if (!b || b.page !== a.page) {
      // across pages: the words on the first page
      const layer = layers.current.get(a.page);
      const kids = layer ? ([...layer.children] as HTMLElement[]) : [];
      b = { page: a.page, at: Number(kids[kids.length - 1]?.dataset.e ?? a.at) };
    }
    const pt = textCache.current.get(a.page);
    if (!pt || b.at <= a.at) return null;
    // trimmed of spaces at either end
    let st = a.at;
    let en = b.at;
    while (st < en && /\s/.test(pt.str[st])) st++;
    while (en > st && /\s/.test(pt.str[en - 1])) en--;
    if (en <= st) return null;
    const text = pt.str.slice(st, en).replace(/\s+/g, " ");
    return { page: a.page, s: st, e: en, text, anchor: anchorOfRect(range.getBoundingClientRect()) };
  };
  const textCache = useRef(new Map<number, PageText>());
  useEffect(() => {
    if (!src?.hasText) return;
    // the text of pages on screen is kept at hand for selections
    for (const p of visiblePages) {
      if (!textCache.current.has(p)) src.text(p).then((t) => t && textCache.current.set(p, t));
    }
  });

  const makeHighlight = async (color: Colour, style: Style, withNote = false, s0: Sel | null = selRef.current) => {
    const s = s0;
    const source = srcRef.current;
    if (!s || !source) return;
    const pt = textCache.current.get(s.page);
    const len = pt?.str.length || 1;
    try {
      const h = await hls.add({
        bookId: book.id,
        cfi: wordsPlace(s.page, s.s, s.e),
        text: s.text,
        chapter: chapterTitle(s.page),
        fraction: (s.page + s.s / len) / source.count,
        pageLabel: labelOf(s.page),
        color,
        style,
      });
      clearSelection();
      hlRef.current = [...hlRef.current.filter((x) => x.id !== h.id), h];
      setHl(hlRef.current);
      const lk = { color, style };
      setLook(lk);
      api.setSetting("reader.hlLook", JSON.stringify(lk)).catch(() => {});
      if (withNote) setCard({ id: h.id, anchor: s.anchor, editing: true });
    } catch (e) {
      console.error(e);
      showToast({ text: "That highlight couldn't be saved." });
    }
  };
  const changeHighlight = async (h: Highlight, color: Colour, style: Style, note: string | null) => {
    const next = { ...h, color, style, note, updatedAt: Date.now() };
    hlRef.current = hlRef.current.map((x) => (x.id === h.id ? next : x));
    setHl(hlRef.current);
    if (color !== h.color || style !== h.style) {
      const lk = { color, style };
      setLook(lk);
      api.setSetting("reader.hlLook", JSON.stringify(lk)).catch(() => {});
    }
    const saved = await hls.update(h.id, color, style, note).then(
      () => true,
      () => (showToast({ text: "That change couldn't be saved." }), false),
    );
    // Ctrl Z puts the look or the note back
    if (saved) highlightChanged(h, color, style, note);
  };
  const deleteHighlight = async (h: Highlight) => {
    setCard(null);
    hlRef.current = hlRef.current.filter((x) => x.id !== h.id);
    setHl(hlRef.current);
    // the undo bar offers it back (Ctrl Z)
    await removeHighlight(h).catch(() => {});
  };
  const copySel = async () => {
    const s = selRef.current;
    if (!s) return;
    await copyText(s.text);
    clearSelection();
    showToast({ text: "Copied" });
  };

  /** The word card for words on a page. */
  const openWord = (s: Sel) => {
    const t = s.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!t || t.length > 60) return;
    const pt = textCache.current.get(s.page);
    const src0 = srcRef.current;
    setSel(null);
    setCard(null);
    setWord({
      text: t,
      sentence: pt ? sentenceIn(pt.str, s.s, s.e - s.s) : null,
      anchor: s.anchor,
      cfi: wordsPlace(s.page, s.s, s.e),
      fraction: src0 ? (s.page + 0.5) / src0.count : null,
      pageLabel: labelOf(s.page),
      chapter: chapterTitle(s.page),
    });
  };
  const lookUp = () => {
    const s = selRef.current;
    if (s && s.text.length <= 60) openWord(s);
  };

  const wordSaved = (w: Word) => {
    setBookWords((list) => [w, ...list.filter((x) => x.id !== w.id)]);
    showToast({ text: `“${w.word}” is in My words` });
  };
  const wordRemoved = (w: Word) => {
    setBookWords((list) => list.filter((x) => x.id !== w.id));
    // the undo bar offers it back (Ctrl Z)
    recordWordRemoved(w);
  };
  // this book's saved words (again when one is taken out or put back anywhere)
  useEffect(() => {
    const load = () => wordsApi.list(book.id).then(setBookWords).catch(() => {});
    load();
    const un = listen("words-changed", load);
    return () => {
      un.then((f) => f());
    };
  }, [book.id]);

  /** Goes to a mark's page, and to its words. */
  const goToPlace = (cfi: string | null) => {
    const p = parsePlace(cfi);
    if (!p) return;
    jumpFrom();
    if (p.s == null) return show(p.page);
    show(p.page);
    srcRef.current?.text(p.page).then((t) => {
      const b = roughBox(t, p.s!);
      if (b) show(p.page, b.y);
    });
  };
  const goToMark = (m: Mark) => {
    logRevisit(m);
    goToPlace(m.cfi);
    if (!dock) setSide(null);
  };
  const removeAnyMark = (m: Mark) => (m.kind === "hl" ? deleteHighlight(m.h) : removeMark(m.b));
  const exportMarks = async () => {
    try {
      const path = await exportMarkdown(book.id);
      if (path) showToast({ text: `Saved ${path.split(/[\\/]/).pop()}` });
    } catch (e) {
      showToast({ text: e instanceof Error ? e.message : String(e) });
    }
  };

  /** Marks from Grimmory (bookmarks by page) get their page label, chapter and first words here. */
  const placeMissing = async () => {
    const s = srcRef.current;
    if (!s) return;
    const todo = marksRef.current.filter((b) => b.fraction == null || !b.pageLabel);
    if (!todo.length) return;
    const places = [];
    for (const b of todo) {
      const p = parsePlace(b.cfi);
      if (!p) continue;
      const t = await s.text(p.page).catch(() => null);
      places.push({ kind: "bookmark" as const, id: b.id, fraction: p.page / s.count, pageLabel: labelOf(p.page), chapter: chapterTitle(p.page), excerpt: firstWords(t?.str) });
    }
    if (!places.length) return;
    await marksSync.place(places).catch(() => {});
    const b = await marksApi.list(book.id).catch(() => null);
    if (b) {
      marksRef.current = b;
      setMarks(b);
    }
  };
  const reloadMarks = useCallback(async () => {
    const [h, b] = await Promise.all([hls.list(book.id), marksApi.list(book.id)]).catch(() => [null, null]);
    if (h) {
      hlRef.current = h;
      setHl(h);
      const c = cardRef.current;
      if (c && !h.some((x) => x.id === c.id)) setCard(null);
    }
    if (b) {
      marksRef.current = b;
      setMarks(b);
    }
    marksSync.syncState(book.id).then((st) => setSyncLine(syncText(st, comic, book.format === "pdf"))).catch(() => {});
    if (book.format === "pdf") pdfAnnots.list(book.id).then(setAnnots).catch(() => {});
    placeMissing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  const answer = async (go: boolean) => {
    setOffer(null);
    const p = await grimmory.answer(book.id, go).catch(() => null);
    const s = srcRef.current;
    if (!go || !p || !s) return;
    acted.current = false;
    const n = Number(p.location);
    if (p.location && Number.isInteger(n) && n >= 1) show(n - 1, null, false);
    else if (p.fraction != null) show(Math.max(0, Math.ceil(p.fraction * s.count) - 1), null, false);
  };

  // Keep up with Grimmory while the book is open: a look every 30 s, and when the window comes back to the
  // front. Coming back from Grimmory's PDF reader with nothing read here since, the book follows to its page
  // and leaves "Back to p. N"; reading here, it asks as at the start.
  const followed = useRef(0);
  const keepUpRef = useRef({ show, placeNow });
  keepUpRef.current = { show, placeNow };
  useEffect(() => {
    let on = true;
    const check = async (follow: boolean) => {
      if (book.format === "pdf") pdfAnnots.sync(book.id).catch(() => {});
      const p = await grimmory.keepUp(book.id, follow).catch(() => null);
      const s = srcRef.current;
      if (!on || !p || !s) return;
      followed.current = Date.now();
      setOffer(null);
      const n = Number(p.location);
      const to = p.location && Number.isInteger(n) && n >= 1 ? n - 1 : p.fraction != null ? Math.max(0, Math.ceil(p.fraction * s.count) - 1) : null;
      if (to == null || to === pageRef.current) return;
      setBack(keepUpRef.current.placeNow());
      keepUpRef.current.show(to, null, false);
      acted.current = false;
    };
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") check(false);
    }, 30_000);
    const un = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) check(true);
    });
    return () => {
      on = false;
      clearInterval(iv);
      un.then((f) => f());
    };
  }, [book.id]);

  // ---------- find ----------
  const runFind = useCallback(
    async (query: string) => {
      const s = srcRef.current;
      const run = ++findRun.current;
      setHits([]);
      setHitAt(-1);
      const needle = query.trim();
      if (!s || !s.hasText || needle.length < 2) {
        setSearching(null);
        return;
      }
      const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "gi");
      const found: Hit[] = [];
      setSearching({ done: 0, total: s.count });
      // from the page you're on to the end, then from the start: the first match is the next one ahead
      const start = pageRef.current;
      let jumped = false;
      let last = Date.now();
      const all: Hit[][] = Array.from({ length: s.count }, () => []);
      for (let k = 0; k < s.count; k++) {
        const p = (start + k) % s.count;
        const t = await s.text(p);
        if (run !== findRun.current) return;
        if (t) {
          textCache.current.set(p, t);
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(t.str))) {
            all[p].push({ page: p, s: m.index, e: m.index + m[0].length });
            if (!m[0].length) pattern.lastIndex++;
          }
        }
        if (!jumped && all[p].length) {
          jumped = true;
          jumpFrom();
          const h = all[p][0];
          const b = roughBox(t, h.s);
          show(p, b?.y ?? null);
        }
        if (Date.now() - last > 250 || k === s.count - 1) {
          last = Date.now();
          const flat = all.flat();
          found.length = 0;
          found.push(...flat);
          setHits(flat);
          if (jumped) {
            const firstAhead = flat.findIndex((h) => h.page >= start);
            setHitAt((i) => (i >= 0 ? i : firstAhead >= 0 ? firstAhead : 0));
          }
          setSearching({ done: k + 1, total: s.count });
        }
      }
      setSearching(null);
    },
    [jumpFrom, show],
  );
  useEffect(() => {
    if (!find) return;
    const t = window.setTimeout(() => runFind(q), 280);
    return () => clearTimeout(t);
  }, [q, find, runFind]);
  const stepHit = (dir: 1 | -1) => {
    const list = hitsRef.current;
    if (!list.length) return;
    const i = hitAt < 0 ? 0 : (hitAt + dir + list.length) % list.length;
    setHitAt(i);
    const h = list[i];
    const t = textCache.current.get(h.page) ?? null;
    const b = roughBox(t, h.s);
    if (h.page !== pageRef.current) jumpFrom();
    show(h.page, b?.y ?? null);
  };
  const closeFind = () => {
    findRun.current++;
    setFind(false);
    setHits([]);
    setHitAt(-1);
    setSearching(null);
  };
  const hitsByPage = useMemo(() => {
    const m = new Map<number, Hit[]>();
    for (const h of hits) m.set(h.page, [...(m.get(h.page) ?? []), h]);
    return m;
  }, [hits]);
  const curHit = hitAt >= 0 ? hits[hitAt] ?? null : null;

  // ---------- keys, wheel, mouse ----------
  const act = useRef({ toggleMark, goBack, poke, hideBars, makeHighlight, copySel, lookUp, clearSelection, deleteHighlight, turn, zoomBy, show, stepHit, closeFind });
  act.current = { toggleMark, goBack, poke, hideBars, makeHighlight, copySel, lookUp, clearSelection, deleteHighlight, turn, zoomBy, show, stepHit, closeFind };
  const ui = useRef({ side, card, word, review, find, draw });
  ui.current = { side, card, word, review, find, draw };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ui.current.review) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, [contenteditable]");
      const k = e.key.toLowerCase();
      if (!e.ctrlKey && !e.altKey && t?.closest?.("button") && (e.key === " " || e.key === "Enter")) return;
      if (!e.altKey && t?.closest?.("[role=slider]") && e.key.startsWith("Arrow")) return;
      const a = act.current;
      if (selRef.current && !e.ctrlKey && !e.altKey && !e.metaKey && !typing) {
        const lk = lookRef.current;
        const n = Number(e.key);
        if (k === "h") return (e.preventDefault(), void a.makeHighlight(lk.color, lk.style));
        if (k === "n") return (e.preventDefault(), void a.makeHighlight(lk.color, lk.style, true));
        if (k === "c") return (e.preventDefault(), void a.copySel());
        if (k === "l") return (e.preventDefault(), a.lookUp());
        if (n >= 1 && n <= 5) return (e.preventDefault(), void a.makeHighlight(COLOURS[n - 1].id, lk.style));
        if (e.key === "Escape") return (e.preventDefault(), a.clearSelection());
      }
      if (ui.current.card && !typing && e.key === "Delete") {
        const h = hlRef.current.find((x) => x.id === ui.current.card?.id);
        if (h) return (e.preventDefault(), void a.deleteHighlight(h));
      }
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (k === "b" && !typing) {
          e.preventDefault();
          a.toggleMark();
        } else if (k === "f" && srcRef.current?.hasText) {
          e.preventDefault();
          setFind(true);
          setTimeout(() => findInput.current?.select(), 0);
        } else if (k === "=" || k === "+") {
          e.preventDefault();
          a.zoomBy(1);
        } else if (k === "-") {
          e.preventDefault();
          a.zoomBy(-1);
        } else if (k === "0") {
          e.preventDefault();
          setView({ fit: srcRef.current?.kind === "comic" ? "page" : "width" });
        }
        return;
      }
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        a.goBack();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || typing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        const u = ui.current;
        if (u.word) return setWord(null);
        if (u.draw) return setDraw(null);
        if (u.card) return setCard(null);
        if (u.find) return a.closeFind();
        if (u.side) return setSide(null);
        return closeRef.current();
      }
      const sc = scRef.current;
      const scroll = viewRef.current.mode === "scroll";
      const rtl = viewRef.current.rtl;
      if (e.key === " " || e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        a.hideBars();
        return a.turn(e.key === "PageUp" || (e.key === " " && e.shiftKey) ? -1 : 1);
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        return a.show(e.key === "Home" ? 0 : (srcRef.current?.count ?? 1) - 1);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        a.hideBars();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        // a page taller than the window scrolls first, then turns
        if (sc && (scroll || sc.scrollHeight > sc.clientHeight + 2)) {
          const atEnd = dir > 0 ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 : sc.scrollTop <= 0;
          if (scroll || !atEnd) return sc.scrollBy({ top: dir * 80 });
        }
        return a.turn(dir);
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        a.hideBars();
        const fwd = (e.key === "ArrowRight") !== rtl;
        if (scroll) {
          // a page on in Scroll
          const p = pageRef.current + (fwd ? 1 : -1);
          return a.show(p);
        }
        return a.turn(fwd ? 1 : -1);
      }
    };
    let wheelAcc = 0;
    let wheelLock = 0;
    const onWheel = (e: WheelEvent) => {
      const sc = scRef.current;
      if (!sc) return;
      if (e.ctrlKey) {
        e.preventDefault();
        const now = Date.now();
        if (now < wheelLock) return;
        wheelLock = now + 90;
        act.current.zoomBy(e.deltaY < 0 ? 1 : -1);
        return;
      }
      if (viewRef.current.mode === "scroll") return;
      // a page bigger than the window scrolls; at its end the wheel turns the page
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      const fits = sc.scrollHeight <= sc.clientHeight + 2;
      const atEnd = dy > 0 ? sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 : sc.scrollTop <= 0;
      if (!fits && !atEnd) return;
      e.preventDefault();
      const now = Date.now();
      if (now < wheelLock) return;
      wheelAcc += dy;
      if (Math.abs(wheelAcc) >= 50) {
        act.current.turn(wheelAcc > 0 ? 1 : -1);
        wheelAcc = 0;
        wheelLock = now + 280;
      }
    };
    let mx = -1;
    let my = -1;
    const onMove = (e: MouseEvent) => {
      if (e.screenX === mx && e.screenY === my) return;
      mx = e.screenX;
      my = e.screenY;
      act.current.poke();
    };
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("resize", onResize);
    const sc = scRef.current;
    sc?.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => {
      if (sc) setArea({ w: sc.clientWidth, h: sc.clientHeight });
      const rd = rdRef.current;
      if (rd) setRoom({ w: rd.clientWidth, h: rd.clientHeight });
      setSel(null);
      setCard(null);
    });
    if (sc) ro.observe(sc);
    if (rdRef.current) ro.observe(rdRef.current);
    const unOffer = listen<number>("grimmory-offer", (e) => {
      if (e.payload === book.id && Date.now() - followed.current > 3000) grimmory.offer(book.id).then((o) => o && setOffer(o)).catch(() => {});
    });
    const unMarks = listen<number>("marks-changed", (e) => {
      if (e.payload === book.id) {
        reloadMarks();
        reloadAnnots();
      }
    });
    const unLost = listen<number>("marks-lost", (e) => {
      if (e.payload === book.id) marksSync.lost(book.id).then(setLost).catch(() => {});
    });
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastTurn.current < 120_000) {
        api.addReading(15, book.id, turns.current).catch(() => {});
        turns.current = 0;
      }
    }, 15_000);
    return () => {
      clearInterval(tick);
      clearTimeout(saveTimer.current);
      clearTimeout(barTimer.current);
      clearTimeout(toastTimer.current);
      saveRef.current().finally(() => grimmory.closed(book.id).catch(() => {}));
      unOffer.then((f) => f());
      unMarks.then((f) => f());
      unLost.then((f) => f());
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", onResize);
      sc?.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // words selected with the mouse: the selection card (or, with the highlighter on, a highlight at once)
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setTimeout(() => {
      const s = readSelection();
      if (!s) return;
      setCard(null);
      if (penRef.current) {
        makeHighlight(lookRef.current.color, lookRef.current.style, false, s);
        return;
      }
      setSel(s);
    }, 0);
  };
  const onDoubleClick = () => {
    setTimeout(() => {
      const s = readSelection();
      if (s && s.text.length <= 40) openWord(s);
    }, 0);
  };
  // a click on a highlight opens its card; in One page and Two pages a click in the outer fifth turns
  const onClick = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.detail >= 2) return;
    const s = document.getSelection();
    if (s && !s.isCollapsed) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    const pg = target.closest("[data-page]") as HTMLElement | null;
    if (pg) {
      for (const b of pg.querySelectorAll<HTMLElement>(".hlbox")) {
        const r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2) {
          const id = Number(b.dataset.id);
          setSel(null);
          setCard({ id, anchor: anchorOfRect(r), editing: false });
          return;
        }
      }
    }
    if (cardRef.current) return setCard(null);
    if (ui.current.word) return setWord(null);
    if (viewRef.current.mode === "scroll") return;
    const sc = scRef.current!.getBoundingClientRect();
    const f = (e.clientX - sc.left) / sc.width;
    if (f >= 0.2 && f <= 0.8) return;
    const fwd = (f > 0.8) !== viewRef.current.rtl;
    turn(fwd ? 1 : -1);
  };

  // ---------- what's drawn ----------
  const dpr = window.devicePixelRatio || 1;
  const visibleRows = useMemo(() => {
    if (view.mode !== "scroll") return rows[curRow] ? [curRow] : [];
    // the rows on screen and a screen and a half either side, so a scroll finds pages already drawn
    const top = scrollTop - area.h * 1.5;
    const bottom = scrollTop + area.h * 2.5;
    const out: number[] = [];
    for (let k = 0; k < rows.length; k++) {
      const t = layout.tops[k];
      const b = t + rowH(k);
      if (b >= top && t <= bottom) out.push(k);
      else if (t > bottom) break;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.mode, rows, curRow, scrollTop, area.h, layout]);
  const visiblePages = visibleRows.flatMap((k) => rows[k] ?? []);

  const onComicSize = useCallback((i: number, w: number, h: number) => {
    setSizes((prev) => {
      const s = prev[i];
      if (!s || !w || !h || (Math.abs(s.w - w) < 1 && Math.abs(s.h - h) < 1)) return prev;
      const next = prev.slice();
      next[i] = { w, h };
      // pictures in a comic are usually all one size: the rest not yet seen follow the first one in
      if (i === 0 || prev.every((x, k) => k === i || (x.w === 1000 && x.h === 1500))) {
        for (let k = 0; k < next.length; k++) if (next[k].w === 1000 && next[k].h === 1500) next[k] = { w, h };
      }
      return next;
    });
  }, []);

  // kept the same between renders, so pages don't draw again on every scroll
  const toggleMarkRef = useRef(toggleMark);
  toggleMarkRef.current = toggleMark;
  const onCorner = useCallback((i: number) => toggleMarkRef.current(i), []);
  const onPinClick = useCallback((hh: Highlight, el: HTMLElement) => {
    setSel(null);
    const box = rdRef.current!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setCard({ id: hh.id, anchor: { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top }, editing: false });
  }, []);

  const pageEl = (p: number) => {
    const s = sizes[p];
    if (!src || !s) return null;
    const w = s.w * zoom;
    const h = s.h * zoom;
    // a very large page draws at a lower resolution than the screen's, so it fits in memory
    const d = Math.min(dpr, Math.sqrt(16e6 / Math.max(1, w * h)));
    return (
      <PageView
        key={p}
        src={src}
        index={p}
        w={w}
        h={h}
        dpr={d}
        highlights={hlByPage.get(p) ?? EMPTY_HL}
        hits={hitsByPage.get(p) ?? EMPTY_HITS}
        current={curHit && curHit.page === p ? curHit : null}
        marked={markedPages.has(p)}
        version={hlV}
        onLayer={onLayer}
        onPinClick={onPinClick}
        onCorner={onCorner}
        onSize={comic ? onComicSize : undefined}
        annots={isPdf ? annotsByPage.get(p) ?? EMPTY_ANNOTS : undefined}
        pt={isPdf && sizes[p] ? { w: sizes[p].w * 0.75, h: sizes[p].h * 0.75 } : undefined}
        pen={inkPen}
        onRects={isPdf ? onRects : undefined}
        onStroke={onStroke}
        onErase={onErase}
      />
    );
  };

  const contentW = Math.max(area.w, layout.maxW + 2 * GAP);
  const pageRows =
    view.mode === "scroll" ? (
      <div className="pv-inner" style={{ height: layout.total, width: contentW }}>
        {visibleRows.map((k) => (
          <div key={k} className="pv-row" style={{ top: layout.tops[k], width: contentW }}>
            {(rows[k] ?? []).map(pageEl)}
          </div>
        ))}
      </div>
    ) : (
      <div className="pv-one" style={{ minWidth: contentW, minHeight: Math.max(area.h, rowH(curRow) + TOP + BOTTOM) }}>
        <div className={`pv-spread ${view.rtl ? "rtl" : ""}`}>{(rows[curRow] ?? []).map(pageEl)}</div>
      </div>
    );

  // ---------- the slider ----------
  const [drag, setDrag] = useState<number | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const fracAt = (clientX: number) => {
    const r = sliderRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return view.rtl ? 1 - f : f;
  };
  const fraction = count ? (page + 1) / count : 0;
  const pageAt = (f: number) => Math.max(0, Math.min(count - 1, Math.round(f * (count - 1))));
  const shownFrac = drag ?? (count > 1 ? page / (count - 1) : 0);
  const ticks = useMemo(() => {
    if (count < 2) return [] as number[];
    return [...new Set((src?.outline ?? []).filter((o) => o.page != null && o.page > 0).map((o) => o.page! / (count - 1)))].slice(0, 80);
  }, [src, count]);

  const pillW = Math.min(760, Math.max(360, area.w - 360));
  const curToc = chapterOf(page)?.href ?? null;
  const pageText = count ? `p. ${labelOf(shownPages[0] ?? page)}${shownPages.length > 1 ? `–${labelOf(shownPages[shownPages.length - 1])}` : ""} / ${count}` : "";
  const zoomPct = Math.round(zoom * 100);
  const hlCount = hl.length;

  const fitBtn = (k: "width" | "page", name: string) => (
    <button type="button" className={`pic ${view.fit === k ? "on" : ""}`} title={name} aria-label={name} aria-pressed={view.fit === k} onClick={() => setView({ fit: k })}>
      <FitPic k={k} />
    </button>
  );
  const modeBtn = (k: Mode, name: string) => (
    <button type="button" className={`pic ${view.mode === k ? "on" : ""}`} title={name} aria-label={name} aria-pressed={view.mode === k} onClick={() => setView({ mode: k })}>
      <ModePic k={k} />
    </button>
  );
  const openSide = (t: SideTab) => setSide(side === t ? null : t);

  return (
    <div
      ref={rdRef}
      className={`rd pvr ${bars ? "" : "bars-off"}`}
      onMouseDown={(e) => {
        if ((e.target as Element).closest?.(".pop")) return;
        if (cardRef.current && !cardRef.current.editing && !(e.target as Element).closest?.(".pin")) setCard(null);
        if (selRef.current && !(e.target as Element).closest?.(".ptl")) clearSelection();
      }}
    >
      <div className="pgarea" style={{ left: offL, right: 0 }}>
        <div
          className={`pv m-${view.mode} ${pen ? "pen" : ""} t-${view.tint ?? "none"}`}
          ref={scRef}
          onScroll={onScroll}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onClick={onClick}
          tabIndex={-1}
        >
          {state === "ready" && src && sizes.length > 0 && area.w > 0 && pageRows}
          {state === "loading" && (
            <div className="rmsg">
              <i className="ms">menu_book</i>
              <span>Opening {book.title}…</span>
            </div>
          )}
          {state === "error" && (
            <div className="rmsg">
              <i className="ms">error</i>
              <b>This book didn't open</b>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      <header className="rtb glass bar pvbar" data-tauri-drag-region onMouseEnter={() => (overBars.current = true)} onMouseLeave={() => (overBars.current = false)}>
        <button type="button" className="ib" aria-label="Back to the library" title="Back to the library (Esc)" onClick={onClose}>
          <i className="ms">arrow_back</i>
        </button>
        <button type="button" className={`ib ${side ? "on" : ""}`} aria-label="Pages, contents and marks" title="Pages, contents and marks" onClick={() => setSide(side ? null : "pages")}>
          <i className="ms">view_sidebar</i>
        </button>
        <div className="pvt" data-tauri-drag-region>
          <b>{book.title}</b>
        </div>
        <div className="grow" data-tauri-drag-region />
        {state === "ready" && (
          <>
            {!comic && (
              <div className="zoom" role="group" aria-label="Zoom">
                <button type="button" aria-label="Zoom out" title="Zoom out (Ctrl −)" onClick={() => zoomBy(-1)}>
                  <i className="ms">zoom_out</i>
                </button>
                <span>{zoomPct}%</span>
                <button type="button" aria-label="Zoom in" title="Zoom in (Ctrl +)" onClick={() => zoomBy(1)}>
                  <i className="ms">zoom_in</i>
                </button>
              </div>
            )}
            {comic ? (
              <>
                <span className="pics">
                  {modeBtn("one", "One page")}
                  {modeBtn("two", "Two pages")}
                  {modeBtn("scroll", "Scroll, for webtoons")}
                </span>
                <span className="pics">
                  <button type="button" className={`pic ${!view.rtl ? "on" : ""}`} title="Left to right" aria-label="Left to right" aria-pressed={!view.rtl} onClick={() => setView({ rtl: false })}>
                    <i className="ms">arrow_forward</i>
                  </button>
                  <button type="button" className={`pic ${view.rtl ? "on" : ""}`} title="Right to left (manga)" aria-label="Right to left" aria-pressed={view.rtl} onClick={() => setView({ rtl: true })}>
                    <i className="ms">arrow_back</i>
                  </button>
                </span>
                <span className="pics">
                  {fitBtn("page", "Fit page")}
                  {fitBtn("width", "Fit width")}
                </span>
              </>
            ) : (
              <>
                <span className="pics">
                  {fitBtn("width", "Fit width")}
                  {fitBtn("page", "Fit page")}
                </span>
                <span className="pics">
                  {modeBtn("scroll", "Scroll")}
                  {modeBtn("one", "One page")}
                  {modeBtn("two", "Two pages")}
                </span>
              </>
            )}
          </>
        )}
        <div className="grow" data-tauri-drag-region />
        {state === "ready" && (
          <span className="tintwrap">
            <button
              type="button"
              className={`ib ${(view.tint ?? "none") !== "none" ? "on" : ""}`}
              aria-label="Page colours"
              aria-expanded={tintOpen}
              title="Page colours: invert, sepia, dim"
              onClick={() => setTintOpen(!tintOpen)}
            >
              <i className="ms">contrast</i>
            </button>
            {tintOpen && (
              <div className="pop tintpop" role="radiogroup" aria-label="Page colours" onMouseLeave={() => setTintOpen(false)}>
                {TINTS.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    role="radio"
                    aria-checked={(view.tint ?? "none") === t.id}
                    className={`tile ${(view.tint ?? "none") === t.id ? "on" : ""}`}
                    title={t.title}
                    onClick={() => {
                      setView({ tint: t.id });
                      setTintOpen(false);
                    }}
                  >
                    <span className={`tintpg t-${t.id}`}>
                      <i /><i /><i /><i />
                    </span>
                    <span className="tn">{t.name}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        {src?.hasText && (
          <>
            <button
              type="button"
              className={`ib ${find ? "on" : ""}`}
              aria-label="Find in this book"
              title="Find (Ctrl F)"
              onClick={() => {
                if (find) closeFind();
                else {
                  setFind(true);
                  setTimeout(() => findInput.current?.select(), 0);
                }
              }}
            >
              <i className="ms">search</i>
            </button>
            <button
              type="button"
              className={`ib ${pen ? "on" : ""}`}
              aria-label="Highlighter"
              aria-pressed={pen}
              title={pen ? "Highlighter on: words you select are highlighted at once" : "Highlighter: highlight words as you select them"}
              onClick={() => setPen((x) => !x)}
            >
              <i className="ms">format_ink_highlighter</i>
            </button>
          </>
        )}
        {isPdf && state === "ready" && (
          <span className="tintwrap">
            <button
              type="button"
              className={`ib ${draw ? "on" : ""}`}
              aria-label="Pen"
              aria-pressed={!!draw}
              title={draw ? "Pen on: draw on the page (Esc stops)" : "Pen: draw on the page, the same pen as Grimmory's PDF reader"}
              onClick={() => setDraw(draw ? null : { color: "blue", erase: false })}
            >
              <i className="ms">draw</i>
            </button>
            {draw && (
              <div className="pop penpop" role="group" aria-label="Pen">
                {COLOURS.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`dot ${!draw.erase && draw.color === c.id ? "on" : ""}`}
                    style={{ ["--c" as string]: PDF_HEX[c.id] }}
                    aria-label={`${c.name} pen`}
                    title={`${c.name} pen`}
                    onClick={() => setDraw({ color: c.id, erase: false })}
                  />
                ))}
                <button type="button" className={`ib ${draw.erase ? "on" : ""}`} aria-label="Eraser" title="Eraser: touch a drawing to take it away" onClick={() => setDraw({ ...draw, erase: !draw.erase })}>
                  <i className="ms">ink_eraser</i>
                </button>
              </div>
            )}
          </span>
        )}
        <button
          type="button"
          className="ib"
          aria-label={here.size ? "Remove the bookmark on this page" : "Bookmark this page"}
          aria-pressed={here.size > 0}
          title={here.size ? "Remove the bookmark (Ctrl B)" : "Bookmark this page (Ctrl B)"}
          onClick={() => toggleMark()}
          disabled={state !== "ready"}
        >
          <i className={`ms ${here.size ? "f ribbon-ic" : ""}`}>bookmark</i>
        </button>
        <button type="button" className={`ib ${side === "marks" ? "on" : ""}`} aria-label="Marks in this book" title="Highlights, notes and bookmarks in this book" onClick={() => openSide("marks")}>
          <i className="ms">bookmarks</i>
        </button>
        <button
          type="button"
          className="ib"
          aria-label="Full screen"
          title="Full screen (F11)"
          onClick={async () => {
            const w = getCurrentWindow();
            w.setFullscreen(!(await w.isFullscreen()));
          }}
        >
          <i className="ms">fullscreen</i>
        </button>
        <CaptionButtons />
      </header>

      {find && (
        <div className="findbar glass" style={{ left: offL + area.w / 2 }} role="search">
          <i className="ms">search</i>
          <input
            ref={findInput}
            value={q}
            placeholder="Find in this book"
            aria-label="Find in this book"
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") stepHit(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") closeFind();
            }}
          />
          <span className="dim">
            {searching && <span className="spin" />}
            {hits.length ? `${hitAt >= 0 ? hitAt + 1 : 0} of ${hits.length}` : q.trim().length >= 2 && !searching ? "No matches" : ""}
          </span>
          <button type="button" aria-label="Previous match" title="Previous (Shift Enter)" onClick={() => stepHit(-1)} disabled={!hits.length}>
            <i className="ms">chevron_left</i>
          </button>
          <button type="button" aria-label="Next match" title="Next (Enter)" onClick={() => stepHit(1)} disabled={!hits.length}>
            <i className="ms">chevron_right</i>
          </button>
          <button type="button" aria-label="Close" title="Close (Esc)" onClick={closeFind}>
            <i className="ms">close</i>
          </button>
        </div>
      )}

      {side && src && (
        <div className={`pwrap left ${dock ? "docked" : ""}`}>
          <Panel
            side="left"
            label="Pages, contents and marks"
            title={side === "pages" ? "Pages" : side === "toc" ? "Contents" : "Marks in this book"}
            sub={
              side === "marks"
                ? `${hlCount} ${hlCount === 1 ? "highlight" : "highlights"} · ${marks.length} ${marks.length === 1 ? "bookmark" : "bookmarks"}`
                : side === "pages"
                  ? `${count} pages${hits.length ? ` · ${hits.length} matches` : ""}`
                  : `${toc.flat.length} ${toc.flat.length === 1 ? "part" : "parts"}`
            }
            pinned={pinned}
            docked={dock}
            width={SIDE_W}
            onPin={() => {
              setPinned((p) => {
                api.setSetting("reader.pinLeft", p ? "0" : "1").catch(() => {});
                return !p;
              });
            }}
            onClose={() => setSide(null)}
          >
            <div className="tabs sidetabs" role="tablist">
              {(
                [
                  ["pages", "Pages"],
                  ["toc", "Contents"],
                  ["marks", "Marks"],
                ] as [SideTab, string][]
              ).map(([t, name]) => (
                <button key={t} type="button" role="tab" aria-selected={side === t} className={side === t ? "on" : ""} onClick={() => setSide(t)}>
                  {name}
                </button>
              ))}
            </div>
            {side === "pages" && (
              <Thumbs
                src={src}
                sizes={sizes}
                current={shownPages}
                hits={hitsByPage}
                marked={markedPages}
                labelOf={labelOf}
                onGo={(p) => {
                  jumpTo(p);
                  if (!dock) setSide(null);
                }}
              />
            )}
            {side === "toc" && (
              <ContentsPanel
                toc={toc.toc}
                current={curToc}
                pageOf={(href) => {
                  const p = Number(href.split("|")[0]);
                  return Number.isFinite(p) ? labelOf(p) : null;
                }}
                onGo={(href) => {
                  jumpTo(Number(href.split("|")[0]));
                  if (!dock) setSide(null);
                }}
              />
            )}
            {side === "marks" && (
              <MarksPanel
                highlights={hl}
                bookmarks={marks}
                here={here}
                hereLabel={`p. ${labelOf(page)}`}
                hereCfi={pagePlace(page)}
                fraction={fraction}
                syncLine={syncLine}
                onGo={goToMark}
                onRemove={removeAnyMark}
                onSaveBookmark={saveBookmark}
                onExport={exportMarks}
                words={bookWords}
                onGoWord={(w) => {
                  learning.revisit("word", w.uuid, book.id);
                  goToPlace(w.cfi);
                  if (!dock) setSide(null);
                }}
                onRemoveWord={async (w) => {
                  const gone = await wordsApi.remove(w.id).catch(() => null);
                  if (gone) wordRemoved(gone);
                }}
                onReview={() => setReview(true)}
                onToast={(text) => showToast({ text })}
              />
            )}
          </Panel>
        </div>
      )}

      {state === "ready" && (
        <div className="pillbar glass bar" style={{ left: offL + area.w / 2, width: pillW }} onMouseEnter={() => (overBars.current = true)} onMouseLeave={() => (overBars.current = false)}>
          <button type="button" className={`ib ${side === "pages" ? "on" : ""}`} aria-label="Pages" title="Pages" onClick={() => openSide("pages")}>
            <i className="ms">grid_view</i>
          </button>
          <span className="pct">{Math.round(fraction * 100)}%</span>
          <div
            className={`slider ${view.rtl ? "rtl" : ""}`}
            ref={sliderRef}
            role="slider"
            tabIndex={0}
            aria-label="Page"
            aria-valuemin={1}
            aria-valuemax={count}
            aria-valuenow={page + 1}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              setDrag(fracAt(e.clientX));
            }}
            onPointerMove={(e) => {
              if (drag != null) setDrag(fracAt(e.clientX));
            }}
            onPointerUp={(e) => {
              if (drag == null) return;
              const p = pageAt(fracAt(e.clientX));
              setDrag(null);
              if (p !== page) jumpTo(p);
            }}
            onKeyDown={(e) => {
              if (!e.altKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                e.preventDefault();
                e.stopPropagation();
                const fwd = (e.key === "ArrowRight") !== view.rtl;
                jumpTo(page + (fwd ? 1 : -1));
              }
            }}
          >
            <i style={{ width: `${shownFrac * 100}%` }} />
            {ticks.map((t, i) => (
              <u key={i} style={{ left: `${t * 100}%` }} />
            ))}
            <b style={{ left: `${shownFrac * 100}%` }} />
            {drag != null && (
              <span className="sl-tip" style={{ left: `${drag * 100}%` }}>
                p. {labelOf(pageAt(drag))}
              </span>
            )}
          </div>
          <span className="pno">{drag != null ? `p. ${labelOf(pageAt(drag))}` : pageText}</span>
          {back && (
            <button type="button" className="backchip" onClick={goBack} title="Go back to where you were before the jump (Alt ←)">
              <i className="ms">history</i>Back to {back.label}
            </button>
          )}
        </div>
      )}

      {sel && (
        <SelectionCard
          anchor={sel.anchor}
          room={room}
          look={look}
          lookUp={sel.text.length <= 60 ? sel.text : null}
          onColour={(c) => makeHighlight(c, look.style)}
          onNote={() => makeHighlight(look.color, look.style, true)}
          onCopy={copySel}
          onLookUp={lookUp}
        />
      )}

      {card &&
        (() => {
          const h = hl.find((x) => x.id === card.id);
          if (!h) return null;
          return (
            <HighlightCard
              key={h.id}
              h={h}
              anchor={card.anchor}
              room={room}
              editing={card.editing}
              onEdit={(on) => setCard((c) => (c ? { ...c, editing: on } : c))}
              onLook={(color, style) => {
                changeHighlight(h, color, style, h.note);
                setHlV((n) => n + 1);
              }}
              onNote={(n) => changeHighlight(h, h.color, h.style, n)}
              onCopy={async () => {
                await copyText(h.text);
                showToast({ text: "Copied" });
              }}
              onDelete={() => deleteHighlight(h)}
            />
          );
        })()}

      {word && <WordCard key={`${word.cfi}|${word.text}`} ask={word} room={room} bookId={book.id} onClose={() => setWord(null)} onSaved={wordSaved} onRemoved={wordRemoved} />}

      {review && <Review bookId={book.id} onClose={() => setReview(false)} onChanged={() => wordsApi.list(book.id).then(setBookWords).catch(() => {})} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              className="pill tone"
              onClick={() => {
                const u = toast.undo;
                setToast(null);
                u?.();
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}

      {lost && (
        <div className="offer wrap" role="alertdialog" aria-label="Grimmory lost some marks">
          <i className="ms">cloud_off</i>
          <span>
            Grimmory no longer has{" "}
            {[lost.highlights ? `${lost.highlights} of this book's highlights` : "", lost.bookmarks ? `${lost.bookmarks} of its bookmarks` : ""].filter(Boolean).join(" and ")}. Remove them here too, or put them back on Grimmory?
          </span>
          <span className="acts2">
            <button
              type="button"
              className="pill"
              onClick={() => {
                setLost(null);
                marksSync.lostAnswer(book.id, false).catch(() => {});
              }}
            >
              Remove here
            </button>
            <button
              type="button"
              className="pill fill"
              onClick={() => {
                setLost(null);
                marksSync.lostAnswer(book.id, true).catch(() => {});
              }}
            >
              Put back
            </button>
          </span>
        </div>
      )}

      {offer && (
        <div className="offer" role="alertdialog" aria-label="Grimmory has an earlier place">
          <i className="ms">cloud_sync</i>
          <span>
            Grimmory has this book at {offer.page != null ? `p. ${offer.page}` : `${Math.round((offer.fraction ?? 0) * 100)}%`}
            {offer.at ? `, read ${fmtWhen(offer.at).replace(/^Today, /, "today at ")}` : ""} on another device
          </span>
          <button type="button" className="pill" onClick={() => answer(true)}>
            Go there
          </button>
          <button type="button" className="pill fill" onClick={() => answer(false)}>
            Stay here
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY_HL: Highlight[] = [];
const EMPTY_HITS: Hit[] = [];
const EMPTY_ANNOTS: Annot[] = [];

/** The Pages tab: every page small, drawn as it scrolls into view, with its find matches and bookmark. */
function Thumbs({
  src,
  sizes,
  current,
  hits,
  marked,
  labelOf,
  onGo,
}: {
  src: PageSource;
  sizes: { w: number; h: number }[];
  current: number[];
  hits: Map<number, Hit[]>;
  marked: Map<number, Bookmark[]>;
  labelOf: (p: number) => string;
  onGo: (p: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const W = 120;
  useEffect(() => {
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "center" });
    // only when the tab opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const jobs = new Map<Element, { cancel: () => void }>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const box = en.target as HTMLElement;
          const p = Number(box.dataset.p);
          if (en.isIntersecting && !box.dataset.drawn && !jobs.has(box)) {
            const job = src.draw(p, W, window.devicePixelRatio || 1, true);
            jobs.set(box, job);
            job.el
              .then((el) => {
                el.className = "pgpic";
                box.replaceChildren(el);
                box.dataset.drawn = "1";
              })
              .catch(() => {})
              .finally(() => jobs.delete(box));
          } else if (!en.isIntersecting && jobs.has(box)) {
            jobs.get(box)?.cancel();
            jobs.delete(box);
          }
        }
      },
      { root: list, rootMargin: "300px 0px" },
    );
    list.querySelectorAll(".pth-img").forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      jobs.forEach((j) => j.cancel());
    };
  }, [src]);
  return (
    <div className="pthumbs" ref={listRef}>
      {sizes.map((s, p) => {
        const n = hits.get(p)?.length ?? 0;
        return (
          <button key={p} type="button" className={`pth ${current.includes(p) ? "on" : ""}`} onClick={() => onGo(p)} aria-label={`Page ${labelOf(p)}`}>
            <span className="pth-img" data-p={p} style={{ width: W, height: Math.round((W * s.h) / Math.max(1, s.w)) }} />
            {marked.has(p) && <span className="pth-rib" />}
            <small>
              {labelOf(p)}
              {n ? ` · ${n} ${n === 1 ? "match" : "matches"}` : ""}
            </small>
          </button>
        );
      })}
    </div>
  );
}
