// Share as an image (Katana 1.2.5's quote card, on the desk): a highlight drawn as a card, the preview on the
// left and its ground and shape on the right. Paper, Dusk, Teal, the book's cover colours, the book's cover
// itself or your own picture (chosen, or dropped on the window), blurred or not; square or tall. Save image…
// writes a PNG (Pictures\Katana by default), Copy image puts it on the clipboard to paste into a chat.
// Opens from a highlight's card in the reader and from right-clicking a highlight on the Bookmarks page.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, bookKey, covers, gcoverUrl } from "../lib/api";
import { useStore } from "../lib/store";
import { paletteOf } from "./Cover";
import { copyText } from "../reader/cards";
import { DUSK, PAPER, PICTURE, TEAL, coverCardColors, fileName, isPicture, parseColor, type CardColors, type CardShape, type Ground } from "../lib/quotecard";
import { cardFontsReady, cardPng, decodePicture, drawCard, swatchesOfDrawn, swatchesOfImage } from "../lib/quotedraw";
import "../styles/share.css";

/** The book a quote is from: what the card says and where its cover is. */
export type ShareBook = { id: number; title: string; author: string | null; cover: string | null; grimmoryId: number | null; source?: string };
export type ShareQuote = { text: string; book: ShareBook };

type ShareState = {
  quote: ShareQuote | null;
  /** the right-click menu of a highlight on the Bookmarks page */
  menu: { x: number; y: number; quote: ShareQuote } | null;
};
export const useShare = create<ShareState>(() => ({ quote: null, menu: null }));

/** Opens Share as an image for a quote. */
export const openShare = (quote: ShareQuote) => useShare.setState({ quote, menu: null });
/** Whether the dialog is open (a picture dropped on the window is its background then, not a book). */
export const shareOpen = () => useShare.getState().quote != null;
/** A highlight's right-click menu. */
export function shareMenuAt(e: React.MouseEvent, quote: ShareQuote) {
  e.preventDefault();
  useShare.setState({ menu: { x: e.clientX, y: e.clientY, quote } });
}

/** The dialog and the highlight menu, wherever they're open. */
export function ShareHost() {
  const quote = useShare((s) => s.quote);
  const menu = useShare((s) => s.menu);
  return (
    <>
      {menu && <QuoteMenu m={menu} />}
      {quote && <ShareDialog q={quote} />}
    </>
  );
}

function QuoteMenu({ m }: { m: NonNullable<ShareState["menu"]> }) {
  const close = () => useShare.setState({ menu: null });
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: m.x, top: m.y });
  useEffect(() => {
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
    };
  }, []);
  // stay inside the window
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(m.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(m.y, window.innerHeight - r.height - 8)) });
  }, [m.x, m.y]);
  return (
    <div className="menu ctx sh-menu" ref={ref} style={pos} role="menu" aria-label="Highlight">
      <div className="mh" title={m.quote.book.title}>{m.quote.book.title}</div>
      <button type="button" role="menuitem" onClick={() => openShare(m.quote)}>
        <i className="ms">share</i>Share as an image…
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          close();
          copyText(m.quote.text);
        }}
      >
        <i className="ms">content_copy</i>Copy the words
      </button>
    </div>
  );
}

type Picture = { image: ImageBitmap; url: string };

/** Bytes to a picture and a small address the swatch can show. */
async function pictureOf(bytes: ArrayBuffer | Blob): Promise<Picture> {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  const image = await decodePicture(blob);
  return { image, url: URL.createObjectURL(blob) };
}

const PICTURE_EXT = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

/** The cover the desk shows for this book: one given on this PC, the book's own, or Grimmory's kept here. */
async function loadCover(b: ShareBook, custom: Record<string, string>): Promise<Picture | null> {
  const keys = [bookKey(b), b.grimmoryId != null ? `g:${b.grimmoryId}` : null, `b:${b.id}`];
  const mine = keys.map((k) => (k ? custom[k] : undefined)).find(Boolean);
  // the library's latest (a PDF's first page becomes its cover after it was opened)
  const own = useStore.getState().books.find((x) => x.id === b.id)?.cover ?? b.cover;
  for (const path of [mine, own]) {
    if (!path) continue;
    try {
      return await pictureOf(await covers.file(path));
    } catch {
      /* the next one */
    }
  }
  if (b.grimmoryId != null) {
    // Grimmory's cover kept on this PC, read as a picture (it's served to any page, so the card can be saved)
    const v = useStore.getState().catalog.books.find((x) => x.id === b.grimmoryId)?.coverV ?? null;
    const url = gcoverUrl(b.grimmoryId, v);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = url;
      await img.decode();
      return { image: await createImageBitmap(img), url };
    } catch {
      /* no cover */
    }
  }
  return null;
}

/** The theme's own accent, for a cover with none vivid enough. */
const themeAccent = () => parseColor(getComputedStyle(document.documentElement).getPropertyValue("--k-pri")) ?? 0xb7c7d9;

/** Joins a folder and a file name with the folder's own separator. */
const joinPath = (dir: string, name: string) => (/[\\/]$/.test(dir) ? dir + name : `${dir}${dir.includes("/") && !dir.includes("\\") ? "/" : "\\"}${name}`);

const GROUNDS: { id: Ground; name: string; colors?: CardColors }[] = [
  { id: "paper", name: "Paper", colors: PAPER },
  { id: "dusk", name: "Dusk", colors: DUSK },
  { id: "teal", name: "Teal", colors: TEAL },
  { id: "cover", name: "Cover colours" },
  { id: "coverPicture", name: "Book cover" },
  { id: "photo", name: "Your picture" },
];

function ShareDialog({ q }: { q: ShareQuote }) {
  const close = () => useShare.setState({ quote: null });
  const [ground, setGround] = useState<Ground>("paper");
  const [shape, setShape] = useState<CardShape>("square");
  const [blurred, setBlurred] = useState(true);
  const [cover, setCover] = useState<Picture | null | undefined>(undefined);
  const [photo, setPhoto] = useState<Picture | null>(null);
  const [fonts, setFonts] = useState(false);
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const [msg, setMsg] = useState<{ text: string; path?: string; error?: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const pictures = useRef<Picture[]>([]);
  const text = useMemo(() => ({ quote: q.text, title: q.book.title, author: q.book.author }), [q]);

  // the faces first (the card is drawn with them), the cover alongside
  useEffect(() => {
    let live = true;
    cardFontsReady(text).finally(() => live && setFonts(true));
    loadCover(q.book, useStore.getState().customCovers).then((c) => {
      if (c) pictures.current.push(c);
      if (live) setCover(c);
    });
    return () => {
      live = false;
    };
  }, [q, text]);
  useEffect(
    () => () => {
      for (const p of pictures.current) {
        if (p.url.startsWith("blob:")) URL.revokeObjectURL(p.url);
        p.image.close();
      }
    },
    [],
  );

  // the cover's colours: its picture's, or for a book without one, its drawn cover's
  const coverColors = useMemo(() => {
    if (cover === undefined) return null;
    const [from, to] = paletteOf(q.book.title, q.book.author);
    const sw = (cover && swatchesOfImage(cover.image)) || swatchesOfDrawn(from, to);
    if (!sw) return null;
    return coverCardColors(sw, document.documentElement.dataset.tone !== "light", themeAccent());
  }, [cover, q.book.title, q.book.author]);

  const colorsOf = (g: Ground) => (g === "cover" ? coverColors ?? PAPER : isPicture(g) ? PICTURE : (GROUNDS.find((x) => x.id === g)?.colors ?? PAPER));
  const backdrop = ground === "coverPicture" && cover ? { image: cover.image, blurred } : ground === "photo" && photo ? { image: photo.image, blurred } : null;
  // a picture ground that isn't there (yet) waits on Paper
  const shown: Ground = isPicture(ground) && !backdrop ? "paper" : ground;

  useEffect(() => {
    if (!fonts || !canvas.current) return;
    drawCard(canvas.current, text, colorsOf(shown), shape, backdrop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fonts, text, shown, shape, blurred, cover, photo, coverColors]);

  const takePicture = async (get: () => Promise<ArrayBuffer | Blob>) => {
    try {
      const p = await pictureOf(await get());
      pictures.current.push(p);
      setPhoto(p);
      setGround("photo");
      setMsg(null);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    }
  };
  const choose = async () => {
    const f = await openDialog({ title: "Choose a picture", filters: [{ name: "Pictures", extensions: PICTURE_EXT }] }).catch(() => null);
    if (typeof f === "string") takePicture(() => covers.file(f));
  };

  // your picture: dropped on the window (the library's own drop is off while this is open)
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") return setDragging(true);
      setDragging(false);
      if (p.type !== "drop" || !p.paths.length) return;
      const path = p.paths[0];
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      if (!PICTURE_EXT.includes(ext)) return setMsg({ text: "Drop a picture: JPG, PNG, WebP or GIF.", error: true });
      takePicture(() => covers.file(path));
    });
    return () => {
      un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes; the other keys stay here, so the book behind doesn't turn its pages
  useEffect(() => {
    // the keys come here, not to a book's page behind
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const save = async () => {
    if (!canvas.current || busy) return;
    setBusy("save");
    setMsg(null);
    try {
      const png = await cardPng(canvas.current);
      const dir = await invoke<string>("share_pictures_dir").catch(() => null);
      const name = fileName(q.book.title, new Date());
      const path = await saveDialog({ title: "Save image", defaultPath: dir ? joinPath(dir, name) : name, filters: [{ name: "PNG image", extensions: ["png"] }] });
      if (!path) return;
      const saved = await invoke<string>("share_save_image", new Uint8Array(await png.arrayBuffer()), { headers: { path: encodeURIComponent(path) } });
      const folder = saved.replace(/[\\/][^\\/]*$/, "");
      const where = dir && folder.toLowerCase() === dir.toLowerCase() ? "Pictures\\Katana" : folder.split(/[\\/]/).pop() || folder;
      setMsg({ text: `Saved to ${where}`, path: saved });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!canvas.current || busy) return;
    setBusy("copy");
    setMsg(null);
    try {
      // the PNG as a promise, so the click still counts while it's being made
      await navigator.clipboard.write([new ClipboardItem({ "image/png": cardPng(canvas.current) })]);
      setMsg({ text: "Copied. Paste it anywhere with Ctrl V." });
    } catch (e) {
      console.error(e);
      setMsg({ text: "The image couldn't be copied. Save it instead.", error: true });
    } finally {
      setBusy(null);
    }
  };

  const pick = (g: Ground) => {
    if (g === "photo" && !photo) return void choose();
    setGround(g);
  };

  const swatch = (g: (typeof GROUNDS)[number]) => {
    if (g.id === "coverPicture" && !cover) return null;
    if (g.id === "cover" && !coverColors) return null;
    const on = ground === g.id;
    const common = {
      type: "button" as const,
      "aria-pressed": on,
      "aria-label": g.id === "photo" && !photo ? "Your picture: choose one" : g.name,
      title: g.id === "photo" && !photo ? "Your picture" : g.name,
      onClick: () => pick(g.id),
    };
    if (g.id === "coverPicture" || g.id === "photo") {
      const url = g.id === "coverPicture" ? cover?.url : photo?.url;
      return (
        <button key={g.id} {...common} className={`sh-sw pic ${on ? "on" : ""} ${url ? "" : "add"}`} style={url ? { backgroundImage: `url("${url}")` } : undefined}>
          {!url && <i className="ms">add</i>}
        </button>
      );
    }
    const c = g.id === "cover" ? coverColors! : g.colors!;
    return <button key={g.id} {...common} className={`sh-sw ${on ? "on" : ""}`} style={{ "--g": c.ground, "--d": c.accent } as CSSProperties} />;
  };

  return (
    <div className="pal-scrim cd-scrim sh-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} tabIndex={-1} className={`sh ${dragging ? "dropping" : ""}`} role="dialog" aria-label="Share as an image">
        <div className="sh-hd">
          <b>Share as an image</b>
          <button type="button" className="ib" aria-label="Close" title="Close (Esc)" onClick={close}>
            <i className="ms">close</i>
          </button>
        </div>
        <div className="sh-prev">
          <canvas ref={canvas} width={1080} height={shape === "tall" ? 1350 : 1080} className={fonts ? "" : "wait"} aria-label="The card" role="img" />
        </div>
        <div className="sh-ctl">
          <div>
            <div className="sh-lbl">Background</div>
            <div className="sh-sws">{GROUNDS.map(swatch)}</div>
          </div>
          <div>
            <div className="sh-lbl">Card</div>
            <div className="sh-chips">
              <span className="sh-pair" role="radiogroup" aria-label="Shape">
                {(["square", "tall"] as const).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={shape === s} className={`sh-chip ${shape === s ? "on" : ""}`} onClick={() => setShape(s)} title={s === "square" ? "1080 × 1080" : "1080 × 1350"}>
                    {s === "square" ? "Square" : "Tall"}
                  </button>
                ))}
              </span>
              {isPicture(ground) && (
                <button type="button" className={`sh-chip ${blurred ? "on" : ""}`} aria-pressed={blurred} onClick={() => setBlurred(!blurred)}>
                  {blurred && <i className="ms">check</i>}Blur
                </button>
              )}
              {ground === "photo" && photo && (
                <button type="button" className="sh-chip" onClick={choose}>
                  <i className="ms">image</i>Change picture
                </button>
              )}
            </div>
          </div>
          <p className="sh-hint">Or drop a picture here to use it as the background.</p>
          <div className="sh-foot">
            {msg && (
              <div className={`sh-msg ${msg.error ? "err" : ""}`} role="status">
                {msg.text}
                {msg.path && (
                  <button type="button" className="sh-link" onClick={() => api.reveal(msg.path!)}>
                    Show in File Explorer
                  </button>
                )}
              </div>
            )}
            <div className="sh-btns">
              <button type="button" className="pill tone" onClick={save} disabled={!fonts || !!busy}>
                <i className="ms">download</i>
                {busy === "save" ? "Saving…" : "Save image…"}
              </button>
              <button type="button" className="pill fill" onClick={copy} disabled={!fonts || !!busy}>
                <i className="ms">content_copy</i>
                {busy === "copy" ? "Copying…" : "Copy image"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
