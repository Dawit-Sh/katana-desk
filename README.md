# Katana Desk

The desktop version of [Katana](https://github.com/Dawit-Sh/Katana) (刀), a reader that syncs with Grimmory. Windows first.

Built with [Tauri 2](https://github.com/tauri-apps/tauri), React and TypeScript ([Vite](https://github.com/vitejs/vite)), and
[foliate-js](https://github.com/johnfactotum/foliate-js) for EPUB, MOBI, AZW3, FB2 and CBZ.

## Milestone 1: Shell and Local

- Katana's own 48 px title bar (decorations off): fold button, the ink katana, "Katana 刀", search, Windows-shaped 46 px
  caption buttons. Hold the mouse on Maximise for Windows' Snap layouts
  ([tauri-plugin-decorum](https://github.com/clearlysid/tauri-plugin-decorum)). Mica behind the title bar and sidebar
  (Tauri's window effects, [window-vibrancy](https://github.com/tauri-apps/window-vibrancy)). Drag empty parts of the bar to
  move the window, double-click to maximise. The window shows only once drawn, so no white flash.
- The sidebar (248 px) folds to an 80 px rail by its button or under 1200 px wide; under 840 px it is a drawer.
- Themes from Katana's tokens: Paper when Windows is light, Graphite when dark (Settings can fix one).
- Local: add folders; they are scanned at start and watched while open ([notify](https://github.com/notify-rs/notify)),
  shown as folders with two real covers peeking out, with a path (Books › Nonfiction) and a "Folders up to date" pill.
  Drop files or folders anywhere, or Add books. Everything lives in SQLite ([rusqlite](https://github.com/rusqlite/rusqlite))
  in the app's data folder. Books are read where they are: nothing is ever moved, renamed or deleted.
- The covers grid at Large size with real covers from the books. One click shows the book's page at the side (400 px),
  double-click or Enter opens it.
- Reading: arrows, Space, Page Up/Down, the wheel and clicks in the outer fifth turn pages; the chapter on top, the page
  and pages left in the chapter below; the reading place is remembered.

## Milestone 2: Grimmory

- Sign in to [Grimmory](https://github.com/grimmory-tools/grimmory) from the Grimmory page (or Settings › Sources, where the
  server address can be changed). The password goes to Grimmory once and is never kept; the sign-in renews itself through
  one path, one renewal at a time, saved the moment it arrives (Grimmory replaces the refresh token on every renewal).
- The whole library comes down once, page by page (Grimmory's app API, 50 books a page, six pages at a time) into SQLite,
  showing as it arrives. Later starts fetch only what changed: new books, reading places that moved elsewhere, books that
  went away, and once a day a full pass for changed titles and covers. Libraries, shelves and magic shelves come too, as
  filters, with sorting (last read, added, title, author), covers or list, and search over title, author, series and tags.
- Covers are fetched once at full size, made library-sized and kept on this PC (`kcover://`).
- Downloads pause and go on where they stopped (HTTP Range with `If-Range`, partial bytes kept apart until the file is
  whole). They wait for silence, never for a total time; a lost connection waits for Grimmory and goes on by itself;
  Try again checks Grimmory at once.
- The reading place syncs both ways for Grimmory books and for Local copies of the same file (matched by KOReader's partial
  MD5, read from Grimmory as twelve 1 KB samples): it goes up a few seconds after a page turn and when the book closes, and
  a book opens at Grimmory's place when that's the latest read. A place behind this PC's is asked about first ("Go there" or
  "Stay here"). A time without a zone is never compared with this PC's clock.
- One slow reply never shows Grimmory offline (a second look 1.5 s later); offline, it looks again after 2, 4, 8, 16 and
  then every 30 minutes, and places waiting go up when it's back.

Sync lives in Rust (`src-tauri/src/grimmory/`, [reqwest](https://github.com/seanmonstar/reqwest)); the place rules are in
`place.rs` with their tests (`cargo test`).

## Milestone 3: Reading view

- The top bar and the pill bar float over the page and fade after 2 s of a still mouse; the first move brings them back.
  They stay while a floating panel, a footnote or Grimmory's question is open.
- Panels float over the page (Contents and Search on the left, Bookmarks and Reading settings on the right). The pin docks
  one beside the page and the page moves over; a pinned side stays pinned for every book. A window too narrow to dock keeps
  it floating.
- Pages: Auto (two pages when the page has 1200 px of room, else one), One, Two or Scroll.
- Contents with each chapter's page (the printed page when the book has a page list), the chapter you're in lit up,
  nested parts folding.
- Search in the book: every match marked on the pages, a counter ("3 of 42"), Enter and Shift Enter for the next and
  previous, the matches listed by chapter.
- Reading settings (Aa), per book, with "Save as default" for books without their own: font (the book's own, Noto Serif,
  Literata, Source Serif, Manrope, Atkinson Hyperlegible, all bundled), size, line spacing, alignment, margins,
  hyphenation, the book's own styles on or off, page colours (as the app, Paper, Sepia, Grey, Dusk, Black), the layout,
  and footnotes in a pop-up or followed. Every choice with a look is drawn as a little picture of the result.
- Footnotes open in a pop-up over the page, with "Go to the note".
- Bookmarks: Ctrl B, a click on the page's top corner or the ribbon button; the ribbon hangs on a marked page. The marks
  panel lists them with their page, chapter and first words, searchable, with the place you are between them.
  They are kept in SQLite shaped for Grimmory sync in milestone 4 (local book id, uuid, remote id and CFI, sync state,
  a tombstone for removals Grimmory has to hear about).
- "Back to p. N" after any jump (contents, search, a link, the slider, a bookmark, a footnote's "Go to the note");
  it flips, so you can hop between the two places.
- The reading place keeps syncing with Grimmory as in milestone 2; a jump counts as reading.

## Milestone 4: Highlights and notes

- Select words and the selection card shows above them: Highlight, Note, Copy, Look up (the built-in dictionary comes in
  milestone 5), and five colour dots. One click on a dot highlights in that colour and the last style.
- Four styles: highlight, underline, strike and squiggle, drawn by foliate-js's overlayer. On dark pages a highlight
  lightens the words under it.
- Click a highlight for its card: the styles as little pictures in its colour, the colours, its note (click to write,
  Enter saves), Copy, and Delete with Undo.
- The marks panel ("Marks in this book"): All, Highlights, Notes and Bookmarks, in reading order under their chapters,
  with "You're here", search, previous and next mark, names and notes for bookmarks right in the list, and Export Markdown.
- The Bookmarks page: every book with marks, a search across every mark of every book, and the picked book's marks; a mark
  opens the book there.
- Markdown export of a book's bookmarks (names, first words, notes) and highlights (under their chapters, with notes).
- Highlights and bookmarks sync both ways with Grimmory for EPUBs (`/api/v1/annotations`, `/api/v1/bookmarks`, names and
  notes), sharing them with Grimmory's web reader and KOReader. foliate-js's CFIs are the web reader's own, so places go
  across as they are. The last change wins with a 2-minute margin, a removal on one side removes it on the other unless
  it was changed there later, a lost answer is matched by place instead of sent twice, and a server that suddenly lacks
  most of a book's marks is asked about instead of believed. Grimmory's zone-less times are never compared with this PC's
  clock: they are first put on it with the server's own "now". MOBI, AZW3, FB2 and CBZ marks stay on this PC.

## Keys

| Where | Keys |
|---|---|
| Anywhere | Ctrl K search · Ctrl O open a file · Ctrl , settings · F11 full screen |
| Library | Arrows move between covers · Space or a click shows the book's page · Enter or a double-click opens it · Esc closes the page |
| Reading | → Space Page Down next · ← Page Up previous · the wheel · a click in the outer fifth · Ctrl B bookmark · Ctrl F search · Alt ← back to where you jumped from · Ctrl + / Ctrl − / Ctrl 0 text size · Esc closes a card, note or panel, then the book |
| Words selected | H highlight · 1 to 5 in that colour · N with a note · C copy · L look up · Esc lets go |
| A highlight's card | Delete removes it · Esc closes it |

## Build

Needs [Rust](https://rustup.rs), [Node.js](https://nodejs.org) LTS and the Visual Studio C++ Build Tools.

```
npm install
npm run tauri dev      # run while working on it
npm run tauri build    # installer in src-tauri/target/release/bundle/nsis
```

## License

GPL-3.0-or-later, like Katana. See `LICENSE`.
