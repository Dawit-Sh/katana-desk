import { useEffect, useMemo, useState } from "react";
import { useUpdates } from "../lib/updates";
import { api, m7, type ReadingDays } from "../lib/api";
import { HeatKey, heatLevel } from "../lib/heat";
import { Cover } from "./Cover";
import "../styles/reading-card.css";
import { useStore, type Page } from "../lib/store";

type Item = { page: Page; icon: string; label: string; count?: number; badge?: string };

const dayKey = (d: Date) =>
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

/** Minutes as "45 min", or hours once past an hour and a half ("2.5 h"). */
const minOrH = (secs: number): [string, string] => {
  const m = Math.round(secs / 60);
  if (m < 90) return [String(m), "min"];
  const h = secs / 3600;
  return [h < 10 ? h.toFixed(1).replace(/\.0$/, "") : String(Math.round(h)), "h"];
};

/** The longest run of days read in a row, in what's kept (about 400 days). */
function bestStreak(secs: Map<string, number>) {
  const days = [...secs.entries()].filter(([, s]) => s > 0).map(([d]) => d).sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const k of days) {
    const d = new Date(`${k}T12:00:00`);
    run = prev && Math.round((d.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/** Streaks, today, this week and the last 12 weeks as a calendar (a column a week, Monday on top). */
function stats(rd: ReadingDays | null) {
  const secs = new Map(rd?.days ?? []);
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const start = new Date(monday);
  start.setDate(monday.getDate() - 7 * 11);
  const cells: { cls: string; title: string }[] = [];
  for (let i = 0; i < 84; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const k = dayKey(d);
    if (d > today) {
      cells.push({ cls: "fut", title: "" });
      continue;
    }
    const s = secs.get(k) ?? 0;
    const m = Math.round(s / 60);
    cells.push({
      cls: `l${heatLevel(s)}${k === dayKey(today) ? " today" : ""}`,
      title: `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${m ? `${m} min` : "no reading"}`,
    });
  }
  let week = 0;
  for (const m = new Date(monday); m <= today; m.setDate(m.getDate() + 1)) week += secs.get(dayKey(m)) ?? 0;
  return { cells, streak: streakOf(secs, today), best: bestStreak(secs), today: secs.get(dayKey(today)) ?? 0, week };
}

export function useReadingDays() {
  const readingId = useStore((s) => s.readingId);
  const [rd, setRd] = useState<ReadingDays | null>(null);
  useEffect(() => {
    if (readingId == null) api.readingDays().then(setRd).catch(() => {});
  }, [readingId]);
  return rd;
}

/** This year's numbers from the Journal: hours read, days read, books finished (looked at when the reader closes). */
function useYear() {
  const readingId = useStore((s) => s.readingId);
  const [y, setY] = useState<{ secs: number; days: number; finished: number } | null>(null);
  useEffect(() => {
    if (readingId != null) return;
    m7.journal("year")
      .then((j) => {
        const year = String(new Date().getFullYear());
        const days = j.days.filter(([d, s]) => d.startsWith(year) && s > 0).length;
        setY({ secs: j.yearSeconds, days, finished: j.finishedYear });
      })
      .catch(() => {});
  }, [readingId]);
  return y;
}

function ReadingCard() {
  const go = useStore((s) => s.go);
  const open = useStore((s) => s.open);
  const books = useStore((s) => s.books);
  const { cells, streak, best, today, week } = stats(useReadingDays());
  const year = useYear();
  // the book you're reading now: the last one opened that's started and not finished
  const now = useMemo(
    () =>
      books
        .filter((b) => b.openedAt && (b.fraction ?? 0) > 0.004 && (b.fraction ?? 0) < 0.995)
        .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0] ?? null,
    [books],
  );
  const [tv, tu] = minOrH(today);
  const [wv, wu] = minOrH(week);
  const [yv, yu] = minOrH(year?.secs ?? 0);
  const pct = now ? Math.round((now.fraction ?? 0) * 100) : 0;
  return (
    <div className="rc">
      <button type="button" className="rch" onClick={() => go("journal")} title="Your reading days (Journal)">
        <span>Reading</span>
        <span className="dim">Journal ›</span>
      </button>
      {now && (
        <button type="button" className="rnow" onClick={() => open(now.id)} title={`Continue ${now.title}`}>
          <Cover book={now} size="xs" progress={false} />
          <span className="rnt">
            <b>{now.title}</b>
            <small>{now.chapter?.trim() ? `${pct}% · ${now.chapter.trim()}` : `${pct}%${now.author ? ` · ${now.author}` : ""}`}</small>
            <span className="pbar">
              <i style={{ width: `${pct}%` }} />
            </span>
          </span>
        </button>
      )}
      <button type="button" className="rcbody" onClick={() => go("journal")} title="Your reading days (Journal)">
        <span className="rcs">
          <span><b>{streak}</b>{streak === 1 ? "day" : "days"}<small>Streak</small></span>
          <span><b>{best}</b>{best === 1 ? "day" : "days"}<small>Best streak</small></span>
          <span><b>{tv}</b>{tu}<small>Today</small></span>
          <span><b>{wv}</b>{wu}<small>This week</small></span>
        </span>
        <span className="heat12" aria-hidden="true">
          {cells.map((c, i) => <i key={i} className={c.cls} title={c.title} />)}
        </span>
        <span className="rcfoot">
          <span>12 weeks</span>
          <HeatKey />
        </span>
        {year && (
          <span className="rcyear">
            <span><b>{yv}</b>{yu}<small>This year</small></span>
            <span><b>{year.days}</b><small>{year.days === 1 ? "Day read" : "Days read"}</small></span>
            <span><b>{year.finished}</b><small>Finished</small></span>
          </span>
        )}
      </button>
    </div>
  );
}

export function useNavItems() {
  const count = useStore((s) => s.books.filter((b) => b.source === "local").length);
  const gcount = useStore((s) => (s.g?.signedIn ? s.catalog.books.length : 0));
  const sources: Item[] = [
    { page: "grimmory", icon: "cloud", label: "Grimmory", count: gcount },
    { page: "local", icon: "folder", label: "Local", count },
  ];
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
  const { sources, pages } = useNavItems();
  const signedIn = useStore((s) => !!s.g?.signedIn);
  const upd = useUpdates((u) => u.phase === "found");
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
  return (
    <nav className={`side ${drawer ? "drawer" : ""}`} aria-label="Katana">
      <div className="sl">Sources</div>
      {sources.map(row)}
      {!signedIn && (
        <button type="button" className="nv" onClick={() => pick("grimmory")} title="Sign in to Grimmory">
          <i className="ms">add</i><span>Add a server</span>
        </button>
      )}
      <ReadingCard />
      <div className="sl">Your reading</div>
      {pages.map(row)}
      <div className="grow" />
      {row({ page: "settings", icon: "settings", label: "Settings", badge: upd ? "Update" : undefined })}
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
