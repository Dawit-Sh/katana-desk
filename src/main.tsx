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
import { App } from "./App";
import { api, grimmory } from "./lib/api";
import { useStore, type GSort, type ThemePref } from "./lib/store";

async function start() {
  // settings first, so the first frame already has the right theme and sidebar
  const [theme, folded, mica, g, sort, view] = await Promise.all([
    api.getSetting("theme").catch(() => null),
    api.getSetting("sidebarFolded").catch(() => null),
    api.hasMica().catch(() => false),
    grimmory.status().catch(() => null),
    api.getSetting("grimmorySort").catch(() => null),
    api.getSetting("grimmoryView").catch(() => null),
  ]);
  useStore.setState({
    themePref: (theme as ThemePref) ?? "system",
    folded: folded === "1",
    g,
    // the library opens on Grimmory once signed in
    page: g?.signedIn ? "grimmory" : "local",
    gSort: (sort as GSort) ?? "lastRead",
    gView: view === "list" ? "list" : "grid",
  });
  document.documentElement.classList.toggle("mica", mica);
  const pref = useStore.getState().themePref;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = pref === "system" ? (dark ? "graphite" : "paper") : pref;

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
