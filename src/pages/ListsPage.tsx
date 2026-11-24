// Lists (milestone 7): your own reading lists on this PC, with books from Local and Grimmory alike.
// Also the "Add to a list" menu (a book's page, a cover's right-click menu) and that right-click menu.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, lists as listApi, m7, gReadable, READABLE, type Book, type GBook, type List } from "../lib/api";
import { plural } from "../lib/format";
import { useStore, type BookMenuAt } from "../lib/store";
import { Cover, GCover } from "../components/Cover";
import { coverForBook, coverForG } from "../components/CoverDialog";

type Entry = { key: string; local?: Book; g?: GBook };

function useEntries(keys: string[]): Entry[] {
  const books = useStore((s) => s.books);
  const catalog = useStore((s) => s.catalog);
  return useMemo(() => {
    const byId = new Map(books.map((b) => [b.id, b]));
    const gById = new Map(catalog.books.map((b) => [b.id, b]));
    return keys
      .map((key) => {
        const id = Number(key.slice(2));
        if (key.startsWith("b:")) return { key, local: byId.get(id) };
        const g = gById.get(id);
        const local = g?.localId != null ? byId.get(g.localId) : books.find((b) => b.grimmoryId === id);
        return { key, g, local: g ? undefined : local };
      })
      .filter((e) => e.local || e.g);
  }, [keys, books, catalog]);
}

/** Opens a book from a list: a file here opens, a Grimmory book shows its page (Ctrl: a new window). */
function openEntry(e: Entry, ctrl: boolean) {
  const st = useStore.getState();
  if (e.local) {
    if (!READABLE.has(e.local.format)) return;
    if (ctrl) m7.openWindow(e.local.id, null, e.local.title);
    else st.open(e.local.id);
  } else if (e.g) {
    if (ctrl && e.g.localId != null) return m7.openWindow(e.g.localId, null, e.g.title);
    st.go("grimmory");
    st.gSelect(e.g.id, true);
  }
}

/** Lists to start from on an empty Lists page, drawn as faint lists ("ghosts"); one click makes one. */
const GHOSTS = [
  { name: "Want to read", icon: "bookmark_add", about: "Books you'd like to get to" },
  { name: "Reading next", icon: "schedule", about: "The next few, in order" },
  { name: "Finished", icon: "task_alt", about: "Books you've read" },
  { name: "Favourites", icon: "favorite", about: "The ones you'd read again" },
];

export function ListsPage() {
  const all = useStore((s) => s.lists);
  const loadLists = useStore((s) => s.loadLists);
  // the open list lives in the store, so Back can come back to it
  const sel = useStore((s) => s.listSel);
  const setSel = useStore((s) => s.setListSel);
  const [naming, setNaming] = useState<number | "new" | null>(null);
  const [name, setName] = useState("");
  const [undo, setUndo] = useState<List | null>(null);
  const undoTimer = useRef(0);
  useEffect(() => {
    loadLists().catch(() => {});
  }, [loadLists]);
  const cur = all.find((l) => l.id === sel) ?? all[0] ?? null;
  const entries = useEntries(cur?.books ?? []);

  const create = async () => {
    const n = name.trim();
    if (!n) return setNaming(null);
    const id = await listApi.create(n);
    await loadLists();
    setSel(id);
    setNaming(null);
  };
  const rename = async (id: number) => {
    const n = name.trim();
    if (n) await listApi.rename(id, n);
    await loadLists();
    setNaming(null);
  };
  const remove = async (l: List) => {
    await listApi.remove(l.id);
    await loadLists();
    setSel(null);
    setUndo(l);
    clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
  };
  const putBack = async () => {
    if (!undo) return;
    const id = await listApi.restore(undo);
    setUndo(null);
    await loadLists();
    setSel(id);
  };

  const nameField = (onDone: () => void) => (
    <span className="field ls-name">
      <input
        autoFocus
        value={name}
        placeholder="The list's name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onDone();
          if (e.key === "Escape") {
            e.stopPropagation();
            setNaming(null);
          }
        }}
        onBlur={onDone}
        aria-label="The list's name"
      />
    </span>
  );

  if (!all.length && naming !== "new")
    return (
      <div className="scroll lsempty">
        <div className="sech">
          <span className="h">Lists</span>
          <button type="button" className="pill fill" onClick={() => { setName(""); setNaming("new"); }}>
            <i className="ms">add</i>New list
          </button>
        </div>
        <p className="lsintro">
          Lists for books to read next, a course, a series, anything. Books from Local and Grimmory can share a list. Start
          with one of these, or make your own.
        </p>
        <div className="lsghosts">
          {GHOSTS.map((g) => (
            <button
              type="button"
              key={g.name}
              className="lsghost"
              onClick={async () => {
                const id = await listApi.create(g.name);
                await loadLists();
                setSel(id);
              }}
            >
              <span className="gcovers" aria-hidden="true">
                <i /><i /><i />
              </span>
              <span className="gname"><i className="ms">{g.icon}</i>{g.name}</span>
              <small>{g.about}</small>
              <span className="gadd"><i className="ms">add</i>Make this list</span>
            </button>
          ))}
        </div>
        <p className="lshint">Add books to a list from a book's page (Add to a list) or by right-clicking a cover.</p>
        {undo && (
          <div className="ls-undo">
            <span>“{undo.name}” removed</span>
            <button type="button" className="pill" onClick={putBack}>Undo</button>
          </div>
        )}
      </div>
    );

  return (
    <div className="bmpage ls">
      <div className="bmleft">
        <div className="sech">
          <span className="h">Lists<span className="c">{all.length || ""}</span></span>
          <button type="button" className="pill fill" onClick={() => { setName(""); setNaming("new"); }}>
            <i className="ms">add</i>New list
          </button>
        </div>
        <div className="mrows">
          {naming === "new" && nameField(create)}
          {all.map((l) => (
            <button type="button" key={l.id} className={`mr book ls-row ${cur?.id === l.id ? "here" : ""}`} onClick={() => setSel(l.id)}>
              <i className="ms">checklist</i>
              <div>
                <span className="bn">{l.name}</span>
                <small>{plural(l.books.length, "book")}</small>
              </div>
            </button>
          ))}
        </div>
        {undo && (
          <div className="ls-undo">
            <span>“{undo.name}” removed</span>
            <button type="button" className="pill" onClick={putBack}>Undo</button>
          </div>
        )}
      </div>
      <div className="bmright">
        {cur && (
          <>
            <div className="bmhead">
              <div className="rct">
                {naming === cur.id ? nameField(() => rename(cur.id)) : <span className="ti">{cur.name}</span>}
                <span className="su">{plural(cur.books.length, "book")} · made {new Date(cur.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>
              </div>
              <div className="pills">
                <button type="button" className="pill" onClick={() => { setName(cur.name); setNaming(cur.id); }}><i className="ms">edit</i>Rename</button>
                <button type="button" className="pill" onClick={() => remove(cur)}><i className="ms">delete</i>Remove the list</button>
              </div>
            </div>
            {entries.length ? (
              <div className="grid ls-grid">
                {entries.map((e) => {
                  const title = e.local?.title ?? e.g!.title;
                  return (
                    <div
                      key={e.key}
                      className="bk"
                      onDoubleClick={(ev) => openEntry(e, ev.ctrlKey)}
                      onClick={(ev) => ev.ctrlKey && openEntry(e, true)}
                      onContextMenu={(ev) => {
                        ev.preventDefault();
                        useStore.getState().setMenu({ x: ev.clientX, y: ev.clientY, local: e.local, g: e.g });
                      }}
                      title={`${title} · double-click to open`}
                    >
                      {e.local ? <Cover book={e.local} /> : <GCover book={e.g!} />}
                      <div className="bt">
                        <span>{title}</span>
                        <button type="button" aria-label="Take it off this list" title="Take it off this list" onClick={() => listApi.take(cur.id, e.key).then(() => useStore.getState().loadLists())}>
                          <i className="ms">remove_circle_outline</i>
                        </button>
                      </div>
                      <div className="bm">{e.local ? (e.local.author ?? e.local.format.toUpperCase()) : (e.g!.authors ?? "Grimmory")}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="bmmsg">No books in this list yet. Right-click a cover, or use Add to a list on a book's page.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The lists a book is on (ticked), a click adds or takes it off; a new list at the bottom. */
export function ListMenu({ bookKey, onDone }: { bookKey: string; onDone?: () => void }) {
  const all = useStore((s) => s.lists);
  const loadLists = useStore((s) => s.loadLists);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    loadLists().catch(() => {});
  }, [loadLists]);
  const toggle = async (l: List) => {
    if (l.books.includes(bookKey)) await listApi.take(l.id, bookKey);
    else await listApi.add(l.id, bookKey);
    await loadLists();
  };
  const create = async () => {
    if (name?.trim()) {
      await listApi.create(name.trim(), bookKey);
      await loadLists();
    }
    setName(null);
    onDone?.();
  };
  return (
    <>
      <div className="mh">Add to a list</div>
      {all.map((l) => (
        <button type="button" key={l.id} onClick={() => toggle(l)} role="menuitemcheckbox" aria-checked={l.books.includes(bookKey)}>
          <i className="ms">{l.books.includes(bookKey) ? "check_box" : "check_box_outline_blank"}</i>
          {l.name}
        </button>
      ))}
      {name == null ? (
        <button type="button" onClick={() => setName("")}><i className="ms">add</i>New list…</button>
      ) : (
        <span className="field" style={{ padding: "4px 8px" }}>
          <input
            autoFocus
            value={name}
            placeholder="The list's name, then Enter"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(null);
              }
            }}
            aria-label="The new list's name"
          />
        </span>
      )}
    </>
  );
}

/** A cover's right-click menu: open, open in a new window, change cover, add to a list. */
export function BookMenu({ m }: { m: BookMenuAt }) {
  const close = () => useStore.getState().setMenu(null);
  const ref = useRef<HTMLDivElement>(null);
  const [lists, setLists] = useState(false);
  const [pos, setPos] = useState({ left: m.x, top: m.y });
  useEffect(() => {
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", off);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
    };
  }, []);
  // stay inside the window
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.min(m.x, window.innerWidth - r.width - 8), top: Math.max(8, Math.min(m.y, window.innerHeight - r.height - 8)) });
  }, [m.x, m.y, lists]);

  const st = useStore.getState();
  const local = m.local ?? (m.g?.localId != null ? st.books.find((b) => b.id === m.g!.localId) : undefined);
  const title = m.local?.title ?? m.g?.title ?? "";
  const readable = local ? READABLE.has(local.format) : m.g ? gReadable(m.g) : false;
  const key = m.local ? (m.local.source === "grimmory" && m.local.grimmoryId != null ? `g:${m.local.grimmoryId}` : `b:${m.local.id}`) : `g:${m.g!.id}`;
  return (
    <div className="menu ctx" ref={ref} style={pos} role="menu" aria-label={title}>
      {!lists ? (
        <>
          <div className="mh" title={title}>{title}</div>
          {readable && (
            <button type="button" role="menuitem" onClick={() => { close(); if (local) st.open(local.id); else if (m.g) st.openG(m.g.id); }}>
              <i className="ms">menu_book</i>Open
            </button>
          )}
          {local && READABLE.has(local.format) && (
            <button type="button" role="menuitem" onClick={() => { close(); m7.openWindow(local.id, null, local.title); }}>
              <i className="ms">open_in_new</i>Open in a new window
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              st.setCoverFor(m.local ? coverForBook(m.local) : coverForG(m.g!));
            }}
          >
            <i className="ms">image</i>Change cover…
          </button>
          <button type="button" role="menuitem" onClick={() => setLists(true)}>
            <i className="ms">checklist</i>Add to a list<i className="ms" style={{ marginLeft: "auto" }}>chevron_right</i>
          </button>
          {m.local && (
            <button type="button" role="menuitem" onClick={() => { close(); api.reveal(m.local!.path); }}>
              <i className="ms">folder_open</i>Show in File Explorer
            </button>
          )}
        </>
      ) : (
        <ListMenu bookKey={key} />
      )}
    </div>
  );
}
