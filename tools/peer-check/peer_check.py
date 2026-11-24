"""End-to-end check of Katana Desk's "Sync on this Wi-Fi" server, the way Katana talks to it.

  python -I peer_check.py http://127.0.0.1:47615 --code 123456 --book <path to a book in the desk's library>
  python -I peer_check.py http://127.0.0.1:47615 --token <64 hex> --book <path>

Pairs (or uses a token; a refused code says why: wrong, closed), matches the book by format + size + KOReader
partial MD5, asks which book is being read, downloads the book's file (whole, and its end as a range), says a sync
starts and ends, then walks the Grimmory-shaped routes: place, status, reset, highlights, bookmarks. Prints each
step; exits 1 on a miss.
Writes to the desk's test profile only: never point it at his real profile.
"""
import argparse, hashlib, json, os, sys, urllib.request, urllib.error, uuid

def partial_md5(path):
    m = hashlib.md5()
    with open(path, "rb") as f:
        for i in range(-1, 11):
            f.seek(1024 << (2 * i) if i >= 0 else 0)  # KOReader: the first sample is at 0
            b = f.read(1024)
            if not b:
                break
            m.update(b)
    return m.hexdigest()

class Desk:
    def __init__(self, base, token=None):
        self.base, self.token = base.rstrip("/"), token
    def call(self, method, path, body=None, token=True):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token and self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            return e.code, (json.loads(raw) if raw else None)
    def raw(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers={"Authorization": "Bearer " + self.token, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

fails = []
def check(name, cond, extra=""):
    print(("ok   " if cond else "MISS ") + name + (f"  {extra}" if extra else ""))
    if not cond:
        fails.append(name)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base")
    ap.add_argument("--code")
    ap.add_argument("--token")
    ap.add_argument("--book", required=True)
    a = ap.parse_args()
    d = Desk(a.base, a.token)

    st, hello = d.call("GET", "/katana-sync/v1/hello", token=False)
    check("hello", st == 200 and hello.get("app") == "katana-desk" and hello.get("protocol") == 1 and hello.get("deskId"), json.dumps(hello))
    check("hello says whether a code is showing", isinstance(hello.get("pairing"), bool), json.dumps(hello))

    if a.code:
        wrong = "000000" if a.code != "000000" else "000001"
        st, r = d.call("POST", "/katana-sync/v1/pair", {"code": wrong, "deviceId": "x", "deviceName": "x"}, token=False)
        check("wrong code is 403, reason wrong", st == 403 and (r or {}).get("reason") == "wrong", f"{st} {r}")
        st, p = d.call("POST", "/katana-sync/v1/pair", {"code": a.code, "deviceId": str(uuid.uuid4()), "deviceName": "peer_check"}, token=False)
        check("pair", st == 200 and len(p.get("token", "")) == 64, str(st))
        d.token = p["token"]
        print("token", d.token)
        st, r = d.call("POST", "/katana-sync/v1/pair", {"code": a.code, "deviceId": "y", "deviceName": "y"}, token=False)
        check("a code pairs one device (then none is showing)", st == 403 and (r or {}).get("reason") == "closed", f"{st} {r}")

    st, _ = Desk(a.base, "f" * 64).call("GET", "/api/v1/books/1")
    check("unknown token is 401", st == 401, str(st))
    st, _ = Desk(a.base).call("GET", "/api/v1/books/1", token=False)
    check("no token is 401", st == 401, str(st))

    fmt = os.path.splitext(a.book)[1].lstrip(".").upper()
    size = os.path.getsize(a.book)
    md5 = partial_md5(a.book)
    st, m = d.call("POST", "/katana-sync/v1/match", {"books": [{"key": "k1", "md5": md5, "size": size, "format": fmt},
                                                             {"key": "k2", "md5": md5, "size": size + 1, "format": fmt}]})
    books = m.get("books", []) if m else []
    check("match finds the book (and not a size off)", st == 200 and len(books) == 1 and books[0]["key"] == "k1", json.dumps(m))
    bid = books[0]["bookId"]

    # a sync said out loud, the book being read here, and a book's file
    st, _ = d.call("POST", "/katana-sync/v1/sync", {"phase": "start"})
    check("sync start", st == 200, str(st))
    st, rd = d.call("GET", "/katana-sync/v1/reading")
    check("which book is being read", st == 200 and "book" in (rd or {}), json.dumps(rd)[:300])
    st, h, body = d.raw(f"/api/v1/books/{bid}/content")
    check("the book's file", st == 200 and len(body) == size and h.get("Accept-Ranges") == "bytes" and h.get("ETag"), f"{st} {len(body)}")
    tag = h.get("ETag", "")
    st, h, tail = d.raw(f"/api/v1/books/{bid}/content", {"Range": f"bytes={size - 10}-", "If-Range": tag})
    check("its last 10 bytes as a range", st == 206 and tail == body[-10:] and h.get("Content-Range") == f"bytes {size - 10}-{size - 1}/{size}", f"{st} {h.get('Content-Range')}")
    st, _, _ = d.raw(f"/api/v1/books/{bid}/content", {"Range": f"bytes={size}-"})
    check("a range past the end is 416", st == 416, str(st))
    st, _ = d.call("POST", "/katana-sync/v1/sync", {"phase": "later"})
    check("an unknown sync phase is 400", st == 400, str(st))
    st, _ = d.call("POST", "/katana-sync/v1/sync", {"phase": "end", "books": 1, "changed": False})
    check("sync end", st == 200, str(st))

    d.call("POST", "/api/v1/books/reset-progress?type=BOOKLORE", [bid])  # start unread
    st, b = d.call("GET", f"/api/v1/books/{bid}")
    check("book (with the libraryId Katana needs)", st == 200 and b["id"] == bid and b.get("libraryId") is not None and (b.get("primaryFile") or {}).get("id"), json.dumps(b)[:300])
    file_id = (b.get("primaryFile") or {}).get("id")
    epub = fmt == "EPUB"

    # a place from the phone
    if epub:
        cfi = "epubcfi(/6/8!/4/2/1:0)"
        body = {"bookId": bid, "fileProgress": {"bookFileId": file_id, "positionData": cfi, "positionHref": "ch1.xhtml", "progressPercent": 37.5}}
    else:
        body = {"bookId": bid, "fileProgress": {"bookFileId": file_id, "positionData": "5", "progressPercent": 37.5}}
    st, _ = d.call("POST", "/api/v1/books/progress", body)
    check("progress", st == 200, str(st))
    st, b = d.call("GET", f"/api/v1/books/{bid}")
    key = "epubProgress" if epub else ("pdfProgress" if fmt == "PDF" else "cbxProgress")
    prog = b.get(key) or {}
    want = (prog.get("cfi") == cfi) if epub else (prog.get("page") == 5)
    check("the phone's place comes back", want and abs((prog.get("percentage") or 0) - 37.5) < 0.01, json.dumps(prog))
    check("lastReadTime is a Z instant", str(b.get("lastReadTime", "")).endswith("Z"), str(b.get("lastReadTime")))
    check("reading", b.get("readStatus") == "READING", str(b.get("readStatus")))

    st, r = d.call("POST", "/api/v1/books/status", {"bookIds": [bid], "status": "READ"})
    st2, b = d.call("GET", f"/api/v1/books/{bid}")
    check("status READ", st == 200 and r[0]["readStatus"] == "READ" and b.get("readStatus") == "READ", json.dumps(r))
    st, _ = d.call("POST", "/api/v1/books/status", {"bookIds": [bid], "status": "SOMEDAY"})
    check("unknown status is 400", st == 400, str(st))

    # highlights
    hl = {"bookId": bid, "cfi": "epubcfi(/6/8!/4/2,/1:0,/1:20)", "text": "peer check words", "color": "#38BDF8", "style": "underline", "note": "a note", "chapterTitle": "One"}
    st, h = d.call("POST", "/api/v1/annotations", hl)
    check("highlight added", st == 200 and h.get("id") and h.get("color") == "#38BDF8" and h.get("style") == "underline", json.dumps(h))
    st, _ = d.call("POST", "/api/v1/annotations", hl)
    check("same place twice is 409", st == 409, str(st))
    st, lst = d.call("GET", f"/api/v1/annotations/book/{bid}")
    check("highlight listed", st == 200 and any(x["id"] == h["id"] for x in lst), str(len(lst or [])))
    st, h2 = d.call("PUT", f"/api/v1/annotations/{h['id']}", {"color": "#F472B6", "style": "highlight", "note": ""})
    check("highlight changed (note cleared)", st == 200 and h2.get("color") == "#F472B6" and not h2.get("note"), json.dumps(h2))
    st, _ = d.call("DELETE", f"/api/v1/annotations/{h['id']}")
    check("highlight removed", st in (200, 204), str(st))
    st, lst = d.call("GET", f"/api/v1/annotations/book/{bid}")
    check("removed highlight gone from the list", not any(x["id"] == h["id"] for x in lst))
    st, _ = d.call("DELETE", f"/api/v1/annotations/{h['id']}")
    check("removing again is 404", st == 404, str(st))

    # bookmarks
    if epub:
        bm = {"bookId": bid, "cfi": "epubcfi(/6/10!/4/2/1:0)", "title": "Mark"}
    elif fmt in ("CBZ", "CBR"):
        bm = {"bookId": bid, "cfi": "7", "title": "Mark"}
    else:
        bm = {"bookId": bid, "pageNumber": 7, "title": "Mark"}
    st, k = d.call("POST", "/api/v1/bookmarks", bm)
    check("bookmark added", st == 200 and k.get("id") and k.get("title") == "Mark", json.dumps(k))
    st, _ = d.call("POST", "/api/v1/bookmarks", bm)
    check("second bookmark at one place is 409", st == 409, str(st))
    st, k2 = d.call("PUT", f"/api/v1/bookmarks/{k['id']}", {"title": "Renamed", "notes": "n"})
    check("bookmark changed", st == 200 and k2.get("title") == "Renamed" and k2.get("notes") == "n", json.dumps(k2))
    st, lst = d.call("GET", f"/api/v1/bookmarks/book/{bid}")
    check("bookmark listed", any(x["id"] == k["id"] for x in lst), json.dumps(lst)[:200])
    st, _ = d.call("DELETE", f"/api/v1/bookmarks/{k['id']}")
    st, lst = d.call("GET", f"/api/v1/bookmarks/book/{bid}")
    check("removed bookmark gone from the list", not any(x["id"] == k["id"] for x in lst))

    # reset last: unread, no place
    st, r = d.call("POST", "/api/v1/books/reset-progress?type=BOOKLORE", [bid])
    st2, b = d.call("GET", f"/api/v1/books/{bid}")
    check("reset: unread, no place", st == 200 and b.get("readStatus") == "UNREAD" and key not in b, json.dumps(b)[:300])

    print(("all good" if not fails else f"{len(fails)} missed: " + ", ".join(fails)))
    sys.exit(1 if fails else 0)


main()
