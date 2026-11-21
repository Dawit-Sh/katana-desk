"""Read-only look at a Katana Desk profile's sync state: books (place, status, peer place), highlights,
bookmarks and paired devices. Never writes (opens the database read-only).

  python -I desk_db.py                      # the local-sync test profile
  python -I desk_db.py <profile folder> [book id ...]
"""
import os, sqlite3, sys, datetime

def t(ms):
    if ms is None:
        return "-"
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%I:%M:%S %p").lstrip("0")

prof = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ["LOCALAPPDATA"], "katana-desk-test", "local-sync")
ids = [int(x) for x in sys.argv[2:]]
db = sqlite3.connect("file:" + os.path.join(prof, "katana.db").replace("\\", "/") + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
where = f"WHERE id IN ({','.join('?' * len(ids))})" if ids else ""
print("BOOKS")
for b in db.execute(f"SELECT id, title, format, size, hash, location, fraction, place_at, read_status, finished_at, peer_place, peer_synced_at, peer_served_at FROM books {where} ORDER BY id", ids):
    print(f"  #{b['id']} {b['title']} ({b['format']}, {b['size']} bytes, md5 {b['hash']})")
    print(f"     here: {b['location']}  {b['fraction']}  read at {t(b['place_at'])}  status {b['read_status']}  finished {t(b['finished_at'])}")
    print(f"     phone: {b['peer_place']}  weighed {t(b['peer_synced_at'])}  this PC's chosen {t(b['peer_served_at'])}")
print("HIGHLIGHTS (deleted ones marked x)")
for h in db.execute(f"SELECT id, book_id, cfi, text, color, style, note, updated_at, deleted_at, sync_state FROM highlights {where.replace('id IN', 'book_id IN')} ORDER BY book_id, id", ids):
    print(f"  {'x' if h['deleted_at'] else ' '} #{h['id']} book {h['book_id']} {h['color']}/{h['style']} {h['cfi']}  \"{(h['text'] or '')[:40]}\"  note={h['note']!r}  {t(h['updated_at'])} {h['sync_state']}")
print("BOOKMARKS (deleted ones marked x)")
for m in db.execute(f"SELECT id, book_id, cfi, title, note, updated_at, deleted_at, sync_state FROM bookmarks {where.replace('id IN', 'book_id IN')} ORDER BY book_id, id", ids):
    print(f"  {'x' if m['deleted_at'] else ' '} #{m['id']} book {m['book_id']} {m['cfi']}  title={m['title']!r} note={m['note']!r}  {t(m['updated_at'])} {m['sync_state']}")
print("DEVICES")
for d in db.execute("SELECT device_id, name, paired_at, seen_at FROM peer_devices"):
    print(f"  {d['name']} ({d['device_id']}) paired {t(d['paired_at'])}, last seen {t(d['seen_at'])}")
