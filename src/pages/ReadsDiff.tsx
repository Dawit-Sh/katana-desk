// Compare two reads of a book, side by side like a diff: what stood out on the first read on the left,
// on the second on the right. A passage marked both times sits on one row; one only in the first read
// is red on the left, one only in the second green on the right. Matching goes by the words (the same
// passage, or one inside the other, or most of the same words) and, for bookmarks, by the page.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { allMarks, byPlace, type Mark } from "../reader/marklist";
import { hexOf, type Bookmark, type Highlight } from "../reader/marks";
import { plural } from "../lib/format";

export type Reads = {
  current: number;
  reads: { n: number; startedAt: number | null; highlights: number; bookmarks: number }[];
  hl: Record<number, number>;
  bm: Record<number, number>;
};

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** How much two marks are the same passage, 0 to 1. */
function same(a: Mark, b: Mark): number {
  if (a.kind !== b.kind) return 0;
  if (a.kind === "bm" && b.kind === "bm") {
    if (a.cfi === b.cfi) return 1;
    return a.b.pageLabel && a.b.pageLabel === b.b.pageLabel ? 0.9 : 0;
  }
  if (a.kind !== "hl" || b.kind !== "hl") return 0;
  const x = words(a.h.text).join(" ");
  const y = words(b.h.text).join(" ");
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const wa = new Set(x.split(" "));
  const wb = new Set(y.split(" "));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const r = common / Math.min(wa.size, wb.size);
  return r >= 0.6 ? r * 0.8 : 0;
}

type Row = { a: Mark | null; b: Mark | null };

export function pairUp(left: Mark[], right: Mark[]): Row[] {
  const taken = new Set<number>();
  const rows: Row[] = [];
  for (const a of left) {
    let best = -1;
    let score = 0;
    right.forEach((b, j) => {
      if (taken.has(j)) return;
      const s = same(a, b);
      if (s > score) {
        score = s;
        best = j;
      }
    });
    if (best >= 0) {
      taken.add(best);
      rows.push({ a, b: right[best] });
    } else rows.push({ a, b: null });
  }
  right.forEach((b, j) => {
    if (!taken.has(j)) rows.push({ a: null, b });
  });
  return rows.sort((p, q) => byPlace((p.a ?? p.b)!, (q.a ?? q.b)!));
}

const readName = (n: number) => `Read ${n}`;
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null);

function Cell({ m, side }: { m: Mark | null; side: "a" | "b" }) {
  if (!m) return <div className={`dcell empty ${side}`} />;
  const page = m.kind === "hl" ? m.h.pageLabel : m.b.pageLabel;
  if (m.kind === "bm") {
    return (
      <div className={`dcell ${side}`}>
        <span className="dbar bm" />
        <div>
          <div className="dtext ui">
            <i className="ms">bookmark</i> {m.b.title?.trim() || m.b.excerpt?.slice(0, 120) || "Bookmark"}
          </div>
          {m.b.note && <div className="dnote">{m.b.note}</div>}
          <div className="dmeta">Bookmark{page ? ` · p. ${page}` : ""}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={`dcell ${side}`}>
      <span className="dbar" style={{ background: hexOf(m.h.color) }} />
      <div>
        <div className="dtext">{m.h.text}</div>
        {m.h.note && <div className="dnote">{m.h.note}</div>}
        <div className="dmeta">{[m.h.style === "highlight" ? "Highlight" : m.h.style[0].toUpperCase() + m.h.style.slice(1), page ? `p. ${page}` : null, m.h.chapter].filter(Boolean).join(" · ")}</div>
      </div>
    </div>
  );
}

export function ReadsDiff({
  title,
  reads,
  hl,
  bm,
  onClose,
}: {
  title: string;
  reads: Reads;
  hl: Highlight[];
  bm: Bookmark[];
  onClose: () => void;
}) {
  const ns = reads.reads.map((r) => r.n);
  const [a, setA] = useState(ns[ns.length - 2] ?? 1);
  const [b, setB] = useState(ns[ns.length - 1] ?? 1);
  const [only, setOnly] = useState<"all" | "changes">("all");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);
  const of = (n: number) => allMarks(hl.filter((h) => (reads.hl[h.id] ?? 1) === n), bm.filter((x) => (reads.bm[x.id] ?? 1) === n));
  const rows = useMemo(() => pairUp(of(a), of(b)), [a, b, hl, bm, reads]); // eslint-disable-line react-hooks/exhaustive-deps
  const gone = rows.filter((r) => r.a && !r.b).length;
  const added = rows.filter((r) => r.b && !r.a).length;
  const both = rows.filter((r) => r.a && r.b).length;
  const shown = only === "changes" ? rows.filter((r) => !(r.a && r.b)) : rows;
  const pick = (cur: number, set: (n: number) => void, other: number) => (
    <span className="seg">
      {ns.map((n) => (
        <button type="button" key={n} className={cur === n ? "on" : ""} disabled={n === other} onClick={() => set(n)}>
          {readName(n)}
        </button>
      ))}
    </span>
  );
  const r = (n: number) => reads.reads.find((x) => x.n === n);
  return createPortal(
    <div className="diffwrap" role="dialog" aria-label={`Compare reads of ${title}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="diff">
        <header className="dhead">
          <div className="rct">
            <span className="ti">{title}</span>
            <span className="su">
              <b className="minus">−{gone}</b> only in {readName(a)} · <b className="plus">+{added}</b> only in {readName(b)} · {plural(both, "passage")} in both
            </span>
          </div>
          <span className="seg">
            <button type="button" className={only === "all" ? "on" : ""} onClick={() => setOnly("all")}>Everything</button>
            <button type="button" className={only === "changes" ? "on" : ""} onClick={() => setOnly("changes")}>Only changes</button>
          </span>
          <button type="button" className="ib" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <i className="ms">close</i>
          </button>
        </header>
        <div className="dcols">
          <div className="dside a">
            {pick(a, setA, b)}
            <small>{[when(r(a)?.startedAt ?? null) && `started ${when(r(a)?.startedAt ?? null)}`, plural((r(a)?.highlights ?? 0) + (r(a)?.bookmarks ?? 0), "mark")].filter(Boolean).join(" · ")}</small>
          </div>
          <div className="dside b">
            {pick(b, setB, a)}
            <small>{[when(r(b)?.startedAt ?? null) && `started ${when(r(b)?.startedAt ?? null)}`, plural((r(b)?.highlights ?? 0) + (r(b)?.bookmarks ?? 0), "mark")].filter(Boolean).join(" · ")}</small>
          </div>
        </div>
        <div className="drows">
          {shown.map((row, i) => (
            <div key={i} className={`drow ${row.a && row.b ? "same" : row.a ? "gone" : "added"}`}>
              <span className="dsign" aria-hidden="true">{row.a && row.b ? "" : row.a ? "−" : "+"}</span>
              <Cell m={row.a} side="a" />
              <Cell m={row.b} side="b" />
            </div>
          ))}
          {!shown.length && <div className="bmmsg dempty">{rows.length ? "No changes between these two reads." : "Neither read has marks yet."}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
