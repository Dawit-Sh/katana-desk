// One scale for reading days, in the sidebar's Reading card and the Journal's year: how long you read that
// day, in five steps. "A lot" is an hour and a half or more. The colours are the theme's own accent (the
// green of Graphite and Paper), lighter to stronger (see --hm0 to --hm4 in styles/reading-card.css).

export const HEAT_STEPS: { level: number; name: string }[] = [
  { level: 0, name: "No reading" },
  { level: 1, name: "Under 15 min" },
  { level: 2, name: "15 to 45 min" },
  { level: 3, name: "45 to 90 min" },
  { level: 4, name: "90 min or more" },
];

/** A day's reading time (seconds) as a step from 0 to 4. */
export function heatLevel(secs: number): number {
  const m = secs / 60;
  return m <= 0 ? 0 : m < 15 ? 1 : m < 45 ? 2 : m < 90 ? 3 : 4;
}

/** "Less ▢▢▢▢▢ More", each square named on hover. */
export function HeatKey() {
  return (
    <span className="hmkey" aria-label="Less to more reading">
      Less
      {HEAT_STEPS.map((s) => (
        <i key={s.level} className={`l${s.level}`} title={s.name} />
      ))}
      More
    </span>
  );
}
