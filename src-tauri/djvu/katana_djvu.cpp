// A small C API over DjVuLibre's public C API (ddjvuapi.h) for Katana Desk's Rust side
// (src-tauri/src/djvu.rs). The waiting and error handling follow Katana's Android glue
// (core/djvu/src/main/cpp/djvu_jni.cpp in Dawit-Sh/Katana), with the standard library's threads in
// place of pthreads so the same file builds on Windows and Linux.
//
// One KDjvu per open document: its own ddjvu context and document. The Rust side holds one lock per
// document, so these functions never run at the same time for the same KDjvu.
//
// DjVuLibre decodes on its own threads and reports through a message queue. Every wait drains that
// queue, keeps the DDJVU_ERROR texts, and checks the job's status again; a job that posts nothing for
// a minute counts as failed instead of blocking forever. No C++ exception crosses into Rust.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <chrono>
#include <condition_variable>
#include <mutex>
#include <new>
#include <string>
#include <vector>

#include "ddjvuapi.h"
#include "miniexp.h"

namespace {

const long kWaitSliceMs = 200;
const long kStallTimeoutMs = 60000;
const size_t kMaxErrors = 3;
const size_t kMaxErrorLength = 400;
const int kMaxZoneDepth = 16;

}  // namespace

struct KDjvu {
  ddjvu_context_t *context = nullptr;
  ddjvu_document_t *document = nullptr;
  ddjvu_format_t *rgb = nullptr;
  ddjvu_format_t *grey = nullptr;
  int pageCount = 0;

  std::mutex mutex;
  std::condition_variable posted;
  unsigned long postedCount = 0;

  std::string errors;
  size_t errorCount = 0;
};

namespace {

std::string asciiOnly(const std::string &text) {
  std::string out;
  out.reserve(text.size());
  for (char c : text) {
    unsigned char u = static_cast<unsigned char>(c);
    if (u == '\n' || u == '\t') out.push_back(' ');
    else if (u >= 0x20 && u < 0x7f) out.push_back(c);
    else if (u >= 0x80) out.push_back('?');
  }
  return out;
}

void onMessagePosted(ddjvu_context_t *, void *closure) {
  KDjvu *h = static_cast<KDjvu *>(closure);
  {
    std::lock_guard<std::mutex> lock(h->mutex);
    h->postedCount++;
  }
  h->posted.notify_all();
}

unsigned long postedCount(KDjvu *h) {
  std::lock_guard<std::mutex> lock(h->mutex);
  return h->postedCount;
}

std::string cleanErrorText(const char *raw) {
  if (raw == nullptr) return std::string();
  std::string text = asciiOnly(raw);
  const char *const marker = "Message name:";
  size_t at = text.find(marker);
  if (at != std::string::npos) text = text.substr(at + strlen(marker));
  size_t first = text.find_first_not_of(' ');
  if (first == std::string::npos) return std::string();
  size_t last = text.find_last_not_of(' ');
  text = text.substr(first, last - first + 1);
  if (text.size() > kMaxErrorLength) text.resize(kMaxErrorLength);
  return text;
}

void drainMessages(KDjvu *h) {
  const ddjvu_message_t *message;
  while ((message = ddjvu_message_peek(h->context)) != nullptr) {
    if (message->m_any.tag == DDJVU_ERROR) {
      std::string text = cleanErrorText(message->m_error.message);
      if (!text.empty() && h->errorCount < kMaxErrors && h->errors.find(text) == std::string::npos) {
        if (!h->errors.empty()) h->errors += "; ";
        h->errors += text;
        h->errorCount++;
      }
    }
    ddjvu_message_pop(h->context);
  }
}

void startOperation(KDjvu *h) {
  drainMessages(h);
  h->errors.clear();
  h->errorCount = 0;
}

bool waitForPost(KDjvu *h, unsigned long seen, long timeoutMs) {
  std::unique_lock<std::mutex> lock(h->mutex);
  return h->posted.wait_for(lock, std::chrono::milliseconds(timeoutMs), [h, seen] { return h->postedCount != seen; });
}

template <typename Poll>
ddjvu_status_t waitForJob(KDjvu *h, Poll poll) {
  long idleMs = 0;
  for (;;) {
    unsigned long seen = postedCount(h);
    drainMessages(h);
    ddjvu_status_t status = poll();
    if (status >= DDJVU_JOB_OK) {
      drainMessages(h);
      return status;
    }
    if (waitForPost(h, seen, kWaitSliceMs)) {
      idleMs = 0;
      continue;
    }
    if (status == DDJVU_JOB_NOTSTARTED && !h->errors.empty()) return DDJVU_JOB_FAILED;
    idleMs += kWaitSliceMs;
    if (idleMs >= kStallTimeoutMs) {
      if (h->errors.empty()) h->errors = "decoding stalled";
      return DDJVU_JOB_FAILED;
    }
  }
}

void setError(char *err, int errlen, const std::string &what, const KDjvu *h) {
  if (err == nullptr || errlen <= 0) return;
  std::string message = what;
  if (h != nullptr && !h->errors.empty()) message += " (" + h->errors + ")";
  size_t n = message.size() < static_cast<size_t>(errlen - 1) ? message.size() : static_cast<size_t>(errlen - 1);
  memcpy(err, message.data(), n);
  err[n] = '\0';
}

void destroy(KDjvu *h) {
  if (h == nullptr) return;
  if (h->context != nullptr) ddjvu_message_set_callback(h->context, nullptr, nullptr);
  if (h->rgb != nullptr) ddjvu_format_release(h->rgb);
  if (h->grey != nullptr) ddjvu_format_release(h->grey);
  if (h->document != nullptr) ddjvu_document_release(h->document);
  if (h->context != nullptr) {
    drainMessages(h);
    ddjvu_context_release(h->context);
  }
  delete h;
}

// ----- JSON out -----

void jsonString(std::string &out, const char *s) {
  out.push_back('"');
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(s); *p; p++) {
    unsigned char c = *p;
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(static_cast<char>(c));
    } else if (c < 0x20) {
      char buf[8];
      snprintf(buf, sizeof buf, "\\u%04x", c);
      out += buf;
    } else {
      out.push_back(static_cast<char>(c));
    }
  }
  out.push_back('"');
}

char *dup(const std::string &s) {
  char *out = static_cast<char *>(malloc(s.size() + 1));
  if (out == nullptr) return nullptr;
  memcpy(out, s.data(), s.size());
  out[s.size()] = '\0';
  return out;
}

bool isZone(miniexp_t type, const char *name) {
  return miniexp_symbolp(type) && strcmp(miniexp_to_name(type), name) == 0;
}

struct PageText {
  std::string text;   // the words, as UTF-8
  std::string words;  // JSON numbers per word: line, start, end (bytes), xmin, ymin, xmax, ymax
  int lines = 0;
  int lastLine = -1;
  bool any = false;
};

void collectZone(miniexp_t zone, int line, PageText &out, int depth) {
  if (!miniexp_consp(zone) || depth > kMaxZoneDepth) return;
  miniexp_t type = miniexp_car(zone);
  if (!miniexp_symbolp(type)) return;
  int box[4];
  miniexp_t rest = miniexp_cdr(zone);
  for (int i = 0; i < 4; i++) {
    miniexp_t number = miniexp_car(rest);
    if (!miniexp_numberp(number)) return;
    box[i] = miniexp_to_int(number);
    rest = miniexp_cdr(rest);
  }
  if (isZone(type, "line")) line = out.lines++;
  miniexp_t first = miniexp_car(rest);
  if (miniexp_stringp(first)) {
    const char *text = miniexp_to_str(first);
    if (text == nullptr || *text == '\0') return;
    if (line < 0) line = out.lines++;
    // words are set apart by a space, lines by a line break
    if (!out.text.empty()) out.text += (line == out.lastLine) ? " " : "\n";
    out.lastLine = line;
    size_t start = out.text.size();
    out.text += text;
    char buf[160];
    snprintf(buf, sizeof buf, "%s%d,%zu,%zu,%d,%d,%d,%d", out.any ? "," : "", line, start, out.text.size(), box[0], box[1],
             box[2], box[3]);
    out.words += buf;
    out.any = true;
    return;
  }
  for (; miniexp_consp(rest); rest = miniexp_cdr(rest)) collectZone(miniexp_car(rest), line, out, depth + 1);
}

// The outline: (bookmarks ("title" "#page" child...) ...)
void outlineItems(KDjvu *h, miniexp_t list, std::string &out, int depth) {
  bool firstItem = true;
  for (; miniexp_consp(list); list = miniexp_cdr(list)) {
    miniexp_t item = miniexp_car(list);
    if (!miniexp_consp(item) || depth > kMaxZoneDepth) continue;
    miniexp_t title = miniexp_car(item);
    miniexp_t url = miniexp_cadr(item);
    if (!miniexp_stringp(title)) continue;
    int page = -1;
    if (miniexp_stringp(url)) {
      const char *u = miniexp_to_str(url);
      if (u != nullptr && u[0] == '#') {
        const char *name = u + 1;
        char *end = nullptr;
        long n = strtol(name, &end, 10);
        if (end != name && *end == '\0' && n >= 1 && n <= h->pageCount) page = static_cast<int>(n) - 1;
        else page = ddjvu_document_search_pageno(h->document, name);
      }
    }
    if (!firstItem) out.push_back(',');
    firstItem = false;
    out += "{\"t\":";
    jsonString(out, miniexp_to_str(title));
    out += ",\"p\":" + std::to_string(page) + ",\"c\":[";
    outlineItems(h, miniexp_cddr(item), out, depth + 1);
    out += "]}";
  }
}

bool pageInfo(KDjvu *h, int page, ddjvu_pageinfo_t &info) {
  ddjvu_document_t *document = h->document;
  memset(&info, 0, sizeof(info));
  ddjvu_status_t status = waitForJob(h, [document, page, &info] { return ddjvu_document_get_pageinfo(document, page, &info); });
  return status == DDJVU_JOB_OK && info.width > 0 && info.height > 0;
}

}  // namespace

extern "C" {

KDjvu *kdjvu_open(const char *utf8Path, char *err, int errlen) {
  KDjvu *h = nullptr;
  try {
    h = new KDjvu();
    h->context = ddjvu_context_create("katana-desk");
    if (h->context == nullptr) {
      setError(err, errlen, "Could not start the DjVu decoder", nullptr);
      destroy(h);
      return nullptr;
    }
    ddjvu_message_set_callback(h->context, onMessagePosted, h);
    h->rgb = ddjvu_format_create(DDJVU_FORMAT_RGB24, 0, nullptr);
    h->grey = ddjvu_format_create(DDJVU_FORMAT_GREY8, 0, nullptr);
    if (h->rgb == nullptr || h->grey == nullptr) {
      setError(err, errlen, "Could not set up the DjVu pixel format", nullptr);
      destroy(h);
      return nullptr;
    }
    for (ddjvu_format_t *f : {h->rgb, h->grey}) {
      ddjvu_format_set_row_order(f, 1);
      ddjvu_format_set_y_direction(f, 1);
    }
    startOperation(h);
    h->document = ddjvu_document_create_by_filename_utf8(h->context, utf8Path, 1);
    if (h->document == nullptr) {
      drainMessages(h);
      setError(err, errlen, "Could not open the DjVu document", h);
      destroy(h);
      return nullptr;
    }
    ddjvu_document_t *document = h->document;
    ddjvu_status_t status = waitForJob(h, [document] { return ddjvu_document_decoding_status(document); });
    if (status != DDJVU_JOB_OK) {
      setError(err, errlen, "Not a readable DjVu document", h);
      destroy(h);
      return nullptr;
    }
    h->pageCount = ddjvu_document_get_pagenum(document);
    if (h->pageCount <= 0) {
      setError(err, errlen, "The DjVu document has no pages", nullptr);
      destroy(h);
      return nullptr;
    }
    return h;
  } catch (...) {
    setError(err, errlen, "Unexpected error while opening the DjVu document", nullptr);
    if (h != nullptr) destroy(h);
    return nullptr;
  }
}

int kdjvu_page_count(KDjvu *h) { return h == nullptr ? 0 : h->pageCount; }

// width and height with the page's own rotation applied, and its dpi. 1 when known.
int kdjvu_page_info(KDjvu *h, int page, int *width, int *height, int *dpi) {
  try {
    if (h == nullptr || page < 0 || page >= h->pageCount) return 0;
    startOperation(h);
    ddjvu_pageinfo_t info;
    if (!pageInfo(h, page, info)) return 0;
    *width = info.width;
    *height = info.height;
    *dpi = info.dpi;
    return 1;
  } catch (...) {
    return 0;
  }
}

// Draws the whole page scaled to width x height into `pixels` (rows of `stride` bytes): grey (one
// byte a pixel) for black-and-white pages when `allowGrey`, else RGB (three bytes). Returns 1 for RGB,
// 2 for grey, 0 when it failed (then `pixels` is untouched), -1 when the page has nothing DjVuLibre can
// draw (left white).
int kdjvu_render(KDjvu *h, int page, int width, int height, int allowGrey, unsigned char *pixels, size_t length,
                 char *err, int errlen) {
  try {
    if (h == nullptr || page < 0 || page >= h->pageCount || width <= 0 || height <= 0) return 0;
    startOperation(h);
    ddjvu_page_t *p = ddjvu_page_create_by_pageno(h->document, page);
    if (p == nullptr) {
      drainMessages(h);
      setError(err, errlen, "Could not open the page", h);
      return 0;
    }
    ddjvu_status_t status = waitForJob(h, [p] { return ddjvu_page_decoding_status(p); });
    if (status != DDJVU_JOB_OK) {
      ddjvu_page_release(p);
      setError(err, errlen, "Could not decode the page", h);
      return 0;
    }
    bool grey = allowGrey && ddjvu_page_get_type(p) == DDJVU_PAGETYPE_BITONAL;
    size_t stride = static_cast<size_t>(width) * (grey ? 1 : 3);
    if (length < stride * static_cast<size_t>(height)) {
      ddjvu_page_release(p);
      setError(err, errlen, "The buffer is too small", nullptr);
      return 0;
    }
    ddjvu_rect_t rect;
    rect.x = 0;
    rect.y = 0;
    rect.w = static_cast<unsigned int>(width);
    rect.h = static_cast<unsigned int>(height);
    int rendered = ddjvu_page_render(p, DDJVU_RENDER_COLOR, &rect, &rect, grey ? h->grey : h->rgb, stride,
                                     reinterpret_cast<char *>(pixels));
    ddjvu_page_release(p);
    if (!rendered) {
      memset(pixels, 0xff, stride * static_cast<size_t>(height));
      return -1;
    }
    return grey ? 2 : 1;
  } catch (const std::bad_alloc &) {
    setError(err, errlen, "Out of memory while drawing the page", nullptr);
  } catch (...) {
    setError(err, errlen, "Unexpected error while drawing the page", nullptr);
  }
  return 0;
}

// A page's hidden text as JSON, or null when it has none:
// {"w":..,"h":..,"r":rotation,"text":"...","words":[line,start,end,xmin,ymin,xmax,ymax, ...]}
// w and h are the stored page's size, boxes are pixels from its bottom left, before its own rotation
// (quarter turns anticlockwise); start and end are byte offsets in text. Free with kdjvu_free.
char *kdjvu_page_text(KDjvu *h, int page) {
  try {
    if (h == nullptr || page < 0 || page >= h->pageCount) return nullptr;
    startOperation(h);
    ddjvu_pageinfo_t info;
    if (!pageInfo(h, page, info)) return nullptr;
    ddjvu_document_t *document = h->document;
    miniexp_t text = miniexp_dummy;
    ddjvu_status_t status = waitForJob(h, [document, page, &text] {
      text = ddjvu_document_get_pagetext(document, page, "word");
      return text == miniexp_dummy ? DDJVU_JOB_STARTED : DDJVU_JOB_OK;
    });
    if (status != DDJVU_JOB_OK || !miniexp_consp(text)) {
      if (text != miniexp_dummy) ddjvu_miniexp_release(document, text);
      return nullptr;
    }
    PageText out;
    collectZone(text, -1, out, 0);
    ddjvu_miniexp_release(document, text);
    if (!out.any) return nullptr;
    int rotation = info.rotation & 3;
    std::string json = "{\"w\":" + std::to_string((rotation & 1) ? info.height : info.width) +
                       ",\"h\":" + std::to_string((rotation & 1) ? info.width : info.height) +
                       ",\"r\":" + std::to_string(rotation) + ",\"text\":";
    jsonString(json, out.text.c_str());
    json += ",\"words\":[" + out.words + "]}";
    return dup(json);
  } catch (...) {
    return nullptr;
  }
}

// The outline as JSON ([{"t":title,"p":page index or -1,"c":[...]}]), "[]" when there is none.
char *kdjvu_outline(KDjvu *h) {
  try {
    if (h == nullptr) return nullptr;
    startOperation(h);
    ddjvu_document_t *document = h->document;
    miniexp_t outline = miniexp_dummy;
    ddjvu_status_t status = waitForJob(h, [document, &outline] {
      outline = ddjvu_document_get_outline(document);
      return outline == miniexp_dummy ? DDJVU_JOB_STARTED : DDJVU_JOB_OK;
    });
    std::string json = "[";
    if (status == DDJVU_JOB_OK && miniexp_consp(outline) && isZone(miniexp_car(outline), "bookmarks")) {
      outlineItems(h, miniexp_cdr(outline), json, 0);
    }
    json += "]";
    if (outline != miniexp_dummy) ddjvu_miniexp_release(document, outline);
    return dup(json);
  } catch (...) {
    return nullptr;
  }
}

void kdjvu_free(char *s) { free(s); }

void kdjvu_close(KDjvu *h) {
  try {
    destroy(h);
  } catch (...) {
  }
}

}  // extern "C"
