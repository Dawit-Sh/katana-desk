// One page of a PDF, DjVu or comic: its picture, drawn sharp for the size it's shown at, an invisible
// text layer over it (for selecting, double-click to look up, find), and the layers for highlights,
// search matches and notes pinned on the page.
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Highlight } from "./marks";
import { hexOf } from "./marks";
import type { PageSource, PageText, Run } from "./pagesrc";
import { parsePlace } from "./pagesrc";

/** A box on the page, as fractions of it. */
export type Box = { x: number; y: number; w: number; h: number };
export type Hit = { page: number; s: number; e: number };

let measureCtx: CanvasRenderingContext2D | null = null;
const measure = (text: string, px: number) => {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = `${px}px sans-serif`;
  return measureCtx.measureText(text).width;
};

/** The boxes that words s..e cover on a page, from the text layer as laid out now. */
export function boxesOf(layer: HTMLElement | null, s: number, e: number): Box[] {
  if (!layer) return [];
  const page = layer.getBoundingClientRect();
  if (!page.width || !page.height) return [];
  const out: Box[] = [];
  for (const span of layer.children as HTMLCollectionOf<HTMLElement>) {
    const rs = Number(span.dataset.s);
    const re = Number(span.dataset.e);
    if (re <= s || rs >= e) continue;
    const node = span.firstChild;
    if (!node) continue;
    const r = document.createRange();
    const len = node.textContent?.length ?? 0;
    r.setStart(node, Math.max(0, Math.min(len, s - rs)));
    r.setEnd(node, Math.max(0, Math.min(len, e - rs)));
    for (const b of r.getClientRects()) {
      if (b.width < 0.5 || b.height < 0.5) continue;
      out.push({ x: (b.left - page.left) / page.width, y: (b.top - page.top) / page.height, w: b.width / page.width, h: b.height / page.height });
    }
  }
  // one box per line: pieces on the same line join
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: Box[] = [];
  for (const b of out) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(m.y - b.y) < m.h * 0.5 && Math.abs(m.h - b.h) < m.h * 0.6 && b.x <= m.x + m.w + m.h * 1.2) {
      const x2 = Math.max(m.x + m.w, b.x + b.w);
      const y2 = Math.max(m.y + m.h, b.y + b.h);
      m.x = Math.min(m.x, b.x);
      m.y = Math.min(m.y, b.y);
      m.w = x2 - m.x;
      m.h = y2 - m.y;
    } else merged.push({ ...b });
  }
  return merged;
}

/** Where words s..e sit when the text layer isn't laid out: from the runs alone (good enough to scroll to). */
export function roughBox(t: PageText | null, s: number): Box | null {
  const r = t?.runs.find((x) => x.e > s) ?? t?.runs[t.runs.length - 1];
  return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
}

function TextLayer({ text, height, layerRef }: { text: PageText; height: number; layerRef: (el: HTMLDivElement | null) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // spans keep their place in percent; their size follows the page's height, each stretched to its run's width
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !height) return;
    const width = el.clientWidth || 1;
    for (const span of el.children as HTMLCollectionOf<HTMLElement>) {
      const r = text.runs[Number(span.dataset.i)];
      const px = Math.max(1, r.h * height);
      span.style.fontSize = `${px}px`;
      const natural = measure(span.textContent ?? "", px);
      const want = r.w * width;
      const sx = natural > 0 && want > 0 ? want / natural : 1;
      span.style.transform = `${r.a ? `rotate(${r.a}rad) ` : ""}scaleX(${sx})`;
    }
  }, [text, height]);
  return (
    <div
      className="ptl"
      ref={(el) => {
        ref.current = el;
        layerRef(el);
      }}
    >
      {text.runs.map((r: Run, i) => (
        <span key={i} data-i={i} data-s={r.s} data-e={r.e} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }}>
          {text.str.slice(r.s, r.e)}
        </span>
      ))}
    </div>
  );
}

export const PageView = memo(function PageView({
  src,
  index,
  w,
  h,
  dpr,
  highlights,
  hits,
  current,
  marked,
  version,
  onLayer,
  onPinClick,
  onCorner,
  onSize,
}: {
  src: PageSource;
  index: number;
  w: number;
  h: number;
  dpr: number;
  highlights: Highlight[];
  hits: Hit[];
  /** the find match you're on, when it's on this page */
  current: Hit | null;
  marked: boolean;
  /** bumps when highlights are redrawn (a colour changed, the page laid out again) */
  version: number;
  onLayer: (index: number, el: HTMLDivElement | null) => void;
  onPinClick: (h: Highlight, el: HTMLElement) => void;
  onCorner: (index: number) => void;
  /** a comic page's real size, once its picture is in */
  onSize?: (index: number, w: number, h: number) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<PageText | null>(null);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [boxes, setBoxes] = useState<{ hl: { h: Highlight; b: Box[] }[]; hits: { hit: Hit; b: Box[] }[] }>({ hl: [], hits: [] });

  // the picture: drawn again when the size it's shown at changes enough (a moment after the last change)
  const drawnW = useRef(0);
  useEffect(() => {
    if (!w) return;
    const need = Math.round(w);
    const close = drawnW.current && Math.abs(need - drawnW.current) / drawnW.current < 0.04;
    if (close) return;
    let job: ReturnType<PageSource["draw"]> | null = null;
    const t = window.setTimeout(
      () => {
        job = src.draw(index, need, dpr);
        job.el
          .then((el) => {
            const box = holder.current;
            if (!box) return;
            el.className = "pgpic";
            box.replaceChildren(el);
            drawnW.current = need;
            setFailed(false);
            if (el instanceof HTMLImageElement && onSize && src.kind === "comic") onSize(index, el.naturalWidth, el.naturalHeight);
          })
          .catch((e) => {
            if (String(e?.message ?? e) !== "cancelled" && !/cancel/i.test(String(e?.name ?? ""))) setFailed(true);
          });
      },
      drawnW.current ? 140 : 0,
    );
    return () => {
      clearTimeout(t);
      job?.cancel();
    };
  }, [src, index, w, dpr, onSize]);

  // the words
  useEffect(() => {
    if (!src.hasText) return;
    let live = true;
    src.text(index).then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [src, index]);

  useEffect(() => {
    onLayer(index, layer);
    return () => onLayer(index, null);
  }, [layer, index, onLayer]);

  // highlights and matches: boxes worked out from the laid-out words
  useLayoutEffect(() => {
    if (!layer) {
      setBoxes({ hl: [], hits: [] });
      return;
    }
    const hl = highlights
      .map((x) => {
        const p = parsePlace(x.cfi);
        return p && p.s != null && p.e != null ? { h: x, b: boxesOf(layer, p.s, p.e) } : null;
      })
      .filter((x): x is { h: Highlight; b: Box[] } => !!x && x.b.length > 0);
    const hb = hits.map((hit) => ({ hit, b: boxesOf(layer, hit.s, hit.e) })).filter((x) => x.b.length);
    setBoxes({ hl, hits: hb });
  }, [layer, highlights, hits, h, w, version, text]);

  const pct = (b: Box) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });

  return (
    <div className="pg" data-page={index} style={{ width: w, height: h }}>
      <div className="pgimg" ref={holder} />
      {failed && (
        <div className="pgfail">
          <i className="ms">broken_image</i>
          <span>This page couldn't be drawn</span>
        </div>
      )}
      <div className="hl-layer" aria-hidden="true">
        {boxes.hits.map(({ hit, b }) =>
          b.map((x, k) => <i key={`${hit.s}-${k}`} className={`hitbox ${current && current.s === hit.s && current.page === hit.page ? "on" : ""}`} style={pct(x)} />),
        )}
        {boxes.hl.map(({ h: hh, b }) =>
          b.map((x, k) => <i key={`${hh.id}-${k}`} data-id={hh.id} className={`hlbox ${hh.style}`} style={{ ...pct(x), "--c": hexOf(hh.color) } as React.CSSProperties} />),
        )}
      </div>
      {text && <TextLayer text={text} height={h} layerRef={setLayer} />}
      {boxes.hl
        .filter((x) => x.h.note?.trim())
        .map(({ h: hh, b }) => {
          const last = b[b.length - 1];
          return (
            <button
              key={`pin${hh.id}`}
              type="button"
              className="pin"
              style={{ left: `calc(${(last.x + last.w) * 100}% + 2px)`, top: `calc(${last.y * 100}% - 14px)`, "--c": hexOf(hh.color) } as React.CSSProperties}
              title={hh.note ?? ""}
              aria-label="Note on this highlight"
              onClick={(e) => {
                e.stopPropagation();
                onPinClick(hh, e.currentTarget);
              }}
            >
              <i className="ms">edit_note</i>
            </button>
          );
        })}
      <button
        type="button"
        className={`pcorner ${marked ? "on" : ""}`}
        aria-label={marked ? "Remove the bookmark on this page" : "Bookmark this page"}
        title={marked ? "Remove the bookmark (Ctrl B)" : "Bookmark this page (Ctrl B)"}
        onClick={(e) => {
          e.stopPropagation();
          onCorner(index);
        }}
      >
        <span className="ribbon" />
      </button>
    </div>
  );
});
