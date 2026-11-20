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
  /** "local" (Local folders, added one by one) or "grimmory" (downloaded from Grimmory) */
  source: "local" | "grimmory";
  /** the Grimmory book this file is (a download, or a Local copy of the same file) */
  grimmoryId: number | null;
  placeState: "clean" | "pending";
  syncedAt: number | null;
};

export type GStatus = {
  url: string;
  user: string | null;
  signedIn: boolean;
  signedOut: boolean;
  reach: "unknown" | "online" | "offline";
  syncing: boolean;
  syncDone: number;
  syncTotal: number;
  lastSync: number | null;
  lastError: string | null;
  waiting: number;
};
export type GBook = {
  id: number;
  libraryId: number | null;
  title: string;
  authors: string | null;
  series: string | null;
  seriesNumber: number | null;
  fileType: string | null;
  fileName: string | null;
  sizeKb: number | null;
  addedOn: number | null;
  lastRead: number | null;
  progress: number | null;
  readStatus: string | null;
  coverV: number | null;
  pageCount: number | null;
  language: string | null;
  publisher: string | null;
  categories: string | null;
  tags: string | null;
  published: string | null;
  localId: number | null;
};
export type GLibrary = { id: number; name: string; icon: string | null; bookCount: number | null };
export type GShelf = { kind: "shelf" | "magic"; id: number; name: string; icon: string | null; bookCount: number | null; bookIds: number[] };
export type Catalog = { books: GBook[]; libraries: GLibrary[]; shelves: GShelf[] };
export type Dl = {
  bookId: number;
  state: "queued" | "running" | "paused" | "waiting" | "failed" | "done" | "none";
  done: number;
  total: number;
  error: string | null;
  localId: number | null;
  openAfter: boolean;
};
export type Offer = { fraction: number | null; at: number | null; page: number | null };
export type OpenPlace = { location: string | null; fraction: number | null; offer: Offer | null; grimmoryId: number | null };
export type ScanState = { scanning: boolean; lastScan: number | null; done: number; total: number };
export type Library = { folders: Folder[]; books: Book[]; scan: ScanState };
export type ReadingDays = { today: string; days: [string, number][] };

export const api = {
  library: () => invoke<Library>("get_library"),
  book: (id: number) => invoke<Book | null>("get_book", { id }),
  addPaths: (paths: string[]) => invoke<void>("add_paths", { paths }),
  removeFolder: (id: number) => invoke<void>("remove_folder", { id }),
  scanNow: () => invoke<void>("scan_now"),
  saveProgress: (id: number, location: string, fraction: number, chapter: string | null, href: string | null, turned: boolean) =>
    invoke<void>("save_progress", { id, location, fraction, chapter, href, turned }),
  markOpened: (id: number) => invoke<void>("mark_opened", { id }),
  addReading: (seconds: number) => invoke<void>("add_reading", { seconds }),
  readingDays: () => invoke<ReadingDays>("reading_days"),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) => invoke<void>("set_setting", { key, value }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  hasMica: () => invoke<boolean>("has_mica"),
  snapOverlay: () => invoke<void>("plugin:decorum|show_snap_overlay"),
};

export const grimmory = {
  status: () => invoke<GStatus>("grimmory_status"),
  signIn: (url: string, user: string, password: string) => invoke<GStatus>("grimmory_sign_in", { url, user, password }),
  signOut: () => invoke<void>("grimmory_sign_out"),
  setUrl: (url: string) => invoke<GStatus>("grimmory_set_url", { url }),
  check: () => invoke<boolean>("grimmory_check"),
  catalog: () => invoke<Catalog>("grimmory_catalog"),
  sync: (full: boolean) => invoke<void>("grimmory_sync", { full }),
  downloads: () => invoke<Dl[]>("grimmory_downloads"),
  download: (id: number, openAfter: boolean) => invoke<void>("grimmory_download", { id, openAfter }),
  pause: (id: number) => invoke<void>("grimmory_pause", { id }),
  resume: (id: number) => invoke<void>("grimmory_resume", { id }),
  cancel: (id: number) => invoke<void>("grimmory_cancel", { id }),
  openPlace: (id: number) => invoke<OpenPlace>("grimmory_open_place", { id }),
  offer: (id: number) => invoke<Offer | null>("grimmory_offer", { id }),
  answer: (id: number, go: boolean) => invoke<OpenPlace>("grimmory_answer", { id, go }),
  closed: (id: number) => invoke<void>("grimmory_closed", { id }),
  match: (id: number) => invoke<number | null>("grimmory_match", { id }),
};

export const fileUrl = (path: string) => convertFileSrc(path);

/** A Grimmory cover, fetched once and kept on this PC (the kcover protocol in Rust). */
export const gcoverUrl = (id: number, v: number | null) => convertFileSrc(`${id}-${v ?? 0}`, "kcover");

/** Grimmory's file types that the reader opens in this version. */
export const G_READABLE = new Set(["EPUB", "MOBI", "AZW3", "AZW", "FB2", "CBX", "CBZ", "CBR", "PDF"]);
export const gFormat = (b: { fileType: string | null; fileName: string | null }) => {
  if (b.fileType === "AUDIOBOOK") return "Audiobook";
  const ext = b.fileName?.split(".").pop()?.toUpperCase();
  if (b.fileType === "CBX") return ext && ext.length <= 4 ? ext : "CBZ";
  return b.fileType ?? ext ?? "";
};
export const gReadable = (b: { fileType: string | null; fileName: string | null }) =>
  G_READABLE.has((b.fileType ?? "").toUpperCase()) && gFormat(b) !== "CBR" && gFormat(b) !== "CB7";

/** Formats the reader opens in this version (foliate-js). PDF and DjVu come in milestone 6. */
export const READABLE = new Set(["epub", "mobi", "azw3", "azw", "fb2", "fbz", "cbz", "cbr", "pdf", "djvu"]);

export const BOOK_EXTENSIONS = ["epub", "mobi", "azw3", "azw", "fb2", "fbz", "zip", "cbz", "cbr", "pdf", "djvu", "djv"];
