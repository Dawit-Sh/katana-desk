// Bookmarks on this PC (src-tauri/src/marks.rs). Shaped for milestone 4's Grimmory sync.
import { invoke } from "@tauri-apps/api/core";

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
  syncState: "local" | "synced" | "dirty" | "deleted";
};

export const marks = {
  list: (bookId: number) => invoke<Bookmark[]>("bookmarks", { bookId }),
  add: (bookId: number, cfi: string, fraction: number | null, pageLabel: string | null, chapter: string | null, excerpt: string | null) =>
    invoke<Bookmark>("add_bookmark", { bookId, cfi, fraction, pageLabel, chapter, excerpt }),
  remove: (id: number) => invoke<void>("remove_bookmark", { id }),
  update: (id: number, title: string | null, note: string | null) => invoke<void>("update_bookmark", { id, title, note }),
};
