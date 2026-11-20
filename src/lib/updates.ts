// Updates from the GitHub releases (tauri-plugin-updater, signed with the app's own key).
// Windows and the Linux AppImage update themselves; a .deb or .rpm install gets a link to the release instead.
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { api } from "./api";

export const RELEASES = "https://github.com/Dawit-Sh/katana-desk/releases";

/** How this copy was installed: "windows", "appimage" or "package" (a .deb or .rpm, updated by hand). */
export type InstallKind = "windows" | "appimage" | "package";

type UpdState = {
  phase: "idle" | "checking" | "none" | "found" | "downloading" | "ready" | "error";
  version?: string;
  notes?: string;
  got: number;
  total: number;
  error?: string;
  /** what failed: the check, or the download and install */
  failed?: "check" | "install";
  checkedAt?: number;
  kind?: InstallKind;
};

export const useUpdates = create<UpdState>(() => ({ phase: "idle", got: 0, total: 0 }));

let found: Update | null = null;
const set = (s: Partial<UpdState>) => useUpdates.setState(s);

async function kind(): Promise<InstallKind> {
  const k = useUpdates.getState().kind ?? (await invoke<InstallKind>("install_kind").catch(() => "windows" as InstallKind));
  set({ kind: k });
  return k;
}

/** Asks GitHub for a newer release. Quiet: no "checking" state and errors kept to itself (the daily check). */
export async function checkForUpdate(quiet = false): Promise<void> {
  const st = useUpdates.getState().phase;
  if (st === "checking" || st === "downloading" || st === "ready") return;
  await kind();
  if (!quiet) set({ phase: "checking", error: undefined });
  try {
    found = await check({ timeout: 20000 });
    const now = Date.now();
    api.setSetting("update.checkedAt", String(now)).catch(() => {});
    if (found) set({ phase: "found", version: found.version, notes: found.body ?? "", checkedAt: now });
    else set({ phase: quiet && st !== "idle" ? st : "none", checkedAt: now });
  } catch (e) {
    // GitHub answers 404 until a release with latest.json is published: nothing newer to offer
    if (/valid release JSON/i.test(String(e))) set({ phase: quiet && st !== "idle" ? st : "none", checkedAt: Date.now() });
    else if (!quiet) set({ phase: "error", failed: "check", error: String(e) });
  }
}

/** Downloads the update, checks its signature and installs it; Windows closes the app for the installer. */
export async function installUpdate(): Promise<void> {
  if (!found) return;
  set({ phase: "downloading", got: 0, total: 0, error: undefined });
  try {
    await found.downloadAndInstall((ev) => {
      if (ev.event === "Started") set({ total: ev.data.contentLength ?? 0 });
      else if (ev.event === "Progress") set({ got: useUpdates.getState().got + ev.data.chunkLength });
    });
    set({ phase: "ready" });
  } catch (e) {
    set({ phase: "error", failed: "install", error: String(e) });
  }
}

export const restartNow = () => relaunch();

/** Once a day, a little after the start, a quiet look for a newer release (the main window only). */
export function startUpdateChecks(): () => void {
  if (import.meta.env.DEV) return () => {};
  const t = window.setTimeout(async () => {
    const last = Number((await api.getSetting("update.checkedAt").catch(() => null)) ?? 0);
    const auto = (await api.getSetting("update.auto").catch(() => null)) !== "0";
    if (auto && Date.now() - last > 20 * 3600 * 1000) checkForUpdate(true);
  }, 15000);
  return () => clearTimeout(t);
}
