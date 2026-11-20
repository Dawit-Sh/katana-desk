// Calls into the Rust side (src-tauri/src/lib.rs).
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type Folder = { id: number; path: string; name: string; addedAt: number };
export type Book = {
  id: number;
  path: string;
  folderId: number | null;
  relDir: string;
  format: string;
  title: string;
  author: string | null;
  size: number;
  cover: string | null;
  addedAt: number;
  openedAt: number | null;
  location: string | null;
  fraction: number | null;
  chapter: string | null;
};
export type ScanState = { scanning: boolean; lastScan: number | null; done: number; total: number };
export type Library = { folders: Folder[]; books: Book[]; scan: ScanState };
export type ReadingDays = { today: string; days: [string, number][] };

export const api = {
  library: () => invoke<Library>("get_library"),
  book: (id: number) => invoke<Book | null>("get_book", { id }),
  addPaths: (paths: string[]) => invoke<void>("add_paths", { paths }),
  removeFolder: (id: number) => invoke<void>("remove_folder", { id }),
  scanNow: () => invoke<void>("scan_now"),
  saveProgress: (id: number, location: string, fraction: number, chapter: string | null) =>
    invoke<void>("save_progress", { id, location, fraction, chapter }),
  markOpened: (id: number) => invoke<void>("mark_opened", { id }),
  addReading: (seconds: number) => invoke<void>("add_reading", { seconds }),
  readingDays: () => invoke<ReadingDays>("reading_days"),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  hasMica: () => invoke<boolean>("has_mica"),
  snapOverlay: () => invoke<void>("plugin:decorum|show_snap_overlay"),
};

export const fileUrl = (path: string) => convertFileSrc(path);

/** Formats the reader opens in this version (foliate-js). PDF and DjVu come in milestone 6. */
export const READABLE = new Set(["epub", "mobi", "azw3", "azw", "fb2", "fbz", "cbz"]);

export const BOOK_EXTENSIONS = ["epub", "mobi", "azw3", "azw", "fb2", "fbz", "zip", "cbz", "pdf", "djvu", "djv"];
