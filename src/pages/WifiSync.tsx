// Settings › Sync and backup › Sync on this Wi-Fi: Katana on a phone or tablet syncs its Local books
// (places, statuses, highlights, bookmarks) with this PC on the same Wi-Fi, no Grimmory server needed.
// Off until he turns it on; "Pair a device" shows a 6-digit code for 5 minutes; paired devices with Forget.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { fmtAgo } from "../lib/format";

type Device = { deviceId: string; name: string; pairedAt: number; seenAt: number | null };
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
  return (
    <>
      <div className="glab">Sync on this Wi-Fi</div>
      <div className="grp">
        <div className="srow">
          <i className="ms" style={{ color: "var(--k-var)" }}>{st.running ? "wifi" : "wifi_off"}</i>
          <div className="tx">
            <b>Sync with Katana on this Wi-Fi</b>
            <small style={{ whiteSpace: "normal" }}>
              {st.error
                ? st.error
                : st.running
                  ? `On: ${st.name}${st.address ? ` at ${st.address}:${st.port}` : ""}. Katana on a phone or tablet keeps the same books' places, statuses, highlights and bookmarks in step with this PC, with Grimmory's rules.`
                  : "Off. Katana on a phone or tablet can sync its Local books with this PC when both are on the same Wi-Fi, without a Grimmory server."}
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
        {st.running && (
          <div className="srow">
            <i className="ms" style={{ color: "var(--k-var)" }}>add_link</i>
            <div className="tx">
              {code ? (
                <>
                  <b style={{ fontSize: 28, letterSpacing: "0.18em", fontVariantNumeric: "tabular-nums" }}>{code}</b>
                  <small style={{ whiteSpace: "normal" }}>
                    In Katana: Settings › Sources › Katana Desk, then this code. Good for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.
                  </small>
                </>
              ) : (
                <>
                  <b>Pair a device</b>
                  <small style={{ whiteSpace: "normal" }}>Shows a code to type in Katana. Each code pairs one device and lasts 5 minutes.</small>
                </>
              )}
            </div>
            {code ? (
              <button type="button" className="pill" onClick={async () => setSt(await invoke<PeerStatus>("peer_pair_close"))}>
                Done
              </button>
            ) : (
              <button type="button" className="pill fill" onClick={async () => setSt(await invoke<PeerStatus>("peer_pair_open"))}>
                Pair a device
              </button>
            )}
          </div>
        )}
        {st.devices.map((d) => (
          <div className="srow" key={d.deviceId}>
            <i className="ms" style={{ color: "var(--k-var)" }}>smartphone</i>
            <div className="tx">
              <b>{d.name}</b>
              <small>{d.seenAt ? `Last synced ${fmtAgo(d.seenAt)}` : "Paired, not synced yet"}</small>
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
