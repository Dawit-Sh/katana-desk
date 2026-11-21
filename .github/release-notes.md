A fix for the new sidebar: the reading card and the word of the day now stay inside it.

## New in __VERSION__

- The reading card no longer runs past its right edge (the progress bar, Journal › and the Less/More key spilled over on most screens). Its footer now reads "Goal 30 min" to fit; hover it for the whole goal.
- The word of the day's → button is round again and sits in line with Review and I know it.

## New in 0.2.0

- **Sync on this Wi-Fi.** Your Local books can now sync with Katana on your phone or tablet (Katana 1.2.0 or newer) whenever both are on the same Wi-Fi, no Grimmory server needed: reading place, status, highlights and bookmarks. Turn it on in Settings › Sync and backup, press Pair a device, and type the 6-digit code into Katana (Settings › Sources › Katana Desk). The first time you turn it on, Windows asks whether Katana Desk may use the network: Private networks is enough for home Wi-Fi.
- **A new sidebar.** What you're reading is at the top now: today's reading time, the book you're on, and your reading days as a calendar. Days are coloured by a daily goal (30 minutes, change it in Settings › Reading defaults or the Journal). Hover a day to see how long you read, click it to see that day in the Journal. A word from My words sits above Settings, with Review, I know it, and another word.
- A book you mark as Read keeps the day you finished it.

If you have 0.1.0 or 0.2.0, it offers this update by itself (or Settings › About › Check for updates).

## Katana Desk

A reader for EPUB, MOBI, AZW3, FB2, PDF, DjVu and comics that keeps your reading place, highlights and bookmarks in sync with Grimmory, with offline dictionaries built in.

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
