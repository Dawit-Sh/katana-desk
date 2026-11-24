// A sync on this Wi-Fi, seen from Local (his OK on the round's page, item 5): while a paired device syncs,
// the pill at the top of Local ("Folders up to date" the rest of the time) says "Syncing with Pixel 10a…",
// then "Synced with Pixel 10a · 2:14 PM" for a few seconds, then gives the spot back. A quick sync that
// changed nothing (a device checks in every couple of minutes) doesn't flash it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtTime } from "../lib/format";
import { Spinner } from "./Spinner";
import "../styles/peer.css";
import type { PeerChanges, PeerSyncEnded, PeerSyncing } from "../pages/WifiSync";

/** A sync shows once it has gone on this long; most take a fraction of a second. */
const SHOW_AFTER_MS = 700;
/** How long "Synced with …" stays. */
const DONE_MS = 6000;

type Shown = { going: boolean; name: string; at: number };

export function changedAnything(got: PeerChanges | undefined, phoneChanged: boolean | null | undefined): boolean {
  const g = got ?? { places: 0, statuses: 0, highlights: 0, bookmarks: 0, booksSent: 0 };
  return g.places + g.statuses + g.highlights + g.bookmarks + g.booksSent > 0 || phoneChanged === true;
}

/** The sync pill while a sync is on or just ended; `otherwise` (the folders pill) the rest of the time. */
export function SyncPill({ otherwise }: { otherwise: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const goingShown = useRef(false);
  useEffect(() => {
    let showTimer: number | undefined;
    let clearTimer: number | undefined;
    invoke<{ syncing: PeerSyncing[] }>("peer_status")
      .then((s) => {
        const now = s.syncing[0];
        if (now) {
          goingShown.current = true;
          setShown({ going: true, name: now.name, at: now.since });
        }
      })
      .catch(() => {});
    const un = listen<({ phase: "start" } & PeerSyncing) | ({ phase: "end" } & PeerSyncEnded)>("peer-sync", (e) => {
      const p = e.payload;
      window.clearTimeout(clearTimer);
      if (p.phase === "start") {
        window.clearTimeout(showTimer);
        showTimer = window.setTimeout(() => {
          goingShown.current = true;
          setShown({ going: true, name: p.name, at: p.since });
        }, SHOW_AFTER_MS);
        return;
      }
      window.clearTimeout(showTimer);
      if (goingShown.current || changedAnything(p.got, p.phone?.changed)) {
        setShown({ going: false, name: p.name, at: p.at });
        clearTimer = window.setTimeout(() => setShown(null), DONE_MS);
      } else {
        setShown(null);
      }
      goingShown.current = false;
    });
    return () => {
      un.then((f) => f());
      window.clearTimeout(showTimer);
      window.clearTimeout(clearTimer);
    };
  }, []);
  if (!shown) return <>{otherwise}</>;
  return (
    <span className="pill tone syncpill" role="status" title="Sync on this Wi-Fi (Settings › Sync on this Wi-Fi)">
      {shown.going ? <Spinner /> : <span className="syncdot" aria-hidden />}
      {shown.going ? `Syncing with ${shown.name}…` : `Synced with ${shown.name} · ${fmtTime(shown.at)}`}
    </span>
  );
}
