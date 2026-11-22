import { useState } from "react";
import type { Book, GBook } from "../lib/api";
import { bookKey, fileUrl, gcoverUrl } from "../lib/api";
import { useStore } from "../lib/store";

/** A custom cover given on this PC (Change cover), looked up under the book's own key and its twin's. */
export const useCustom = (keys: (string | null)[]) =>
  useStore((s) => {
    for (const k of keys) if (k && s.customCovers[k]) return s.customCovers[k];
    return null;
  });

// Drawn covers for books without a picture, in the canvas's cover colours: [from, to, text].
const PALETTE: [string, string, string][] = [
  ["#2c4a32", "#14261a", "#efdca4"],
  ["#5f8a3c", "#2f4c1d", "#f4f2e6"],
  ["#c42b25", "#7c1412", "#7fd3dc"],
  ["#4a3020", "#1c120b", "#f1e6d2"],
  ["#2f5d8a", "#173452", "#f6e7b8"],
  ["#183449", "#081520", "#e9f1f5"],
  ["#3d3f46", "#16171b", "#c9d7a0"],
  ["#d9cfb8", "#b7a988", "#2a2620"],
  ["#e8d6c6", "#c9a98f", "#4a2a1c"],
  ["#1d4f5c", "#0b2128", "#f0e6cf"],
  ["#5b4a6e", "#2b2138", "#efe3c8"],
  ["#e3e0d3", "#c2bca6", "#7a1d1d"],
];

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** A drawn cover's colours for a title and author: [from, to, text]. */
export const paletteOf = (title: string, author: string | null) => PALETTE[hash(title + (author ?? "")) % PALETTE.length];

export const coverColors = (b: Book) => {
  const [c1, c2, ct] = paletteOf(b.title, b.author);
  return { "--c1": c1, "--c2": c2, "--ct": ct } as React.CSSProperties;
};

/** The title size on a drawn cover shrinks for long titles. */
const titleSize = (t: string, base: number) => (t.length > 46 ? base * 0.72 : t.length > 26 ? base * 0.85 : base);

type Props = { book: Book; size?: "" | "l" | "m" | "s" | "xs"; progress?: boolean };

export function Cover({ book, size = "", progress = true }: Props) {
  const custom = useCustom([bookKey(book), book.grimmoryId != null ? `g:${book.grimmoryId}` : null, `b:${book.id}`]);
  const comic = book.format === "cbz" || book.format === "cbr";
  const frac = book.fraction ?? 0;
  const base = size === "l" ? 11 : size === "m" ? 8 : 15;
  const pr = progress && frac > 0.004 && frac < 0.995 && (
    <span className="pr"><i style={{ width: `${Math.round(frac * 100)}%` }} /></span>
  );
  const pic = custom ?? book.cover;
  if (pic) {
    return (
      <div className={`cv img ${size} ${comic ? "comic" : ""}`}>
        <img src={fileUrl(pic)} alt="" loading="lazy" draggable={false} />
        {pr}
      </div>
    );
  }
  return (
    <div className={`cv ${size} ${comic ? "comic" : ""}`} style={coverColors(book)}>
      <b style={{ fontSize: titleSize(book.title, base) }}>{book.title}</b>
      <s>{book.author ?? ""}</s>
      {book.format !== "epub" && size === "" && <span className="fmt">{book.format.toUpperCase()}</span>}
      {pr}
    </div>
  );
}

/** A small book peeking out of a folder tile. */
export function Peek({ book, side }: { book: Book; side: "a" | "b" }) {
  const custom = useCustom([bookKey(book), `b:${book.id}`]);
  if (custom || book.cover)
    return (
      <span className={`peek ${side}`}>
        <img src={fileUrl(custom ?? book.cover!)} alt="" loading="lazy" draggable={false} />
      </span>
    );
  return (
    <span className={`peek ${side}`} style={coverColors(book)}>
      <b>{book.title}</b>
      <s>{book.author ?? ""}</s>
    </span>
  );
}

/** A Grimmory book's cover: drawn at once, Grimmory's picture laid over it as soon as it's on this PC. */
export function GCover({ book, size = "", progress }: { book: GBook; size?: "" | "l" | "m" | "s" | "xs"; progress?: number | null }) {
  const [failed, setFailed] = useState(false);
  const custom = useCustom([`g:${book.id}`, book.localId != null ? `b:${book.localId}` : null]);
  const comic = book.fileType === "CBX";
  const base = size === "l" ? 11 : size === "m" ? 8 : size === "s" ? 6.5 : 15;
  const frac = progress ?? 0;
  const colors = coverColors({ title: book.title, author: book.authors } as Book);
  return (
    <div className={`cv ${size} ${comic ? "comic" : ""}`} style={colors}>
      <b style={{ fontSize: titleSize(book.title, base) }}>{book.title}</b>
      <s>{book.authors ?? ""}</s>
      {custom ? (
        <img src={fileUrl(custom)} alt="" loading="lazy" draggable={false} />
      ) : !failed && (
        <img
          key={book.coverV ?? 0}
          src={gcoverUrl(book.id, book.coverV)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      {progress != null && frac > 0.004 && frac < 0.995 && (
        <span className="pr"><i style={{ width: `${Math.round(frac * 100)}%` }} /></span>
      )}
    </div>
  );
}
