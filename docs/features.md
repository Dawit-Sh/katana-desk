# Katana Desk, in detail

Everything the app does, part by part, with the bits that matter if you want to change the code.

## The window and Local folders

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

## Grimmory

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

## Reading

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

## Highlights and notes

- Select words and the selection card shows above them: Highlight, Note, Copy, Look up, and five colour dots. One click on a dot highlights in that colour and the last style.
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

## Words

- Full dictionaries built in and offline: English Wiktionary (from [wiktextract](https://github.com/tatuylonen/wiktextract)'s
  data on [kaikki.org](https://kaikki.org), CC BY-SA 4.0) and [Open English WordNet](https://github.com/globalwordnet/english-wordnet)
  (CC BY 4.0). They come down on the first look up (about 138 MB and 21 MB), with progress, Pause and Go on; a download
  goes on where it stopped after a cut connection or a restart, and each file is checked against its SHA-256 before it's
  used. Settings › Dictionaries shows them, removes them, and has the address they come from.
- Your own StarDict dictionaries (`.ifo` with its `.idx` and `.dict` or `.dict.dz`, `.syn` too) are read where they are and
  get their own tab. Their HTML is shown as plain text.
- The word card: double-click a word, or select words and press L (or Look up). Each dictionary that knows the word has a
  tab: senses with examples, pronunciation, origin, similar words (a click looks them up, with a way back) and the sentence
  from the book with the word set apart. A form finds its headword ("geese" goose, "clutching" clutch, "ran" run). Save to My
  words, Full entry, and a small button that looks the word up on Wiktionary online. Lookups take a few milliseconds.
- My words, in the sidebar and as the Words tab of the marks panel: each word with its meaning from the built-in
  dictionary, the sentence it was met in, the book and page; search, a book filter, the full entry and a note per word, a
  way back to the sentence, Take out with Undo, and Markdown export.
- Review cards: the word and its sentence, then its meaning (Space); 1 Again, 2 I know it. Katana's schedule: a word known
  comes back after 1, 3, 7, 14, then 30 days; Again brings it back later in the same round.
- The learning numbers for the Journal (milestone 7) are kept from now on: words learned (known at the 7-day step), reviews
  and first-try answers, words looked up, and highlights, notes, bookmarks and words gone back to from a list.

The dictionary files are made once by `tools/build-dictionary.py` (see its notes) and published with the app's releases.

## PDF, DjVu and comics

- PDFs, DjVu books and comics (CBZ, and CBR) open in a page view: each page drawn sharp for the size it's shown at,
  only the pages near the screen drawn.
- The top bar has zoom (out, the percentage, in; Ctrl + / Ctrl − / Ctrl 0, Ctrl and the wheel), and pictures for how the
  page fits (Fit width, Fit page) and how pages are laid out (Scroll, One page, Two pages, the first page and wide pages
  alone, like a printed book). Comics also have Left to right and Right to left (manga), and Scroll for webtoons. The
  choice is kept per book, and the last one is where a new book starts.
- A side panel with three tabs: Pages (every page small, drawn as it scrolls into view, with its find matches and a
  ribbon on bookmarked pages), Contents (the PDF's or DjVu's outline, the part you're in lit up) and Marks (the same
  marks list as EPUB: highlights, notes, bookmarks, words, export). It floats over the page, or docks with the pin.
- Find (Ctrl F) in a PDF's text and a DjVu's hidden text: every match is marked on the page, a counter ("2 of 14"),
  Enter and Shift Enter, and the matches per page in Pages. The first match is the next one from the page you're on.
- Select words (an invisible text layer lies over the page) and the selection card shows: highlights in five colours
  and four styles (highlight, underline, strike, squiggle), notes, Copy and Look up (the word card from milestone 5;
  a double-click on a word looks it up too). A highlight with a note gets a pin on the page; click it, or the highlight,
  for its card. The highlighter in the top bar highlights words as soon as they're selected. They're kept in the same
  highlights table as EPUB, placed by page and the words' place in the page's text (`page:12:340-388`).
- Bookmarks: Ctrl B, the corner of any page, or the ribbon button; the ribbon hangs on marked pages. "Back to p. N"
  after any jump (contents, pages, find, a mark, the slider). Keys: arrows, Space, Page Up/Down, Home, End.
- The reading place is saved by page. For Grimmory books and Local copies of them, PDF and comic places sync with
  Grimmory by page (`pdfProgress` and `cbxProgress`, pages from 1), and bookmarks sync both ways the way Grimmory's own
  readers keep them: a PDF's in `pageNumber`, a comic's page in `cfi`, unnamed ones going up as "Page 12". PDF and DjVu
  highlights stay on this PC (Grimmory's PDF reader keeps its own annotations in another shape). DjVu books come from
  Local folders only (Grimmory has no DjVu).
- Library covers for PDFs (their first page, drawn by PDF.js in the background, once per book), DjVu books (their
  first page, drawn by DjVuLibre) and CBR comics.
- DjVuLibre 3.5.28 is compiled into the app from source with the `cc` crate (MSVC on Windows, g++ or clang++ on Linux):
  see `src-tauri/djvu/djvulibre/KATANA.md`. A CBR that is really a ZIP opens directly; a RAR one is unpacked once into
  the app's data folder by bsdtar (Windows' own `tar.exe` reads RAR), or unrar, 7-Zip or unar on Linux.

## Journal, search and the rest

- **Journal**: the whole year of reading days (a square a day, darker the longer you read), the streak, this week, this
  year and books finished, the books of the week, month or year (time, days, highlights and bookmarks made, how far, a
  click opens one), and three charts: the days of the week you read (on average), the hours each month, and pages an
  hour week by week. Beside them: your words (learned, learning, new, reviews, the share remembered on the first try,
  Review), going back to your highlights (times this year, notes reread, highlights edited, the most revisited) and the
  hours of the day you read. Counted from the reader's 15-second ticks, which now keep the book, the hour and the pages
  turned (EPUB and the page view alike). Export writes the year as Markdown.
- **Ctrl K, search everything**, anywhere (a book open too): books here and on Grimmory, authors, highlights, notes,
  bookmarks and My words, in every format (EPUB, MOBI, PDF, DjVu, comics). ↑ ↓ move, Enter opens (a mark opens the book
  at it, and counts as going back to it in the Journal), Ctrl Enter opens a book in a window of its own. Type `>` for
  commands (go to a page, the keyboard map, add a folder, a theme, sync now).
- **Settings**, a section at a time: General (what Katana Desk opens on, the app's size), Appearance (eight themes drawn
  as little windows: Follow Windows, Graphite, Paper, Sepia Reading, OLED Reader, High Contrast, Blueprint, Detective
  File; cover size in the library; glass sidebar), Reading defaults (the Aa panel for books without their own),
  Sources (Grimmory, Local folders), Dictionaries, Sync and backup (what syncs, Sync now, a backup of the whole library
  file, every book's marks as Markdown), Keyboard, About (credits and licences).
- **Lists**: your own reading lists, Local and Grimmory books together, from a book's page (Add to a list), a cover's
  right-click menu, or the Lists page (new, rename, remove with Undo, take a book off).
- **Change cover**, from the button on the cover in a book's page or a cover's right-click menu: Grimmory's cover (at
  full size), the book's own cover or its first page (PDF by PDF.js; DjVu and comics), your own picture (drop it, paste
  it with Ctrl V, or choose a file) or Open Library covers found by title and author
  ([Open Library](https://openlibrary.org/dev/docs/api/covers)). Move and zoom it in a 2:3 frame, see it in the library
  and on the reading card, or go Back to the original. Custom covers are saved on this PC (600 by 900 JPEG); Grimmory's
  covers are never touched.
- **The keyboard map**: `?` or Ctrl / anywhere, and in Settings › Keyboard.
- **A second window**: Ctrl+click a cover, a mark or a search result (or Open in a new window from a cover's menu) and
  the book opens in a window of its own; closing the book closes that window. One window stays the default.
- **MOBI, AZW and AZW3 covers**, titles and authors are read from the file (its EXTH header and image records).
- Outside a book, Ctrl + and Ctrl − change the app's size.

## Keys

| Where | Keys |
|---|---|
| Anywhere | Ctrl K search everything · ? or Ctrl / the keyboard map · Ctrl O open a file · Ctrl , settings · Ctrl + / Ctrl − / Ctrl 0 app size (outside a book) · F11 full screen |
| Library | Arrows move between covers · Space or a click shows the book's page · Enter or a double-click opens it · Ctrl+click opens it in a new window · right-click for its menu · Esc closes the page |
| Reading | → Space Page Down next · ← Page Up previous · the wheel · a click in the outer fifth · Ctrl B bookmark · Ctrl F search · Alt ← back to where you jumped from · Ctrl + / Ctrl − / Ctrl 0 text size · a double-click on a word looks it up · Esc closes a card, note or panel, then the book |
| PDF, DjVu, comics | ↓ ↑ scroll, then turn · → ← the next or previous page (swapped right to left) · Space Page Down Page Up a screen or a page · Home End · Ctrl + / Ctrl − zoom, Ctrl 0 fits again, Ctrl and the wheel · Ctrl F find · Ctrl B bookmark · Alt ← back |
| Review cards | Space shows the meaning · 1 Again · 2 I know it · Esc closes |
| Words selected | H highlight · 1 to 5 in that colour · N with a note · C copy · L look up · Esc lets go |
| A highlight's card | Delete removes it · Esc closes it |
