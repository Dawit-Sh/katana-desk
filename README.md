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

## Keys

| Where | Keys |
|---|---|
| Anywhere | Ctrl K search · Ctrl O open a file · Ctrl , settings · F11 full screen |
| Library | Arrows move between covers · Space or a click shows the book's page · Enter or a double-click opens it · Esc closes the page |
| Reading | → Space Page Down next · ← Page Up previous · the wheel · a click in the outer fifth · Esc back to the library |

## Build

Needs [Rust](https://rustup.rs), [Node.js](https://nodejs.org) LTS and the Visual Studio C++ Build Tools.

```
npm install
npm run tauri dev      # run while working on it
npm run tauri build    # installer in src-tauri/target/release/bundle/nsis
```

## License

GPL-3.0-or-later, like Katana. See `LICENSE`.
