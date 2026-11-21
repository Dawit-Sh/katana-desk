// The sidebar (canvas row "Sidebar · the Reading card and reading days", board "B · Chosen"): the Reading
// card on top (today's reading, the book being read, the reading days as a calendar), the sources, your
// reading, the word of the day and Settings. It never scrolls and nothing is cut off: when the window is
// short the calendar drops weeks first, then the word card its meaning, then the word card goes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { useUpdates } from "../lib/updates";
import { api, type ReadingDays } from "../lib/api";
import { DayTip, HeatKey, heatLevel, useGoal } from "../lib/heat";
import { dict, words, type Word } from "../lib/words";
import { Cover } from "./Cover";
import { Review } from "./Review";
import "../styles/reading-card.css";
import { useStore, type Page } from "../lib/store";

type Item = { page: Page; icon: string; label: string; count?: number; badge?: string };

export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Days read in a row up to today (or yesterday, when today isn't read yet). */
export function streakOf(secs: Map<string, number>, today: Date) {
  let streak = 0;
  const d = new Date(today);
  if (!(secs.get(dayKey(d)) ?? 0)) d.setDate(d.getDate() - 1); // today not read yet keeps yesterday's streak
  while ((secs.get(dayKey(d)) ?? 0) > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

/** The reading days, looked at again when a book closes, when another window reads, and every minute. */
export function useReadingDays() {
  const readingId = useStore((s) => s.readingId);
  const [rd, setRd] = useState<ReadingDays | null>(null);
  useEffect(() => {
    if (readingId != null) return;
    const load = () => api.readingDays().then(setRd).catch(() => {});
    load();
    const t = window.setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    const un = listen("library-changed", load);
    return () => {
      clearInterval(t);
      un.then((f) => f());
    };
  }, [readingId]);
  return rd;
}

/** "1 h 12" + "read today", or "22 min" + "read today". */
const readToday = (secs: number): string => {
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${Math.floor(m / 60)} h`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The reading days as a calendar: Monday to Sunday across, a week a row, this week at the bottom. */
function DayCalendar({ rd, weeks, onDay }: { rd: ReadingDays | null; weeks: number; onDay: (day: string) => void }) {
  const goal = useGoal((g) => g.goal);
  const [tip, setTip] = useState<{ at: DOMRect; day: string; secs: number } | null>(null);
  const { cells, months } = useMemo(() => {
    const secs = new Map(rd?.days ?? []);
    const now = new Date();
    const today = rd?.today ?? dayKey(now);
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const cells: { day: string; secs: number; cls: string; row: number; col: number }[] = [];
    const months: { row: number; name: string }[] = [];
    for (let w = 0; w < weeks; w++) {
      const first = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7 * (weeks - 1 - w));
      // a month's name on the row its 1st falls in (the top row names the month its Sunday is in)
      const sunday = new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6);
      if (w === 0) months.push({ row: w, name: MONTHS[sunday.getMonth()] });
      else if (sunday.getDate() <= 7) months.push({ row: w, name: MONTHS[sunday.getMonth()] });
      for (let r = 0; r < 7; r++) {
        const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + r);
        const k = dayKey(d);
        const s = secs.get(k) ?? 0;
        cells.push({ day: k, secs: s, row: w, col: r, cls: k > today ? "fut" : `l${heatLevel(s, goal)}${k === today ? " today" : ""}` });
      }
    }
    // the top row's name and the next one can't sit on neighbouring rows
    if (months.length > 1 && months[1].row === 1) months.shift();
    return { cells, months };
  }, [rd, weeks, goal]);
  return (
    <div className="hcal" style={{ gridTemplateRows: `14px repeat(${weeks}, 20px)` }} onMouseLeave={() => setTip(null)}>
      {["M", "T", "W", "T", "F", "S", "S"].map((t, i) => (
        <span key={i} className="hd" style={{ gridColumn: 2 + i, gridRow: 1 }}>{t}</span>
      ))}
      {months.map((m) => (
        <span key={m.row} className="mo" style={{ gridColumn: 1, gridRow: 2 + m.row }}>{m.name}</span>
      ))}
      {cells.map((c) =>
        c.cls === "fut" ? (
          <i key={c.day} className="fut" style={{ gridColumn: 2 + c.col, gridRow: 2 + c.row }} />
        ) : (
          <button
            type="button"
            key={c.day}
            className={c.cls}
            style={{ gridColumn: 2 + c.col, gridRow: 2 + c.row }}
            aria-label={c.day}
            onMouseEnter={(e) => setTip({ at: e.currentTarget.getBoundingClientRect(), day: c.day, secs: c.secs })}
            onFocus={(e) => setTip({ at: e.currentTarget.getBoundingClientRect(), day: c.day, secs: c.secs })}
            onBlur={() => setTip(null)}
            onClick={() => {
              setTip(null);
              onDay(c.day);
            }}
          />
        ),
      )}
      {tip && <DayTip at={tip.at} day={tip.day} secs={tip.secs} hint="click to open in the Journal" />}
    </div>
  );
}

/** A random word from My words, the same all day (kept in the setting `words.today`), with its meaning. */
function useWordOfDay() {
  const readingId = useStore((s) => s.readingId);
  const page = useStore((s) => s.page);
  const [list, setList] = useState<Word[] | null>(null);
  const [pick, setPick] = useState<{ id: number; on: string } | null>(null);
  const [meaning, setMeaning] = useState<string | null>(null);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const load = () => words.list(null).then(setList).catch(() => setList([]));
  // looked at again when a book closes (words saved while reading) and on leaving My words
  useEffect(() => {
    if (readingId == null) load();
  }, [readingId, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (l: Word[], not: number | null) => {
    const pool = l.filter((w) => w.id !== not);
    return (pool.length ? pool : l)[Math.floor(Math.random() * (pool.length || l.length))].id;
  };
  useEffect(() => {
    if (!list) return;
    const today = dayKey(new Date());
    if (!list.length) return setPick(null);
    if (pick && pick.on === today && list.some((w) => w.id === pick.id)) return;
    let alive = true;
    api
      .getSetting("words.today")
      .catch(() => null)
      .then((v) => {
        if (!alive) return;
        const [d, x] = (v ?? "").split(":");
        const keep = d === today && list.some((w) => w.id === Number(x));
        const id = keep ? Number(x) : choose(list, null);
        setPick({ id, on: today });
        if (!keep) api.setSetting("words.today", `${today}:${id}`).catch(() => {});
      });
    return () => {
      alive = false;
    };
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  const w = (pick && list?.find((x) => x.id === pick.id)) || null;
  // the saved meaning first, else the dictionary's first sense
  useEffect(() => {
    setMeaning(null);
    if (!w) return;
    if (w.meaning?.trim()) return setMeaning(w.meaning.trim());
    let alive = true;
    dict
      .lookup(w.headword || w.word)
      .then((r) => {
        const f = r.found[0];
        const g = f?.entries[0]?.senses.find((s) => !s.sub)?.gloss ?? f?.texts[0]?.text ?? "";
        if (alive) setMeaning(g.replace(/\s+/g, " ").trim());
      })
      .catch(() => alive && setMeaning(""));
    return () => {
      alive = false;
    };
  }, [w?.id, w?.meaning]); // eslint-disable-line react-hooks/exhaustive-deps

  const another = () => {
    if (!list || list.length < 2) return;
    const today = dayKey(new Date());
    const id = choose(list, pick?.id ?? null);
    setPick({ id, on: today });
    api.setSetting("words.today", `${today}:${id}`).catch(() => {});
  };
  const know = async () => {
    if (!w) return;
    const after = await words.answer(w.id, true, true).catch(() => null);
    if (!after) return;
    setKnown((k) => new Set(k).add(after.id));
    setList((l) => l?.map((x) => (x.id === after.id ? after : x)) ?? l);
  };
  return { w, meaning, count: list?.length ?? 0, known: !!w && known.has(w.id), another, know, reload: load };
}

const stateOf = (w: Word) => (w.learnedAt ? "learned" : w.reviewedAt ? "learning" : "new");
const STATE_NAME = { new: "New, not reviewed yet", learning: "Learning", learned: "Learned" };

function WordCard({ wod, meaning, onReview }: { wod: ReturnType<typeof useWordOfDay>; meaning: boolean; onReview: (w: Word) => void }) {
  const w = wod.w!;
  const st = stateOf(w);
  return (
    <div className="wod">
      <div className="lbl">
        <span>Word of the day</span>
        {w.bookTitle && (
          <span className="dim" title={`${STATE_NAME[st]} · from ${w.bookTitle}`}>
            <i className={`d ${st}`} />
            <span className="wbook">{w.bookTitle}</span>
          </span>
        )}
        {!w.bookTitle && <i className={`d ${st}`} title={STATE_NAME[st]} />}
      </div>
      <div className="w" title={w.word}>{w.word}</div>
      {meaning && wod.meaning && (
        <div className="m" title={wod.meaning}>
          {wod.meaning}
        </div>
      )}
      <div className="acts">
        <button type="button" className="pill fill" onClick={() => onReview(w)} title="Review this word: its sentence, then its meaning">
          <i className="ms">style</i>Review
        </button>
        <button type="button" className="pill" disabled={wod.known} onClick={() => wod.know()} title="Counts as a good review">
          {wod.known ? (
            <>
              <i className="ms">check</i>Known
            </>
          ) : (
            "I know it"
          )}
        </button>
        {wod.count > 1 && (
          <button type="button" className="pill sq" aria-label="Another word" title="Another word" onClick={wod.another}>
            <i className="ms">arrow_forward</i>
          </button>
        )}
      </div>
    </div>
  );
}

const MIN_WEEKS = 4;
const ROW = 23; // a calendar row: a 20 px day and the 3 px gap
/** Seven weeks at a 1080 px window (a 1032 px sidebar), a week more for every row of room above that. */
const maxWeeks = (h: number) => Math.min(26, 7 + Math.max(0, Math.floor((h - 1032) / ROW)));
/**
 * How much of the sidebar shows, so it never scrolls: level 0 everything, 1 the word card without its
 * meaning, 2 no word card, 3 no book row, 4 no calendar, 5 tighter rows. At every level the calendar keeps
 * as many weeks as fit (never fewer than four); it starts again from everything when the room or the
 * content changes.
 */
function useFit(nav: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const [h, setH] = useState(0);
  const [fit, setFit] = useState({ level: 0, weeks: 7 });
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    setH(el.clientHeight);
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [nav]);
  useLayoutEffect(() => {
    if (h) setFit({ level: 0, weeks: maxWeeks(h) });
  }, [h, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el || !h) return;
    const over = el.scrollHeight - el.clientHeight;
    if (over <= 0) return;
    setFit((f) => {
      if (f.level < 4 && f.weeks > MIN_WEEKS) return { ...f, weeks: Math.max(MIN_WEEKS, f.weeks - Math.ceil(over / ROW)) };
      return f.level < 5 ? { level: f.level + 1, weeks: maxWeeks(h) } : f;
    });
  });
  return fit;
}

export function useNavItems() {
  const count = useStore((s) => s.books.filter((b) => b.source === "local").length);
  const gcount = useStore((s) => (s.g?.signedIn ? s.catalog.books.length : 0));
  // every server first (Grimmory for now), then this PC's folders
  const servers: Item[] = [{ page: "grimmory", icon: "cloud", label: "Grimmory", count: gcount }];
  const sources: Item[] = [...servers, { page: "local", icon: "folder", label: "Local", count }];
  const pages: Item[] = [
    { page: "lists", icon: "checklist", label: "Lists" },
    { page: "bookmarks", icon: "bookmarks", label: "Bookmarks" },
    { page: "words", icon: "dictionary", label: "My words" },
    { page: "journal", icon: "history", label: "Journal" },
  ];
  return { sources, pages };
}

export function Sidebar({ drawer, onPick }: { drawer?: boolean; onPick?: () => void }) {
  const page = useStore((s) => s.page);
  const go = useStore((s) => s.go);
  const goPlace = useStore((s) => s.goPlace);
  const goJournalDay = useStore((s) => s.goJournalDay);
  const goSettings = useStore((s) => s.goSettings);
  const open = useStore((s) => s.open);
  const books = useStore((s) => s.books);
  const { sources, pages } = useNavItems();
  const signedIn = useStore((s) => !!s.g?.signedIn);
  const upd = useUpdates((u) => u.phase === "found");
  const rd = useReadingDays();
  const wod = useWordOfDay();
  const [reviewing, setReviewing] = useState<Word | null>(null);
  const nav = useRef<HTMLElement>(null);
  // the book being read: the last one opened that's started and not finished
  const now = useMemo(
    () =>
      books
        .filter((b) => b.openedAt && (b.fraction ?? 0) > 0.004 && (b.fraction ?? 0) < 0.995)
        .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0] ?? null,
    [books],
  );
  const fit = useFit(nav, [now?.id, wod.w?.id, wod.meaning, rd == null]);

  const pick = (p: Page) => {
    if (p === "local" && page === "local") goPlace({ folderId: null, sub: [] });
    else go(p);
    onPick?.();
  };
  const row = (it: Item) => (
    <button type="button" key={it.page} className={`nv ${page === it.page ? "on" : ""}`} onClick={() => pick(it.page)}>
      <i className="ms">{it.icon}</i>
      <span>{it.label}</span>
      {!!it.count && <span className="cnt">{it.count.toLocaleString("en-US")}</span>}
      {!!it.badge && <span className="badge">{it.badge}</span>}
    </button>
  );
  const todaySecs = new Map(rd?.days ?? []).get(rd?.today ?? dayKey(new Date())) ?? 0;
  const goal = useGoal((g) => g.goal);
  const pct = now ? Math.round((now.fraction ?? 0) * 100) : 0;
  const where = now ? [now.chapter?.trim() || now.author || "", `${pct}%`].filter(Boolean).join(" · ") : "";

  return (
    <nav ref={nav} className={`side ${drawer ? "drawer" : ""} ${fit.level >= 5 ? "tight" : ""}`} aria-label="Katana">
      <div className="rc">
        <button type="button" className="rtop" onClick={() => pick("journal")} title="Your reading days (Journal)">
          <span>
            <b>{readToday(todaySecs)}</b>read today
          </span>
          <span className="dim">Journal ›</span>
        </button>
        {now && fit.level < 3 && (
          <button
            type="button"
            className="rnow"
            onClick={() => {
              open(now.id);
              onPick?.();
            }}
            title={`Continue ${now.title}`}
          >
            <Cover book={now} size="xs" progress={false} />
            <span className="rnt">
              <b>{now.title}</b>
              <small>{where}</small>
              <span className="pbar">
                <i style={{ width: `${pct}%` }} />
              </span>
            </span>
          </button>
        )}
        {fit.level < 4 && (
          <div className="hblock">
            <DayCalendar
              rd={rd}
              weeks={fit.weeks}
              onDay={(d) => {
                goJournalDay(d);
                onPick?.();
              }}
            />
            <div className="hfoot">
              <span title="Change it in Settings › Reading defaults, or in the Journal">Goal {goal} min a day</span>
              <HeatKey />
            </div>
          </div>
        )}
      </div>
      <div className="sl">Sources</div>
      {sources.map(row)}
      <button
        type="button"
        className="nv add"
        onClick={() => {
          if (signedIn) goSettings("sources");
          else go("grimmory");
          onPick?.();
        }}
        title={signedIn ? "Your servers (Settings › Sources)" : "Sign in to Grimmory"}
      >
        <i className="ms">add</i>
        <span>Add a server</span>
      </button>
      <div className="sl">Your reading</div>
      {pages.map(row)}
      <div className="grow" />
      {wod.w && fit.level < 2 && <WordCard wod={wod} meaning={fit.level < 1} onReview={setReviewing} />}
      {row({ page: "settings", icon: "settings", label: "Settings", badge: upd ? "Update" : undefined })}
      {reviewing &&
        createPortal(
          <Review
            bookId={null}
            word={reviewing}
            onChanged={wod.reload}
            onClose={() => {
              setReviewing(null);
              wod.reload();
            }}
          />,
          document.body,
        )}
    </nav>
  );
}

export function Rail() {
  const page = useStore((s) => s.page);
  const go = useStore((s) => s.go);
  const goPlace = useStore((s) => s.goPlace);
  const { sources, pages } = useNavItems();
  const pick = (p: Page) => (p === "local" && page === "local" ? goPlace({ folderId: null, sub: [] }) : go(p));
  const item = (it: Item) => (
    <button type="button" key={it.page} className={`ri ${page === it.page ? "on" : ""}`} onClick={() => pick(it.page)}>
      <i className="ms">{it.icon}</i>
      <small>{it.label}</small>
    </button>
  );
  return (
    <nav className="railnav" aria-label="Katana">
      {sources.map(item)}
      <hr />
      {pages.map(item)}
      <div className="grow" />
      {item({ page: "settings", icon: "settings", label: "Settings" })}
    </nav>
  );
}
