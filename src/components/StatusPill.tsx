// A book's reading status, as Grimmory keeps it, and Reset progress: a pill on the book's page that opens a
// menu. A status or a reset made here goes to Grimmory at once (and a reset clears the place here too).
// A book only on this PC keeps its status here, with the same menu.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { grimmory } from "../lib/api";
import { useStore } from "../lib/store";
import { statusChanged, statusMarks } from "../lib/undoable";

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

/** A book's reading status and its menu. With `title`, a status picked here goes on the undo history (Ctrl Z). */
export function StatusPill({ gid, status, localId, title }: { gid: number | null; status: string | null; localId: number | null; started?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(status);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setNow(status), [status]);
  // a book only on this PC: its status is kept here
  useEffect(() => {
    if (gid == null && localId != null) invoke<string | null>("book_status", { id: localId }).then(setNow).catch(() => {});
  }, [gid, localId]);
  // an undo or redo of this book's status: read it again
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ gid: number | null; localId: number | null }>).detail;
      const mine = (d.localId != null && d.localId === localId) || (d.gid != null && d.gid === gid);
      if (!mine) return;
      if (gid == null && localId != null) invoke<string | null>("book_status", { id: localId }).then(setNow).catch(() => {});
      else if (gid != null) setNow(useStore.getState().catalog.books.find((b) => b.id === gid)?.readStatus ?? null);
    };
    window.addEventListener("katana-status", on);
    return () => window.removeEventListener("katana-status", on);
  }, [gid, localId]);
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
  if (gid == null && localId == null) return null;

  const done = async (p: Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    let ok = false;
    try {
      const s = await p;
      if (typeof s === "string") setNow(s);
      setOpen(false);
      setConfirm(false);
      const st = useStore.getState();
      st.reload();
      st.reloadCatalog().catch(() => {});
      ok = true;
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
    return ok;
  };
  // a status picked in the menu; with `title`, Undo can put back the status and what it changed here
  // (Unread clears the place, Read sets the finished day, Re-reading starts a new read)
  const pick = async (to: string) => {
    const from = now;
    const copies = title == null ? [] : useStore.getState().books.filter((b) => b.id === localId || (gid != null && b.grimmoryId === gid));
    const marks = await Promise.all(copies.map((b) => statusMarks(b.id).catch(() => null)));
    let call: Promise<unknown>;
    if (gid == null) call = invoke<string>("book_set_status", { id: localId, status: to });
    else {
      // re-reading: the marks from here on go to a new read (Bookmarks › Compare reads)
      if (to === "RE_READING" && localId != null) invoke("book_new_read", { bookId: localId }).catch(() => {});
      call = grimmory.setStatus(gid, to);
    }
    const ok = await done(call);
    if (!ok || title == null || to === from) return;
    statusChanged({
      gid,
      localId,
      title,
      from,
      to,
      name: (s) => statusName(s)?.name ?? s,
      places: copies.map((b, i) => ({ id: b.id, location: b.location, fraction: b.fraction, chapter: b.chapter, marks: marks[i] })),
    });
  };
  const cur = statusName(now);
  const reset = () => done(gid != null ? grimmory.resetProgress(gid) : grimmory.resetPlace(localId!));

  return (
    <div className="stwrap" ref={ref}>
      <button
        type="button"
        className="pill stpill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={gid != null ? "Reading status, as on Grimmory" : "Reading status, kept on this PC"}
      >
        <i className="ms">{cur?.icon ?? "bookmark_manager"}</i>
        {cur?.name ?? "Set a status"}
        <i className="ms chev">expand_more</i>
      </button>
      {open && (
        <div className="menu stmenu" role="menu">
          {STATUSES.map((s) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={now === s.id}
                key={s.id}
                disabled={busy}
                onClick={() => void pick(s.id)}
              >
                <i className="ms">{s.icon}</i>
                <span>{s.name}</span>
                {now === s.id && <i className="ms tick">check</i>}
              </button>
            ))}
          <hr />
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
