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
import { COLOURS, exportMarkdown, hexOf, hls, marks as marksApi, marksApi as marksSync, type Bookmark, type Colour, type Highlight, type MarkPlace, type Style } from "./marks";
import { HighlightCard, SelectionCard, copyText, type Anchor } from "./cards";
import { logRevisit, type Mark } from "./marklist";
import { WordCard, type WordAsk } from "./WordCard";
import { Review } from "../components/Review";
import { learning, sentenceAround, words as wordsApi, type Word } from "../lib/words";
import { Overlayer } from "foliate-js/overlayer.js";
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
/** Words selected on the page: the selection card shows. */
type Sel = { index: number; range: Range; doc: Document; text: string; cfi: string; anchor: Anchor };
/** A highlight clicked (or just made with Note): the highlight card shows. */
type Card = { id: number; anchor: Anchor; editing: boolean };
type Toast = { text: string; undo?: () => void };
type Look = { color: Colour; style: Style };

/** A page's first words for a bookmark: about 160 characters, ending at a word. */
function firstWords(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= 160) return t || null;
  const cut = t.slice(0, 160);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 100 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** How far through the book a range is: its section's share, and the characters before it there. */
function fractionIn(view: FoliateView, index: number, doc: Document, range: Range): number | null {
  try {
    const sf: number[] = view.getSectionFractions?.() ?? [];
    const a = sf[index] ?? 0;
    const b = sf[index + 1] ?? 1;
    const body = doc.body ?? doc.documentElement;
    const pre = doc.createRange();
    pre.setStart(body, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const before = pre.toString().length;
    const total = (body.textContent ?? "").length || 1;
    return Math.min(1, Math.max(0, a + ((b - a) * before) / total));
  } catch {
    return null;
  }
}

/** A range's box in the reader's coordinates (the page sits in an iframe). */
function anchorOf(range: Range, doc: Document, rd: HTMLElement): Anchor {
  const frame = doc.defaultView?.frameElement as HTMLElement | null;
  const fr = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const box = rd.getBoundingClientRect();
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const r = range.getBoundingClientRect();
  // a selection over two columns: point at its first line
  const first = rects[0];
  const twoCols = first && rects.some((x) => x.left > first.right + 40 && x.top < first.top);
  const b = twoCols ? first : r;
  return { left: fr.left + b.left - box.left, right: fr.left + b.right - box.left, top: fr.top + b.top - box.top, bottom: fr.top + (twoCols ? first.bottom : r.bottom) - box.top };
}

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

const syncText = (s: string) =>
  s === "synced"
    ? "Highlights and bookmarks sync with Grimmory."
    : s === "waiting"
      ? "Changes wait to go to Grimmory."
      : s === "format"
        ? "This format's highlights and bookmarks stay on this PC."
        : "Highlights and bookmarks stay on this PC.";

export function Reader({ book, onClose, startAt }: { book: Book; onClose: () => void; startAt?: string | null }) {
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
  /** pages turned since the last reading tick, for the Journal's pages an hour */
  const turns = useRef(0);
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

  // highlights, the selection card, the highlight card
  const [hl, setHl] = useState<Highlight[]>([]);
  const hlRef = useRef(hl);
  hlRef.current = hl;
  const [sel, setSel] = useState<Sel | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const [card, setCard] = useState<Card | null>(null);
  const cardRef = useRef(card);
  cardRef.current = card;
  const [look, setLook] = useState<Look>({ color: "yellow", style: "highlight" });
  const lookRef = useRef(look);
  lookRef.current = look;
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef(0);
  // the word card (Look up, a double-click), this book's saved words, the review cards
  const [word, setWord] = useState<WordAsk | null>(null);
  const [bookWords, setBookWords] = useState<Word[]>([]);
  const [review, setReview] = useState(false);
  const [lost, setLost] = useState<{ highlights: number; bookmarks: number } | null>(null);
  const [syncLine, setSyncLine] = useState<string | null>(null);
  const annotClick = useRef(0);
  const totalRef = useRef(0);
  const [room, setRoom] = useState({ w: 0, h: 0 });

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
  keep.current = floating || !!offer || !!note || !!sel || !!card || !!word || review || !!lost || state !== "ready";
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
  }, [floating, offer, note, state, poke, lost, word, review]);

  // this book's saved words, for the Words tab
  useEffect(() => {
    wordsApi.list(book.id).then(setBookWords).catch(() => {});
  }, [book.id]);

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
    const excerpt = firstWords(r.range?.toString() ?? "");
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

  const saveBookmark = async (b: Bookmark, title: string | null, note: string | null) => {
    await marksApi.update(b.id, title, note).catch(() => {});
    setMarks(marksRef.current.map((x) => (x.id === b.id ? { ...x, title, note, updatedAt: Date.now() } : x)));
  };

  // ---------- highlights ----------
  const showToast = useCallback((t: Toast) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), t.undo ? 6000 : 2600);
  }, []);

  const draw = (h: Highlight) => viewRef.current?.addAnnotation({ value: h.cfi }).catch?.(() => {});
  const undraw = (cfi: string) => viewRef.current?.deleteAnnotation({ value: cfi }).catch?.(() => {});

  const clearSelection = () => {
    const s = selRef.current;
    try {
      s?.doc.getSelection()?.removeAllRanges();
    } catch {
      /* the page went */
    }
    setSel(null);
  };

  /** Highlights the selected words (one click on a dot, H, or Note). */
  const makeHighlight = async (color: Colour, style: Style, withNote = false) => {
    const s = selRef.current;
    const v = viewRef.current;
    if (!s || !v) return;
    const progress = v.getProgressOf?.(s.index, s.range) ?? {};
    // the page as the reader counts it: the page you're on (the right one of two when the words are there)
    const frac = last.current?.fraction ?? fractionIn(v, s.index, s.doc, s.range);
    const printedPage = progress.pageItem?.label ? String(progress.pageItem.label) : null;
    const shown = Number(pageLabelRef.current.replace(/^p\. /, ""));
    const host = hostRef.current?.getBoundingClientRect();
    const rightPage = cols.current === 2 && host && s.anchor.left > host.left + host.width / 2;
    const pageLabel = printedPage ?? (shown ? String(shown + (rightPage ? 1 : 0)) : null);
    try {
      const h = await hls.add({
        bookId: book.id,
        cfi: s.cfi,
        text: s.text,
        chapter: progress.tocItem?.label?.trim() || last.current?.tocItem?.label?.trim() || null,
        fraction: frac,
        pageLabel,
        color,
        style,
      });
      clearSelection();
      setHl((list) => [...list.filter((x) => x.id !== h.id), h]);
      hlRef.current = [...hlRef.current.filter((x) => x.id !== h.id), h];
      draw(h);
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
    setHl((list) => list.map((x) => (x.id === h.id ? next : x)));
    hlRef.current = hlRef.current.map((x) => (x.id === h.id ? next : x));
    draw(next);
    if (color !== h.color || style !== h.style) {
      const lk = { color, style };
      setLook(lk);
      api.setSetting("reader.hlLook", JSON.stringify(lk)).catch(() => {});
    }
    await hls.update(h.id, color, style, note).catch(() => showToast({ text: "That change couldn't be saved." }));
  };

  const deleteHighlight = async (h: Highlight) => {
    setCard(null);
    setHl((list) => list.filter((x) => x.id !== h.id));
    hlRef.current = hlRef.current.filter((x) => x.id !== h.id);
    undraw(h.cfi);
    await hls.remove(h.id).catch(() => {});
    showToast({
      text: "Highlight deleted",
      undo: async () => {
        const back = await hls.restore(h).catch(() => null);
        if (!back) return;
        setHl((list) => [...list.filter((x) => x.id !== back.id), back]);
        hlRef.current = [...hlRef.current.filter((x) => x.id !== back.id), back];
        draw(back);
      },
    });
  };

  const copySel = async () => {
    const s = selRef.current;
    if (!s) return;
    await copyText(s.text);
    clearSelection();
    showToast({ text: "Copied" });
  };

  /** Opens the word card for words on the page (Look up, L, or a double-click). */
  const openWord = (s: { index: number; range: Range; doc: Document; text: string; cfi: string | null; anchor: Anchor }) => {
    const v = viewRef.current;
    let progress: { tocItem?: { label?: string }; pageItem?: { label?: string } } = {};
    try {
      progress = v?.getProgressOf?.(s.index, s.range) ?? {};
    } catch {
      /* no place: still looked up */
    }
    const printedPage = progress.pageItem?.label ? String(progress.pageItem.label) : null;
    const shown = Number(pageLabelRef.current.replace(/^p\. /, ""));
    const host = hostRef.current?.getBoundingClientRect();
    const rightPage = cols.current === 2 && host && s.anchor.left > host.left + host.width / 2;
    setSel(null);
    setCard(null);
    setWord({
      text: s.text,
      sentence: sentenceAround(s.range),
      anchor: s.anchor,
      cfi: s.cfi,
      fraction: last.current?.fraction ?? (v ? fractionIn(v, s.index, s.doc, s.range) : null),
      pageLabel: printedPage ?? (shown ? String(shown + (rightPage ? 1 : 0)) : null),
      chapter: progress.tocItem?.label?.trim() || last.current?.tocItem?.label?.trim() || null,
    });
  };

  const lookUp = () => {
    const s = selRef.current;
    if (!s || s.text.length > 60) return;
    openWord(s);
  };

  const wordSaved = (w: Word) => {
    setBookWords((list) => [w, ...list.filter((x) => x.id !== w.id)]);
    showToast({ text: `“${w.word}” is in My words` });
  };
  const wordRemoved = (w: Word) => {
    setBookWords((list) => list.filter((x) => x.id !== w.id));
    showToast({
      text: `“${w.word}” taken out of My words`,
      undo: async () => {
        const back = await wordsApi.restore(w).catch(() => null);
        if (back) setBookWords((list) => [back, ...list.filter((x) => x.id !== back.id)].sort((a, b) => b.createdAt - a.createdAt));
      },
    });
  };
  const removeWord = async (w: Word) => {
    const gone = await wordsApi.remove(w.id).catch(() => null);
    if (gone) wordRemoved(gone);
  };
  const goToWord = (w: Word) => {
    if (!w.cfi) return;
    learning.revisit("word", w.uuid, book.id);
    jumpTo(w.cfi);
    if (!dockR) setRight(null);
  };

  /** Reloads marks after Grimmory changed them, and redraws what moved. */
  const reloadMarks = useCallback(async () => {
    const [h, b] = await Promise.all([hls.list(book.id), marksApi.list(book.id)]).catch(() => [null, null]);
    if (h) {
      const before = new Map(hlRef.current.map((x) => [x.cfi, x]));
      const after = new Map(h.map((x) => [x.cfi, x]));
      for (const [cfi] of before) if (!after.has(cfi)) undraw(cfi);
      hlRef.current = h;
      setHl(h);
      for (const x of h) {
        const o = before.get(x.cfi);
        if (!o || o.color !== x.color || o.style !== x.style) draw(x);
      }
      const c = cardRef.current;
      if (c && !h.some((x) => x.id === c.id)) setCard(null);
    }
    if (b) {
      marksRef.current = b;
      setMarks(b);
    }
    marksSync.syncState(book.id).then((st) => setSyncLine(syncText(st))).catch(() => {});
    placeMissing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  /** Marks from Grimmory have no page here yet: they get one (how far through, page, chapter, first words). */
  const placing = useRef(false);
  const placeMissing = async () => {
    const v = viewRef.current;
    if (!v || placing.current) return;
    const todo: { kind: "highlight" | "bookmark"; id: number; cfi: string }[] = [
      ...hlRef.current.filter((h) => h.fraction == null).map((h) => ({ kind: "highlight" as const, id: h.id, cfi: h.cfi })),
      ...marksRef.current.filter((b) => b.fraction == null).map((b) => ({ kind: "bookmark" as const, id: b.id, cfi: b.cfi })),
    ];
    if (!todo.length) return;
    placing.current = true;
    const docs = new Map<number, Document>();
    const places: MarkPlace[] = [];
    for (const t of todo) {
      try {
        const { index, anchor } = v.resolveNavigation(t.cfi) ?? {};
        if (index == null || !anchor) continue;
        let doc = docs.get(index);
        if (!doc) {
          doc = (await v.book.sections[index].createDocument()) as Document;
          docs.set(index, doc);
        }
        const found = anchor(doc);
        const range: Range = found instanceof Range ? found : (() => {
          const r = doc.createRange();
          r.selectNodeContents(found ?? doc.body);
          r.collapse(true);
          return r;
        })();
        const frac = fractionIn(v, index, doc, range);
        const p = v.getProgressOf?.(index, range) ?? {};
        // a printed page is exact; a page of this window is filled in once its page is on screen
        const pageLabel = p.pageItem?.label ? String(p.pageItem.label) : null;
        let excerpt: string | null = null;
        if (t.kind === "bookmark") {
          const r2 = doc.createRange();
          r2.setStart(range.startContainer, range.startOffset);
          r2.setEnd(doc.body, doc.body.childNodes.length);
          excerpt = firstWords(r2.toString());
        }
        places.push({ kind: t.kind, id: t.id, fraction: frac, pageLabel, chapter: p.tocItem?.label?.trim() || null, excerpt });
      } catch {
        /* a place that doesn't resolve in this copy: it stays unplaced */
      }
    }
    placing.current = false;
    if (!places.length) return;
    await marksSync.place(places).catch(() => {});
    const [h, b] = await Promise.all([hls.list(book.id), marksApi.list(book.id)]).catch(() => [null, null]);
    if (h) {
      hlRef.current = h;
      setHl(h);
    }
    if (b) {
      marksRef.current = b;
      setMarks(b);
    }
  };

  /** Marks on the page now that have no page of this window yet (from Grimmory) take this page. */
  const fillPages = (d: Relocate, label: string) => {
    const CFI = cfiRef.current;
    const n = label.replace(/^p\. /, "");
    if (!CFI || !n || !d.cfi) return;
    let start: string;
    let end: string;
    try {
      start = CFI.collapse(d.cfi);
      end = CFI.collapse(d.cfi, true);
    } catch {
      return;
    }
    const onPage = (c: string) => {
      try {
        return CFI.compare(c, start) >= 0 && CFI.compare(c, end) <= 0;
      } catch {
        return false;
      }
    };
    const hs = hlRef.current.filter((h) => !h.pageLabel && onPage(h.cfi));
    const bs = marksRef.current.filter((b) => !b.pageLabel && onPage(b.cfi));
    if (!hs.length && !bs.length) return;
    const places: MarkPlace[] = [
      ...hs.map((h) => ({ kind: "highlight" as const, id: h.id, fraction: null, pageLabel: n, chapter: null })),
      ...bs.map((b) => ({ kind: "bookmark" as const, id: b.id, fraction: null, pageLabel: n, chapter: null })),
    ];
    marksSync.place(places).catch(() => {});
    const hid = new Set(hs.map((h) => h.id));
    const bid = new Set(bs.map((b) => b.id));
    hlRef.current = hlRef.current.map((h) => (hid.has(h.id) ? { ...h, pageLabel: n } : h));
    marksRef.current = marksRef.current.map((b) => (bid.has(b.id) ? { ...b, pageLabel: n } : b));
    setHl(hlRef.current);
    setMarks(marksRef.current);
  };

  const goToMark = (m: Mark) => {
    logRevisit(m);
    jumpTo(m.cfi);
    if (!dockR) setRight(null);
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
  const act = useRef({ toggleMark, goBack, poke, hideBars, setPrefs, makeHighlight, copySel, lookUp, openWord, clearSelection, deleteHighlight, reloadMarks, fillPages });
  act.current = { toggleMark, goBack, poke, hideBars, setPrefs, makeHighlight, copySel, lookUp, openWord, clearSelection, deleteHighlight, reloadMarks, fillPages };
  const ui = useRef({ left, right, note, card, word, review });
  ui.current = { left, right, note, card, word, review };

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
      turns.current++;
      acted.current = true;
      setNote(null);
      setSel(null);
      setCard(null);
      setWord(null);
      if (how === "prev") v.prev(distance);
      else if (how === "next") v.next(distance);
      else if (how === "left") v.goLeft();
      else v.goRight();
    };

    const onKey = (e: KeyboardEvent) => {
      // the review cards take the keys while they're open
      if (ui.current.review) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, [contenteditable]");
      const k = e.key.toLowerCase();
      // a focused button takes Space and Enter, the slider its arrows
      if (!e.ctrlKey && !e.altKey && t?.closest?.("button") && (e.key === " " || e.key === "Enter")) return;
      if (!e.altKey && t?.closest?.("[role=slider]") && e.key.startsWith("Arrow")) return;
      // words selected: H highlights, 1 to 5 in that colour, N with a note, C copies, L looks up
      if (selRef.current && !e.ctrlKey && !e.altKey && !e.metaKey && !typing) {
        const lk = lookRef.current;
        const n = Number(e.key);
        const a = act.current;
        if (k === "h") return (e.preventDefault(), void a.makeHighlight(lk.color, lk.style));
        if (k === "n") return (e.preventDefault(), void a.makeHighlight(lk.color, lk.style, true));
        if (k === "c") return (e.preventDefault(), void a.copySel());
        if (k === "l") return (e.preventDefault(), a.lookUp());
        if (n >= 1 && n <= 5) return (e.preventDefault(), void a.makeHighlight(COLOURS[n - 1].id, lk.style));
        if (e.key === "Escape") return (e.preventDefault(), a.clearSelection());
      }
      if (ui.current.card && !typing && e.key === "Delete") {
        const h = hlRef.current.find((x) => x.id === ui.current.card?.id);
        if (h) {
          e.preventDefault();
          act.current.deleteHighlight(h);
          return;
        }
      }
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
        if (u.word) return setWord(null);
        if (u.card) return setCard(null);
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

    let edgeTurn = 0;
    let lastDouble = 0;
    // A click in the outer fifth of the page turns it; the middle is left for reading and selecting.
    const onDocClick = (doc: Document) => (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      // the second click of a double-click (a word looked up) never turns the page
      if (e.detail >= 2) {
        lastDouble = Date.now();
        clearTimeout(edgeTurn);
        return;
      }
      if ((e.target as Element)?.closest?.("a[href]")) return;
      setNote(null);
      if (scrolled()) return;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      const pageRect = host.getBoundingClientRect();
      const x = (frame?.getBoundingClientRect().left ?? 0) + e.clientX;
      const f = (x - pageRect.left) / pageRect.width;
      // a click on a highlight opens its card (foliate-js says so in the same click); a click off an
      // open card closes it; only then does the outer fifth turn the page
      const hadCard = !!cardRef.current;
      const hadWord = !!ui.current.word;
      // a click on words waits a moment for a second click; one on the margin turns at once
      const t = e.target as Element | null;
      const onWords = !!t && t !== doc.body && t !== doc.documentElement && /\S/.test(t.textContent ?? "");
      setTimeout(() => {
        if (Date.now() - annotClick.current < 400) return;
        if (hadCard) return setCard(null);
        if (hadWord) return setWord(null);
        if (f >= 0.2 && f <= 0.8) return;
        clearTimeout(edgeTurn);
        edgeTurn = window.setTimeout(() => {
          if (Date.now() - lastDouble > 600) turn(f < 0.2 ? "left" : "right");
        }, onWords ? 300 : 0);
      }, 0);
    };

    // words selected with the mouse: the selection card
    const onPointerUp = (doc: Document, index: number) => (e: PointerEvent) => {
      if (e.button !== 0) return;
      setTimeout(() => {
        const s = doc.getSelection();
        const v = viewRef.current;
        if (!s || s.isCollapsed || !s.rangeCount || !v) return;
        const range = s.getRangeAt(0).cloneRange();
        const text = range.toString().replace(/\s+/g, " ").trim();
        if (!text) return;
        let cfi: string;
        try {
          cfi = v.getCFI(index, range);
        } catch {
          return;
        }
        setCard(null);
        setSel({ index, range, doc, text, cfi, anchor: anchorOf(range, doc, rdRef.current!) });
      }, 0);
    };
    // a double-click on a word: the word card (after the selection card the click made)
    const onDblClick = (doc: Document, index: number) => () => {
      setTimeout(() => {
        const s = doc.getSelection();
        const v = viewRef.current;
        if (!s || s.isCollapsed || !s.rangeCount || !v) return;
        const range = s.getRangeAt(0).cloneRange();
        const text = range
          .toString()
          .replace(/\s+/g, " ")
          .trim()
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (!text || text.length > 40) return;
        let cfi: string | null = null;
        try {
          cfi = v.getCFI(index, range);
        } catch {
          /* looked up without a place */
        }
        act.current.openWord({ index, range, doc, text, cfi, anchor: anchorOf(range, doc, rdRef.current!) });
      }, 0);
    };
    const onSelChange = (doc: Document) => () => {
      const s = doc.getSelection();
      if ((!s || s.isCollapsed) && selRef.current?.doc === doc) setSel(null);
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
        totalRef.current = total;
        setPageText(`${n} / ${total}`);
        label = `p. ${n}`;
      } else if (d.location) {
        setPageText(`${d.location.current + 1} / ${d.location.total}`);
        label = `p. ${d.location.current + 1}`;
        setTotalPages(d.location.total);
      }
      setPageLabel(label);
      pageLabelRef.current = label;
      // pages of this window are only right once a chapter taught how much a page holds
      if (d.pageItem?.label || perPage.current > 0) act.current.fillPages(d, label);
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

    const onLoad = (e: CustomEvent<{ doc: Document; index: number }>) => {
      const { doc, index } = e.detail;
      doc.addEventListener("keydown", onKey);
      doc.addEventListener("wheel", onWheel, { passive: false });
      doc.addEventListener("click", onDocClick(doc));
      doc.addEventListener("mousemove", onMove);
      doc.addEventListener("pointerup", onPointerUp(doc, index));
      doc.addEventListener("dblclick", onDblClick(doc, index));
      doc.addEventListener("selectionchange", onSelChange(doc));
    };

    // highlights: drawn by foliate-js's overlayer in each section as it's laid out
    const sectionOf = new Map<string, number>();
    const indexOf = (cfi: string) => {
      let i = sectionOf.get(cfi);
      if (i == null) {
        try {
          i = viewRef.current?.resolveNavigation(cfi)?.index ?? -1;
        } catch {
          i = -1;
        }
        sectionOf.set(cfi, i!);
      }
      return i!;
    };
    const onCreateOverlay = (e: CustomEvent<{ index: number }>) => {
      const v = viewRef.current;
      for (const h of hlRef.current) if (indexOf(h.cfi) === e.detail.index) v?.addAnnotation({ value: h.cfi }).catch?.(() => {});
    };
    const onDrawAnnotation = (e: CustomEvent<{ draw: (f: unknown, o: unknown) => void; annotation: { value: string } }>) => {
      const { draw, annotation } = e.detail;
      const h = hlRef.current.find((x) => x.cfi === annotation.value);
      if (!h) return;
      const color = hexOf(h.color);
      if (h.style === "underline") draw(Overlayer.underline, { color, width: 2 });
      else if (h.style === "strikethrough") draw(Overlayer.strikethrough, { color, width: 2 });
      else if (h.style === "squiggly") draw(Overlayer.squiggly, { color, width: 2 });
      else draw(Overlayer.highlight, { color });
    };
    const onShowAnnotation = (e: CustomEvent<{ value: string; range: Range }>) => {
      const { value, range } = e.detail;
      const h = hlRef.current.find((x) => x.cfi === value);
      const doc = range?.startContainer?.ownerDocument;
      if (!h || !doc || !rdRef.current) return;
      annotClick.current = Date.now();
      setSel(null);
      setNote(null);
      setCard({ id: h.id, anchor: anchorOf(range, doc, rdRef.current), editing: false });
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
        const [{ prefs: p, own: o, def: d }, list, CFI, , hlist, lk] = await Promise.all([
          loadPrefs(book.id),
          marksApi.list(book.id).catch(() => [] as Bookmark[]),
          import("foliate-js/epubcfi.js"),
          import("foliate-js/view.js"),
          hls.list(book.id).catch(() => [] as Highlight[]),
          api.getSetting("reader.hlLook").catch(() => null),
        ]);
        cfiRef.current = CFI;
        hlRef.current = hlist;
        setHl(hlist);
        try {
          const l = lk ? (JSON.parse(lk) as Look) : null;
          if (l?.color && l?.style) setLook(l);
        } catch {
          /* the default look */
        }
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
        view.addEventListener("create-overlay", onCreateOverlay);
        view.addEventListener("draw-annotation", onDrawAnnotation);
        view.addEventListener("show-annotation", onShowAnnotation);
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
        // Grimmory's highlights and bookmarks for this book; marks without a page here get one
        act.current.reloadMarks();
        marksSync
          .sync(book.id)
          .then(() => marksSync.lost(book.id))
          .then((l) => !cancelled && setLost(l))
          .catch(() => {});
        if (startAt) {
          jumpFrom();
          await view.goTo(startAt);
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setState("error");
        }
      }
    })();

    const onResize = () => setWinW(window.innerWidth);
    const ro = new ResizeObserver(() => {
      setArea({ w: host.clientWidth, h: host.clientHeight });
      const rd = rdRef.current;
      if (rd) setRoom({ w: rd.clientWidth, h: rd.clientHeight });
      // the words moved: a card pointing at them would point at nothing
      setSel(null);
      setCard(null);
    });
    ro.observe(host);
    if (rdRef.current) ro.observe(rdRef.current);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMove);
    host.addEventListener("wheel", onWheel, { passive: false });
    // Grimmory's place moved while the book is open (read on the Fire): ask
    const unOffer = listen<number>("grimmory-offer", (e) => {
      if (e.payload === book.id) grimmory.offer(book.id).then((o) => o && setOffer(o)).catch(() => {});
    });
    // highlights or bookmarks changed on Grimmory (or here, by a sync)
    const unMarks = listen<number>("marks-changed", (e) => {
      if (e.payload === book.id) act.current.reloadMarks();
    });
    const unLost = listen<number>("marks-lost", (e) => {
      if (e.payload === book.id) marksSync.lost(book.id).then(setLost).catch(() => {});
    });

    // Reading time for the reading card and the Journal: counted while the window is in front
    // and a page was turned in the last two minutes.
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastTurn.current < 120_000) {
        api.addReading(15, book.id, turns.current).catch(() => {});
        turns.current = 0;
      }
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(tick);
      clearTimeout(saveTimer.current);
      clearTimeout(barTimer.current);
      // the place goes up as the book closes
      save().finally(() => grimmory.closed(book.id).catch(() => {}));
      unOffer.then((f) => f());
      unMarks.then((f) => f());
      unLost.then((f) => f());
      clearTimeout(toastTimer.current);
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
    <div
      ref={rdRef}
      className={`rd ${tone} ${bars ? "" : "bars-off"}`}
      style={pageStyle}
      data-page-dark={colours.dark ? "1" : "0"}
      onMouseDown={(e) => {
        // a click anywhere off the cards closes them (clicks on the page itself are handled in the book)
        if ((e.target as Element).closest?.(".pop")) return;
        if (cardRef.current && !cardRef.current.editing) setCard(null);
        if (selRef.current) clearSelection();
      }}
    >
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
          aria-label="Marks in this book"
          title="Highlights, notes and bookmarks in this book"
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
              label="Marks in this book"
              title="Marks in this book"
              sub={`${hl.length} ${hl.length === 1 ? "highlight" : "highlights"} · ${marks.length} ${marks.length === 1 ? "bookmark" : "bookmarks"}`}
              pinned={pinR}
              docked={dockR}
              width={RIGHT_W}
              onPin={() => pin("right")}
              onClose={() => setRight(null)}
            >
              <MarksPanel
                highlights={hl}
                bookmarks={marks}
                here={here}
                hereLabel={pageLabel || `${Math.round(fraction * 100)}%`}
                hereCfi={last.current?.cfi ? cfiRef.current?.collapse(last.current.cfi) ?? null : null}
                fraction={fraction}
                syncLine={syncLine}
                onGo={goToMark}
                onRemove={removeAnyMark}
                onSaveBookmark={saveBookmark}
                onExport={exportMarks}
                words={bookWords}
                onGoWord={goToWord}
                onRemoveWord={removeWord}
                onReview={() => setReview(true)}
                onToast={(text) => showToast({ text })}
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
              onLook={(color, style) => changeHighlight(h, color, style, h.note)}
              onNote={(n) => changeHighlight(h, h.color, h.style, n)}
              onCopy={async () => {
                await copyText(h.text);
                showToast({ text: "Copied" });
              }}
              onDelete={() => deleteHighlight(h)}
            />
          );
        })()}

      {word && (
        <WordCard
          key={`${word.cfi}|${word.text}`}
          ask={word}
          room={room}
          bookId={book.id}
          onClose={() => setWord(null)}
          onSaved={wordSaved}
          onRemoved={wordRemoved}
        />
      )}

      {review && (
        <Review
          bookId={book.id}
          onClose={() => setReview(false)}
          onChanged={() => wordsApi.list(book.id).then(setBookWords).catch(() => {})}
        />
      )}

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
            {[lost.highlights ? `${lost.highlights} of this book's highlights` : "", lost.bookmarks ? `${lost.bookmarks} of its bookmarks` : ""]
              .filter(Boolean)
              .join(" and ")}
            . Remove them here too, or put them back on Grimmory?
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
