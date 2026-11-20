# DjVuLibre in Katana Desk

- **What:** `libdjvu` from DjVuLibre **3.5.28**: every `.cpp` and `.h` of its `libdjvu/` folder, plus the
  release's `COPYING`, `COPYRIGHT` and `README`. The same files as Katana on Android
  (`core/djvu/src/main/cpp/djvulibre` in https://github.com/Dawit-Sh/Katana).
- **From:** the release tarball `djvulibre-3.5.28.tar.gz`,
  <https://sourceforge.net/projects/djvu/files/DjVuLibre/3.5.28/>.
- **License:** GPL-2.0-or-later (see `COPYING` and `COPYRIGHT`), which Katana Desk's GPL-3.0-or-later can
  include.
- **Changes:** none. The files are the release's.

How it is built (`src-tauri/build.rs`, with the `cc` crate, on every platform):

- `../config.h` is hand-written and replaces the one `configure` generates. On Windows it lets DjVuLibre
  use its own Windows code (WINTHREADS, the Interlocked atomics, the Win32 file calls, `_wfopen` for
  Unicode paths); on Linux and macOS it is Katana Android's (POSIX threads, `stdint`/`inttypes`, wide
  characters, `mmap`). No JPEG library (so JPEG-encoded chunks, which are rare, are not decoded), no iconv.
- `DJVUAPI`, `DDJVUAPI` and `MINILISPAPI` are defined empty on the command line: it is linked statically,
  without DLL import or export markers.
- Every file of `libdjvulibre_la_SOURCES` (from `libdjvu/Makefile.am`) is compiled as C++14 (MSVC:
  `/std:c++14 /EHsc /utf-8`; gcc or clang: `-std=gnu++14 -fexceptions`; the code predates C++17:
  `GBitmap.h` still uses `register`), with warnings off for these files.
- It links into the app together with `../katana_djvu.cpp`, a small C API over the public `ddjvuapi.h`
  (open, page sizes, drawing a page, the hidden text, the outline) that `src-tauri/src/pages.rs` calls.
- On Linux it needs a C++ compiler (`g++` or `clang++`, from `build-essential`) and links `pthread`.

To update: replace the files here with a newer release's `libdjvu/*.cpp`, `libdjvu/*.h` and the three text
files, compare its `libdjvulibre_la_SOURCES` with the list in `build.rs` and its `config/config.h.in` with
`../config.h`, and update this note.
