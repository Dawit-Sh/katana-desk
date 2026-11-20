// Settings (milestone 7), from the canvas's Settings artboard: a list of sections on the left, the
// section on the right. General, Appearance, Reading defaults, Sources (Grimmory and Local folders),
// Dictionaries, Sync and backup, Keyboard, About.
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, grimmory, m7 } from "../lib/api";
import { fmtTime, fmtWhen, plural } from "../lib/format";
import { useStore, type CoverSize, type ThemePref } from "../lib/store";
import { addFolder } from "./LocalPage";
import { DictCredits, DictSettings } from "./DictSettings";
import { dict } from "../lib/words";
import { KeyList } from "../components/KeyMap";
import { checkForUpdate, installUpdate, RELEASES, restartNow, useUpdates } from "../lib/updates";
import { AaPanel } from "../reader/AaPanel";
import { BUILT_IN, loadUiFonts, normalise, saveDefaultPrefs, type Prefs } from "../reader/prefs";

type Section = "general" | "appearance" | "reading" | "sources" | "dictionaries" | "sync" | "keyboard" | "about";
const SECTIONS: { id: Section; icon: string; name: string; about: string }[] = [
  { id: "general", icon: "tune", name: "General", about: "How Katana Desk starts, and how big everything is." },
  { id: "appearance", icon: "palette", name: "Appearance", about: "Themes, cover sizes and the glass behind the sidebar." },
  { id: "reading", icon: "menu_book", name: "Reading defaults", about: "How a book looks when it has no settings of its own." },
  { id: "sources", icon: "cloud", name: "Sources", about: "Your Grimmory server and the folders on this PC." },
  { id: "dictionaries", icon: "dictionary", name: "Dictionaries", about: "The built-in offline dictionaries and your own StarDict files." },
  { id: "sync", icon: "sync", name: "Sync and backup", about: "What goes to Grimmory, and copies of your library and marks." },
  { id: "keyboard", icon: "keyboard", name: "Keyboard", about: "Every key and click, in the library and in a book." },
  { id: "about", icon: "info", name: "About", about: "The version, updates, and everything Katana Desk is built on." },
];

/** Katana's themes: name, sidebar, ground, ink, selected item (drawn as little windows). */
export const THEMES: { id: ThemePref; name: string; s: string; g: string; t: string; p: string }[] = [
  { id: "system", name: "Follow Windows", s: "linear-gradient(135deg, #f6ece1 50%, #16191c 50%)", g: "linear-gradient(135deg, #fff8f0 50%, #101214 50%)", t: "#8a8580", p: "#405f6b" },
  { id: "graphite", name: "Graphite", s: "#16191c", g: "#101214", t: "#e7eaee", p: "#33475e" },
  { id: "paper", name: "Paper", s: "#f6ece1", g: "#fff8f0", t: "#1b1c1f", p: "#d3e7ef" },
  { id: "sepia", name: "Sepia Reading", s: "#efe0c6", g: "#f7ebd8", t: "#211a12", p: "#ecd8bc" },
  { id: "oled", name: "OLED Reader", s: "#08090b", g: "#000000", t: "#e7eaf2", p: "#2d323b" },
  { id: "contrast", name: "High Contrast", s: "#0c0c0c", g: "#000000", t: "#ffffff", p: "#3a3a3a" },
  { id: "blueprint", name: "Blueprint", s: "#0f3159", g: "#0b2a4d", t: "#edf6ff", p: "#1a4574" },
  { id: "detective", name: "Detective File", s: "#d8b978", g: "#e2c68a", t: "#2a1f0e", p: "#f3e2bc" },
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
    </div>
  );
}

function LocalSettings() {
  const { folders, books } = useStore();
  return (
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
            <button type="button" className="ib" title="Stop showing this folder in Katana Desk (the files stay where they are)" onClick={() => api.removeFolder(f.id)}>
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
  );
}

export const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
/** The app's size (the web view's zoom), kept in the setting `app.zoom`. */
export async function setAppZoom(z: number) {
  const v = Math.max(0.8, Math.min(1.5, Math.round(z * 100) / 100));
  await getCurrentWebview().setZoom(v).catch(() => {});
  await api.setSetting("app.zoom", String(v));
  window.dispatchEvent(new CustomEvent("katana-zoom", { detail: v }));
  return v;
}
/** One step bigger or smaller (0: back to 100%). */
export async function stepAppZoom(dir: 1 | -1 | 0) {
  if (dir === 0) return setAppZoom(1);
  const cur = Number((await api.getSetting("app.zoom").catch(() => null)) ?? 1) || 1;
  const i = ZOOMS.findIndex((z) => z >= cur - 0.001);
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 2 : i) + dir))];
  return setAppZoom(next);
}

function General() {
  const [opensOn, setOpensOn] = useState("auto");
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    api.getSetting("app.opensOn").then((v) => v && setOpensOn(v));
    api.getSetting("app.zoom").then((v) => v && setZoom(Number(v) || 1));
    const on = (e: Event) => setZoom((e as CustomEvent<number>).detail);
    window.addEventListener("katana-zoom", on);
    return () => window.removeEventListener("katana-zoom", on);
  }, []);
  const opens: [string, string][] = [
    ["auto", "Grimmory, or Local before you sign in"],
    ["grimmory", "Grimmory"],
    ["local", "Local"],
    ["last", "The book you read last"],
    ["journal", "The Journal"],
  ];
  return (
    <>
      <div className="glab">Window</div>
      <div className="grp">
        <div className="srow tight">
          <div className="tx"><b>Opens on</b><small>What you see when Katana Desk starts</small></div>
        </div>
        <div className="chips" role="radiogroup" aria-label="Opens on">
          {opens.map(([v, n]) => (
            <button type="button" key={v} role="radio" aria-checked={opensOn === v} className={`chip ${opensOn === v ? "on" : ""}`} onClick={() => { setOpensOn(v); api.setSetting("app.opensOn", v); }}>
              {opensOn === v && <i className="ms">check</i>}
              {n}
            </button>
          ))}
        </div>
        <div className="srow">
          <div className="tx"><b>App size</b><small>Ctrl + and Ctrl − change it anywhere outside a book (in a book they change the text)</small></div>
          <div className="seg" role="radiogroup" aria-label="App size">
            {ZOOMS.map((z) => (
              <button type="button" key={z} role="radio" aria-checked={Math.abs(zoom - z) < 0.001} className={Math.abs(zoom - z) < 0.001 ? "on" : ""} onClick={() => setAppZoom(z).then(setZoom)}>
                {Math.round(z * 100)}%
              </button>
            ))}
          </div>
        </div>
        <div className="srow">
          <div className="tx">
            <b>One window</b>
            <small>Books open in the main window. Ctrl+click a cover, a mark or a search result (or Ctrl Enter in Ctrl K) to open a book in a window of its own, beside another one.</small>
          </div>
        </div>
      </div>
    </>
  );
}

function Appearance() {
  const { themePref, setThemePref, coverSize, setCoverSize } = useStore();
  const [glass, setGlass] = useState(document.documentElement.classList.contains("mica"));
  const [glassMsg, setGlassMsg] = useState("");
  const sizes: [CoverSize, string, number, number][] = [["s", "Small", 14, 21], ["m", "Medium", 18, 27], ["l", "Large", 22, 33]];
  return (
    <>
      <div className="glab">Theme</div>
      <div className="grp" style={{ padding: 0 }}>
        <div className="themes t8" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button type="button" key={t.id} role="radio" aria-checked={themePref === t.id} className={`th ${themePref === t.id ? "on" : ""}`} onClick={() => setThemePref(t.id)}>
              <span className="mwin" style={{ ["--s" as string]: t.s, ["--g" as string]: t.g, ["--t" as string]: t.t, ["--p" as string]: t.p }}>
                <span className="ms-side"><i /><i /><i /><i /></span>
                <span className="ms-main"><b style={{ background: "#2c4a32" }} /><b style={{ background: "#c42b25" }} /><span><i /><i /><i /></span></span>
              </span>
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div className="glab">Covers in the library</div>
      <div className="grp csizes" role="radiogroup" aria-label="Cover size">
        {sizes.map(([id, name, w, h]) => (
          <button type="button" key={id} role="radio" aria-checked={coverSize === id} className={`cbtn ${coverSize === id ? "on" : ""}`} onClick={() => setCoverSize(id)}>
            <span className="csz">{[0, 1, 2].map((i) => <b key={i} style={{ width: w, height: h }} />)}</span>
            {name}
          </button>
        ))}
      </div>
      <div className="glab">Window</div>
      <div className="grp">
        <div className="srow">
          <div className="tx">
            <b>Glass sidebar</b>
            <small>{glassMsg || "Windows 11's Mica behind the title bar and sidebar, like the glass bars on the Fire"}</small>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={glass}
            aria-label="Glass sidebar"
            className={`sw ${glass ? "on" : ""}`}
            onClick={async () => {
              const on = await m7.setGlass(!glass).catch(() => false);
              document.documentElement.classList.toggle("mica", on);
              setGlass(on);
              setGlassMsg(!glass && !on ? "Mica isn't available here (it needs Windows 11), so the sidebar stays plain." : "");
            }}
          />
        </div>
      </div>
    </>
  );
}

function ReadingDefaults() {
  const [p, setP] = useState<Prefs | null>(null);
  useEffect(() => {
    loadUiFonts();
    api.getSetting("reader.defaults").then((v) => setP(normalise(v ? JSON.parse(v) : BUILT_IN))).catch(() => setP(BUILT_IN));
  }, []);
  if (!p) return null;
  const set = (x: Partial<Prefs>) => {
    const next = { ...p, ...x };
    setP(next);
    saveDefaultPrefs(next);
  };
  const same = JSON.stringify(p) === JSON.stringify(BUILT_IN);
  return (
    <>
      <div className="glab">How books open</div>
      <div className="su" style={{ whiteSpace: "normal", maxWidth: 760, marginTop: -6 }}>
        Every book without its own settings opens like this. A book's own Aa panel can change it for that book, or save its look
        as this default.
      </div>
      <div className="grp aa-settings">
        <AaPanel
          prefs={p}
          set={set}
          own={false}
          isDefault
          fixed={false}
          onSaveDefault={() => {}}
          onUseDefault={() => {}}
          footer={
            <div className="pfoot">
              <button type="button" className="pill" disabled={same} onClick={() => { setP(BUILT_IN); saveDefaultPrefs(BUILT_IN); }}>
                <i className="ms">history</i>Back to Katana's own
              </button>
            </div>
          }
        />
      </div>
    </>
  );
}

function SyncBackup() {
  const g = useStore((s) => s.g);
  const [msg, setMsg] = useState("");
  const backup = async () => {
    const d = new Date();
    const name = `katana-desk-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.db`;
    const path = await saveDialog({ title: "Back up the library", defaultPath: name, filters: [{ name: "Katana Desk library", extensions: ["db"] }] });
    if (!path) return;
    try {
      await m7.backup(path);
      setMsg(`Saved to ${path}`);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const exportAll = async () => {
    const dir = await openDialog({ directory: true, title: "Export every book's marks to a folder" });
    if (typeof dir !== "string") return;
    try {
      const n = await m7.exportAllMarks(dir);
      setMsg(n ? `${plural(n, "file")} written to ${dir}` : "No book has marks yet.");
    } catch (e) {
      setMsg(String(e));
    }
  };
  const rows: [string, string, string][] = [
    ["place", "Reading places", "Both ways, for Grimmory books and Local copies of the same file: EPUB by position, PDF and comics by page. A place behind this PC's is asked about first."],
    ["format_ink_highlighter", "Highlights and notes", "Both ways for EPUB books. PDF, DjVu, MOBI and comic highlights stay on this PC."],
    ["bookmark", "Bookmarks", "Both ways, with their names and notes: EPUB by position, PDF and comics by page."],
    ["image", "Covers and lists", "Stay on this PC. A cover you change never goes to Grimmory."],
    ["dictionary", "My words and the Journal", "Stay on this PC (Grimmory has no place for them)."],
  ];
  return (
    <>
      <div className="glab">What syncs with Grimmory</div>
      <div className="grp">
        <div className="srow">
          <i className="ms" style={{ color: "var(--k-var)" }}>{g?.signedIn ? "cloud_done" : "cloud_off"}</i>
          <div className="tx">
            <b>{g?.signedIn ? (g.syncing ? "Syncing…" : `Synced${g.lastSync ? ` at ${fmtTime(g.lastSync)}` : ""}`) : "Not signed in to Grimmory"}</b>
            <small>{g?.signedIn ? (g.reach === "offline" ? "Grimmory can't be reached right now: changes wait and go up when it's back." : "Changes go up a few seconds after you make them.") : "Sign in under Sources to sync."}</small>
          </div>
          {g?.signedIn && (
            <button type="button" className="pill" disabled={g.syncing} onClick={() => grimmory.sync(false).catch(() => {})}>
              <i className={`ms ${g.syncing ? "spin" : ""}`}>{g.syncing ? "progress_activity" : "sync"}</i>Sync now
            </button>
          )}
        </div>
        {rows.map(([icon, b, s]) => (
          <div className="srow" key={b}>
            <i className="ms" style={{ color: "var(--k-var)" }}>{icon}</i>
            <div className="tx"><b>{b}</b><small>{s}</small></div>
          </div>
        ))}
      </div>
      <div className="glab">Backup</div>
      <div className="grp">
        <div className="srow">
          <div className="tx">
            <b>Back up the library</b>
            <small>One file with everything Katana Desk keeps: places, highlights, bookmarks, My words, the Journal, lists and settings (not the books).</small>
          </div>
          <button type="button" className="pill" onClick={backup}><i className="ms">save</i>Back up…</button>
        </div>
        <div className="srow">
          <div className="tx">
            <b>Export every book's marks</b>
            <small>A Markdown file per book, in Katana's shape: bookmarks, then the quotes under their chapters with their notes.</small>
          </div>
          <button type="button" className="pill" onClick={exportAll}><i className="ms">download</i>Export…</button>
        </div>
        {msg && <div className="srow" style={{ minHeight: 0 }}><div className="tx"><small>{msg}</small></div></div>}
      </div>
    </>
  );
}

/** The reading engines and the rest inside Katana Desk, with their licences. */
const ENGINES = [
  { name: "foliate-js", what: "Reads EPUB, MOBI, AZW3 and FB2", licence: "MIT", url: "https://github.com/johnfactotum/foliate-js" },
  { name: "PDF.js", what: "Mozilla's PDF reader: draws PDFs and their text", licence: "Apache-2.0", url: "https://github.com/mozilla/pdf.js" },
  { name: "DjVuLibre 3.5.28", what: "Reads DjVu books and their hidden text", licence: "GPL-2.0-or-later", url: "https://djvu.sourceforge.net/" },
  { name: "Tauri", what: "The window, files and network, in Rust", licence: "MIT or Apache-2.0", url: "https://github.com/tauri-apps/tauri" },
  { name: "Open Library", what: "Covers found online in Change cover (Internet Archive)", licence: "Cover terms", url: "https://openlibrary.org/dev/docs/api/covers" },
];

/** Settings › About: the version, Check for updates, and the update itself when one is out. */
function UpdateRows() {
  const u = useUpdates();
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    api.getSetting("update.auto").then((v) => setAuto(v !== "0"));
    if (u.phase === "idle") useUpdates.setState({ checkedAt: undefined });
    api.getSetting("update.checkedAt").then((v) => v && !useUpdates.getState().checkedAt && useUpdates.setState({ checkedAt: Number(v) }));
  }, []);
  const pct = u.total ? Math.min(100, (u.got / u.total) * 100) : 0;
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const words =
    u.phase === "checking"
      ? "Looking for a newer version…"
      : u.phase === "none"
        ? "You have the newest version."
        : u.phase === "found"
          ? `Version ${u.version} is out.`
          : u.phase === "downloading"
            ? `Downloading ${u.version} · ${u.total ? `${Math.round(pct)}% · ${mb(u.got)} of ${mb(u.total)}` : mb(u.got)}`
            : u.phase === "ready"
              ? `Version ${u.version} is installed. Restart to use it.`
              : u.phase === "error"
                ? u.failed === "install"
                  ? /signature/i.test(u.error ?? "")
                    ? "The download didn't match its signature, so it wasn't installed."
                    : "The update couldn't be downloaded. Try again in a while."
                  : "Couldn't check for updates. Are you online?"
                : u.checkedAt
                  ? `Last checked ${fmtWhen(u.checkedAt)}`
                  : "Updates come from the GitHub releases, signed so only real ones install.";
  return (
    <>
      <div className="srow">
        <div className="tx">
          <b>Updates</b>
          <small className={u.phase === "error" ? "err" : ""} title={u.phase === "error" ? u.error : undefined}>
            {words}
          </small>
          {u.phase === "downloading" && (
            <div className="dlbar" aria-hidden="true">
              <i style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        {u.phase === "found" && u.kind === "package" ? (
          <button type="button" className="pill" onClick={() => dict.openUrl(`${RELEASES}/latest`)}>
            Get it<i className="ms">open_in_new</i>
          </button>
        ) : u.phase === "found" ? (
          <button type="button" className="pill fill" onClick={() => installUpdate()}>
            <i className="ms">download</i>Update now
          </button>
        ) : u.phase === "ready" ? (
          <button type="button" className="pill fill" onClick={() => restartNow()}>
            <i className="ms">restart_alt</i>Restart
          </button>
        ) : (
          <button type="button" className="pill" disabled={u.phase === "checking" || u.phase === "downloading"} onClick={() => checkForUpdate()}>
            <i className="ms">refresh</i>Check for updates
          </button>
        )}
      </div>
      {u.phase === "found" && !!u.notes && (
        <div className="srow">
          <div className="tx">
            <b>What's new in {u.version}</b>
            <small className="upnotes">{u.notes}</small>
          </div>
        </div>
      )}
      {u.phase === "found" && u.kind === "package" && (
        <div className="srow">
          <div className="tx">
            <small>This copy was installed from a .deb or .rpm, so it can't replace itself. Download the new package from the release page, or use the AppImage, which updates itself.</small>
          </div>
        </div>
      )}
      <div className="srow">
        <div className="tx">
          <b>Look for updates by itself</b>
          <small>Once a day, a little after Katana Desk starts. Nothing installs without you.</small>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={auto}
          aria-label="Look for updates by itself"
          className={`sw ${auto ? "on" : ""}`}
          onClick={() => {
            api.setSetting("update.auto", auto ? "0" : "1");
            setAuto(!auto);
          }}
        />
      </div>
    </>
  );
}

function About() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion);
  }, []);
  return (
    <>
      <div className="glab">About</div>
      <div className="grp">
        <div className="srow">
          <div className="tx">
            <b>Katana Desk {version}</b>
            <small>The desktop version of Katana. Free software under GPL-3.0-or-later.</small>
          </div>
          <button type="button" className="pill" onClick={() => dict.openUrl("https://github.com/Dawit-Sh/katana-desk")}>
            GitHub<i className="ms">open_in_new</i>
          </button>
        </div>
        <UpdateRows />
      </div>
      <div className="glab">Credits and licences</div>
      <div className="grp">
        {ENGINES.map((e) => (
          <div className="srow" key={e.name}>
            <div className="tx">
              <b>{e.name}</b>
              <small>{e.what}</small>
            </div>
            <button type="button" className="pill" title={e.url} onClick={() => dict.openUrl(e.url)}>
              {e.licence}
              <i className="ms">open_in_new</i>
            </button>
          </div>
        ))}
        <DictCredits />
      </div>
    </>
  );
}

export function SettingsPage() {
  const [sec, setSec] = useState<Section>(() => (useUpdates.getState().phase === "found" ? "about" : "general"));
  const here = SECTIONS.find((x) => x.id === sec) ?? SECTIONS[0];
  return (
    <div className="setp">
      <nav className="lpane" aria-label="Settings">
        <span className="h">Settings</span>
        {SECTIONS.map((s) => (
          <button type="button" key={s.id} className={`nv ${sec === s.id ? "on" : ""}`} onClick={() => setSec(s.id)} aria-current={sec === s.id}>
            <i className="ms">{s.icon}</i>
            <span>{s.name}</span>
          </button>
        ))}
      </nav>
      <div className="scroll ppane" key={sec}>
        <div className="setbody">
        <header className="sethead">
          <span className="seticon"><i className="ms">{here.icon}</i></span>
          <div>
            <h1>{here.name}</h1>
            <p>{here.about}</p>
          </div>
        </header>
        {sec === "general" && <General />}
        {sec === "appearance" && <Appearance />}
        {sec === "reading" && <ReadingDefaults />}
        {sec === "sources" && (
          <>
            <div className="glab">Grimmory</div>
            <GrimmorySettings />
            <div className="glab">Local folders</div>
            <LocalSettings />
          </>
        )}
        {sec === "dictionaries" && (
          <>
            <div className="glab">Dictionaries</div>
            <DictSettings />
          </>
        )}
        {sec === "sync" && <SyncBackup />}
        {sec === "keyboard" && (
          <>
            <div className="glab">Keyboard and mouse</div>
            <div className="su" style={{ whiteSpace: "normal", marginTop: -6 }}>Press ? or Ctrl / anywhere to see these over what you're doing.</div>
            <div className="grp km-settings"><KeyList /></div>
          </>
        )}
        {sec === "about" && <About />}
        </div>
      </div>
    </div>
  );
}
