import { useEffect, useRef, useState } from "react";
import { startUpdateChecks } from "./lib/updates";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, grimmory, READABLE, type Dl, type GStatus, type ScanState } from "./lib/api";
import { useStore } from "./lib/store";
import { TitleBar } from "./components/TitleBar";
import { Rail, Sidebar } from "./components/Sidebar";
import { BackBar } from "./components/BackBar";
import { LocalPage, addBooks } from "./pages/LocalPage";
import { SettingsPage, stepAppZoom } from "./pages/OtherPages";
import { JournalPage } from "./pages/JournalPage";
import { BookMenu, ListsPage } from "./pages/ListsPage";
import { Palette } from "./components/Palette";
import { KeyMap } from "./components/KeyMap";
import { CoverDialog } from "./components/CoverDialog";
import { ShareHost, shareOpen } from "./components/ShareImage";
import { BookmarksPage } from "./pages/BookmarksPage";
import { WordsPage } from "./pages/WordsPage";
import { GrimmoryPage } from "./pages/GrimmoryPage";
import { Reader } from "./reader/Reader";
import { PageReader } from "./reader/PageReader";
import { PAGE_FORMATS } from "./reader/pagesrc";
import { startPdfCovers } from "./lib/pdfcovers";

const win = getCurrentWindow();

/** Window sizes from the canvas: 1200 px and up the full sidebar, 840 to 1199 the rail, under 840 a drawer. */
function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/** The light themes; the rest are dark. */
export const LIGHT_THEMES = new Set(["paper", "sepia", "detective"]);

/** Sets the theme on the page: `data-theme` for the colours, `data-tone` light or dark. */
export function applyTheme(pref: string, systemDark: boolean) {
  const theme = pref === "system" ? (systemDark ? "graphite" : "paper") : pref;
  const root = document.documentElement;
  root.dataset.tone = LIGHT_THEMES.has(theme) ? "light" : "dark";
  root.dataset.theme = theme;
  return theme;
}

/** Theme: Paper when Windows is light, Graphite when dark, unless chosen in Settings. Mica follows too. */
function useTheme() {
  const pref = useStore((s) => s.themePref);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = applyTheme(pref, mq.matches);
      win.setTheme(pref === "system" ? null : LIGHT_THEMES.has(theme) ? "light" : "dark").catch(() => {});
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
}

export function App() {
  const s = useStore();
  const width = useWidth();
  const searchRef = useRef<HTMLInputElement>(null);
  const [drawer, setDrawer] = useState(false);
  useTheme();

  // PDF covers, drawn from their first pages in the background
  useEffect(() => startPdfCovers(), []);

  // a quiet look for a newer release once a day (the main window only)
  useEffect(() => (useStore.getState().bookWindow ? undefined : startUpdateChecks()), []);

  // the library, kept fresh by the folder scanner
  useEffect(() => {
    s.reload();
    const a = listen("library-changed", () => useStore.getState().reload());
    const b = listen<ScanState>("scan-state", (e) => useStore.getState().setScan(e.payload));
    // back to the front: the window looks awake again, and Grimmory's library catches up (places read
    // elsewhere meanwhile), at most once a minute
    let lastLook = Date.now();
    const c = win.onFocusChanged(({ payload }) => {
      document.documentElement.classList.toggle("blurred", !payload);
      const st = useStore.getState();
      if (payload && !st.bookWindow && st.g?.signedIn && st.g.reach === "offline") {
        // Grimmory was away: look now (its answer sends what waits here and catches the library up)
        grimmory.check().catch(() => {});
      } else if (payload && !st.bookWindow && st.g?.signedIn && Date.now() - lastLook > 60_000) {
        lastLook = Date.now();
        grimmory.sync(false).catch(() => {});
      }
    });
    // Grimmory: its state, its library (reloaded at most every 1.5 s while it fills in), its downloads
    const d = listen<GStatus>("grimmory-status", (e) => useStore.getState().setG(e.payload));
    let catTimer = 0;
    let catLast = 0;
    const e = listen("grimmory-changed", () => {
      const run = () => {
        catLast = Date.now();
        useStore.getState().reloadCatalog().catch(() => {});
      };
      clearTimeout(catTimer);
      const wait = Math.max(0, 1500 - (Date.now() - catLast));
      catTimer = window.setTimeout(run, wait);
    });
    const f = listen<Dl>("grimmory-download", (ev) => useStore.getState().setDownload(ev.payload));
    // custom covers and lists, changed here or in another window
    const g = listen("covers-changed", () => useStore.getState().loadCovers().catch(() => {}));
    const h = listen("lists-changed", () => useStore.getState().loadLists().catch(() => {}));
    useStore.getState().loadCovers().catch(() => {});
    useStore.getState().loadLists().catch(() => {});
    grimmory.status().then((st) => useStore.getState().setG(st)).catch(() => {});
    grimmory.downloads().then((list) => list.forEach((x) => useStore.getState().setDownload(x))).catch(() => {});
    useStore.getState().reloadCatalog().catch(() => {});
    return () => {
      a.then((f) => f());
      b.then((f) => f());
      c.then((f) => f());
      d.then((f) => f());
      e.then((f) => f());
      f.then((f) => f());
      g.then((f) => f());
      h.then((f) => f());
      clearTimeout(catTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // drop books and folders anywhere in the window
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const st = useStore.getState();
      // Change cover and Share as an image take a dropped picture themselves; a book's own window takes no books
      if (st.coverFor || shareOpen() || st.bookWindow) return st.setDropping(false);
      if (e.payload.type === "enter" || e.payload.type === "over") st.setDropping(true);
      else if (e.payload.type === "leave") st.setDropping(false);
      else if (e.payload.type === "drop") {
        st.setDropping(false);
        if (e.payload.paths.length) {
          api.addPaths(e.payload.paths);
          if (st.readingId == null) st.go("local");
        }
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // keys that work anywhere
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const st = useStore.getState();
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest?.("input, textarea, select, [contenteditable]");
      if (e.key === "F11") {
        e.preventDefault();
        win.setFullscreen(!(await win.isFullscreen()));
      } else if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "k") {
        // Ctrl K: search everything, anywhere (a book open too)
        e.preventDefault();
        st.setKeymap(false);
        st.setPalette(!st.palette);
      } else if ((e.ctrlKey && (e.key === "/" || e.code === "Slash")) || (e.key === "?" && !e.ctrlKey && !typing)) {
        e.preventDefault();
        st.setPalette(false);
        st.setKeymap(true);
      } else if (e.ctrlKey && !e.altKey && st.readingId == null && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) {
        // outside a book, Ctrl + and Ctrl - change the app's size (in a book, the text's)
        e.preventDefault();
        stepAppZoom(e.key === "-" ? -1 : e.key === "0" ? 0 : 1);
      } else if (e.ctrlKey && e.key === "," && !st.bookWindow) {
        e.preventDefault();
        st.closeReader();
        st.go("settings");
      } else if (e.ctrlKey && e.key.toLowerCase() === "o" && !st.bookWindow) {
        // open a file: it joins Local where it is, then opens
        e.preventDefault();
        const files = await addBooks();
        if (files[0]) {
          await st.reload();
          const b = useStore.getState().books.find((x) => x.path === files[0]);
          if (b && READABLE.has(b.format)) useStore.getState().open(b.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reading = s.readingId != null ? s.books.find((b) => b.id === s.readingId) : null;

  const narrow = width < 840;
  const railWidth = width < 1200;
  // under 1200 px the rail shows unless you unfold it; at 1200 and up the sidebar shows unless you fold it
  const [unfoldedNarrow, setUnfoldedNarrow] = useState(false);
  const showRail = narrow ? false : railWidth ? !unfoldedNarrow : s.folded;
  const onFold = () => {
    if (narrow) setDrawer((d) => !d);
    else if (railWidth) setUnfoldedNarrow((u) => !u);
    else s.setFolded(!s.folded);
  };
  const foldIcon = narrow ? "menu" : showRail ? "menu" : "menu_open";
  const foldLabel = narrow ? "Show the sidebar" : showRail ? "Unfold the sidebar" : "Fold the sidebar";

  const pageView = (() => {
    switch (s.page) {
      case "local":
        return <LocalPage />;
      case "grimmory":
        return <GrimmoryPage />;
      case "settings":
        return <SettingsPage />;
      case "bookmarks":
        return <BookmarksPage />;
      case "words":
        return <WordsPage />;
      case "lists":
        return <ListsPage />;
      case "journal":
        return <JournalPage />;
      default:
        return null;
    }
  })();

  const overlays = (
    <>
      {s.palette && <Palette />}
      {s.keymap && <KeyMap />}
      {s.coverFor && <CoverDialog key={s.coverFor.key} t={s.coverFor} />}
      {s.menu && <BookMenu m={s.menu} />}
      <ShareHost />
    </>
  );

  // a book in a window of its own: the reader only, and closing the book closes the window
  if (s.bookWindow) {
    const close = () => win.close();
    return (
      <div className="app">
        {reading ? (
          PAGE_FORMATS.has(reading.format) ? (
            <PageReader key={reading.id} book={reading} onClose={close} startAt={s.openAt} />
          ) : (
            <Reader key={reading.id} book={reading} onClose={close} startAt={s.openAt} />
          )
        ) : (
          s.loaded && (
            <div className="empty">
              <i className="ms big">menu_book</i>
              <b>This book isn't in the library any more</b>
              <button type="button" className="pill" onClick={close}>Close the window</button>
            </div>
          )
        )}
        {overlays}
      </div>
    );
  }

  return (
    <div className="app">
      {reading ? (
        PAGE_FORMATS.has(reading.format) ? (
          <PageReader key={reading.id} book={reading} onClose={s.closeReader} startAt={s.openAt} />
        ) : (
          <Reader key={reading.id} book={reading} onClose={s.closeReader} startAt={s.openAt} />
        )
      ) : (
        <>
          <TitleBar
            onFold={onFold}
            foldIcon={foldIcon}
            foldLabel={foldLabel}
            query={s.query}
            setQuery={s.setQuery}
            searchRef={searchRef}
          />
          <div className={`body ${narrow ? "drawer-mode" : ""}`}>
            {!narrow && (showRail ? <Rail /> : <Sidebar />)}
            {narrow && drawer && (
              <>
                <div className="drawer-scrim" onClick={() => setDrawer(false)} />
                <Sidebar drawer onPick={() => setDrawer(false)} />
              </>
            )}
            <main className="main">
              <BackBar />
              <div className="pagebox">{pageView}</div>
            </main>
          </div>
        </>
      )}
      {s.dropping && (
        <div className="drop">
          <i className="ms">upload_file</i>
          <b>Drop to add to Local</b>
          <span>Books stay where they are on disk. A folder becomes a Local folder, checked at start and while Katana Desk is open.</span>
        </div>
      )}
      {overlays}
    </div>
  );
}
