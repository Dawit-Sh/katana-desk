// Writes latest.json for tauri-plugin-updater from the draft's signed installers and attaches it.
// The URLs point at the tag (releases/download/v<version>/...), so they work once the draft is published.
// The app reads releases/latest/download/latest.json, which only ever sees the newest published release.
import { gh, repo } from "./github.mjs";

const id = process.env.RELEASE_ID;
const version = process.env.VERSION;
const rel = await gh("GET", `repos/${repo}/releases/${id}`);
const assets = rel.assets;

const pick = (re) => {
  const a = assets.find((x) => re.test(x.name));
  if (!a) throw new Error(`No file matching ${re} in the draft (${assets.map((x) => x.name).join(", ")})`);
  return a;
};
const sigOf = async (a) => {
  const s = assets.find((x) => x.name === `${a.name}.sig`);
  if (!s) throw new Error(`No signature for ${a.name}`);
  const bytes = await gh("GET", `repos/${repo}/releases/assets/${s.id}`, null, { accept: "application/octet-stream" });
  return new TextDecoder().decode(bytes).trim();
};
const url = (a) => `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(a.name)}`;

const exe = pick(/_x64-setup\.exe$/);
const appimage = pick(/_amd64\.AppImage$/);
const win = { signature: await sigOf(exe), url: url(exe) };
const lin = { signature: await sigOf(appimage), url: url(appimage) };

const latest = {
  version,
  // the notes' first part, before the first "## " heading
  notes: (rel.body || "").split(/\n## /)[0].trim(),
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": win,
    "windows-x86_64-nsis": win,
    "linux-x86_64": lin,
    "linux-x86_64-appimage": lin,
  },
};
const text = JSON.stringify(latest, null, 2) + "\n";

const old = assets.find((a) => a.name === "latest.json");
if (old) await gh("DELETE", `repos/${repo}/releases/assets/${old.id}`);
const upload = rel.upload_url.replace(/\{.*\}$/, "") + "?name=latest.json";
await gh("POST", upload, new TextEncoder().encode(text), { "content-type": "application/json" });
console.log(text);
