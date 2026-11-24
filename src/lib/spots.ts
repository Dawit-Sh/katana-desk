// Back's rules, kept free of the app so `npm test` can check them: where you are (a "spot"), when a move
// is a new step, and the line beside the Back button. The steps themselves live in the store (store.ts).
import type { Catalog, List } from "./api";
import type { GFilter, Page, Place } from "./store";

/**
 * Where you are, as Back sees it: the page and what's open on it. One of these is kept for every step you
 * take (a page, a folder, a Settings section, a list, a book's page, a search, a Journal day), and Back
 * goes to the one before.
 */
export type Spot = {
  page: Page;
  place: Place;
  journalDay: string | null;
  settingsAt: string | null;
  query: string;
  sheetOpen: boolean;
  selectedId: number | null;
  gSheet: boolean;
  gSelected: number | null;
  gFilter: GFilter;
  listSel: number | null;
};
/** A step Back can undo: a spot to go back to, or a panel to close (`key` names it, so it can leave by itself). */
export type BackStep = { spot: Spot } | { key: string; close: () => void };

/** The spot `s` is at. */
export function spotOf(s: Spot): Spot {
  return {
    page: s.page,
    place: s.place,
    journalDay: s.journalDay,
    settingsAt: s.settingsAt,
    query: s.query,
    sheetOpen: s.sheetOpen,
    selectedId: s.selectedId,
    gSheet: s.gSheet,
    gSelected: s.gSelected,
    gFilter: s.gFilter,
    listSel: s.listSel,
  };
}

/** Whether two spots look the same to you (a book's page open or not, not which book; a search or not, not its words). */
export function sameSpot(a: Spot, b: Spot): boolean {
  return (
    a.page === b.page &&
    a.place.folderId === b.place.folderId &&
    a.place.sub.join("/") === b.place.sub.join("/") &&
    a.journalDay === b.journalDay &&
    (a.settingsAt ?? "") === (b.settingsAt ?? "") &&
    (a.query === "") === (b.query === "") &&
    // a book's page counts while it's open; moving it to another book (the arrow keys) is the same spot
    a.sheetOpen === b.sheetOpen &&
    a.gSheet === b.gSheet &&
    a.gFilter.kind === b.gFilter.kind &&
    a.gFilter.id === b.gFilter.id &&
    a.gFilter.status === b.gFilter.status &&
    a.listSel === b.listSel
  );
}

/** At most this many steps are kept. */
export const MAX_STEPS = 100;

/**
 * The next steps after moving from `from` to `to`: a step back to `from`, unless nothing you'd see changed,
 * or the move went back to the spot of the newest step by another way (closing a book's page, clearing a
 * search), which takes that step off instead.
 */
export function stepsAfterMove(steps: BackStep[], from: Spot, to: Spot): BackStep[] {
  if (sameSpot(from, to)) return steps;
  const top = steps[steps.length - 1];
  if (top && "spot" in top && sameSpot(top.spot, to)) return steps.slice(0, -1);
  return [...steps, { spot: from }].slice(-MAX_STEPS);
}

const PAGE_NAMES: Record<Spot["page"], string> = {
  grimmory: "Grimmory",
  local: "Local",
  lists: "Lists",
  bookmarks: "Bookmarks",
  words: "My words",
  journal: "Journal",
  settings: "Settings",
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-22" as "22 November 2026". */
export function dayName(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return m && d ? `${d} ${MONTHS[m - 1]} ${y}` : day;
}

/** What's around you, for the line beside Back. */
export type Around = {
  sections: { id: string; name: string }[];
  lists: List[];
  catalog: Catalog;
  /** the title of the book whose page is open, if one is */
  bookTitle: string | null;
};

/**
 * Where you are, as the line beside Back says it: "Settings › Keyboard", "Lists › To read", "Journal › 22
 * November 2026", "Grimmory › Fiction › Search". Local shows its own folder path, so it says nothing more.
 */
export function whereYouAre(s: Spot, a: Around): string[] {
  const parts = [PAGE_NAMES[s.page]];
  if (s.page === "settings") {
    const sec = a.sections.find((x) => x.id === s.settingsAt) ?? a.sections[0];
    if (sec) parts.push(sec.name);
  } else if (s.page === "lists") {
    const l = a.lists.find((x) => x.id === s.listSel) ?? a.lists[0];
    if (l) parts.push(l.name);
  } else if (s.page === "journal" && s.journalDay) {
    parts.push(dayName(s.journalDay));
  } else if (s.page === "grimmory") {
    const f = s.gFilter;
    const name =
      f.kind === "library"
        ? a.catalog.libraries.find((x) => x.id === f.id)?.name
        : f.kind === "shelf" || f.kind === "magic"
          ? a.catalog.shelves.find((x) => x.id === f.id)?.name
          : undefined;
    if (name) parts.push(name);
    if (s.query) parts.push("Search");
  } else if (s.page === "local") {
    // Local shows its own folder path; the line names only a search or an open book's page
    const local = s.query ? ["Local", "Search"] : ["Local"];
    if (s.sheetOpen && a.bookTitle) return [...local, a.bookTitle];
    return s.query ? local : [];
  }
  if (s.page === "grimmory" && s.gSheet && a.bookTitle) parts.push(a.bookTitle);
  return parts;
}
