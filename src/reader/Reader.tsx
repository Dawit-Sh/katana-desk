// The reading view: foliate-js (https://github.com/johnfactotum/foliate-js) renders the book,
// Katana draws the page frame around it (chapter on top, page and pages left in the chapter below),
// the bars that fade after 2 s of a still mouse, the panels that float or dock, bookmarks and
// "Back to p. N" after any jump.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api, fileUrl, grimmory, type Book, type Offer } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { CaptionButtons } from "../components/TitleBar";
import { AaPanel } from "./AaPanel";
import { ContentsPanel, MarksPanel, Panel, SearchPanel, type TocItem } from "./panels";
import { marks as marksApi, type Bookmark } from "./marks";
import { cleanNote, isNoteLink, noteElement } from "./footnotes";
import { BUILT_IN, MARGINS, bookCss, loadPrefs, loadUiFonts, pageColours, saveBookPrefs, saveDefaultPrefs, type Prefs } from "./prefs";
import "./reader.css";

type Relocate = {
  fraction: number;
  location?: { current: number; next: number; total: number };
  tocItem?: { label?: string; href?: string };
  pageItem?: { label?: string };
  cfi: string;
  range?: Range;
  section?: { current: number; total: number };
};

// biome-ignore lint: foliate-js has no types
type FoliateView = HTMLElement & any;
// biome-ignore lint: foliate-js has no types
type CfiLib = any;

type LeftPanel = "toc" | "search" | null;
type RightPanel = "marks" | "aa" | null;
/** A place to go back to after a jump. */
type Back = { cfi: string; fraction: number; label: string };
type Note = { x: number; y: number; above: boolean; frag: DocumentFragment; href: string };

const LEFT_W = 340;
const RIGHT_W = 400;
/** A docked panel only docks when the page keeps at least this much room; else it floats. */
const MIN_PAGE = 520;
const BARS_IDLE_MS = 2000;

/** A CFI that didn't land (another reader wrote it, or it doesn't resolve) leaves the book far from
 *  where it should be: more than 3% of the book away from the place's own "how far". */
const missed = (view: FoliateView, fraction: number) => {
  const now = view.lastLocation?.fraction;
  return typeof now !== "number" || Math.abs(now - fraction) > 0.03;
};

/** Goes to a place: its CFI, or how far through when the CFI is missing or doesn't land. */
async function goToPlace(view: FoliateView, location: string | null, fraction: number | null) {
  if (location) {
    try {
      await view.goTo(location);
    } catch {
      /* falls back below */
    }
    await new Promise((r) => setTimeout(r, 120));
    if (fraction == null || !missed(view, fraction)) return;
  }
  if (fraction != null) await view.goToFraction(fraction);
}

const setAttr = (el: Element, name: string, value: string) => {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};

/** Lays the book out: Auto (two pages from 1200 px of page room), One, Two or Scroll; returns the columns. */
function applyLayout(view: FoliateView, p: Prefs, width: number): number {
  const r = view?.renderer;
  if (!r || view.isFixedLayout) return 1;
  const m = MARGINS[p.margins];
  setAttr(r, "margin", "0px");
  setAttr(r, "gap", `${m.gap}%`);
  if (p.layout === "scroll") {
    setAttr(r, "max-column-count", "1");
    setAttr(r, "max-inline-size", `${m.inline}px`);
    setAttr(r, "flow", "scrolled");
    return 1;
  }
  const cols = p.layout === "one" ? 1 : p.layout === "two" ? 2 : width >= 1200 ? 2 : 1;
  // two columns need the column narrower than half the room, or foliate-js lays out one
  const inline = cols === 2 ? Math.max(240, Math.min(m.inline, Math.floor(width / 2) - 1)) : m.inline;
  setAttr(r, "max-column-count", String(cols));
  setAttr(r, "max-inline-size", `${inline}px`);
  setAttr(r, "flow", "paginated");
  return cols;
}

/** foliate-js keeps its page container in a closed shadow root; a stylesheet adopted into it gives the
 *  Scroll layout a thin scroll bar in the page's colours instead of Windows' one with arrows. */
let shadowPatched = false;
function themeFoliateScrollbars() {
  if (shadowPatched) return;
  shadowPatched = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    #container::-webkit-scrollbar { width: 10px; height: 10px }
    #container::-webkit-scrollbar-button { display: none }
    #container::-webkit-scrollbar-track { background: transparent }
    #container::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 22%, transparent); border-radius: 5px; border: 3px solid transparent; background-clip: padding-box }
  `);
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = orig.call(this, init);
    if (this.localName === "foliate-paginator") root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return root;
  };
}

export function Reader({ book, onClose }: { book: Book; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rdRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const cfiRef = useRef<CfiLib | null>(null);
  const [view, setView] = useState<FoliateView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [chapter, setChapter] = useState("");
  const [tocHref, setTocHref] = useState<string | null>(null);
  const [pageText, setPageText] = useState("");
  const [pageLabel, setPageLabel] = useState("");
  const [leftText, setLeftText] = useState("");
  const [fraction, setFraction] = useState(book.fraction ?? 0);
  const [totalPages, setTotalPages] = useState(0);
  const last = useRef<Relocate | null>(null);
  const lastTurn = useRef(Date.now());
  // characters per page in the current layout, learned from chapters that fill several pages
  const perPage = useRef(0);
  const cols = useRef(1);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Grimmory's place, when it's behind this one: asked, never applied on its own
  const [offer, setOffer] = useState<Offer | null>(null);
  // a page turned (or a link followed) since the book opened: only then is it reading
  const acted = useRef(false);

  // reading settings: this book's own, or the default
  const [prefs, setPrefsState] = useState<Prefs>(BUILT_IN);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [own, setOwn] = useState(false);
  const [def, setDef] = useState<Prefs>(BUILT_IN);
  const [prefsReady, setPrefsReady] = useState(false);

  // panels, bars, bookmarks, back, notes
  const [left, setLeft] = useState<LeftPanel>(null);
  const [right, setRight] = useState<RightPanel>(null);
  const [pinL, setPinL] = useState(false);
  const [pinR, setPinR] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [bars, setBars] = useState(true);
  const [marks, setMarks] = useState<Bookmark[]>([]);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const [here, setHere] = useState<Set<number>>(new Set());
  const [back, setBack] = useState<Back | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [winW, setWinW] = useState(window.innerWidth);

  // ---------- layout of the frame ----------
  const roomFor = (n: number) => winW - n >= MIN_PAGE;
  const dockL = !!left && pinL && roomFor(LEFT_W + (right && pinR ? RIGHT_W : 0));
  const dockR = !!right && pinR && roomFor(RIGHT_W + (dockL ? LEFT_W : 0));
  const offL = dockL ? LEFT_W : 0;
  const offR = dockR ? RIGHT_W : 0;
  const floating = (!!left && !dockL) || (!!right && !dockR);

  // ---------- the bars fade after 2 s of a still mouse ----------
  const barTimer = useRef(0);
  const overBars = useRef(false);
  const keep = useRef(false);
  keep.current = floating || !!offer || !!note || state !== "ready";
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
  }, [floating, offer, note, state, poke]);

  // ---------- where you are ----------
  const pageOfFraction = useCallback(
    (f: number) => {
      if (!totalPages) return null;
      return Math.min(totalPages, Math.floor(f * totalPages) + 1);
    },
    [totalPages],
  );

  /** The place now, to come back to after a jump. */
  const placeNow = useCallback((): Back | null => {
    const r = last.current;
    if (!r?.cfi) return null;
    return { cfi: r.cfi, fraction: r.fraction ?? 0, label: pageLabelRef.current || `${Math.round((r.fraction ?? 0) * 100)}%` };
  }, []);
  const pageLabelRef = useRef("");
  pageLabelRef.current = pageLabel;

  /** Every jump (contents, search, a link, the slider, a bookmark) leaves "Back to p. N". */
  const jumpFrom = useCallback(() => {
    const p = placeNow();
    if (p) setBack(p);
    acted.current = true;
  }, [placeNow]);

  const jumpTo = useCallback(
    async (target: string | { fraction: number }) => {
      const v = viewRef.current;
      if (!v) return;
      jumpFrom();
      setNote(null);
      if (typeof target === "string") await v.goTo(target);
      else await v.goToFraction(target.fraction);
    },
    [jumpFrom],
  );

  const goBack = useCallback(async () => {
    const b = backRef.current;
    const v = viewRef.current;
    if (!b || !v) return;
    const from = placeNow();
    setBack(from);
    acted.current = true;
    await goToPlace(v, b.cfi, b.fraction);
  }, [placeNow]);
  const backRef = useRef(back);
  backRef.current = back;

  // ---------- bookmarks ----------
  const hereOf = (r: Relocate | null, list: Bookmark[]) => {
    const CFI = cfiRef.current;
    const s = new Set<number>();
    if (!r?.cfi || !CFI) return s;
    try {
      const start = CFI.collapse(r.cfi);
      const end = CFI.collapse(r.cfi, true);
      for (const b of list) {
        if (CFI.compare(b.cfi, start) >= 0 && CFI.compare(b.cfi, end) <= 0) s.add(b.id);
      }
    } catch {
      /* a CFI from another book layout: not on this page */
    }
    return s;
  };
  const refreshHere = () => setHere(hereOf(last.current, marksRef.current));

  const toggleMark = useCallback(async () => {
    const r = last.current;
    const CFI = cfiRef.current;
    if (!r?.cfi || !CFI) return;
    const on = hereOf(r, marksRef.current);
    if (on.size) {
      await Promise.all([...on].map((id) => marksApi.remove(id).catch(() => {})));
      const list = marksRef.current.filter((b) => !on.has(b.id));
      setMarks(list);
      setHere(new Set());
      return;
    }
    const excerpt = (r.range?.toString() ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || null;
    try {
      const b = await marksApi.add(
        book.id,
        CFI.collapse(r.cfi),
        r.fraction ?? null,
        pageLabelRef.current.replace(/^p\. /, "") || null,
        r.tocItem?.label?.trim() || null,
        excerpt,
      );
      const list = [...marksRef.current.filter((x) => x.id !== b.id), b].sort((a, c) => (a.fraction ?? 0) - (c.fraction ?? 0));
      setMarks(list);
      setHere(hereOf(r, list));
    } catch (e) {
      console.error(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  const removeMark = async (b: Bookmark) => {
    await marksApi.remove(b.id).catch(() => {});
    const list = marksRef.current.filter((x) => x.id !== b.id);
    setMarks(list);
    setHere(hereOf(last.current, list));
  };

  // ---------- reading settings ----------
  const setPrefs = useCallback(
    (patch: Partial<Prefs>) => {
      const p = { ...prefsRef.current, ...patch };
      setPrefsState(p);
      setOwn(true);
      saveBookPrefs(book.id, p).catch(() => {});
    },
    [book.id],
  );
  const colours = pageColours(prefs);
  const tone = prefs.colour === "theme" ? "" : colours.dark ? "tone-graphite" : "tone-paper";

  // Save the reading place: shortly after each turn, and when the book closes.
  const saveTimer = useRef<number>(0);
  const save = () => {
    const r = last.current;
    if (!r?.cfi) return Promise.resolve();
    const idx = r.section?.current;
    const id = idx != null ? viewRef.current?.book?.sections?.[idx]?.id : null;
    const href = typeof id === "string" ? id : null;
    return api.saveProgress(book.id, r.cfi, r.fraction ?? 0, r.tocItem?.label?.trim() || null, href, acted.current).catch(() => {});
  };

  const answer = async (go: boolean) => {
    setOffer(null);
    const p = await grimmory.answer(book.id, go).catch(() => null);
    const v = viewRef.current;
    if (!go || !p || !v) return;
    acted.current = false;
    await goToPlace(v, p.location, p.fraction);
  };

  // keys need the latest of these without re-binding listeners in every book page
  const act = useRef({ toggleMark, goBack, poke, hideBars, setPrefs });
  act.current = { toggleMark, goBack, poke, hideBars, setPrefs };
  const ui = useRef({ left, right, note });
  ui.current = { left, right, note };

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current!;
    let view: FoliateView | null = null;
    let wheelAcc = 0;
    let wheelLock = 0;
    const scrolled = () => prefsRef.current.layout === "scroll" && !viewRef.current?.isFixedLayout;

    const turn = (how: "prev" | "next" | "left" | "right", distance?: number) => {
      const v = viewRef.current;
      if (!v?.renderer) return;
      lastTurn.current = Date.now();
      acted.current = true;
      setNote(null);
      if (how === "prev") v.prev(distance);
      else if (how === "next") v.next(distance);
      else if (how === "left") v.goLeft();
      else v.goRight();
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, [contenteditable]");
      const k = e.key.toLowerCase();
      // a focused button takes Space and Enter, the slider its arrows
      if (!e.ctrlKey && !e.altKey && t?.closest?.("button") && (e.key === " " || e.key === "Enter")) return;
      if (!e.altKey && t?.closest?.("[role=slider]") && e.key.startsWith("Arrow")) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (k === "b" && !typing) {
          e.preventDefault();
          act.current.toggleMark();
        } else if (k === "f") {
          e.preventDefault();
          setLeft("search");
          setSearchFocus((n) => n + 1);
        } else if (k === "=" || k === "+") {
          e.preventDefault();
          act.current.setPrefs({ size: Math.min(200, prefsRef.current.size + 10) });
        } else if (k === "-") {
          e.preventDefault();
          act.current.setPrefs({ size: Math.max(70, prefsRef.current.size - 10) });
        } else if (k === "0") {
          e.preventDefault();
          act.current.setPrefs({ size: 100 });
        }
        return;
      }
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        act.current.goBack();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey || typing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // Esc closes the top-most thing: a note, a floating panel, then the book
        const u = ui.current;
        if (u.note) return setNote(null);
        if (u.right) return setRight(null);
        if (u.left) return setLeft(null);
        return closeRef.current();
      }
      const map: Record<string, "prev" | "next" | "left" | "right"> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "prev",
        ArrowDown: "next",
        PageUp: "prev",
        PageDown: "next",
      };
      if (e.key === " ") {
        e.preventDefault();
        act.current.hideBars();
        return turn(e.shiftKey ? "prev" : "next");
      }
      const how = map[e.key];
      if (how) {
        e.preventDefault();
        act.current.hideBars();
        // in Scroll, the up and down arrows move a few lines
        if (scrolled() && (e.key === "ArrowUp" || e.key === "ArrowDown")) return turn(how, 90);
        turn(how);
      }
    };

    // The wheel turns one page per notch; a trackpad's stream of small deltas adds up to one turn.
    // In Scroll the wheel just scrolls.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || scrolled()) return;
      e.preventDefault();
      const now = Date.now();
      if (now < wheelLock) return;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      wheelAcc += e.deltaMode === 1 ? d * 40 : d;
      if (Math.abs(wheelAcc) >= 50) {
        turn(wheelAcc > 0 ? "next" : "prev");
        wheelAcc = 0;
        wheelLock = now + 280;
      }
    };

    // A click in the outer fifth of the page turns it; the middle is left for reading and selecting.
    const onDocClick = (doc: Document) => (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if ((e.target as Element)?.closest?.("a[href]")) return;
      setNote(null);
      if (scrolled()) return;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      const pageRect = host.getBoundingClientRect();
      const x = (frame?.getBoundingClientRect().left ?? 0) + e.clientX;
      const f = (x - pageRect.left) / pageRect.width;
      if (f < 0.2) turn("left");
      else if (f > 0.8) turn("right");
    };

    // a real mouse move (not a page laid out under a still mouse) shows the bars
    let mx = -1;
    let my = -1;
    const onMove = (e: MouseEvent) => {
      if (e.screenX === mx && e.screenY === my) return;
      mx = e.screenX;
      my = e.screenY;
      act.current.poke();
    };

    const onRelocate = (e: CustomEvent<Relocate>) => {
      const d = e.detail;
      last.current = d;
      setChapter(d.tocItem?.label?.trim() ?? "");
      setTocHref(d.tocItem?.href ?? null);
      setFraction(d.fraction ?? 0);
      const v = viewRef.current;
      const r = v?.renderer;
      const book_ = v?.book;
      const isScroll = !!r?.scrolled;
      const textPages = r && typeof r.pages === "number" && !isScroll ? r.pages - 2 : 0;
      // Pages: foliate-js counts the book in 1,500-byte locations, which don't move on every turn.
      // Katana counts pages of the window as it is laid out now: the book's size over what one page holds.
      const sections = (book_?.sections ?? []).filter((x: { linear?: string }) => x.linear !== "no");
      const totalBytes = sections.reduce((a: number, x: { size?: number }) => a + (x.size ?? 0), 0);
      const idx = d.section?.current;
      const hereBytes = idx != null ? book_?.sections?.[idx]?.size ?? 0 : 0;
      if (textPages >= 3 && hereBytes > 4000) perPage.current = hereBytes / textPages;
      const per = perPage.current || 1900 * cols.current;
      let label = "";
      if (d.pageItem?.label) {
        setPageText(`p. ${d.pageItem.label}`);
        label = `p. ${d.pageItem.label}`;
        if (totalBytes > 0) setTotalPages(Math.max(1, Math.round(totalBytes / per)));
      } else if (totalBytes > 0) {
        const total = Math.max(1, Math.round(totalBytes / per));
        const n = Math.min(total, Math.floor((d.fraction ?? 0) * total) + 1);
        setTotalPages(total);
        setPageText(`${n} / ${total}`);
        label = `p. ${n}`;
      } else if (d.location) {
        setPageText(`${d.location.current + 1} / ${d.location.total}`);
        label = `p. ${d.location.current + 1}`;
        setTotalPages(d.location.total);
      }
      setPageLabel(label);
      pageLabelRef.current = label;
      if (isScroll && r.viewSize && r.size) {
        const left = Math.max(0, Math.ceil((r.viewSize - r.end) / r.size));
        setLeftText(left === 0 ? "End of chapter" : `${left} ${left === 1 ? "screen" : "screens"} left in chapter`);
      } else if (textPages > 0) {
        const left = Math.max(0, textPages - r.page);
        setLeftText(left === 0 ? "Last page in chapter" : `${left} left in chapter`);
      } else setLeftText("");
      setHere(hereOf(d, marksRef.current));
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(save, 600);
    };

    // links: a footnote opens in a pop-up (when chosen), any other jump leaves "Back to p. N"
    const onLink = (e: CustomEvent<{ a: HTMLAnchorElement; href: string }>) => {
      const v = viewRef.current;
      const { a, href } = e.detail;
      acted.current = true;
      if (prefsRef.current.footnotes === "popup" && v && isNoteLink(a)) {
        e.preventDefault();
        const doc = a.ownerDocument;
        const frame = doc.defaultView?.frameElement as HTMLElement | null;
        const fr = frame?.getBoundingClientRect();
        const ar = a.getBoundingClientRect();
        const rd = rdRef.current!.getBoundingClientRect();
        const x = (fr?.left ?? 0) + ar.left + ar.width / 2 - rd.left;
        const yTop = (fr?.top ?? 0) + ar.top - rd.top;
        const yBot = (fr?.top ?? 0) + ar.bottom - rd.top;
        (async () => {
          try {
            const { index, anchor } = await v.book.resolveHref(href);
            const sdoc = await v.book.sections[index].createDocument();
            const el = noteElement(anchor(sdoc));
            if (!el) throw new Error("no note");
            const frag = cleanNote(el);
            if (!frag.textContent?.trim()) throw new Error("empty note");
            const above = yBot > rd.height * 0.6;
            setNote({ x, y: above ? yTop : yBot, above, frag, href });
          } catch {
            jumpFrom();
            v.goTo(href);
          }
        })();
        return;
      }
      jumpFrom();
    };

    const onLoad = (e: CustomEvent<{ doc: Document }>) => {
      const doc = e.detail.doc;
      doc.addEventListener("keydown", onKey);
      doc.addEventListener("wheel", onWheel, { passive: false });
      doc.addEventListener("click", onDocClick(doc));
      doc.addEventListener("mousemove", onMove);
    };

    const themeObserver = new MutationObserver(() => {
      const v = viewRef.current;
      if (!v?.renderer) return;
      const c = pageColours(prefsRef.current);
      v.renderer.setStyles?.(bookCss(prefsRef.current, c));
      // re-render so the page colour follows the theme
      setPrefsState((p) => ({ ...p }));
    });

    (async () => {
      try {
        loadUiFonts();
        themeFoliateScrollbars();
        const [{ prefs: p, own: o, def: d }, list, CFI] = await Promise.all([
          loadPrefs(book.id),
          marksApi.list(book.id).catch(() => [] as Bookmark[]),
          import("foliate-js/epubcfi.js"),
          import("foliate-js/view.js"),
        ]);
        cfiRef.current = CFI;
        prefsRef.current = p;
        setPrefsState(p);
        setOwn(o);
        setDef(d);
        setMarks(list);
        marksRef.current = list;
        setPrefsReady(true);
        const [pl, pr] = await Promise.all([api.getSetting("reader.pinLeft"), api.getSetting("reader.pinRight")]).catch(() => [null, null]);
        setPinL(pl === "1");
        setPinR(pr === "1");
        const res = await fetch(fileUrl(book.path));
        if (!res.ok) throw new Error(`The file could not be read (${res.status}).`);
        const blob = await res.blob();
        const name = book.path.split(/[\\/]/).pop() ?? "book";
        const file = new File([blob], name, { type: blob.type });
        if (cancelled) return;
        view = document.createElement("foliate-view") as FoliateView;
        view.setAttribute("autohide-cursor", "");
        viewRef.current = view;
        host.append(view);
        await view.open(file);
        if (cancelled) return;
        const r = view.renderer;
        cols.current = applyLayout(view, p, host.clientWidth);
        r.setStyles?.(bookCss(p, pageColours(p)));
        view.addEventListener("relocate", onRelocate);
        view.addEventListener("load", onLoad);
        view.addEventListener("link", onLink);
        view.addEventListener("external-link", (e: Event) => e.preventDefault());
        // a Grimmory book (or a Local copy of one) opens at Grimmory's place when that's the latest read
        const place = await grimmory.openPlace(book.id).catch(() => null);
        if (cancelled) return;
        const location = place ? place.location : book.location;
        const fraction = place ? place.fraction : book.fraction;
        await view.init({ lastLocation: location ?? undefined, showTextStart: !location && !fraction });
        if (!location && fraction && fraction > 0) await view.goToFraction(fraction);
        else if (location && fraction != null && missed(view, fraction)) await view.goToFraction(fraction);
        if (cancelled) return;
        if (place?.offer) setOffer(place.offer);
        setView(view);
        setState("ready");
        api.markOpened(book.id).catch(() => {});
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setState("error");
        }
      }
    })();

    const onResize = () => setWinW(window.innerWidth);
    const ro = new ResizeObserver(() => setArea({ w: host.clientWidth, h: host.clientHeight }));
    ro.observe(host);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMove);
    host.addEventListener("wheel", onWheel, { passive: false });
    // Grimmory's place moved while the book is open (read on the Fire): ask
    const unOffer = listen<number>("grimmory-offer", (e) => {
      if (e.payload === book.id) grimmory.offer(book.id).then((o) => o && setOffer(o)).catch(() => {});
    });

    // Reading time for the reading card and the Journal: counted while the window is in front
    // and a page was turned in the last two minutes.
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastTurn.current < 120_000)
        api.addReading(15).catch(() => {});
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(tick);
      clearTimeout(saveTimer.current);
      clearTimeout(barTimer.current);
      // the place goes up as the book closes
      save().finally(() => grimmory.closed(book.id).catch(() => {}));
      unOffer.then((f) => f());
      themeObserver.disconnect();
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMove);
      host.removeEventListener("wheel", onWheel);
      try {
        view?.close();
      } catch {
        /* already closed */
      }
      view?.remove();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  // settings and room changes lay the book out again
  useEffect(() => {
    const v = viewRef.current;
    if (!v?.renderer || !prefsReady) return;
    cols.current = applyLayout(v, prefs, area.w);
    v.renderer.setStyles?.(bookCss(prefs, pageColours(prefs)));
    perPage.current = 0;
  }, [prefs, area.w, prefsReady, view]);

  // after a re-layout, the page you're on may hold other bookmarks
  useEffect(() => {
    refreshHere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks]);

  const pin = (side: "left" | "right") => {
    if (side === "left") {
      setPinL((p) => {
        api.setSetting("reader.pinLeft", p ? "0" : "1").catch(() => {});
        return !p;
      });
    } else {
      setPinR((p) => {
        api.setSetting("reader.pinRight", p ? "0" : "1").catch(() => {});
        return !p;
      });
    }
  };

  // contents: pages of each chapter, from where its section starts in the book
  const toc: TocItem[] = (view?.book?.toc as TocItem[]) ?? [];
  const sectionFractions: number[] = useMemo(() => (view ? view.getSectionFractions?.() ?? [] : []), [view]);
  // a book with printed page numbers: each chapter's printed page, found once when Contents opens
  const [tocPages, setTocPages] = useState<Map<string, string> | null>(null);
  const tocPagesStarted = useRef(false);
  const printed: { label?: string }[] = view?.book?.pageList ?? [];
  useEffect(() => {
    const v = viewRef.current;
    if (left !== "toc" || !v || !printed.length || tocPagesStarted.current) return;
    tocPagesStarted.current = true;
    (async () => {
      const map = new Map<string, string>();
      const docs = new Map<number, Document>();
      const all: TocItem[] = [];
      const walk = (items: TocItem[]) => items.forEach((it) => (all.push(it), it.subitems && walk(it.subitems)));
      walk(toc);
      for (const it of all) {
        if (!it.href || viewRef.current !== v) continue;
        try {
          const { index, anchor } = await v.resolveNavigation(it.href);
          let doc = docs.get(index);
          if (!doc) {
            doc = (await v.book.sections[index].createDocument()) as Document;
            docs.set(index, doc);
          }
          const frag = anchor ? anchor(doc) : null;
          let range: Range;
          if (frag instanceof Range) range = frag;
          else {
            range = doc.createRange();
            range.selectNodeContents(frag ?? doc.body);
            range.collapse(true);
          }
          const label = v.getProgressOf(index, range)?.pageItem?.label;
          if (label) map.set(it.href, String(label));
        } catch {
          /* no printed page for this one */
        }
      }
      if (viewRef.current === v) setTocPages(map);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, view]);

  const pageOfHref = useCallback(
    (href: string) => {
      const v = viewRef.current;
      if (tocPages) return tocPages.get(href) ?? null;
      if (printed.length) return null;
      if (!v || !totalPages) return null;
      try {
        const [id] = v.book.splitTOCHref?.(href) ?? [href];
        const idx = v.book.sections.findIndex((s: { id: string }) => s.id === id);
        if (idx < 0) return null;
        return pageOfFraction(sectionFractions[idx] ?? 0);
      } catch {
        return null;
      }
    },
    [totalPages, sectionFractions, pageOfFraction, tocPages, printed.length],
  );
  // chapter marks on the slider: where each top-level chapter starts
  const ticks = useMemo(() => {
    const v = viewRef.current;
    if (!v) return [] as number[];
    const out: number[] = [];
    for (const it of toc) {
      if (!it.href) continue;
      try {
        const [id] = v.book.splitTOCHref?.(it.href) ?? [it.href];
        const idx = v.book.sections.findIndex((s: { id: string }) => s.id === id);
        const f = sectionFractions[idx];
        if (idx >= 0 && f > 0.005 && f < 0.995) out.push(f);
      } catch {
        /* skip */
      }
    }
    return [...new Set(out)].slice(0, 80);
  }, [toc, sectionFractions]);

  // the slider: drag to a place, let go to go there
  const [drag, setDrag] = useState<number | null>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const fracAt = (clientX: number) => {
    const r = sliderRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const shownFrac = drag ?? fraction;

  // the ribbon sits at the top right of the text column
  const m = MARGINS[prefs.margins];
  const colsNow = view?.isFixedLayout || prefs.layout === "scroll" || prefs.layout === "one" ? 1 : prefs.layout === "two" || area.w >= 1200 ? 2 : 1;
  const avail = area.w * (1 - (2 * m.gap) / 100);
  const textW = Math.min(avail, colsNow * Math.min(m.inline, colsNow === 2 ? area.w / 2 : m.inline));
  const ribbonX = Math.round(Math.min(area.w / 2 + textW / 2 - 40, area.w - 60));
  const marked = here.size > 0;

  const pageStyle = {
    "--k-page": colours.bg,
    "--k-ptext": colours.fg,
  } as CSSProperties;

  // the pill bar leaves the bottom strip's "left in chapter" in view
  const pillW = Math.min(760, Math.max(360, area.w - 460));

  return (
    <div ref={rdRef} className={`rd ${tone} ${bars ? "" : "bars-off"}`} style={pageStyle} data-page-dark={colours.dark ? "1" : "0"}>
      <div className="pgarea" style={{ left: offL, right: offR }}>
        <div className="strip">{chapter}</div>
        <div className="page" ref={hostRef}>
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
        <div className="strip bot">
          <span />
          <span>{pageText}</span>
          <span>{leftText}</span>
        </div>
        {state === "ready" && (
          <button
            type="button"
            className={`corner ${marked ? "on" : ""}`}
            style={{ left: ribbonX }}
            aria-label={marked ? "Remove the bookmark on this page" : "Bookmark this page"}
            title={marked ? "Remove the bookmark (Ctrl B)" : "Bookmark this page (Ctrl B)"}
            onClick={toggleMark}
          >
            <span className="ribbon" />
          </button>
        )}
      </div>

      <header
        className="rtb glass bar"
        data-tauri-drag-region
        onMouseEnter={() => (overBars.current = true)}
        onMouseLeave={() => (overBars.current = false)}
      >
        <button type="button" className="ib" aria-label="Back to the library" title="Back to the library (Esc)" onClick={onClose}>
          <i className="ms">arrow_back</i>
        </button>
        <div className="t" data-tauri-drag-region>
          <b>{book.title}</b>
          {book.author && <small>{book.author}</small>}
        </div>
        <div className="grow" data-tauri-drag-region />
        <button
          type="button"
          className={`ib ${left === "search" ? "on" : ""}`}
          aria-label="Search this book"
          title="Search this book (Ctrl F)"
          onClick={() => {
            if (left === "search") setLeft(null);
            else {
              setLeft("search");
              setSearchFocus((n) => n + 1);
            }
          }}
        >
          <i className="ms">search</i>
        </button>
        <button
          type="button"
          className="ib"
          aria-label={marked ? "Remove the bookmark on this page" : "Bookmark this page"}
          aria-pressed={marked}
          title={marked ? "Remove the bookmark (Ctrl B)" : "Bookmark this page (Ctrl B)"}
          onClick={toggleMark}
          disabled={state !== "ready"}
        >
          <i className={`ms ${marked ? "f ribbon-ic" : ""}`}>bookmark</i>
        </button>
        <button
          type="button"
          className={`ib ${right === "marks" ? "on" : ""}`}
          aria-label="Bookmarks in this book"
          title="Bookmarks in this book"
          onClick={() => setRight(right === "marks" ? null : "marks")}
        >
          <i className="ms">bookmarks</i>
        </button>
        <button
          type="button"
          className={`ib ${right === "aa" ? "on" : ""}`}
          aria-label="Reading settings"
          title="Reading settings"
          onClick={() => setRight(right === "aa" ? null : "aa")}
        >
          <i className="ms">format_size</i>
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

      {left && view && (
        <div className={`pwrap left ${dockL ? "docked" : ""}`}>
          {left === "toc" ? (
            <Panel
              side="left"
              label="Contents"
              title="Contents"
              sub={`${toc.length} ${toc.length === 1 ? "part" : "parts"}${printed.length ? ` · ${printed[printed.length - 1]?.label ?? printed.length} printed pages` : totalPages ? ` · ${totalPages} pages` : ""}`}
              pinned={pinL}
              docked={dockL}
              width={LEFT_W}
              onPin={() => pin("left")}
              onClose={() => setLeft(null)}
            >
              <ContentsPanel
                toc={toc}
                current={tocHref}
                pageOf={pageOfHref}
                onGo={(href) => {
                  jumpTo(href);
                  if (!dockL) setLeft(null);
                }}
              />
            </Panel>
          ) : (
            <Panel
              side="left"
              label="Search this book"
              title="Search"
              sub="Every match is marked in the book"
              pinned={pinL}
              docked={dockL}
              width={LEFT_W}
              onPin={() => pin("left")}
              onClose={() => setLeft(null)}
            >
              <SearchPanel view={view} initial={searchText} onQuery={setSearchText} onFirstJump={jumpFrom} focusKey={searchFocus} />
            </Panel>
          )}
        </div>
      )}

      {right && (
        <div className={`pwrap right ${dockR ? "docked" : ""}`}>
          {right === "aa" ? (
            <Panel
              side="right"
              label="Reading settings"
              title="Reading settings"
              sub={own ? "This book's own settings" : "The default · changes become this book's own"}
              pinned={pinR}
              docked={dockR}
              width={RIGHT_W}
              onPin={() => pin("right")}
              onClose={() => setRight(null)}
            >
              <AaPanel
                prefs={prefs}
                set={setPrefs}
                own={own}
                isDefault={JSON.stringify(prefs) === JSON.stringify(def)}
                fixed={!!view?.isFixedLayout}
                onSaveDefault={() => {
                  saveDefaultPrefs(prefs).catch(() => {});
                  setDef(prefs);
                }}
                onUseDefault={() => {
                  saveBookPrefs(book.id, null).catch(() => {});
                  setOwn(false);
                  setPrefsState(def);
                }}
              />
            </Panel>
          ) : (
            <Panel
              side="right"
              label="Bookmarks in this book"
              title="Marks in this book"
              sub={`${marks.length} ${marks.length === 1 ? "bookmark" : "bookmarks"}`}
              pinned={pinR}
              docked={dockR}
              width={RIGHT_W}
              onPin={() => pin("right")}
              onClose={() => setRight(null)}
            >
              <MarksPanel
                marks={marks}
                here={here}
                hereLabel={pageLabel || `${Math.round(fraction * 100)}%`}
                fraction={fraction}
                onGo={(b) => {
                  jumpTo(b.cfi);
                  if (!dockR) setRight(null);
                }}
                onRemove={removeMark}
              />
            </Panel>
          )}
        </div>
      )}

      {state === "ready" && (
        <div
          className="pillbar glass bar"
          style={{ left: offL + area.w / 2, width: pillW }}
          onMouseEnter={() => (overBars.current = true)}
          onMouseLeave={() => (overBars.current = false)}
        >
          <button
            type="button"
            className={`ib ${left === "toc" ? "on" : ""}`}
            aria-label="Contents"
            title="Contents"
            onClick={() => setLeft(left === "toc" ? null : "toc")}
          >
            <i className="ms">toc</i>
          </button>
          <span className="pct">{Math.round(shownFrac * 100)}%</span>
          <div
            className="slider"
            ref={sliderRef}
            role="slider"
            tabIndex={0}
            aria-label="Place in the book"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(shownFrac * 100)}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              setDrag(fracAt(e.clientX));
            }}
            onPointerMove={(e) => {
              if (drag != null) setDrag(fracAt(e.clientX));
            }}
            onPointerUp={(e) => {
              if (drag == null) return;
              const f = fracAt(e.clientX);
              setDrag(null);
              if (Math.abs(f - fraction) > 0.0005) jumpTo({ fraction: f });
            }}
            onKeyDown={(e) => {
              if (!e.altKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                e.preventDefault();
                e.stopPropagation();
                jumpTo({ fraction: Math.min(1, Math.max(0, fraction + (e.key === "ArrowRight" ? 0.01 : -0.01))) });
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
                {printed.length ? `${Math.round(drag * 100)}%` : `p. ${pageOfFraction(drag) ?? "?"}`}
              </span>
            )}
          </div>
          <span className="pno">{drag != null && !printed.length ? `p. ${pageOfFraction(drag) ?? "?"}` : pageText}</span>
          {back && (
            <button type="button" className="backchip" onClick={goBack} title="Go back to where you were before the jump (Alt ←)">
              <i className="ms">history</i>Back to {back.label}
            </button>
          )}
        </div>
      )}

      {note && (
        <div className={`fnote ${note.above ? "above" : ""}`} style={{ left: Math.min(Math.max(note.x, 230), (rdRef.current?.clientWidth ?? 800) - 230), top: note.y }} role="dialog" aria-label="Footnote">
          <div
            className="fbody"
            ref={(el) => {
              if (el && !el.dataset.filled) {
                el.dataset.filled = "1";
                el.replaceChildren(note.frag.cloneNode(true));
              }
            }}
          />
          <div className="ffoot">
            <button
              type="button"
              className="pill tone"
              onClick={() => {
                const href = note.href;
                setNote(null);
                jumpTo(href);
              }}
            >
              <i className="ms">arrow_forward</i>Go to the note
            </button>
            <span className="grow" />
            <button type="button" className="pbtn" aria-label="Close" onClick={() => setNote(null)}>
              <i className="ms">close</i>
            </button>
          </div>
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
