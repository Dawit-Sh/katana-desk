// One scale for reading days, in the sidebar's Reading card and the Journal's year: how a day's reading
// compares with the daily goal (30 min unless changed in Settings › Reading defaults or the Journal), in
// five steps: no reading, under half the goal, under the goal, goal met, twice the goal or more. The
// colours are the theme's own accent, lighter to stronger (--hm0 to --hm4 in styles/reading-card.css).
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { api } from "./api";

export const GOALS = [10, 15, 20, 30, 45, 60, 90, 120];
const DEFAULT_GOAL = 30;

/** The daily reading goal in minutes, kept in the setting `reading.goal`. */
export const useGoal = create<{ goal: number; setGoal: (m: number) => void }>((set) => ({
  goal: DEFAULT_GOAL,
  setGoal: (goal) => {
    set({ goal });
    api.setSetting("reading.goal", String(goal)).catch(() => {});
  },
}));
api
  .getSetting("reading.goal")
  .then((v) => {
    const g = Number(v);
    if (v && g >= 5 && g <= 600) useGoal.setState({ goal: g });
  })
  .catch(() => {});

/** The five steps' names for a goal. */
export function heatSteps(goal: number): string[] {
  return ["No reading", `Under ${goal / 2} min`, `Under ${goal} min (your goal)`, "Goal met", `Twice your goal (${goal * 2} min or more)`];
}

/** A day's reading time (seconds) as a step from 0 to 4, against the goal (minutes). */
export function heatLevel(secs: number, goal: number): number {
  const m = secs / 60;
  if (m <= 0) return 0;
  return m < goal / 2 ? 1 : m < goal ? 2 : m < goal * 2 ? 3 : 4;
}

/** How far a day is from the goal: "12 min short of your goal", "goal met", "twice your goal". */
export function goalNote(secs: number, goal: number): string {
  const m = Math.round(secs / 60);
  if (secs <= 0) return "no reading";
  if (m >= goal * 2) return "twice your goal";
  if (m >= goal) return "goal met";
  return `${goal - m} min short of your goal`;
}

/** "Fri 14 Nov" */
export const dayName = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** A day's reading in the tooltips: "42 min", "1 h 12", "under a minute". */
export const dayTime = (secs: number) => {
  const m = Math.round(secs / 60);
  if (secs > 0 && m === 0) return "under a minute";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`;
};

/** "Less ▢▢▢▢▢ More", each square named on hover. */
export function HeatKey() {
  const goal = useGoal((g) => g.goal);
  return (
    <span className="hmkey" aria-label="Less to more reading">
      Less
      {heatSteps(goal).map((name, i) => (
        <i key={i} className={`l${i}`} title={name} />
      ))}
      More
    </span>
  );
}

/**
 * A reading day's tooltip: the date and its minutes, then how far from the goal (and what a click does).
 * Drawn on top of everything, kept inside the window.
 */
export function DayTip({ at, day, secs, hint }: { at: DOMRect; day: string; secs: number; hint?: string }) {
  const goal = useGoal((g) => g.goal);
  const box = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState<number | null>(null);
  const cx = at.left + at.width / 2;
  useLayoutEffect(() => {
    const w = box.current?.offsetWidth ?? 0;
    setLeft(Math.max(8, Math.min(window.innerWidth - w - 8, cx - w / 2)));
  }, [cx, day]);
  const [y, m, d] = day.split("-").map(Number);
  const note = goalNote(secs, goal);
  return createPortal(
    <div
      ref={box}
      className="daytip"
      role="tooltip"
      style={{ left: left ?? -9999, top: at.top - 8, ["--ax" as string]: `${left == null ? 0 : cx - left}px` }}
    >
      {dayName(new Date(y, m - 1, d))} · {secs > 0 ? dayTime(secs) : "no reading"}
      {(secs > 0 || hint) && (
        <small>
          {secs > 0 ? note[0].toUpperCase() + note.slice(1) : ""}
          {secs > 0 && hint ? " · " : ""}
          {hint}
        </small>
      )}
    </div>,
    document.body,
  );
}
