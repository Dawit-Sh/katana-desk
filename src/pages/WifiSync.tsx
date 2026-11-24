// Settings › Sync on this Wi-Fi: Katana on his other devices syncs its Local books (places, statuses,
// highlights, bookmarks) with this PC on the same Wi-Fi, no Grimmory server needed. Off until he turns it on;
// "Pair a device" shows a 6-digit code for 5 minutes beside this PC's address, the same one Katana shows when
// it finds this PC (his OK on the round's page, item 4); paired devices with their last sync, and Forget.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { fmtWhen } from "../lib/format";
import "../styles/peer.css";

type Device = { deviceId: string; name: string; pairedAt: number; seenAt: number | null };
/** What a phone changed here during one sync. */
export type PeerChanges = { places: number; statuses: number; highlights: number; bookmarks: number; booksSent: number; reading?: number };
/** A phone syncing now (`peer-sync` "start", and `syncing` in the status). */
export type PeerSyncing = { deviceId: string; name: string; since: number; at: number; got: PeerChanges };
/** A phone's sync that ended (`peer-sync` "end"): `phone` is the phone's own side, `quiet` when it just went quiet. */
export type PeerSyncEnded = PeerSyncing & {
  phone: { books: number | null; changed: boolean | null; problem: string | null };
  quiet: boolean;
};
type PeerStatus = {
  enabled: boolean;
  running: boolean;
  error: string | null;
  port: number;
  name: string;
  address: string | null;
  code: string | null;
  codeUntil: number | null;
  devices: Device[];
  syncing: PeerSyncing[];
  lastSync: PeerSyncEnded | null;
};

export function WifiSync() {
  const [st, setSt] = useState<PeerStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  const refresh = () => invoke<PeerStatus>("peer_status").then(setSt).catch(() => {});
  useEffect(() => {
    refresh();
    const un = listen("peer-changed", () => refresh());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      un.then((f) => f());
      window.clearInterval(t);
      // the code only shows while this is open
      invoke("peer_pair_close").catch(() => {});
    };
  }, []);
  if (!st) return null;
  const left = st.codeUntil ? Math.max(0, Math.round((st.codeUntil - now) / 1000)) : 0;
  const code = st.code && left > 0 ? st.code : null;
  const lastOf = (d: Device) => (st.lastSync && st.lastSync.deviceId === d.deviceId ? st.lastSync.at : d.seenAt);
  return (
    <>
      <div className="grp">
        <div className="srow">
          <i className="ms" style={{ color: "var(--k-var)" }}>{st.running ? "wifi" : "wifi_off"}</i>
          <div className="tx">
            <b>Sync with Katana on this Wi-Fi</b>
            <small style={{ whiteSpace: "normal" }}>
              {st.error
                ? st.error
                : st.running
                  ? `On: ${st.name}${st.address ? ` at ${st.address}` : ""}. Katana on your other devices keeps the same books' places, statuses, highlights and bookmarks in step with this PC, with Grimmory's rules.`
                  : "Off. Katana on your other devices can sync its Local books with this PC when both are on the same Wi-Fi, without a Grimmory server."}
            </small>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={st.enabled}
            aria-label="Sync with Katana on this Wi-Fi"
            className={`sw ${st.enabled ? "on" : ""}`}
            onClick={async () => setSt(await invoke<PeerStatus>("peer_set_enabled", { on: !st.enabled }))}
          />
        </div>
        {st.running && code && (
          <div className="pairbox" aria-live="polite">
            <span>Type this code in Katana: Settings › Sources › Katana Desk.</span>
            <span className="pcode" aria-label={`Code ${code.split("").join(" ")}`}>
              {code.slice(0, 3)} {code.slice(3)}
            </span>
            <span className="pchip">
              This PC · {st.name}
              {st.address && (
                <>
                  {" · "}
                  <b>{st.address}</b>
                </>
              )}
            </span>
            <div className="prow">
              <span className="phint">
                Good for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. Each code pairs one device.
              </span>
              <button type="button" className="pill" onClick={async () => setSt(await invoke<PeerStatus>("peer_pair_close"))}>
                Done
              </button>
            </div>
          </div>
        )}
        {!code && (
          <div className="srow">
            <i className="ms" style={{ color: "var(--k-var)" }}>add_link</i>
            <div className="tx">
              <b>Pair a device</b>
              <small style={{ whiteSpace: "normal" }}>
                {st.running ? "Shows a code" : "Turns on sync on this Wi-Fi and shows a code"} to type in Katana. Each code pairs
                one device and lasts 5 minutes.
              </small>
            </div>
            <button type="button" className="pill fill" onClick={async () => setSt(await invoke<PeerStatus>("peer_pair_open"))}>
              Pair a device
            </button>
          </div>
        )}
        {st.devices.map((d) => (
          <div className="srow" key={d.deviceId}>
            <i className="ms" style={{ color: "var(--k-var)" }}>smartphone</i>
            <div className="tx">
              <b>{d.name}</b>
              <small>
                {st.syncing.some((s) => s.deviceId === d.deviceId)
                  ? "Syncing now…"
                  : lastOf(d)
                    ? `Last synced ${fmtWhen(lastOf(d) as number).replace(/^Today, /, "today at ").replace(/^Yesterday, /, "yesterday at ")}`
                    : "Paired, not synced yet"}
              </small>
            </div>
            <button type="button" className="pill" title={`Forget ${d.name}: it can't sync with this PC until it's paired again`} onClick={async () => setSt(await invoke<PeerStatus>("peer_forget", { deviceId: d.deviceId }))}>
              Forget
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
