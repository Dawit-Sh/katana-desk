// The reading view: foliate-js (https://github.com/johnfactotum/foliate-js) renders the book,
// Katana draws the page frame around it (chapter on top, page and pages left in the chapter below).
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api, fileUrl, grimmory, type Book, type Offer } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { CaptionButtons } from "../components/TitleBar";
import serif400 from "@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2?url";
import serif400i from "@fontsource/noto-serif/files/noto-serif-latin-400-italic.woff2?url";
import serif700 from "@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff2?url";
import serif700i from "@fontsource/noto-serif/files/noto-serif-latin-700-italic.woff2?url";

type Relocate = {
  fraction: number;
  location?: { current: number; next: number; total: number };
  tocItem?: { label?: string };
  pageItem?: { label?: string };
  cfi: string;
};

// biome-ignore lint: foliate-js has no types
type FoliateView = HTMLElement & any;

const abs = (u: string) => new URL(u, location.href).href;

/** Styles put into the book's pages: Katana's page colours and the book serif, the book's own styles kept. */
function bookCss(dark: boolean) {
  const cs = getComputedStyle(document.documentElement);
  const text = cs.getPropertyValue("--k-ptext").trim();
  const link = cs.getPropertyValue("--k-link").trim();
  const face = (url: string, weight: number, style: string) =>
    `@font-face { font-family: "Noto Serif"; src: url("${abs(url)}") format("woff2"); font-weight: ${weight}; font-style: ${style}; }`;
  return `
${face(serif400, 400, "normal")}
${face(serif400i, 400, "italic")}
${face(serif700, 700, "normal")}
${face(serif700i, 700, "italic")}
html { color-scheme: ${dark ? "dark" : "light"}; color: ${text}; }
html, body { background: transparent !important; }
body { font-family: "Noto Serif", Georgia, serif; line-height: 1.62; hyphens: auto; -webkit-hyphens: auto; }
p { text-align: justify; }
a:any-link { color: ${link}; }
${dark ? `body :is(p, div, span, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, em, i, b, strong, small, sup, sub, section, article) { color: inherit !important; }` : ""}
`;
}

const isDark = () => document.documentElement.dataset.theme !== "paper";

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

export function Reader({ book, onClose }: { book: Book; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [chapter, setChapter] = useState("");
  const [pageText, setPageText] = useState("");
  const [leftText, setLeftText] = useState("");
  const last = useRef<Relocate | null>(null);
  const lastTurn = useRef(Date.now());
  // characters per page in the current layout, learned from chapters that fill several pages
  const perPage = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Grimmory's place, when it's behind this one: asked, never applied on its own
  const [offer, setOffer] = useState<Offer | null>(null);
  // a page turned (or a link followed) since the book opened: only then is it reading
  const acted = useRef(false);

  // Save the reading place: shortly after each turn, and when the book closes.
  const saveTimer = useRef<number>(0);
  const save = () => {
    const r = last.current;
    if (!r?.cfi) return Promise.resolve();
    const idx = (r as unknown as { section?: { current: number } }).section?.current;
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

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current!;
    let view: FoliateView | null = null;
    let wheelAcc = 0;
    let wheelLock = 0;

    const turn = (how: "prev" | "next" | "left" | "right") => {
      const v = viewRef.current;
      if (!v?.renderer) return;
      lastTurn.current = Date.now();
      acted.current = true;
      if (how === "prev") v.prev();
      else if (how === "next") v.next();
      else if (how === "left") v.goLeft();
      else v.goRight();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable]")) return;
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
        return turn(e.shiftKey ? "prev" : "next");
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return closeRef.current();
      }
      const how = map[e.key];
      if (how) {
        e.preventDefault();
        turn(how);
      }
    };

    // The wheel turns one page per notch; a trackpad's stream of small deltas adds up to one turn.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;
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
      if ((e.target as Element)?.closest?.("a[href]")) {
        acted.current = true;
        return;
      }
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      const pageRect = host.getBoundingClientRect();
      const x = (frame?.getBoundingClientRect().left ?? 0) + e.clientX;
      const f = (x - pageRect.left) / pageRect.width;
      if (f < 0.2) turn("left");
      else if (f > 0.8) turn("right");
    };

    const columns = () => (window.innerWidth >= 1200 ? "2" : "1");
    const onResize = () => viewRef.current?.renderer?.setAttribute("max-column-count", columns());

    const onRelocate = (e: CustomEvent<Relocate>) => {
      const d = e.detail;
      last.current = d;
      setChapter(d.tocItem?.label?.trim() ?? "");
      const r = viewRef.current?.renderer;
      const book_ = viewRef.current?.book;
      const textPages = r && typeof r.pages === "number" ? r.pages - 2 : 0;
      // Pages: foliate-js counts the book in 1,500-byte locations, which don't move on every turn.
      // Katana counts pages of the window as it is laid out now: the book's size over what one page holds.
      const sections = (book_?.sections ?? []).filter((x: { linear?: string }) => x.linear !== "no");
      const totalBytes = sections.reduce((a: number, x: { size?: number }) => a + (x.size ?? 0), 0);
      const idx = (d as unknown as { section?: { current: number } }).section?.current;
      const here = idx != null ? book_?.sections?.[idx]?.size ?? 0 : 0;
      if (textPages >= 3 && here > 4000) perPage.current = here / textPages;
      const cols = window.innerWidth >= 1200 ? 2 : 1;
      const per = perPage.current || 1900 * cols;
      if (d.pageItem?.label) setPageText(`p. ${d.pageItem.label}`);
      else if (totalBytes > 0) {
        const total = Math.max(1, Math.round(totalBytes / per));
        setPageText(`${Math.min(total, Math.floor((d.fraction ?? 0) * total) + 1)} / ${total}`);
      } else if (d.location) setPageText(`${d.location.current + 1} / ${d.location.total}`);
      if (textPages > 0) {
        const left = Math.max(0, textPages - r.page);
        setLeftText(left === 0 ? "Last page in chapter" : `${left} left in chapter`);
      } else setLeftText("");
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(save, 600);
    };

    const themeObserver = new MutationObserver(() => viewRef.current?.renderer?.setStyles?.(bookCss(isDark())));

    (async () => {
      try {
        await import("foliate-js/view.js");
        const res = await fetch(fileUrl(book.path));
        if (!res.ok) throw new Error(`The file could not be read (${res.status}).`);
        const blob = await res.blob();
        const name = book.path.split(/[\\/]/).pop() ?? "book";
        const file = new File([blob], name, { type: blob.type });
        if (cancelled) return;
        view = document.createElement("foliate-view") as FoliateView;
        viewRef.current = view;
        host.append(view);
        await view.open(file);
        if (cancelled) return;
        const r = view.renderer;
        r.setAttribute("flow", "paginated");
        r.setAttribute("margin", "0px");
        r.setAttribute("gap", "6%");
        r.setAttribute("max-inline-size", "720px");
        r.setAttribute("max-column-count", columns());
        r.setStyles?.(bookCss(isDark()));
        view.addEventListener("relocate", onRelocate);
        view.addEventListener("load", (e: CustomEvent<{ doc: Document }>) => {
          const doc = e.detail.doc;
          doc.addEventListener("keydown", onKey);
          doc.addEventListener("wheel", onWheel, { passive: false });
          doc.addEventListener("click", onDocClick(doc));
        });
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

    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
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
      // the place goes up as the book closes
      save().finally(() => grimmory.closed(book.id).catch(() => {}));
      unOffer.then((f) => f());
      themeObserver.disconnect();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
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

  return (
    <div className="rd">
      <header className="rtb" data-tauri-drag-region>
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
      {offer && (
        <div className="offer" role="alertdialog" aria-label="Grimmory has an earlier place">
          <i className="ms">cloud_sync</i>
          <span>
            Grimmory has this book at {offer.page != null ? `p. ${offer.page}` : `${Math.round((offer.fraction ?? 0) * 100)}%`}
            {offer.at ? `, read ${fmtWhen(offer.at).replace(/^Today, /, "today at ")}` : ""} on another device
          </span>
          <button type="button" className="pill" onClick={() => answer(true)}>Go there</button>
          <button type="button" className="pill fill" onClick={() => answer(false)}>Stay here</button>
        </div>
      )}
      <div className="pgarea">
        <div className="strip">{chapter}</div>
        <div className="page" ref={hostRef}>
          {state === "loading" && (
            <div className="rmsg"><i className="ms">menu_book</i><span>Opening {book.title}…</span></div>
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
      </div>
    </div>
  );
}
