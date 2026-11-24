// Change cover (milestone 7), from the canvas's change-cover artboard: pick Grimmory's cover, the
// book's own (or its first page), your own image (drop, paste with Ctrl V, or choose a file) or an
// Open Library cover; move and zoom it in a 2:3 frame; see it in the library and on the reading card;
// or go back to the original. Covers are saved on this PC; Grimmory's own stay untouched.
import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner } from "./Spinner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { covers, type OlCover } from "../lib/api";
import { useStore, type CoverTarget } from "../lib/store";
import { pdfFirstPage } from "../lib/pdfcovers";
import { resetCover, saveCover } from "../lib/undoable";

const FW = 260; // the frame, 2:3
const FH = 390;
const OUT_W = 600; // the saved cover
const OUT_H = 900;

type Cand = {
  id: string;
  name: string;
  /** where it came from, kept with the cover */
  source: string;
  url: string | null;
  w: number;
  h: number;
  state: "loading" | "ok" | "failed";
  error?: string;
  /** an Open Library cover: its small picture until picked, then the large one */
  ol?: OlCover;
};
type Frame = { z: number; x: number; y: number };

const PAGE = new Set(["pdf", "djvu", "cbz", "cbr"]);

/** Bytes to a picture the page can draw (and later put on a canvas without tainting it). */
async function toUrl(bytes: ArrayBuffer | Blob): Promise<{ url: string; w: number; h: number }> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("That isn't a picture Katana Desk can read.");
  }
  return { url, w: img.naturalWidth, h: img.naturalHeight };
}

/** The picture's size and place in a frame `fw` wide (the frame's own scale: 1 = the 260 px stage). */
function place(c: Cand, f: Frame, fw: number) {
  const k = fw / FW;
  const s0 = Math.max(FW / c.w, FH / c.h);
  const w = c.w * s0 * f.z * k;
  const h = c.h * s0 * f.z * k;
  return { w, h, left: (FW / 2 + f.x) * k - w / 2, top: (FH / 2 + f.y) * k - h / 2 };
}

/** Keeps the picture covering the frame. */
function clamp(c: Cand, f: Frame): Frame {
  const s0 = Math.max(FW / c.w, FH / c.h);
  const w = c.w * s0 * f.z;
  const h = c.h * s0 * f.z;
  const mx = Math.max(0, (w - FW) / 2);
  const my = Math.max(0, (h - FH) / 2);
  return { z: f.z, x: Math.max(-mx, Math.min(mx, f.x)), y: Math.max(-my, Math.min(my, f.y)) };
}

function Framed({ c, f, w, h, className }: { c: Cand; f: Frame; w: number; h: number; className?: string }) {
  const p = place(c, f, w);
  return (
    <span className={`cd-mini ${className ?? ""}`} style={{ width: w, height: h }}>
      {c.url && <img src={c.url} alt="" draggable={false} style={{ width: p.w, height: p.h, left: p.left, top: p.top }} />}
    </span>
  );
}

export function CoverDialog({ t }: { t: CoverTarget }) {
  const close = () => useStore.getState().setCoverFor(null);
  const current = useStore((s) => s.customCovers[t.key] ?? null);
  const [cands, setCands] = useState<Cand[]>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame>({ z: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [olState, setOlState] = useState<"idle" | "looking" | "done" | "failed">("idle");
  const urls = useRef<string[]>([]);
  const drag = useRef<{ x: number; y: number; f: Frame } | null>(null);
  const picked = cands.find((c) => c.id === pick && c.state === "ok") ?? null;

  const put = useCallback((c: Cand) => {
    if (c.url) urls.current.push(c.url);
    setCands((list) => {
      const i = list.findIndex((x) => x.id === c.id);
      if (i < 0) return [...list, c];
      const next = list.slice();
      next[i] = c;
      return next;
    });
  }, []);

  /** Loads one source in the background; the first that arrives is picked unless he picked one. */
  const load = useCallback(
    (id: string, name: string, source: string, get: () => Promise<ArrayBuffer | Blob | null>, select = false) => {
      put({ id, name, source, url: null, w: 0, h: 0, state: "loading" });
      get()
        .then(async (b) => {
          if (!b) throw new Error("Nothing there");
          const { url, w, h } = await toUrl(b);
          put({ id, name, source, url, w, h, state: "ok" });
          if (select) {
            setPick(id);
            setFrame({ z: 1, x: 0, y: 0 });
          } else setPick((p) => p ?? id);
        })
        .catch((e) => put({ id, name, source, url: null, w: 0, h: 0, state: "failed", error: String(e?.message ?? e) }));
    },
    [put],
  );

  // the sources this book has
  useEffect(() => {
    if (current) load("now", "Now", "custom", () => covers.file(current));
    if (t.grimmoryId != null) load("grimmory", "From Grimmory", "grimmory", () => covers.source("grimmory", null, t.grimmoryId));
    if (t.bookId != null) {
      if (t.format === "pdf") {
        const b = useStore.getState().books.find((x) => x.id === t.bookId);
        if (b) load("first", "First page", "first-page", () => pdfFirstPage(b.path, 900));
      } else if (PAGE.has(t.format)) load("first", "First page", "first-page", () => covers.source("first", t.bookId, null));
      else load("book", "From the book", "book", () => covers.source("book", t.bookId, null));
    }
    // Open Library, by title and author
    setOlState("looking");
    covers
      .olSearch(t.title, t.author)
      .then((list) => {
        setOlState("done");
        list.slice(0, 4).forEach((o) => load(`ol${o.coverId}`, "Open Library", `openlibrary:${o.coverId}`, () => covers.olCover(o.coverId, "M")));
      })
      .catch(() => setOlState("failed"));
    const u = urls.current;
    return () => u.forEach((x) => URL.revokeObjectURL(x));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.key]);

  // your own image: Ctrl V
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      setErr("");
      load(`own${Date.now()}`, "Your image", "own", async () => file, true);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [load]);

  // your own image: dropped on the window (the library's own drop is off while this is open)
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop" || !e.payload.paths.length) return;
      const path = e.payload.paths[0];
      if (!/\.(jpe?g|png|webp|gif|bmp)$/i.test(path)) return setErr("Drop a picture: JPG, PNG, WebP or GIF.");
      setErr("");
      load(`own${Date.now()}`, "Your image", "own", () => covers.file(path), true);
    });
    return () => {
      un.then((f) => f());
    };
  }, [load]);

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const choose = async () => {
    const f = await openDialog({ title: "Choose a cover", filters: [{ name: "Pictures", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }] });
    if (typeof f === "string") {
      setErr("");
      load(`own${Date.now()}`, "Your image", "own", () => covers.file(f), true);
    }
  };

  const select = async (c: Cand) => {
    if (c.state !== "ok") return;
    setPick(c.id);
    setFrame({ z: 1, x: 0, y: 0 });
    // an Open Library cover is fetched at its largest once picked
    if (c.ol === undefined && c.source.startsWith("openlibrary:")) {
      const id = Number(c.source.split(":")[1]);
      try {
        const big = await toUrl(await covers.olCover(id, "L"));
        if (big.w > c.w) put({ ...c, url: big.url, w: big.w, h: big.h, ol: { coverId: id, title: "", author: null, year: null } });
      } catch {
        /* the small one will do */
      }
    }
  };

  const setZoom = (z: number) => picked && setFrame((f) => clamp(picked, { ...f, z: Math.max(1, Math.min(4, z)) }));

  const useIt = async () => {
    if (!picked?.url) return;
    setBusy(true);
    setErr("");
    try {
      const img = new Image();
      img.src = picked.url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = OUT_W;
      canvas.height = OUT_H;
      const ctx = canvas.getContext("2d", { alpha: false })!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      ctx.imageSmoothingQuality = "high";
      const p = place(picked, frame, OUT_W);
      ctx.drawImage(img, p.left, p.top, p.w, p.h);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
      if (!blob) throw new Error("The cover couldn't be made.");
      // Ctrl Z puts the cover before back
      await saveCover(t, new Uint8Array(await blob.arrayBuffer()), picked.source);
      await useStore.getState().loadCovers();
      close();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await resetCover(t);
      await useStore.getState().loadCovers();
      close();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  const fp = picked ? place(picked, frame, FW) : null;
  const slider = (frame.z - 1) / 3;

  return (
    <div className="pal-scrim cd-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cd" role="dialog" aria-label="Change cover">
        <div className="cd-hd">
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>Change cover</b>
            <small>{t.title}{t.author ? ` · ${t.author}` : ""}</small>
          </div>
          <button type="button" className="ib" aria-label="Close" title="Close (Esc)" onClick={close}><i className="ms">close</i></button>
        </div>
        <div className="cd-cols">
          <div className="cd-stage">
            <div
              className={`cd-crop ${picked ? "" : "empty"}`}
              onPointerDown={(e) => {
                if (!picked) return;
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, f: frame };
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || !picked) return;
                setFrame(clamp(picked, { ...d.f, x: d.f.x + e.clientX - d.x, y: d.f.y + e.clientY - d.y }));
              }}
              onPointerUp={() => (drag.current = null)}
              onWheel={(e) => setZoom(frame.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
            >
              {picked && fp ? (
                <img src={picked.url!} alt="" draggable={false} style={{ width: fp.w, height: fp.h, left: fp.left, top: fp.top }} />
              ) : (
                <span className="su">{cands.some((c) => c.state === "loading") ? "Finding covers…" : "Pick a cover on the right"}</span>
              )}
              <i className="thirds" />
              <i className="frame" />
            </div>
            <div className="cd-zoom">
              <button type="button" className="ib" aria-label="Zoom out" onClick={() => setZoom(frame.z / 1.15)} disabled={!picked}><i className="ms">zoom_out</i></button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={slider}
                aria-label="Zoom"
                disabled={!picked}
                onChange={(e) => setZoom(1 + Number(e.target.value) * 3)}
                style={{ ["--p" as string]: `${slider * 100}%` }}
              />
              <button type="button" className="ib" aria-label="Zoom in" onClick={() => setZoom(frame.z * 1.15)} disabled={!picked}><i className="ms">zoom_in</i></button>
            </div>
            <div className="su cd-help">Drag the picture to move it, scroll to zoom. Covers are 2 by 3, like a book.</div>
          </div>
          <div className="cd-right">
            <div className="cd-lab">Pick a cover</div>
            <div className="cd-cands">
              {cands.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`cd-cand ${c.id === pick ? "on" : ""} ${c.state}`}
                  onClick={() => select(c)}
                  disabled={c.state !== "ok"}
                  title={c.state === "failed" ? c.error : c.name}
                >
                  <span className="cd-thumb">
                    {c.url ? <img src={c.url} alt="" draggable={false} /> : c.state === "loading" ? <Spinner /> : <i className="ms">hide_image</i>}
                  </span>
                  {c.name}
                </button>
              ))}
              {olState === "looking" && <span className="cd-cand loading"><span className="cd-thumb"><Spinner /></span>Open Library</span>}
            </div>
            {olState === "failed" && <div className="su">Open Library can't be reached right now.</div>}
            <button type="button" className="cd-drop" onClick={choose}>
              <i className="ms">upload_file</i>
              <div>
                <b>Use your own image</b>
                Drop a picture here, paste one with Ctrl V, or <u>choose a file</u>. JPG, PNG, WebP.
              </div>
            </button>
            {err && <div className="err">{err}</div>}
            <div className="cd-lab">How it will look</div>
            {picked ? (
              <div className="cd-prev">
                <div>
                  <Framed c={picked} f={frame} w={110} h={165} />
                  <div className="gt">In the library</div>
                </div>
                <div className="cd-card">
                  <Framed c={picked} f={frame} w={48} h={72} className="sm" />
                  <div>
                    <span className="ov">Continue reading · today</span>
                    <div className="gt big">{t.title}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="su">Pick a cover to see it here.</div>
            )}
          </div>
        </div>
        <div className="cd-ft">
          <button type="button" className="pill" onClick={reset} disabled={busy || !current} title={current ? "Forget this cover" : "This book shows its original cover"}>
            <i className="ms">history</i>Back to the original
          </button>
          <span className="su">Saved on this PC. Covers from Grimmory stay untouched.</span>
          <div className="grow" />
          <button type="button" className="pill" onClick={close}>Cancel</button>
          <button type="button" className="pill fill" onClick={useIt} disabled={!picked || busy}>
            {busy ? "Saving…" : "Use this cover"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Opens Change cover for a book on this PC. */
export function coverForBook(b: { id: number; title: string; author: string | null; format: string; source: string; grimmoryId: number | null }): CoverTarget {
  return {
    key: b.source === "grimmory" && b.grimmoryId != null ? `g:${b.grimmoryId}` : `b:${b.id}`,
    bookId: b.id,
    grimmoryId: b.grimmoryId,
    title: b.title,
    author: b.author,
    format: b.format,
  };
}

/** Opens Change cover for a Grimmory book (and its copy here, when there is one). */
export function coverForG(g: { id: number; title: string; authors: string | null; fileType: string | null; fileName: string | null; localId: number | null }): CoverTarget {
  const local = g.localId != null ? useStore.getState().books.find((b) => b.id === g.localId) : undefined;
  const ext = g.fileName?.split(".").pop()?.toLowerCase() ?? "";
  return {
    key: `g:${g.id}`,
    bookId: local?.id ?? null,
    grimmoryId: g.id,
    title: g.title,
    author: g.authors,
    format: local?.format ?? (g.fileType === "CBX" ? ext : (g.fileType ?? ext).toLowerCase()),
  };
}

