import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, grimmory, READABLE, type Dl, type GStatus, type ScanState } from "./lib/api";
import { useStore } from "./lib/store";
import { TitleBar } from "./components/TitleBar";
import { Rail, Sidebar } from "./components/Sidebar";
import { LocalPage, addBooks } from "./pages/LocalPage";
import { SettingsPage, SoonPage } from "./pages/OtherPages";
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

/** Theme: Paper when Windows is light, Graphite when dark, unless chosen in Settings. Mica follows too. */
function useTheme() {
  const pref = useStore((s) => s.themePref);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = pref === "system" ? (mq.matches ? "graphite" : "paper") : pref;
      document.documentElement.dataset.theme = theme;
      win.setTheme(pref === "system" ? null : theme === "paper" ? "light" : "dark").catch(() => {});
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

  // the library, kept fresh by the folder scanner
  useEffect(() => {
    s.reload();
    const a = listen("library-changed", () => useStore.getState().reload());
    const b = listen<ScanState>("scan-state", (e) => useStore.getState().setScan(e.payload));
    const c = win.onFocusChanged(({ payload }) => document.documentElement.classList.toggle("blurred", !payload));
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
      clearTimeout(catTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // drop books and folders anywhere in the window
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const st = useStore.getState();
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
      if (e.key === "F11") {
        e.preventDefault();
        win.setFullscreen(!(await win.isFullscreen()));
      } else if (e.ctrlKey && e.key.toLowerCase() === "k" && st.readingId == null) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        st.closeReader();
        st.go("settings");
      } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
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
      default:
        return <SoonPage page={s.page} />;
    }
  })();

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
            <main className="main">{pageView}</main>
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
    </div>
  );
}
