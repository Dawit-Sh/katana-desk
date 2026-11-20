import { create } from "zustand";
import { api, covers, grimmory, lists, type Book, type Catalog, type Dl, type Folder, type GBook, type GStatus, type List, type ScanState } from "./api";

export type Page = "grimmory" | "local" | "lists" | "bookmarks" | "words" | "journal" | "settings";
export type ThemePref = "system" | "graphite" | "paper" | "sepia" | "oled" | "contrast" | "blueprint" | "detective";
export type CoverSize = "s" | "m" | "l";
/** The book Change cover is open for. `key`: `b:<local id>` or `g:<Grimmory id>`. */
export type CoverTarget = { key: string; bookId: number | null; grimmoryId: number | null; title: string; author: string | null; format: string };

/** Where you are in Local: an added folder (or the top) and the folders below it. */
export type Place = { folderId: number | null; sub: string[] };

export type GSort = "lastRead" | "added" | "title" | "author";
/** Which Grimmory books show: all, a library, a shelf or magic shelf, and how far read. */
export type GFilter = { kind: "all" | "library" | "shelf" | "magic"; id?: number; status: "any" | "reading" | "unread" | "read" };

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
  /** a place to open the book at (a mark picked on the Bookmarks page) */
  openAt: string | null;
  query: string;
  themePref: ThemePref;
  folded: boolean;
  dropping: boolean;
  g: GStatus | null;
  catalog: Catalog;
  downloads: Record<number, Dl>;
  gSelected: number | null;
  gSheet: boolean;
  gSort: GSort;
  gFilter: GFilter;
  gView: "grid" | "list";
  /** a Grimmory book to open as soon as its download is done */
  openWhenHere: number | null;
  reload: () => Promise<void>;
  reloadCatalog: () => Promise<void>;
  setG: (g: GStatus) => void;
  setDownload: (d: Dl) => void;
  gSelect: (id: number | null, sheet?: boolean) => void;
  setGSort: (s: GSort) => void;
  setGFilter: (f: GFilter) => void;
  setGView: (v: "grid" | "list") => void;
  /** opens a Grimmory book: right away when it's on this PC, else once it's downloaded */
  openG: (id: number) => void;
  setScan: (s: ScanState) => void;
  go: (page: Page) => void;
  goPlace: (p: Place) => void;
  select: (id: number | null, sheet?: boolean) => void;
  closeSheet: () => void;
  open: (id: number, at?: string | null) => void;
  closeReader: () => void;
  setQuery: (q: string) => void;
  setThemePref: (t: ThemePref) => void;
  setFolded: (f: boolean) => void;
  setDropping: (d: boolean) => void;
  // milestone 7
  /** custom covers on this PC: book key -> picture file */
  customCovers: Record<string, string>;
  loadCovers: () => Promise<void>;
  lists: List[];
  loadLists: () => Promise<void>;
  palette: boolean;
  setPalette: (p: boolean) => void;
  keymap: boolean;
  setKeymap: (k: boolean) => void;
  coverFor: CoverTarget | null;
  setCoverFor: (t: CoverTarget | null) => void;
  coverSize: CoverSize;
  setCoverSize: (c: CoverSize) => void;
  /** a book's window of its own: no library, the reader only */
  bookWindow: boolean;
  /** the right-click menu of a cover */
  menu: BookMenuAt | null;
  setMenu: (m: BookMenuAt | null) => void;
};
export type BookMenuAt = { x: number; y: number; local?: Book; g?: GBook };

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
  openAt: null,
  query: "",
  themePref: "system",
  folded: false,
  dropping: false,
  g: null,
  catalog: { books: [], libraries: [], shelves: [] },
  downloads: {},
  gSelected: null,
  gSheet: false,
  gSort: "lastRead",
  gFilter: { kind: "all", status: "any" },
  gView: "grid",
  openWhenHere: null,
  reloadCatalog: async () => {
    const catalog = await grimmory.catalog();
    const { gSelected } = get();
    const still = gSelected == null || catalog.books.some((b) => b.id === gSelected);
    set({ catalog, ...(still ? {} : { gSelected: null, gSheet: false }) });
  },
  setG: (g) => set({ g }),
  setDownload: (d) => {
    const downloads = { ...get().downloads };
    if (d.state === "none") delete downloads[d.bookId];
    else downloads[d.bookId] = d;
    set({ downloads });
    if (d.state === "done" && d.localId != null && get().openWhenHere === d.bookId) {
      const localId = d.localId;
      set({ openWhenHere: null });
      get().reload().then(() => get().open(localId));
    }
  },
  gSelect: (id, sheet = true) => set({ gSelected: id, gSheet: id != null && sheet }),
  setGSort: (gSort) => {
    set({ gSort });
    api.setSetting("grimmorySort", gSort);
  },
  setGFilter: (gFilter) => set({ gFilter }),
  setGView: (gView) => {
    set({ gView });
    api.setSetting("grimmoryView", gView);
  },
  openG: (id) => {
    const b = get().catalog.books.find((x) => x.id === id);
    if (b?.localId != null && get().books.some((x) => x.id === b.localId)) return get().open(b.localId);
    set({ openWhenHere: id });
    grimmory.download(id, true);
  },
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
  go: (page) =>
    set({ page, sheetOpen: false, gSheet: false, query: page === "local" || page === "grimmory" ? get().query : "" }),
  goPlace: (place) => set({ place, page: "local", query: "" }),
  select: (id, sheet = true) => set({ selectedId: id, sheetOpen: id != null && sheet }),
  closeSheet: () => set({ sheetOpen: false }),
  open: (id, at = null) => set({ readingId: id, selectedId: id, openAt: at }),
  closeReader: () => {
    set({ readingId: null, openAt: null });
    get().reload();
  },
  // the search covers the source you're in (Grimmory or Local); from other pages, Grimmory when signed in
  setQuery: (query) => {
    const { page, g } = get();
    set({ query, page: page === "local" || page === "grimmory" ? page : g?.signedIn ? "grimmory" : "local" });
  },
  setThemePref: (themePref) => {
    set({ themePref });
    api.setSetting("theme", themePref);
  },
  setFolded: (folded) => {
    set({ folded });
    api.setSetting("sidebarFolded", folded ? "1" : "0");
  },
  setDropping: (dropping) => set({ dropping }),
  customCovers: {},
  loadCovers: async () => {
    const list = await covers.custom();
    set({ customCovers: Object.fromEntries(list.map((c) => [c.key, c.path])) });
  },
  lists: [],
  loadLists: async () => set({ lists: await lists.all() }),
  palette: false,
  setPalette: (palette) => set({ palette }),
  keymap: false,
  setKeymap: (keymap) => set({ keymap }),
  coverFor: null,
  setCoverFor: (coverFor) => set({ coverFor }),
  coverSize: "l",
  setCoverSize: (coverSize) => {
    set({ coverSize });
    document.documentElement.dataset.covers = coverSize;
    api.setSetting("library.coverSize", coverSize);
  },
  bookWindow: false,
  menu: null,
  setMenu: (menu) => set({ menu }),
}));

// dev builds only: lets test runs over the debug port open a book by id
if (import.meta.env.DEV) (window as unknown as { __katana: unknown }).__katana = { open: (id: number, at?: string | null) => useStore.getState().open(id, at ?? null) };
