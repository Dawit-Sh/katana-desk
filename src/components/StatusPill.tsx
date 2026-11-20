// A book's reading status, as Grimmory keeps it, and Reset progress: a pill on the book's page that opens a
// menu. A status or a reset made here goes to Grimmory at once (and a reset clears the place here too).
// A book only on this PC has no status to keep, just Reset progress.
import { useEffect, useRef, useState } from "react";
import { grimmory } from "../lib/api";
import { useStore } from "../lib/store";

export const STATUSES: { id: string; name: string; icon: string }[] = [
  { id: "UNREAD", name: "Unread", icon: "radio_button_unchecked" },
  { id: "READING", name: "Reading", icon: "auto_stories" },
  { id: "RE_READING", name: "Re-reading", icon: "replay" },
  { id: "READ", name: "Read", icon: "task_alt" },
  { id: "PARTIALLY_READ", name: "Partially read", icon: "clock_loader_40" },
  { id: "PAUSED", name: "Paused", icon: "pause_circle" },
  { id: "WONT_READ", name: "Won't read", icon: "block" },
  { id: "ABANDONED", name: "Abandoned", icon: "cancel" },
];

export const statusName = (s: string | null | undefined) => STATUSES.find((x) => x.id === s);

export function StatusPill({ gid, status, localId, started }: { gid: number | null; status: string | null; localId: number | null; started: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(status);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setNow(status), [status]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        setConfirm(false);
      }
    };
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  if (gid == null && !started) return null;

  const done = async (p: Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const s = await p;
      if (typeof s === "string") setNow(s);
      setOpen(false);
      setConfirm(false);
      const st = useStore.getState();
      st.reload();
      st.reloadCatalog().catch(() => {});
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
  };
  const cur = statusName(now);
  const reset = () => done(gid != null ? grimmory.resetProgress(gid) : grimmory.resetPlace(localId!));

  return (
    <div className="stwrap" ref={ref}>
      <button type="button" className="pill stpill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={gid != null ? "Reading status, as on Grimmory" : "Reset progress"}>
        <i className="ms">{gid != null ? cur?.icon ?? "bookmark_manager" : "restart_alt"}</i>
        {gid != null ? cur?.name ?? "Set a status" : "Reset progress"}
        <i className="ms chev">expand_more</i>
      </button>
      {open && (
        <div className="menu stmenu" role="menu">
          {gid != null &&
            STATUSES.map((s) => (
              <button type="button" role="menuitemradio" aria-checked={now === s.id} key={s.id} disabled={busy} onClick={() => done(grimmory.setStatus(gid, s.id))}>
                <i className="ms">{s.icon}</i>
                <span>{s.name}</span>
                {now === s.id && <i className="ms tick">check</i>}
              </button>
            ))}
          {gid != null && <hr />}
          {!confirm ? (
            <button type="button" role="menuitem" disabled={busy} onClick={() => setConfirm(true)}>
              <i className="ms">restart_alt</i>
              <span>Reset progress…</span>
            </button>
          ) : (
            <div className="stconfirm">
              <p>{gid != null ? "Reset progress here and on Grimmory? The place goes and the book is unread again. Highlights and bookmarks stay." : "Reset progress? The place goes and the book is unread again. Highlights and bookmarks stay."}</p>
              <div className="pills">
                <button type="button" className="pill" onClick={() => setConfirm(false)}>Keep</button>
                <button type="button" className="pill fill" disabled={busy} onClick={reset}>Reset</button>
              </div>
            </div>
          )}
          {err && <div className="err stmsg">{err}</div>}
        </div>
      )}
    </div>
  );
}
