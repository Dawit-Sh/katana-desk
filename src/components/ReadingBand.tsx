// Local's reading dashboard (direction A, his pick 2026-11-24): a band on top of Local with the last book
// read large (chapter, last note, time left), the other open books beside it, and a column for books gone
// quiet, Reading next and books new in your folders. Inside a folder it speaks of that folder. Hide folds
// it to one line. Nothing here repeats the Journal (no heat map, charts or hour totals).
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { api, grimmory, m7, READABLE, type Book, type Folder } from "../lib/api";
import { useStore } from "../lib/store";
import {
  cut, finished, leftText, nearText, readingNext, newThisWeek, whenLower, whenText, type Dash, type Extra, type Reading,
} from "../lib/dashboard";
import { Cover } from "./Cover";

const FOLD_KEY = "local.dashboard.folded";
let foldedCache: boolean | null = null;

/** The band's extras from Rust, read again whenever the library changes. */
export function useDash(): [Dash | null, () => void] {
  const books = useStore((s) => s.books);
  const [d, setD] = useState<Dash | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let on = true;
    api.localDashboard().then((x) => on && setD(x)).catch(() => {});
    return () => {
      on = false;
    };
  }, [books, n]);
  return [d, () => setN((k) => k + 1)];
}

function useFolded(): [boolean, (f: boolean) => void] {
  const [f, setF] = useState(foldedCache ?? false);
  useEffect(() => {
    if (foldedCache != null) return;
    api.getSetting(FOLD_KEY).then((v) => setF((foldedCache = v === "1"))).catch(() => {});
  }, []);
  return [f, (v) => {
    foldedCache = v;
    setF(v);
    api.setSetting(FOLD_KEY, v ? "1" : "0").catch(() => {});
  }];
}

const pctOf = (b: Book) => Math.round((b.fraction ?? 0) * 100);
const authorOf = (b: Book) => b.author ?? "Author unknown";

/** One click shows the book's page, a double-click (or Continue) opens it, Ctrl-click opens it in its own window. */
function useBookActions(b: Book) {
  const select = useStore((s) => s.select);
  const open = useStore((s) => s.open);
  const readable = READABLE.has(b.format);
  return {
    onClick: (e: React.MouseEvent) => (e.ctrlKey && readable ? m7.openWindow(b.id, null, b.title) : select(b.id)),
    onDoubleClick: () => readable && open(b.id),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      useStore.getState().setMenu({ x: e.clientX, y: e.clientY, local: b });
    },
  };
}

function Bar({ p, tint }: { p: number; tint?: boolean }) {
  return <span className={`pbar ${tint ? "tint" : ""}`}><i style={{ width: `${p}%` }} /></span>;
}

/** Where a book was last read: "from My reader" when its place came over Sync on this Wi-Fi. */
function Dev({ x }: { x: Extra | undefined }) {
  if (!x?.fromDevice) return null;
  return <span className="dev" title={`Last read on ${x.fromDevice}; its place came over Sync on this Wi-Fi`}><i className="ms">devices</i>from {x.fromDevice}</span>;
}

function Lead({ b, x, folderName, now }: { b: Book; x: Extra | undefined; folderName: string | null; now: number }) {
  const open = useStore((s) => s.open);
  const select = useStore((s) => s.select);
  const acts = useBookActions(b);
  const pct = pctOf(b);
  const m = x?.mark;
  return (
    <div className="lead">
      <button type="button" className="lcv" {...acts} title="One click shows the book's page; a double-click opens it">
        <Cover book={b} size="l" />
      </button>
      <div className="rct">
        <span className="ov">
          Continue reading · {x?.fromDevice ? <>from {x.fromDevice}, </> : null}
          {b.openedAt ? whenLower(b.openedAt, now) : "not opened here yet"}
        </span>
        <span className="ti">{b.title}</span>
        <span className={`au ${b.author ? "" : "unk"}`}>{authorOf(b)}</span>
        <div className="where"><span>{b.chapter?.trim() || "Where you stopped"}</span><span className="pct">{pct}%</span></div>
        <Bar p={pct} />
        {x?.secsLeft != null && <span className="left">{leftText(x.secsLeft)} at your pace</span>}
        {folderName && <span className="fchip"><i className="ms">folder</i>{folderName}</span>}
        {m && (
          <div className="lastmk">
            <small>
              {m.note ? "Your last note" : "Your last highlight"}
              {m.chapter ? ` · ${m.chapter}` : ""} · {whenLower(m.at, now)}
            </small>
            <span>{cut(m.note ? m.note : `“${m.text}”`)}</span>
          </div>
        )}
        <div className="acts">
          <button type="button" className="pill fill" onClick={() => open(b.id)} disabled={!READABLE.has(b.format)}>
            <i className="ms">play_arrow</i>Continue
          </button>
          <button type="button" className="pill" onClick={() => select(b.id, true)}><i className="ms">info</i>The book's page</button>
        </div>
      </div>
    </div>
  );
}

function Small({ b, x, now }: { b: Book; x: Extra | undefined; now: number }) {
  const acts = useBookActions(b);
  const pct = pctOf(b);
  const near = nearText(x?.secsLeft ?? null, b.fraction);
  return (
    <button type="button" className="dri" {...acts} title="One click shows the book's page; a double-click opens it">
      <Cover book={b} size="s" />
      <span className="rct">
        <span className="wh">{b.openedAt ? whenText(b.openedAt, now) : ""}{x?.fromDevice ? " · " : ""}<Dev x={x} /></span>
        <span className="t2">{b.title}</span>
        <span className={`a2 ${b.author ? "" : "unk"}`}>{authorOf(b)}</span>
        <span className="m2">{pct}%{b.chapter?.trim() ? ` · ${b.chapter.trim()}` : ""}</span>
        <Bar p={pct} />
        {near && <span className="tchip">{near}</span>}
      </span>
    </button>
  );
}

function QuietRow({ b, now, onAside }: { b: Book; now: number; onAside?: (b: Book) => void }) {
  const open = useStore((s) => s.open);
  const acts = useBookActions(b);
  return (
    <div className="qrow">
      <button type="button" className="qcv" {...acts} title="One click shows the book's page; a double-click opens it"><Cover book={b} size="xs" /></button>
      <div className="rct">
        <span className="qt">{b.title}</span>
        <span className={`qa ${b.author ? "" : "unk"}`}>{authorOf(b)}</span>
        <span className="qm">{pctOf(b)}% · last read {b.openedAt ? whenLower(b.openedAt, now) : "elsewhere"}</span>
        {onAside && (
          <div className="acts">
            <button type="button" className="pill tone sm" onClick={() => open(b.id)} disabled={!READABLE.has(b.format)}>Pick up</button>
            <button type="button" className="pill ghost sm" onClick={() => onAside(b)} title="Off this list until you open it again">Set aside</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Mini({ b }: { b: Book }) {
  const acts = useBookActions(b);
  return (
    <button type="button" className="mb" {...acts} title="One click shows the book's page; a double-click opens it">
      <Cover book={b} size="s" progress={false} />
      <span className="t3">{b.title}</span>
      <span className={`a3 ${b.author ? "" : "unk"}`}>{authorOf(b)}</span>
    </button>
  );
}

/** How many of the other open books fit in two rows of the band (columns of 270 px and up, 28 px apart). */
function useSlots(el: HTMLDivElement | null) {
  const [slots, setSlots] = useState(8);
  useLayoutEffect(() => {
    if (!el) return;
    const fit = () => setSlots(Math.max(1, Math.floor((el.clientWidth + 28) / 298)) * 2);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return slots;
}

type Props = {
  /** the books at this place (all of Local, or the folder you're in) */
  books: Book[];
  r: Reading;
  dash: Dash | null;
  reload: () => void;
  folders: Folder[];
  /** inside a folder: its name */
  scope: string | null;
};

export function ReadingBand({ books, r, dash, reload, folders, scope }: Props) {
  const lists = useStore((s) => s.lists);
  const goPlace = useStore((s) => s.goPlace);
  const open = useStore((s) => s.open);
  const [folded, setFolded] = useFolded();
  const [allOpen, setAllOpen] = useState(false);
  const [allQuiet, setAllQuiet] = useState(false);
  const [undo, setUndo] = useState<Book | null>(null);
  const [othersEl, setOthersEl] = useState<HTMLDivElement | null>(null);
  const slots = useSlots(othersEl);
  const now = Date.now();
  const extra = useMemo(() => new Map((dash?.books ?? []).map((x) => [x.id, x])), [dash]);
  const next = useMemo(() => readingNext(lists, books, dash), [lists, books, dash]);
  const fresh = useMemo(() => (scope ? null : newThisWeek(books, folders, Date.now())), [books, folders, scope]);
  const done = useMemo(() => finished(books, dash), [books, dash]);

  const lead = r.open[0] ?? null;
  const rest = r.open.slice(1);
  const nothing = !lead && !r.quiet.length && !next.length && !fresh?.books.length && !(scope && done.length);
  if (nothing) return null;

  const folderOf = (b: Book) => {
    if (scope) return null;
    const f = folders.find((x) => x.id === b.folderId);
    if (!f) return null;
    return folders.length === 1 && b.relDir ? b.relDir.split("/")[0] : f.name;
  };
  const goFolderOf = (b: Book) => {
    if (b.folderId == null) return;
    const top = folders.length === 1 && b.relDir ? [b.relDir.split("/")[0]] : [];
    goPlace({ folderId: b.folderId, sub: top });
  };
  const aside = async (b: Book) => {
    try {
      await api.setAside(b.id, true);
      if (b.grimmoryId != null) grimmory.setStatus(b.grimmoryId, "PAUSED").catch(() => {});
      setUndo(b);
      reload();
    } catch {
      /* the book stays where it is */
    }
  };
  const unAside = async () => {
    if (!undo) return;
    const b = undo;
    setUndo(null);
    await api.setAside(b.id, false).catch(() => {});
    if (b.grimmoryId != null) grimmory.setStatus(b.grimmoryId, "READING").catch(() => {});
    reload();
  };

  const counts = scope
    ? [r.open.length && `${r.open.length} open`, `${done.length} of ${books.length.toLocaleString("en-US")} read`]
    : [r.open.length && `${r.open.length} open`, r.quiet.length && `${r.quiet.length} gone quiet`];
  const countText = counts.filter(Boolean).join(" · ");
  const title = scope ? `Reading in ${scope}` : "Pick up where you left off";

  if (folded) {
    return (
      <section className="bandf" aria-label={title}>
        <span className="lbl">{title}</span>
        {lead && (
          <>
            <button type="button" className="fcv" onDoubleClick={() => open(lead.id)} onClick={() => useStore.getState().select(lead.id)}>
              <Cover book={lead} size="xs" progress={false} />
            </button>
            <span className="t2">{lead.title}</span>
            <span className="su">{[lead.chapter?.trim(), `${pctOf(lead)}%`].filter(Boolean).join(" · ")}</span>
            <Bar p={pctOf(lead)} />
            <button type="button" className="pill fill sm" onClick={() => open(lead.id)} disabled={!READABLE.has(lead.format)}>
              <i className="ms">play_arrow</i>Continue
            </button>
          </>
        )}
        <span className="sp" />
        <span className="su">{countText}</span>
        <button type="button" className="pill ghost sm" onClick={() => setFolded(false)} title="Show the reading band"><i className="ms">unfold_more</i>Show</button>
      </section>
    );
  }

  const shownRest = allOpen || rest.length <= slots ? rest : rest.slice(0, slots - 1);
  const quietShown = allQuiet ? r.quiet : r.quiet.slice(0, 2);
  const notStarted = books.filter((b) => (b.fraction ?? 0) <= 0.004).length;

  const quiet = r.quiet.length > 0 && (
    <div className="dcs">
      <div className="dcsh"><i className="ms">bedtime</i>{scope ? "Gone quiet here" : "Gone quiet"}<span className="su">not opened in 14 days</span></div>
      {quietShown.map((b) => <QuietRow key={b.id} b={b} now={now} onAside={aside} />)}
      {r.quiet.length > 2 && (
        <button type="button" className="lnk" onClick={() => setAllQuiet((v) => !v)}>
          {allQuiet ? "Show fewer" : `${r.quiet.length - 2} more gone quiet ›`}
        </button>
      )}
    </div>
  );
  const undoLine = undo && (
    <div className="dundo">
      <span>Set aside: {undo.title}</span>
      <button type="button" className="pill sm" onClick={unAside}>Undo</button>
    </div>
  );
  const nextBox = next.length > 0 && (
    <div className="dcs">
      <div className="dcsh"><i className="ms">schedule</i>{scope ? "Next here" : "Reading next"}<span className="su">{scope ? "from Reading next" : "your list"}</span></div>
      <div className="dmini">{next.slice(0, 3).map((b) => <Mini key={b.id} b={b} />)}</div>
    </div>
  );

  return (
    <section className="band" aria-label={title}>
      <div className="bandh">
        <span className="lbl">{title}</span>
        {countText && <span className="su">{countText}</span>}
        <span className="sp" />
        <button type="button" className="pill ghost sm" onClick={() => setFolded(true)} title="Fold the reading band to one line">
          <i className="ms">unfold_less</i>Hide
        </button>
      </div>
      <div className={`bandg ${scope ? "scoped" : ""} ${lead ? "" : "nolead"}`}>
        {lead ? (
          <Lead b={lead} x={extra.get(lead.id)} folderName={folderOf(lead)} now={now} />
        ) : (
          <div className="none">{scope ? "Nothing open in this folder right now." : "Nothing open right now."}</div>
        )}
        {!scope && (
          <div className="others" ref={setOthersEl}>
            {shownRest.map((b) => <Small key={b.id} b={b} x={extra.get(b.id)} now={now} />)}
            {shownRest.length < rest.length && (
              <button type="button" className="moreo" onClick={() => setAllOpen(true)}>
                {rest.length - shownRest.length} more open<i className="ms">chevron_right</i>
              </button>
            )}
          </div>
        )}
        <aside className="catch">
          {scope && (
            <div className="dcs">
              <div className="dcsh"><i className="ms">folder</i>This folder</div>
              <div className="big">{done.length.toLocaleString("en-US")}<small>of {books.length.toLocaleString("en-US")} read</small></div>
              <Bar p={books.length ? Math.max(done.length ? 1 : 0, Math.round((done.length / books.length) * 100)) : 0} tint />
              <span className="su">{r.open.length} open · {notStarted.toLocaleString("en-US")} not started</span>
            </div>
          )}
          {scope && done.length > 0 && (
            <div className="dcs">
              <div className="dcsh"><i className="ms">task_alt</i>Finished here lately</div>
              {done.slice(0, 3).map(({ book: b, at }) => (
                <div className="qrow" key={b.id}>
                  <span className="qcv"><Cover book={b} size="xs" progress={false} /></span>
                  <div className="rct">
                    <span className="qt">{b.title}</span>
                    <span className={`qa ${b.author ? "" : "unk"}`}>{authorOf(b)}</span>
                    <span className="qm">{at ? `finished ${whenLower(at, now)}` : "finished"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {quiet}
          {undoLine}
          {nextBox}
          {fresh && fresh.books.length > 0 && (
            <div className="dcs nw">
              <div className="dcsh"><i className="ms">new_releases</i>New in your folders<span className="su">this week</span></div>
              <span className="su">
                {fresh.books.length.toLocaleString("en-US")} {fresh.books.length === 1 ? "book" : "books"}
                {fresh.by.length ? ` · ${fresh.by.slice(0, 2).map(([k, n]) => `${k} ${n}`).join(", ")}` : ""}
              </span>
              <div className="newrow">
                {fresh.books.slice(0, 6).map((b) => (
                  <button type="button" key={b.id} className="ncv" title={`${b.title}${b.author ? ` · ${b.author}` : ""}`} onClick={() => goFolderOf(b)}>
                    <Cover book={b} size="xs" progress={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
