// One page of a PDF, DjVu or comic: its picture, drawn sharp for the size it's shown at, an invisible
// text layer over it (for selecting, double-click to look up, find), and the layers for highlights,
// search matches and notes pinned on the page.
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Annot, Highlight } from "./marks";
import { hexOf } from "./marks";
import type { PageSource, PageText, Run } from "./pagesrc";
import { parsePlace } from "./pagesrc";

/** A box on the page, as fractions of it. */
export type Box = { x: number; y: number; w: number; h: number };
export type Hit = { page: number; s: number; e: number };
/** Katana's pen: its colour (hex) and width, or the eraser. */
export type Pen = { color: string; width: number; erase: boolean };
type Pt = { x: number; y: number };

const R = (r: any) => ({ x: Number(r?.origin?.x) || 0, y: Number(r?.origin?.y) || 0, w: Number(r?.size?.width) || 0, h: Number(r?.size?.height) || 0 });

/** One annotation from Grimmory's PDF reader (or Katana's pen), drawn in PDF points. */
function AnnotShape({ a }: { a: Annot }) {
  const x = a.data?.annotation ?? {};
  const col = x.strokeColor ?? x.color ?? "#FFEB3B";
  const op = typeof x.opacity === "number" ? x.opacity : 1;
  const segs = (Array.isArray(x.segmentRects) && x.segmentRects.length ? x.segmentRects : [x.rect]).map(R);
  switch (x.type) {
    case 15: {
      const w = Number(x.strokeWidth) || 2;
      return (
        <g data-aid={a.aid} opacity={op}>
          {(x.inkList ?? []).map((l: { points: Pt[] }, i: number) => (
            <polyline key={i} points={(l.points ?? []).map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={col} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </g>
      );
    }
    case 9:
      return (
        <g data-aid={a.aid} className="amark">
          {segs.map((r: ReturnType<typeof R>, i: number) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={col} opacity={Math.min(op, 0.6)} />)}
        </g>
      );
    case 10:
    case 12:
    case 11:
      return (
        <g data-aid={a.aid} opacity={op}>
          {segs.map((r: ReturnType<typeof R>, i: number) => {
            const y = x.type === 12 ? r.y + r.h / 2 : r.y + r.h - 1;
            if (x.type !== 11) return <line key={i} x1={r.x} y1={y} x2={r.x + r.w} y2={y} stroke={col} strokeWidth={Math.max(1, r.h / 12)} />;
            const pts: string[] = [];
            for (let k = 0, X = r.x; X <= r.x + r.w; X += 2, k++) pts.push(`${X},${y - (k % 2 ? 1.5 : 0)}`);
            return <polyline key={i} points={pts.join(" ")} fill="none" stroke={col} strokeWidth={1} />;
          })}
        </g>
      );
    case 3: {
      const r = R(x.rect);
      const size = Number(x.fontSize) || 12;
      const lines = String(x.contents ?? "").split("\n");
      return (
        <text data-aid={a.aid} x={r.x + 2} y={r.y + size} fontSize={size} fill={x.fontColor ?? "#000000"} opacity={op}>
          {lines.map((l, i) => <tspan key={i} x={r.x + 2} dy={i ? size * 1.2 : 0}>{l}</tspan>)}
        </text>
      );
    }
    case 5:
    case 6: {
      const r = R(x.rect);
      const sw = Number(x.strokeWidth) || 1;
      return x.type === 5 ? (
        <rect data-aid={a.aid} x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={col} strokeWidth={sw} opacity={op} />
      ) : (
        <ellipse data-aid={a.aid} cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} fill="none" stroke={col} strokeWidth={sw} opacity={op} />
      );
    }
    case 7:
    case 8: {
      const pts = (x.vertices ?? []).map((p: Pt) => `${p.x},${p.y}`).join(" ");
      return x.type === 7 ? (
        <polygon data-aid={a.aid} points={pts} fill="none" stroke={col} strokeWidth={Number(x.strokeWidth) || 1} opacity={op} />
      ) : (
        <polyline data-aid={a.aid} points={pts} fill="none" stroke={col} strokeWidth={Number(x.strokeWidth) || 1} opacity={op} />
      );
    }
    case 4: {
      const l = x.linePoints;
      if (!l?.start || !l?.end) return null;
      return <line data-aid={a.aid} x1={l.start.x} y1={l.start.y} x2={l.end.x} y2={l.end.y} stroke={col} strokeWidth={Number(x.strokeWidth) || 1} opacity={op} />;
    }
    default:
      return null;
  }
}

/** Drawings over a PDF page, and Katana's pen: strokes in PDF points, the eraser takes one away. */
function InkLayer({
  annots,
  pt,
  pen,
  onStroke,
  onErase,
}: {
  annots: Annot[];
  pt: { w: number; h: number };
  pen: Pen | null;
  onStroke: (pts: Pt[]) => void;
  onErase: (aid: string) => void;
}) {
  const [live, setLive] = useState<Pt[] | null>(null);
  const down = useRef(false);
  const svg = useRef<SVGSVGElement | null>(null);
  if (!annots.length && !pen) return null;
  const at = (e: React.PointerEvent): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * pt.w * 100) / 100, y: Math.round(((e.clientY - r.top) / r.height) * pt.h * 100) / 100 };
  };
  const erase = (e: React.PointerEvent) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-aid]");
    const aid = el?.getAttribute("data-aid");
    if (aid) onErase(aid);
  };
  return (
    <svg
      ref={svg}
      className={`ink-layer ${pen ? (pen.erase ? "erasing" : "drawing") : ""}`}
      viewBox={`0 0 ${pt.w} ${pt.h}`}
      preserveAspectRatio="none"
      onPointerDown={(e) => {
        if (!pen || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        down.current = true;
        if (pen.erase) erase(e);
        else setLive([at(e)]);
      }}
      onPointerMove={(e) => {
        if (!pen || !down.current) return;
        if (pen.erase) erase(e);
        else setLive((l) => (l ? [...l, at(e)] : l));
      }}
      onPointerUp={(e) => {
        if (!pen || !down.current) return;
        down.current = false;
        e.stopPropagation();
        if (!pen.erase && live && live.length > 1) onStroke(live);
        setLive(null);
      }}
      onClick={(e) => pen && e.stopPropagation()}
      onDoubleClick={(e) => pen && e.stopPropagation()}
    >
      {annots.map((a) => <AnnotShape key={a.aid} a={a} />)}
      {live && pen && (
        <polyline points={live.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={pen.color} strokeWidth={pen.width} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

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
  annots,
  pt,
  pen,
  onRects,
  onStroke,
  onErase,
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
  /** a PDF's drawings on this page, and the page's size in PDF points */
  annots?: Annot[];
  pt?: { w: number; h: number };
  pen?: Pen | null;
  /** the words' boxes of the highlights on this page, once laid out (they go to Grimmory with them) */
  onRects?: (h: Highlight, b: Box[]) => void;
  onStroke?: (index: number, pts: Pt[]) => void;
  onErase?: (aid: string) => void;
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
    if (onRects) for (const x of hl) onRects(x.h, x.b);
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
      {pt && (annots?.length || pen) ? (
        <InkLayer
          annots={annots ?? []}
          pt={pt}
          pen={pen ?? null}
          onStroke={(pts) => onStroke?.(index, pts)}
          onErase={(aid) => onErase?.(aid)}
        />
      ) : null}
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
