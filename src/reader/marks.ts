// Bookmarks and highlights on this PC (src-tauri/src/marks.rs, highlights.rs), synced with Grimmory
// for EPUBs (src-tauri/src/grimmory/marks_sync.rs).
import { invoke } from "@tauri-apps/api/core";

export type SyncState = "local" | "synced" | "dirty" | "deleted" | "kept";

export type Bookmark = {
  id: number;
  uuid: string;
  bookId: number;
  cfi: string;
  fraction: number | null;
  pageLabel: string | null;
  chapter: string | null;
  excerpt: string | null;
  title: string | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  remoteId: number | null;
  syncState: SyncState;
};

export type Colour = "yellow" | "green" | "blue" | "pink" | "orange";
export type Style = "highlight" | "underline" | "strikethrough" | "squiggly";

export type Highlight = {
  id: number;
  uuid: string;
  bookId: number;
  cfi: string;
  text: string;
  chapter: string | null;
  fraction: number | null;
  pageLabel: string | null;
  color: Colour;
  style: Style;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  remoteId: number | null;
  syncState: SyncState;
};

export type MarkedBook = {
  id: number;
  title: string;
  author: string | null;
  cover: string | null;
  format: string;
  fraction: number | null;
  grimmoryId: number | null;
  bookmarks: number;
  highlights: number;
  notes: number;
  latest: number;
};

export type MarkPlace = {
  kind: "highlight" | "bookmark";
  id: number;
  fraction: number | null;
  pageLabel: string | null;
  chapter: string | null;
  excerpt?: string | null;
};

/** How a book's marks stand with Grimmory. */
export type MarksSync = "synced" | "waiting" | "local" | "format";

export const marks = {
  list: (bookId: number) => invoke<Bookmark[]>("bookmarks", { bookId }),
  add: (bookId: number, cfi: string, fraction: number | null, pageLabel: string | null, chapter: string | null, excerpt: string | null) =>
    invoke<Bookmark>("add_bookmark", { bookId, cfi, fraction, pageLabel, chapter, excerpt }),
  /** answers the read it belonged to, for Undo */
  remove: (id: number) => invoke<number | null>("remove_bookmark", { id }),
  update: (id: number, title: string | null, note: string | null) => invoke<void>("update_bookmark", { id, title, note }),
  /** Undo: back as it was, in its read */
  restore: (b: Bookmark, readN: number | null = null) => invoke<Bookmark>("restore_bookmark", { b, readN }),
};

export const hls = {
  list: (bookId: number) => invoke<Highlight[]>("highlights", { bookId }),
  add: (h: { bookId: number; cfi: string; text: string; chapter: string | null; fraction: number | null; pageLabel: string | null; color: Colour; style: Style; note?: string | null }) =>
    invoke<Highlight>("add_highlight", { ...h, note: h.note ?? null }),
  update: (id: number, color: Colour, style: Style, note: string | null) => invoke<Highlight | null>("update_highlight", { id, color, style, note }),
  /** answers the read it belonged to, for Undo */
  remove: (id: number) => invoke<number | null>("remove_highlight", { id }),
  /** Undo: back as it was, in its read */
  restore: (h: Highlight, readN: number | null = null) => invoke<Highlight>("restore_highlight", { h, readN }),
};

/** A PDF drawing: Grimmory's pen, a highlight or a text box made in its reader, or Katana's own pen.
 *  `data` is the annotation as Grimmory's PDF reader (EmbedPDF) keeps it, places in PDF points. */
export type Annot = { aid: string; page: number; kind: "ink" | "mark" | "other"; data: { annotation: Record<string, any> } };

export const pdfAnnots = {
  list: (bookId: number) => invoke<Annot[]>("pdf_annots", { bookId }),
  add: (bookId: number, data: Record<string, unknown>) => invoke<string>("pdf_annot_add", { bookId, data }),
  remove: (aid: string) => invoke<void>("pdf_annot_remove", { aid }),
  rects: (id: number, rects: [number, number, number, number][]) => invoke<void>("highlight_rects", { id, rects }),
  sync: (bookId: number) => invoke<boolean>("pdf_annots_sync", { bookId }),
};

/** Grimmory's PDF reader colours, for Katana's five (what its pen and highlights use). */
export const PDF_HEX: Record<Colour, string> = { yellow: "#FFEB3B", green: "#4CAF50", blue: "#2196F3", pink: "#E91E63", orange: "#FF5722" };

export const marksApi = {
  place: (places: MarkPlace[]) => invoke<void>("place_marks", { places }),
  books: () => invoke<MarkedBook[]>("marked_books"),
  search: (q: string) => invoke<number[]>("search_marks", { q }),
  exportName: (bookId: number) => invoke<string>("export_name", { bookId }),
  exportTo: (bookId: number, path: string) => invoke<void>("export_marks", { bookId, path }),
  sync: (id: number) => invoke<boolean>("marks_sync_book", { id }),
  syncState: (id: number) => invoke<MarksSync>("marks_sync_state", { id }),
  lost: (id: number) => invoke<{ highlights: number; bookmarks: number } | null>("marks_lost", { id }),
  lostAnswer: (id: number, putBack: boolean) => invoke<void>("marks_lost_answer", { id, putBack }),
};

/** Katana's five colours (the dots), and the four styles. */
export const COLOURS: { id: Colour; name: string; hex: string }[] = [
  { id: "yellow", name: "Yellow", hex: "#f2c230" },
  { id: "green", name: "Green", hex: "#5cb85c" },
  { id: "blue", name: "Blue", hex: "#4a90d9" },
  { id: "pink", name: "Pink", hex: "#e0609f" },
  { id: "orange", name: "Orange", hex: "#ef8a2f" },
];
export const STYLES: { id: Style; name: string }[] = [
  { id: "highlight", name: "Highlight" },
  { id: "underline", name: "Underline" },
  { id: "strikethrough", name: "Strike" },
  { id: "squiggly", name: "Squiggle" },
];
export const hexOf = (c: Colour) => COLOURS.find((x) => x.id === c)?.hex ?? COLOURS[0].hex;
export const styleName = (s: Style) => STYLES.find((x) => x.id === s)?.name ?? "Highlight";

/** Saves a book's marks as Markdown, where he picks. Returns the path, or null when he cancelled. */
export async function exportMarkdown(bookId: number): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const name = await marksApi.exportName(bookId);
  const path = await save({ defaultPath: name, filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (!path) return null;
  await marksApi.exportTo(bookId, path);
  return path;
}

/** A mark's place, for lists: the printed page or page, else how far through. */
export const placeLabel = (m: { pageLabel: string | null; fraction: number | null }) =>
  m.pageLabel ? `p. ${m.pageLabel}` : m.fraction != null ? `${Math.round(m.fraction * 100)}%` : "";
