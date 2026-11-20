/*
 * config.h for building DjVuLibre 3.5.28 (libdjvu only) inside Katana Desk with the `cc` crate,
 * on Windows (MSVC) and on Linux or macOS (gcc or clang). Written by hand in place of the one
 * `configure` generates from config/config.h.in; the Unix half is the same as Katana's Android one.
 *
 * Not available on purpose: the IJG JPEG library (HAVE_JPEG stays undefined, so JPEG-encoded
 * chunks, which are rare, are not decoded), iconv, and libtiff.
 */

#ifndef CONFIG_H
#define CONFIG_H

/* Version and package strings */
#define DJVULIBRE_VERSION "3.5.28"
#define PACKAGE "djvulibre"
#define PACKAGE_NAME "djvulibre"
#define PACKAGE_STRING "djvulibre 3.5.28"
#define PACKAGE_TARNAME "djvulibre"
#define PACKAGE_VERSION "3.5.28"
#define PACKAGE_BUGREPORT ""
#define PACKAGE_URL ""
#define VERSION "3.5.28"

/* DjVuMessage looks for translated message files under DIR_DATADIR/djvu/osi. The app ships none,
   so this only needs to be a path that does not exist. */
#ifndef DIR_DATADIR
#define DIR_DATADIR "/nonexistent"
#endif

/* Linked statically into the app: build.rs defines DJVUAPI, DDJVUAPI and MINILISPAPI as empty on the
   command line, so no DLL import or export markers. */

/* Compiler: modern C++ with exceptions, namespaces and the standard headers */
#define HAVE_BOOL 1
#define HAVE_EXCEPTIONS 1
#define HAVE_NAMESPACES 1
#define HAVE_STDINCLUDES 1
#define HAVE_TYPENAME 1
#define HAVE_MEMBER_TEMPLATES 1
#define HAVE_LONG_LONG_INT 1

/* Headers every platform has */
#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1

/* Wide characters */
#define HAVE_WCHAR_H 1
#define HAVE_WCHAR_T 1
#define HAVE_WCTYPE_H 1
#define HAVE_ISWSPACE 1
#define HAVE_MBSTATE_T 1
#define HAVE_WCRTOMB 1

#define HAVE_STRERROR 1
#define HAVE_STRFTIME 1
#define HAVE_VSNPRINTF 1

#if defined(_WIN32)
/* Windows: DjVuLibre's own Windows code (GThreads picks WINTHREADS, atomic.h the Interlocked
   functions, GOS and GURL the Win32 file calls). No POSIX headers, no mmap. */
# ifndef WIN32_LEAN_AND_MEAN
#  define WIN32_LEAN_AND_MEAN 1
# endif
# ifndef NOMINMAX
#  define NOMINMAX 1
# endif
# ifndef _CRT_SECURE_NO_WARNINGS
#  define _CRT_SECURE_NO_WARNINGS 1
# endif
#else
/* Linux, macOS: POSIX threads and the usual headers */
# define HAVE_PTHREAD 1
# if defined(__GNUC__) || defined(__clang__)
#  define HAVE_INTEL_ATOMIC_BUILTINS 1
# endif
# define HAVE_SCHED_H 1
# define HAVE_SCHED_YIELD 1
# define HAVE_STRINGS_H 1
# define HAVE_UNISTD_H 1
# define HAVE_DIRENT_H 1
# define HAVE_SYS_PARAM_H 1
# define HAVE_SYS_TIME_H 1
# define TIME_WITH_SYS_TIME 1
# define HAVE_SYS_MMAN_H 1
# define HAVE_SYS_WAIT_H 1
# define HAVE_DLFCN_H 1
# define HAVE_MMAP 1
# define HAVE_MKSTEMP 1
# define HAVE_GETPAGESIZE 1
# define HAVE_SETENV 1
# define HAVE_SIGACTION 1
#endif

/* The rest below is the hand-written tail of config/config.h.in, unchanged. */

/* - Miscellaneous */
#define AUTOCONF 1
#if defined(__CYGWIN32__) || !defined(_WIN32)
# define UNIX 1
#endif

/* - BOOL */
#if !defined(HAVE_BOOL) && !defined(bool)
#define bool  char
#define true  1
#define false 0
#endif

/* - WCHAR etc.*/
#if ! defined(HAVE_WCHAR_T)
#define HAS_WCHAR 0
#define HAS_WCTYPE 0
#define HAS_MBSTATE 0
#else
#define HAS_WCHAR 1
#if defined(HAVE_WCTYPE_H) && defined(HAVE_ISWSPACE)
#define HAS_WCTYPE 1
#endif
#if defined(HAVE_MBSTATE_T) && defined(HAVE_WCRTOMB)
#define HAS_MBSTATE 1
#endif
#endif
#if defined(HAVE_ICONV_H) && defined(HAVE_ICONV)
#define HAS_ICONV 1
#else
#define HAS_ICONV 0
#endif

/* - I18N MESSAGES HELL */
#define HAS_CTRL_C_IN_ERR_MSG 1

/* - CONTAINERS */
#ifndef HAVE_MEMBER_TEMPLATES
#define GCONTAINER_NO_MEMBER_TEMPLATES 1
#endif
#ifndef HAVE_TYPENAME
#define GCONTAINER_NO_TYPENAME 1
#endif

/* - JPEG */
#ifdef HAVE_JPEG
#define NEED_JPEG_DECODER 1
#endif

/* - MMAP */
#if defined(HAVE_MMAP) && defined(HAVE_SYS_MMAN_H)
#define HAS_MEMMAP 1
#else
#define HAS_MEMMAP 0
#endif

#endif /* CONFIG_H */
