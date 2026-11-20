import { useEffect, useState } from "react";
import { api, type ReadingDays } from "../lib/api";
import { useStore, type Page } from "../lib/store";

type Item = { page: Page; icon: string; label: string; count?: number };

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Streak, minutes this week (from Monday) and the last 28 days, from the reading time the reader records. */
function stats(rd: ReadingDays | null) {
  const secs = new Map(rd?.days ?? []);
  const today = new Date();
  const cells: { cls: string; title: string }[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const s = secs.get(dayKey(d)) ?? 0;
    const m = Math.round(s / 60);
    cells.push({
      cls: (s <= 0 ? "" : m < 10 ? "a" : m < 30 ? "b" : "c") + (i === 0 ? " today" : ""),
      title: `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ${m ? `${m} min` : "no reading"}`,
    });
  }
  let streak = 0;
  const d = new Date(today);
  if (!(secs.get(dayKey(d)) ?? 0)) d.setDate(d.getDate() - 1); // today not read yet keeps yesterday's streak
  while ((secs.get(dayKey(d)) ?? 0) > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  let week = 0;
  for (const m = new Date(monday); m <= today; m.setDate(m.getDate() + 1)) week += secs.get(dayKey(m)) ?? 0;
  return { cells, streak, weekMin: Math.round(week / 60) };
}

export function useReadingDays() {
  const readingId = useStore((s) => s.readingId);
  const [rd, setRd] = useState<ReadingDays | null>(null);
  useEffect(() => {
    if (readingId == null) api.readingDays().then(setRd).catch(() => {});
  }, [readingId]);
  return rd;
}

function ReadingCard() {
  const go = useStore((s) => s.go);
  const { cells, streak, weekMin } = stats(useReadingDays());
  return (
    <button type="button" className="rc" onClick={() => go("journal")} title="Your reading days (Journal)">
      <div className="rch"><span>Reading</span><span className="dim">Journal ›</span></div>
      <div className="rcs">
        <div><b>{streak}</b>{streak === 1 ? "day" : "days"}<small>Streak</small></div>
        <div><b>{weekMin}</b>min<small>This week</small></div>
      </div>
      <div className="heat" aria-hidden="true">
        {cells.map((c, i) => <i key={i} className={c.cls} title={c.title} />)}
      </div>
    </button>
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
      {row({ page: "settings", icon: "settings", label: "Settings" })}
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
