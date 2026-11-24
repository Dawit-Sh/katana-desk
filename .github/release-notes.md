A reading dashboard on Local, Back on every page, Ctrl Z, quote cards, and pairing with Katana by its code alone.

## New in __VERSION__

- **A reading dashboard on Local.** "Pick up where you left off" sits at the top: the book you read last, large, with its chapter, your last note and the time left at your pace, the other books you have open beside it, and the ones gone quiet for two weeks (Set aside moves one off the band). Inside a folder it shows that folder's books. Folder cards are smaller and list the books you're reading in each, with how far you are. The author now shows under every cover. Hide folds the band to one line.
- **Back.** ← Back in the title bar, beside the sidebar button, goes back a step from anywhere: a folder, a Settings section, a list, a book's page, a search, a Journal day. Alt ← and your mouse's back button do the same (in a book, they take you back to where you were before a jump).
- **Ctrl Z undoes, Ctrl Y puts it back.** A removed highlight, note, bookmark or word, a highlight's colour, an edited note, a book's reading status, a list or a book taken off one, a changed cover, a folder taken off Local, a book set aside: each comes back with Ctrl Z, as many steps back as you like. A bar at the bottom says what changed and stays until your next change.
- **Share a highlight as an image**, as on the phone: on paper, dusk or teal, the book's cover colours, the book's cover itself, or a picture of your own (pick one or drop it on the window), blurred or sharp, square or tall. Save image puts it in Pictures\Katana; Copy image puts it on the clipboard to paste into a chat. It's on a highlight's card in a book and on a right-click in Bookmarks.
- **Scroll keeps going between chapters.** In Scroll mode the wheel and the touchpad carry on into the next chapter instead of stopping at a chapter's end.
- **Pairing with Katana by the code alone.** Sync on this Wi-Fi has its own page in Settings, with the code, the time it's good for, and this PC's address as Katana sees it. On the phone (Katana 1.3.0), Settings › Sources › Katana Desk finds this PC by itself, so you only type the code; a code that ran out or was wrong says so. After pairing, the book you're reading here comes to the phone, downloaded there if it isn't, and its place and marks keep in step both ways. A pill at the top of Local shows a sync while it runs and when it's done, and reading on the phone counts toward a book's time left here.
- Settings' boxes give their contents room on every side (the keyboard map, Cover size and Reading defaults ran into their edges).

## New in 0.3.0

- **The words graph.** My words has a Graph view beside the list: each book with the words you saved from it around it, and words that mean the same joined by a zigzag, across books too. Zoom out and the books become small rectangles, zoom in and they're covers again. Hover a word to light up its synonyms, click it for its meaning, sentence and reviews, Open in book or Review it. Pick one book to see its cover in the middle and its words round it. Play the links brings your words in the order you saved them.
- **Grimmory keeps up in the background**, whichever page is open, and catches up as soon as it's back after being away (it used to wait up to half an hour).
- **Reading statuses both ways.** A status changed on Grimmory's site or on your phone shows here (a book marked Unread there loses its place here too), and one set here while Grimmory is away goes up when it's back.
- **Signing in finds Grimmory on your network by itself**, tries again while the network wakes up, and says plainly what to check when nothing answers.
- Katana Desk never opens on Grimmory's sign-in when you only use Local books.

## New in 0.2.1

- The reading card no longer runs past its right edge (the progress bar, Journal › and the Less/More key spilled over on most screens). Its footer now reads "Goal 30 min" to fit; hover it for the whole goal.
- The word of the day's → button is round again and sits in line with Review and I know it.

## New in 0.2.0

- **Sync on this Wi-Fi.** Your Local books can now sync with Katana on your phone or tablet (Katana 1.2.0 or newer) whenever both are on the same Wi-Fi, no Grimmory server needed: reading place, status, highlights and bookmarks. Turn it on in Settings › Sync and backup, press Pair a device, and type the 6-digit code into Katana (Settings › Sources › Katana Desk). The first time you turn it on, Windows asks whether Katana Desk may use the network: Private networks is enough for home Wi-Fi.
- **A new sidebar.** What you're reading is at the top now: today's reading time, the book you're on, and your reading days as a calendar. Days are coloured by a daily goal (30 minutes, change it in Settings › Reading defaults or the Journal). Hover a day to see how long you read, click it to see that day in the Journal. A word from My words sits above Settings, with Review, I know it, and another word.
- A book you mark as Read keeps the day you finished it.

If you have 0.1.0 or newer, it offers this update by itself (or Settings › About › Check for updates).

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

Wiktionary's text is CC BY-SA 4.0 (through [wiktextract](https://github.com/tatuylonen/wiktextract) and kaikki.org), Open English WordNet is CC BY 4.0 (also inside the app, as the words graph's synonym index). Books are drawn by [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT), [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) and [DjVuLibre](https://djvu.sourceforge.net/) (GPL-2.0-or-later). Katana Desk itself is GPL-3.0-or-later.
