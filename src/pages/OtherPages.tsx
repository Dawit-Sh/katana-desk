import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { api, grimmory } from "../lib/api";
import { fmtTime, plural } from "../lib/format";
import { useStore, type Page, type ThemePref } from "../lib/store";
import { addFolder } from "./LocalPage";
import { DictCredits, DictSettings } from "./DictSettings";

const SOON: Partial<Record<Page, { icon: string; title: string; text: string }>> = {
  lists: { icon: "checklist", title: "Lists", text: "Your reading lists come in a later version." },
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

/** Settings › Sources: Grimmory's address, who's signed in, sync now, sign out. */
function GrimmorySettings() {
  const { g, setG, catalog, go } = useStore();
  const [url, setUrl] = useState(g?.url ?? "");
  const [error, setError] = useState("");
  useEffect(() => setUrl(g?.url ?? ""), [g?.url]);
  if (!g) return null;
  const changed = url.trim().replace(/\/+$/, "") !== g.url;
  const save = async () => {
    setError("");
    try {
      setG(await grimmory.setUrl(url));
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="grp">
      <div className="srow">
        <i className="ms" style={{ color: "var(--k-var)" }}>{g.signedIn ? (g.reach === "offline" ? "cloud_off" : "cloud_done") : "cloud"}</i>
        <div className="tx">
          <b>Grimmory</b>
          <small>
            {g.signedIn
              ? `Signed in as ${g.user ?? "you"} · ${plural(catalog.books.length, "book")}${g.lastSync ? ` · synced ${fmtTime(g.lastSync)}` : ""}${g.reach === "offline" ? " · can't be reached right now" : ""}`
              : g.signedOut
                ? "Grimmory signed this PC out. Sign in again to sync."
                : "Not signed in"}
          </small>
        </div>
        {g.signedIn ? (
          <>
            <button type="button" className="pill" disabled={g.syncing} onClick={() => grimmory.sync(true).catch(() => {})} title="Fetch the whole library again (only changed books are written)">
              <i className={`ms ${g.syncing ? "spin" : ""}`}>{g.syncing ? "progress_activity" : "sync"}</i>Sync everything
            </button>
            <button type="button" className="pill" onClick={async () => { await grimmory.signOut(); setG(await grimmory.status()); }}>
              <i className="ms">logout</i>Sign out
            </button>
          </>
        ) : (
          <button type="button" className="pill fill" onClick={() => go("grimmory")}><i className="ms">login</i>Sign in</button>
        )}
      </div>
      <div className="srow">
        <div className="tx">
          <b>Server address</b>
          <small>Where Grimmory answers on your network. Another address means signing in again.</small>
          {error && <small className="err">{error}</small>}
        </div>
        <span className="field" style={{ width: 280 }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} onKeyDown={(e) => e.key === "Enter" && changed && save()} aria-label="Server address" />
        </span>
        <button type="button" className="pill" disabled={!changed} onClick={save}>Save</button>
      </div>
      <div className="srow">
        <div className="tx">
          <b>Reading places sync both ways</b>
          <small>
            A Grimmory book (or a Local copy of the same file) sends its place a few seconds after you turn a page and when you
            close it, and opens where you left it on the Fire. If Grimmory's place is behind yours, Katana Desk asks first.
          </small>
        </div>
      </div>
    </div>
  );
}

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
      <div className="glab">Sources</div>
      <GrimmorySettings />
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
      <div className="glab">Dictionaries</div>
      <DictSettings />
      <div className="glab">About</div>
      <div className="grp">
        <div className="srow">
          <div className="tx">
            <b>Katana Desk {version}</b>
            <small>The desktop version of Katana. Free software under GPL-3.0-or-later · github.com/Dawit-Sh/katana-desk</small>
          </div>
        </div>
        <DictCredits />
      </div>
    </div>
  );
}
