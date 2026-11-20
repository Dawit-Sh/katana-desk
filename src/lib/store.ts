import { create } from "zustand";
import { api, type Book, type Folder, type ScanState } from "./api";

export type Page = "grimmory" | "local" | "lists" | "bookmarks" | "words" | "journal" | "settings";
export type ThemePref = "system" | "graphite" | "paper";

/** Where you are in Local: an added folder (or the top) and the folders below it. */
export type Place = { folderId: number | null; sub: string[] };

type State = {
  folders: Folder[];
  books: Book[];
  scan: ScanState;
  loaded: boolean;
  page: Page;
  place: Place;
  selectedId: number | null;
  sheetOpen: boolean;
  readingId: number | null;
  query: string;
  themePref: ThemePref;
  folded: boolean;
  dropping: boolean;
  reload: () => Promise<void>;
  setScan: (s: ScanState) => void;
  go: (page: Page) => void;
  goPlace: (p: Place) => void;
  select: (id: number | null, sheet?: boolean) => void;
  closeSheet: () => void;
  open: (id: number) => void;
  closeReader: () => void;
  setQuery: (q: string) => void;
  setThemePref: (t: ThemePref) => void;
  setFolded: (f: boolean) => void;
  setDropping: (d: boolean) => void;
};

export const useStore = create<State>((set, get) => ({
  folders: [],
  books: [],
  scan: { scanning: false, lastScan: null, done: 0, total: 0 },
  loaded: false,
  page: "local",
  place: { folderId: null, sub: [] },
  selectedId: null,
  sheetOpen: false,
  readingId: null,
  query: "",
  themePref: "system",
  folded: false,
  dropping: false,
  reload: async () => {
    const lib = await api.library();
    const { selectedId, place } = get();
    const stillThere = selectedId != null && lib.books.some((b) => b.id === selectedId);
    const placeOk = place.folderId == null || lib.folders.some((f) => f.id === place.folderId);
    set({
      folders: lib.folders,
      books: lib.books,
      scan: lib.scan,
      loaded: true,
      ...(stillThere ? {} : { selectedId: null, sheetOpen: false }),
      ...(placeOk ? {} : { place: { folderId: null, sub: [] } }),
    });
  },
  setScan: (scan) => set({ scan }),
  go: (page) => set({ page, sheetOpen: false, query: page === "local" ? get().query : "" }),
  goPlace: (place) => set({ place, page: "local", query: "" }),
  select: (id, sheet = true) => set({ selectedId: id, sheetOpen: id != null && sheet }),
  closeSheet: () => set({ sheetOpen: false }),
  open: (id) => set({ readingId: id, selectedId: id }),
  closeReader: () => {
    set({ readingId: null });
    get().reload();
  },
  setQuery: (query) => set({ query, page: "local" }),
  setThemePref: (themePref) => {
    set({ themePref });
    api.setSetting("theme", themePref);
  },
  setFolded: (folded) => {
    set({ folded });
    api.setSetting("sidebarFolded", folded ? "1" : "0");
  },
  setDropping: (dropping) => set({ dropping }),
}));
