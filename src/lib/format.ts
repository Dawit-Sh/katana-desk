export const fmtSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
};

/** 12-hour times, like 9:42 AM. */
export const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export const fmtDate = (ms: number) => {
  const d = new Date(ms);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-GB", opts);
};

export const fmtWhen = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today, ${fmtTime(ms)}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${fmtTime(ms)}`;
  return fmtDate(ms);
};

export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const progressLabel = (fraction: number | null, readable: boolean, format: string) => {
  if (!readable) return format.toUpperCase();
  if (fraction == null || fraction <= 0) return "Not started";
  if (fraction >= 0.995) return "Finished";
  const p = Math.round(fraction * 100);
  return p < 1 ? "Just started" : `${p}%`;
};
