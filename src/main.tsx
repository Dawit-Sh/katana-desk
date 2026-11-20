import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@fontsource-variable/manrope";
import "@fontsource/noto-serif/400.css";
import "@fontsource/noto-serif/400-italic.css";
import "@fontsource/noto-serif/500.css";
import "material-symbols/rounded.css";
import "./styles/app.css";
import "./styles/words.css";
import "./styles/m7.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { App, applyTheme } from "./App";
import { api, grimmory, READABLE } from "./lib/api";
import { useStore, type CoverSize, type GSort, type Page, type ThemePref } from "./lib/store";

async function start() {
  // settings first, so the first frame already has the right theme and sidebar
  // a book opened in a window of its own (Ctrl+click): index.html?book=<id>&at=<place>
  const args = new URLSearchParams(location.search);
  const bookWindow = args.has("book") ? Number(args.get("book")) : null;
  const [theme, folded, mica, g, sort, view, zoom, coverSize, opensOn] = await Promise.all([
    api.getSetting("theme").catch(() => null),
    api.getSetting("sidebarFolded").catch(() => null),
    api.hasMica().catch(() => false),
    grimmory.status().catch(() => null),
    api.getSetting("grimmorySort").catch(() => null),
    api.getSetting("grimmoryView").catch(() => null),
    api.getSetting("app.zoom").catch(() => null),
    api.getSetting("library.coverSize").catch(() => null),
    api.getSetting("app.opensOn").catch(() => null),
  ]);
  if (zoom && Number(zoom) !== 1) await getCurrentWebview().setZoom(Number(zoom)).catch(() => {});
  const covers = (coverSize === "s" || coverSize === "m" ? coverSize : "l") as CoverSize;
  document.documentElement.dataset.covers = covers;
  const start: Page = opensOn === "grimmory" || opensOn === "local" || opensOn === "journal" ? opensOn : g?.signedIn ? "grimmory" : "local";
  useStore.setState({
    themePref: (theme as ThemePref) ?? "system",
    folded: folded === "1",
    g,
    // the library opens on Grimmory once signed in (or where Settings › General says)
    page: start,
    gSort: (sort as GSort) ?? "lastRead",
    gView: view === "list" ? "list" : "grid",
    coverSize: covers,
    bookWindow: bookWindow != null,
  });
  document.documentElement.classList.toggle("mica", mica);
  applyTheme(useStore.getState().themePref, window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (bookWindow != null) {
    await useStore.getState().reload().catch(() => {});
    useStore.setState({ readingId: bookWindow, selectedId: bookWindow, openAt: args.get("at") });
  } else if (opensOn === "last") {
    // the book read last opens straight away
    await useStore.getState().reload().catch(() => {});
    const last = useStore
      .getState()
      .books.filter((b) => b.openedAt && READABLE.has(b.format))
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0];
    if (last) useStore.setState({ readingId: last.id, selectedId: last.id });
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // show the window only once the first frame is drawn: no white flash
  await document.fonts.ready.catch(() => {});
  requestAnimationFrame(() => requestAnimationFrame(() => getCurrentWindow().show()));
}

start();
