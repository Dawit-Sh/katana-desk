// The Journal (milestone 7), from the canvas's journal artboard: the whole year of reading days, the
// totals, the books of the week / month / year, three charts (days you read, hours each month, pages
// an hour) and the learning column (your words, going back to your highlights, when you read).
// Every number comes from the reader's own 15-second ticks (EPUB and the page view alike).
import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { m7, type Journal, type JBook, type Period, type Book } from "../lib/api";
import { useStore } from "../lib/store";
import { Cover } from "../components/Cover";
import { Review } from "../components/Review";
import { streakOf } from "../components/Sidebar";

type Learning = {
  words: { total: number; new: number; learning: number; learned: number; due: number };
  reviews: { total: number; year: number; firstTry: number | null; weeks: number[]; learnedYear: number };
  revisits: { year: number; weeks: number[]; highlights: number; notes: number; bookmarks: number; words: number; edits: number; most: { text: string; times: number; bookId: number | null } | null };
  lookupsYear: number;
  lookupWeeks: number[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LONG_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** "1 h 12 min", "24 min", "40 s" */
export const hm = (secs: number) => {
  const m = Math.round(secs / 60);
  if (secs > 0 && m === 0) return `${secs} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};

/** A number and its unit, the canvas's big figures: "61" + "h". */
const big = (secs: number): [string, string] => {
  const m = Math.round(secs / 60);
  if (m < 60) return [String(m), "min"];
  const h = secs / 3600;
  return [h < 10 ? h.toFixed(1).replace(/\.0$/, "") : String(Math.round(h)), "h"];
};

const level = (secs: number) => {
  const m = secs / 60;
  return m <= 0 ? 0 : m < 10 ? 1 : m < 30 ? 2 : m < 60 ? 3 : 4;
};

/** The calendar year as 7-row columns, Monday on top, with a cell per day. */
function YearGrid({ j }: { j: Journal }) {
  const secs = useMemo(() => new Map(j.days), [j.days]);
  const cells = useMemo(() => {
    const first = new Date(j.year, 0, 1);
    const lead = (first.getDay() + 6) % 7; // empty cells before 1 January
    const out: { cls: string; title: string }[] = [];
    for (let i = 0; i < lead; i++) out.push({ cls: "pad", title: "" });
    for (let d = new Date(first); d.getFullYear() === j.year; d.setDate(d.getDate() + 1)) {
      const k = ymd(d);
      const s = secs.get(k) ?? 0;
      const future = k > j.today;
      const label = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      out.push({
        cls: `${future ? "fut" : `l${level(s)}`}${k === j.today ? " today" : ""}`,
        title: future ? label : `${label}: ${s ? hm(s) : "no reading"}`,
      });
    }
    return out;
  }, [j.year, j.today, secs]);
  return (
    <div className="jr-yearwrap">
      <div className="jr-mons" aria-hidden="true">
        {MONTHS.map((m) => <span key={m}>{m}</span>)}
      </div>
      <div className="jr-yr" role="img" aria-label={`Reading days in ${j.year}`}>
        {cells.map((c, i) => <i key={i} className={c.cls} title={c.title} />)}
      </div>
    </div>
  );
}

/** Bars for a chart: heights from the largest, the top one in the accent colour. */
function Bars({ vals, labels, top, titles, height = 70 }: { vals: number[]; labels: string[]; top: number; titles: string[]; height?: number }) {
  const max = Math.max(1, ...vals);
  return (
    <>
      <div className="jr-bars" style={{ height }}>
        {vals.map((v, i) => (
          <i key={i} className={i === top && v > 0 ? "top" : v ? "" : "zero"} style={{ height: Math.max(3, Math.round((v / max) * height)) }} title={titles[i]} />
        ))}
      </div>
      <div className={`jr-xl ${labels.length === vals.length ? "even" : ""}`}>{labels.map((l, i) => <span key={i}>{l}</span>)}</div>
    </>
  );
}

/** Little week bars (the last 12 weeks), fading in with how many. */
function Weeks({ vals, scale }: { vals: number[]; scale: number }) {
  const max = Math.max(1, ...vals);
  return (
    <div className="jr-weeks" aria-hidden="true">
      {vals.map((v, i) => (
        <i key={i} style={{ height: Math.max(3, Math.round((v / max) * scale)), opacity: v ? 0.35 + (0.65 * v) / max : 0.15 }} />
      ))}
    </div>
  );
}

function BookRow({ b, book }: { b: JBook; book: Book | undefined }) {
  const open = useStore((s) => s.open);
  const pct = b.finishedAt ? 100 : Math.round((b.fraction ?? 0) * 100);
  const bits = [hm(b.seconds), b.days === 1 ? "1 day" : `${b.days} days`];
  if (b.highlights) bits.push(b.highlights === 1 ? "1 highlight" : `${b.highlights} highlights`);
  if (b.bookmarks) bits.push(b.bookmarks === 1 ? "1 bookmark" : `${b.bookmarks} bookmarks`);
  if (b.finishedAt) bits.push(`finished ${new Date(b.finishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`);
  const shown: Book = book ?? ({ id: b.bookId, title: b.title, author: b.author, format: b.format, cover: b.cover, fraction: b.fraction, source: "local", grimmoryId: b.grimmoryId } as Book);
  return (
    <button
      type="button"
      className="jr-brow"
      title={`Open ${b.title} (Ctrl+click: in a new window)`}
      onClick={(e) => (e.ctrlKey ? m7.openWindow(b.bookId, null, b.title) : open(b.bookId))}
    >
      <Cover book={shown} size="xs" progress={false} />
      <div>
        <span className={`t ${b.format === "cbz" || b.format === "cbr" ? "ui" : ""}`}>{b.title}</span>
        <small>{bits.join(" · ")}</small>
        <div className="pbar"><i style={{ width: `${pct}%` }} /></div>
      </div>
      <span className="su">{b.finishedAt ? "Done" : `${pct}%`}</span>
    </button>
  );
}

export function JournalPage() {
  const [period, setPeriod] = useState<Period>("year");
  const [j, setJ] = useState<Journal | null>(null);
  const [l, setL] = useState<Learning | null>(null);
  const [review, setReview] = useState(false);
  const [msg, setMsg] = useState("");
  const books = useStore((s) => s.books);

  const load = (p: Period) => {
    m7.journal(p).then(setJ).catch((e) => setMsg(String(e)));
    invoke<Learning>("learning_stats").then(setL).catch(() => {});
  };
  useEffect(() => load(period), [period]);
  // a reading tick in a second window, or a review, changes the numbers
  useEffect(() => {
    const t = window.setInterval(() => document.visibilityState === "visible" && load(period), 60_000);
    const un = listen("library-changed", () => load(period));
    return () => {
      clearInterval(t);
      un.then((f) => f());
    };
  }, [period]);

  const byId = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  if (!j) return <div className="scroll">{msg && <div className="err">{msg}</div>}</div>;

  const streak = streakOf(new Map(j.days), new Date());
  const [wk, wku] = big(j.weekSeconds);
  const [yr, yru] = big(j.yearSeconds);
  const periodName = period === "week" ? "this week" : period === "month" ? "this month" : "this year";

  // days you read: the average minutes on each weekday so far in the period
  const avg = j.weekdays.map((s, i) => (j.weekdayCount[i] ? s / j.weekdayCount[i] : 0));
  const topDay = avg.indexOf(Math.max(...avg));
  // hours each month
  const thisMonth = parse(j.today).getMonth();
  const monthsShown = j.months.slice(0, thisMonth + 1);
  const topMonth = monthsShown.indexOf(Math.max(...monthsShown));
  // pages an hour, week by week: only weeks with at least five minutes of reading count
  const speed = j.speed.map(([d, p, s]) => ({ d, v: s >= 300 ? (p / s) * 3600 : null }));
  const pts = speed.map((x, i) => ({ i, v: x.v })).filter((x): x is { i: number; v: number } => x.v != null);
  const now = pts.length ? Math.round(pts[pts.length - 1].v) : null;
  const firstV = pts.length > 1 ? pts[0].v : null;
  const vmin = Math.min(...pts.map((p) => p.v), Infinity);
  const vmax = Math.max(...pts.map((p) => p.v), -Infinity);
  const y = (v: number) => (vmax === vmin ? 35 : 64 - ((v - vmin) / (vmax - vmin)) * 58);
  const x = (i: number) => (i / 15) * 180;
  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const change = firstV && now != null ? Math.round(((now - firstV) / firstV) * 100) : null;
  const speedLabels = [0, 5, 10, 15].map((i) => parse(j.speed[i][0]).toLocaleDateString("en-GB", { day: "numeric", month: "short" }));

  const best = j.bestDay;
  const hourMax = Math.max(1, ...j.hours);
  const hourTop = j.hours.indexOf(Math.max(...j.hours));
  const hourName = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

  const exportIt = async () => {
    const path = await save({ title: "Export the Journal", defaultPath: `reading-journal-${j.year}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    try {
      await m7.journalExport(path);
      setMsg(`Saved to ${path}`);
    } catch (e) {
      setMsg(String(e));
    }
  };

  const w = l?.words;
  const share = (n: number) => (w && w.total ? `${(n / w.total) * 100}%` : "0");

  return (
    <div className="scroll jr">
      <div className="jr-main">
        <div className="sech">
          <span className="h">
            Journal<span className="c">{j.year}</span>
          </span>
          <div className="pills">
            <div className="seg" role="radiogroup" aria-label="Period">
              {(["week", "month", "year"] as Period[]).map((p) => (
                <button type="button" key={p} role="radio" aria-checked={period === p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>
                  {p[0].toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <button type="button" className="pill" onClick={exportIt} title="The year as Markdown: totals, months and every book">
              <i className="ms">download</i>Export
            </button>
          </div>
        </div>
        {msg && <div className="su" style={{ whiteSpace: "normal" }}>{msg}</div>}
        <div className="jr-stats">
          <div><b>{streak}<small>{streak === 1 ? "day" : "days"}</small></b><span>Streak</span></div>
          <div><b>{wk}<small>{wku}</small></b><span>This week</span></div>
          <div><b>{yr}<small>{yru}</small></b><span>This year</span></div>
          <div><b>{j.finishedYear}</b><span>{j.finishedYear === 1 ? "Book finished" : "Books finished"}</span></div>
        </div>
        <div>
          <div className="jr-lbl">
            Reading days
            {best && best[1] > 0 && ` · best day ${parse(best[0]).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${hm(best[1])}`}
          </div>
          <YearGrid j={j} />
        </div>
        <div>
          <div className="jr-lbl">
            Books {periodName} · {j.books.length}
            {j.books.length > 4 && <span style={{ fontWeight: 500 }}> · scroll for more</span>}
          </div>
          {j.books.length ? (
            <div className={`jr-blist ${j.books.length > 4 ? "fade" : ""}`}>
              {j.books.map((b) => <BookRow key={b.bookId} b={b} book={byId.get(b.bookId)} />)}
            </div>
          ) : (
            <div className="su" style={{ whiteSpace: "normal" }}>
              {j.periodSeconds > 0
                ? `${hm(j.periodSeconds)} read ${periodName}, from before Katana Desk kept time per book.`
                : `Nothing read ${periodName} yet. Time counts while a book is open in front and its pages turn.`}
            </div>
          )}
        </div>
        <div className="jr-charts">
          <div>
            <div className="jr-lbl">Days you read</div>
            <Bars
              vals={avg}
              labels={DAYS}
              top={topDay}
              titles={avg.map((v, i) => `${LONG_DAYS[i]}: ${hm(Math.round(v))} on average`)}
            />
            <div className="jr-note">
              {avg[topDay] > 0 ? (
                <><b>{LONG_DAYS[topDay]}</b> is your day · {hm(Math.round(avg[topDay]))} on average</>
              ) : (
                `No reading ${periodName} yet`
              )}
            </div>
          </div>
          <div>
            <div className="jr-lbl">Hours each month</div>
            <Bars
              vals={j.months}
              labels={MONTHS.map((m, i) => (i % 3 === 0 ? m : ""))}
              top={topMonth}
              titles={j.months.map((v, i) => `${LONG_MONTHS[i]}: ${v ? hm(v) : "none"}`)}
            />
            <div className="jr-note">
              {monthsShown[topMonth] > 0 ? (
                <>Most in <b>{LONG_MONTHS[topMonth]}</b>: {hm(monthsShown[topMonth])}{topMonth === thisMonth ? ", so far" : ""}</>
              ) : (
                "No reading this year yet"
              )}
            </div>
          </div>
          <div>
            <div className="jr-lbl">Pages an hour</div>
            <svg viewBox="0 0 180 70" width="100%" height="70" aria-hidden="true" className="jr-line">
              {pts.length > 1 && <polyline points={line} />}
              {pts.length > 0 && <circle cx={x(pts[pts.length - 1].i)} cy={y(pts[pts.length - 1].v)} r="4" />}
              {!pts.length && <line x1="0" y1="64" x2="180" y2="64" className="none" />}
            </svg>
            <div className="jr-xl">{speedLabels.map((s, i) => <span key={i}>{s}</span>)}</div>
            <div className="jr-note">
              {now != null ? (
                <>
                  <b>{now}</b> this week{pts[pts.length - 1].i < 15 ? " (last read)" : ""}
                  {change != null && Math.abs(change) >= 1 ? ` · ${change > 0 ? "up" : "down"} ${Math.abs(change)}% in ${16 - pts[0].i} weeks` : ""}
                </>
              ) : (
                "Counted from pages turned while reading"
              )}
            </div>
          </div>
        </div>
      </div>
      <aside className="jr-learn" aria-label="What you've learned">
        <div>
          <div className="jr-lhead"><i className="ms">dictionary</i>Your words</div>
          {w && w.total > 0 ? (
            <>
              <div className="jr-big">{w.learned}<small>of {w.total} learned</small></div>
              <div className="jr-split">
                <i style={{ width: share(w.learned), background: "var(--k-tint)" }} />
                <i style={{ width: share(w.learning), background: "var(--k-pri)" }} />
                <i style={{ flex: 1, background: "var(--k-schh)" }} />
              </div>
              <div className="jr-key">
                <span style={{ ["--c" as string]: "var(--k-tint)" }}>Learned {w.learned}</span>
                <span style={{ ["--c" as string]: "var(--k-pri)" }}>Learning {w.learning}</span>
                <span style={{ ["--c" as string]: "var(--k-schh)" }}>New {w.new}</span>
              </div>
              <div className="su jr-wrap">
                {l!.reviews.year} {l!.reviews.year === 1 ? "review" : "reviews"} this year · {w.due} due today
                {l!.reviews.firstTry != null && ` · you remember ${Math.round(l!.reviews.firstTry * 100)}% on the first try`}
              </div>
              <Weeks vals={l!.reviews.weeks} scale={40} />
              <div className="jr-wlab"><span>Reviews, last 12 weeks</span><span>this week</span></div>
              <button type="button" className={`pill ${w.due ? "fill" : ""}`} style={{ marginTop: 12 }} onClick={() => setReview(true)}>
                <i className="ms">style</i>
                {w.due ? `Review ${w.due} ${w.due === 1 ? "word" : "words"}` : "Review your words"}
              </button>
            </>
          ) : (
            <div className="su jr-wrap" style={{ marginTop: 8 }}>
              Double-click a word while reading and save it: its meaning, the sentence and your reviews show here.
            </div>
          )}
        </div>
        <div>
          <div className="jr-lhead"><i className="ms">format_ink_highlighter</i>Going back to your highlights</div>
          <div className="jr-big">{l?.revisits.year ?? 0}<small>{l?.revisits.year === 1 ? "time" : "times"} this year</small></div>
          <div className="su jr-wrap">
            Opened from Marks, Bookmarks or Ctrl K
            {l && l.revisits.notes > 0 && ` · ${l.revisits.notes} ${l.revisits.notes === 1 ? "note" : "notes"} reread`}
            {l && l.revisits.edits > 0 && ` · ${l.revisits.edits} ${l.revisits.edits === 1 ? "highlight" : "highlights"} edited`}
          </div>
          <Weeks vals={l?.revisits.weeks ?? Array(12).fill(0)} scale={40} />
          <div className="jr-wlab"><span>Last 12 weeks</span><span>this week</span></div>
          {l?.revisits.most && (
            <>
              <div className="su" style={{ marginTop: 10 }}>Most revisited</div>
              <div className="jr-most">
                “{l.revisits.most.text.length > 90 ? l.revisits.most.text.slice(0, 88) + "…" : l.revisits.most.text}”{" "}
                <span className="su">· {l.revisits.most.times} times</span>
              </div>
            </>
          )}
        </div>
        <div>
          <div className="jr-lhead"><i className="ms">history</i>When you read</div>
          <div className="jr-hours">
            {j.hours.map((s, h) => (
              <i key={h} style={{ height: Math.max(3, Math.round((s / hourMax) * 60)), opacity: s ? 0.35 + (0.65 * s) / hourMax : 0.15 }} title={`${hourName(h)}: ${s ? hm(s) : "none"}`} />
            ))}
          </div>
          <div className="jr-hlab"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div>
          <div className="su jr-wrap" style={{ marginTop: 6 }}>
            {j.hours[hourTop] > 0 ? `Mostly around ${hourName(hourTop)}, ${periodName}` : "The hours fill in as you read"}
          </div>
        </div>
      </aside>
      {review && (
        <Review
          bookId={null}
          onClose={() => {
            setReview(false);
            load(period);
          }}
        />
      )}
    </div>
  );
}
