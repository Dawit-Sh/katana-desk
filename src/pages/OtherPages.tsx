import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { plural } from "../lib/format";
import { useStore, type Page, type ThemePref } from "../lib/store";
import { addFolder } from "./LocalPage";

const SOON: Partial<Record<Page, { icon: string; title: string; text: string }>> = {
  grimmory: {
    icon: "cloud",
    title: "Grimmory comes next",
    text: "Signing in to Grimmory on the Zima, your whole library, downloads and the reading place synced with the Fire come in the next version. Local books work now.",
  },
  lists: { icon: "checklist", title: "Lists", text: "Your reading lists come in a later version." },
  bookmarks: { icon: "bookmarks", title: "Bookmarks", text: "Bookmarks across all your books come with highlights and notes, in a later version." },
  words: { icon: "dictionary", title: "My words", text: "Words you save from the built-in dictionaries come in a later version." },
  journal: {
    icon: "history",
    title: "Journal",
    text: "Your whole year of reading days comes in a later version. Reading time is already being recorded: it's what the Reading card in the sidebar shows.",
  },
};

export function SoonPage({ page }: { page: Page }) {
  const s = SOON[page]!;
  return (
    <div className="scroll">
      <div className="soon">
        <i className="ms">{s.icon}</i>
        <b>{s.title}</b>
        <p>{s.text}</p>
      </div>
    </div>
  );
}

const THEMES: { id: ThemePref; name: string; pic: React.ReactNode }[] = [
  {
    id: "system",
    name: "Follow Windows",
    pic: (
      <div className="pic split">
        <i style={{ ["--a" as string]: "#f6ece1", ["--b" as string]: "#fff8f0", background: "linear-gradient(90deg, #f6ece1 33%, #fff8f0 33%)" }} />
        <i style={{ background: "linear-gradient(90deg, #16191c 33%, #101214 33%)" }} />
      </div>
    ),
  },
  {
    id: "graphite",
    name: "Graphite",
    pic: <div className="pic" style={{ ["--a" as string]: "#16191c", ["--b" as string]: "#101214", ["--t" as string]: "#e7eaee" }}><i /><i /></div>,
  },
  {
    id: "paper",
    name: "Paper",
    pic: <div className="pic" style={{ ["--a" as string]: "#f6ece1", ["--b" as string]: "#fff8f0", ["--t" as string]: "#1b1c1f" }}><i /><i /></div>,
  },
];

export function SettingsPage() {
  const { themePref, setThemePref, folders, books } = useStore();
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion);
  }, []);
  return (
    <div className="scroll">
      <span className="h">Settings</span>
      <div className="glab">Theme</div>
      <div className="grp">
        <div className="themes" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.id}
              role="radio"
              aria-checked={themePref === t.id}
              className={`th ${themePref === t.id ? "on" : ""}`}
              onClick={() => setThemePref(t.id)}
            >
              {t.pic}
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div className="glab">Local folders</div>
      <div className="grp">
        {folders.map((f) => {
          const n = books.filter((b) => b.folderId === f.id).length;
          return (
            <div className="srow" key={f.id}>
              <i className="ms" style={{ color: "var(--k-var)" }}>folder</i>
              <div className="tx"><b>{f.name}</b><small>{f.path} · {plural(n, "book")}</small></div>
              <button type="button" className="ib" title="Show in File Explorer" onClick={() => api.reveal(f.path)}>
                <i className="ms">folder_open</i>
              </button>
              <button
                type="button"
                className="ib"
                title="Stop showing this folder in Katana Desk (the files stay where they are)"
                onClick={() => api.removeFolder(f.id)}
              >
                <i className="ms">remove_circle_outline</i>
              </button>
            </div>
          );
        })}
        <div className="srow">
          <div className="tx">
            <b>Folders are checked at start and while Katana Desk is open</b>
            <small>Books are read where they are. Nothing is ever moved, renamed or deleted.</small>
          </div>
          <button type="button" className="pill fill" onClick={addFolder}><i className="ms">create_new_folder</i>Add a folder</button>
        </div>
      </div>
      <div className="glab">About</div>
      <div className="grp">
        <div className="srow">
          <div className="tx">
            <b>Katana Desk {version}</b>
            <small>The desktop version of Katana. Free software under GPL-3.0-or-later · github.com/Dawit-Sh/katana-desk</small>
          </div>
        </div>
      </div>
    </div>
  );
}
