The first Katana Desk: a reader for EPUB, MOBI, AZW3, FB2, PDF, DjVu and comics that keeps your reading place, highlights and bookmarks in sync with Grimmory, with offline dictionaries built in.

## Which file do I want?

- **Windows:** `Katana.Desk___VERSION___x64-setup.exe`. It installs just for you, no admin needed. Windows may warn that the file isn't common yet: More info, then Run anyway.
- **Linux, any distro:** the `.AppImage`. Make it runnable (`chmod +x`) and open it. This one updates itself.
- **Debian, Ubuntu, Mint:** the `.deb` (`sudo apt install ./Katana.Desk___VERSION___amd64.deb`).
- **Fedora, openSUSE:** the `.rpm`.

The Windows build and the AppImage check for updates once a day and ask before installing. The .deb and .rpm show when a new version is out and link here.

## Good to know

- On Linux, RAR comics (.cbr) need `bsdtar` (the `libarchive-tools` package), `unrar`, `7z` or `unar`. The .deb and .rpm suggest it. CBZ and every other format need nothing extra.
- The dictionaries (English Wiktionary and Open English WordNet, about 160 MB together) download the first time you look a word up, then work offline. They come from the [dictionaries-1](https://github.com/Dawit-Sh/katana-desk/releases/tag/dictionaries-1) release.

## Credits

Wiktionary's text is CC BY-SA 4.0 (through [wiktextract](https://github.com/tatuylonen/wiktextract) and kaikki.org), Open English WordNet is CC BY 4.0. Books are drawn by [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT), [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) and [DjVuLibre](https://djvu.sourceforge.net/) (GPL-2.0-or-later). Katana Desk itself is GPL-3.0-or-later.
