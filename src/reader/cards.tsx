// The selection card (select words: colour dots, Note, Copy, Look up) and the highlight card (click a
// highlight: its style and colour as pictures, its note, Copy, Delete). Both float over the page next
// to the words, above them when there's room.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { COLOURS, STYLES, hexOf, type Colour, type Highlight, type Style } from "./marks";

/** Where a card points: the words' box in the reader's coordinates. */
export type Anchor = { left: number; right: number; top: number; bottom: number };

/** Places a card of `w` x `h` next to the words: above them, else below, kept inside the reader. */
function placeCard(a: Anchor, w: number, h: number, roomW: number, roomH: number) {
  const gap = 12;
  const top = 56;
  const bottom = roomH - 64;
  const above = a.top - gap - h >= top;
  const below = a.bottom + gap + h <= bottom;
  const cx = (a.left + a.right) / 2;
  if (!above && !below) {
    // a tall card: beside the words, on the side with more room, so it never covers them
    const right = a.right + gap + w <= roomW - 12;
    const left = a.left - gap - w >= 12;
    if (right || left) {
      const x = right && (!left || roomW - a.right > a.left) ? a.right + gap : a.left - gap - w;
      const y = Math.max(top, Math.min(bottom - h, (a.top + a.bottom) / 2 - h / 2));
      return { left: x, top: y };
    }
  }
  const y = above ? a.top - gap - h : below ? a.bottom + gap : Math.max(top, Math.min(bottom - h, a.bottom + gap));
  const x = Math.max(12, Math.min(roomW - w - 12, cx - w / 2));
  return { left: x, top: y };
}

export function useCardPlace(anchor: Anchor, room: { w: number; h: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => setPos(placeCard(anchor, el.offsetWidth, el.offsetHeight, room.w || el.parentElement?.clientWidth || 0, room.h || el.parentElement?.clientHeight || 0));
    place();
    // a card that grows (a note typed or added) is placed again so it never covers the words
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor.left, anchor.right, anchor.top, anchor.bottom, room.w, room.h]);
  const style: CSSProperties = pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 };
  return { ref, style };
}

/** A style as a little picture of the result, in the colour it would take. */
export function StylePic({ style, colour }: { style: Style; colour: Colour }) {
  const c = hexOf(colour);
  const s: CSSProperties =
    style === "highlight"
      ? { background: `color-mix(in srgb, ${c} 45%, transparent)`, borderRadius: 3, padding: "0 3px" }
      : style === "underline"
        ? { textDecoration: `underline 2px ${c}`, textUnderlineOffset: 4 }
        : style === "strikethrough"
          ? { textDecoration: `line-through 2px ${c}` }
          : { textDecoration: `underline wavy 1.5px ${c}`, textUnderlineOffset: 4 };
  return (
    <span className="spic" aria-hidden="true">
      <span style={s}>Ab</span>
    </span>
  );
}

export function SelectionCard({
  anchor,
  room,
  look,
  lookUp,
  onColour,
  onNote,
  onCopy,
  onLookUp,
}: {
  anchor: Anchor;
  room: { w: number; h: number };
  look: { color: Colour; style: Style };
  /** a word or a few: what Look up would look up (the dictionaries come in the next version) */
  lookUp: string | null;
  onColour: (c: Colour) => void;
  onNote: () => void;
  onCopy: () => void;
  onLookUp: () => void;
}) {
  const { ref, style } = useCardPlace(anchor, room);
  return (
    <div ref={ref} className="pop selcard" style={style} role="toolbar" aria-label="Selected words" onMouseDown={(e) => e.preventDefault()}>
      <div className="acts">
        <button type="button" className="act" onClick={() => onColour(look.color)} title="Highlight in the last colour and style (H)">
          <i className="ms">format_ink_highlighter</i>Highlight<kbd>H</kbd>
        </button>
        <button type="button" className="act" onClick={onNote} title="Highlight with a note (N)">
          <i className="ms">edit_note</i>Note<kbd>N</kbd>
        </button>
        <button type="button" className="act" onClick={onCopy} title="Copy the words (Ctrl C)">
          <i className="ms">content_copy</i>Copy<kbd>C</kbd>
        </button>
        <button
          type="button"
          className="act"
          onClick={onLookUp}
          disabled={!lookUp}
          title={lookUp ? `Look up “${lookUp}” (L)` : "Select a word or a few to look them up"}
        >
          <i className="ms">dictionary</i>Look up<kbd>L</kbd>
        </button>
      </div>
      <div className="dots">
        {COLOURS.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className={`dot ${look.color === c.id ? "on" : ""}`}
            style={{ "--c": c.hex } as CSSProperties}
            aria-label={`${c.name} ${look.style === "highlight" ? "highlight" : look.style}`}
            title={`${c.name} (${i + 1})`}
            onClick={() => onColour(c.id)}
          >
            <StyleMark style={look.style} />
          </button>
        ))}
        <span className="hint">One click highlights in that colour</span>
      </div>
    </div>
  );
}

/** What a dot draws on the words in the current style: a fill, or a line under or through. */
function StyleMark({ style }: { style: Style }) {
  if (style === "highlight") return null;
  const d = style === "underline" ? "M3 11.5h8" : style === "strikethrough" ? "M3 7h8" : "M2.5 11l1.5-1.5 1.5 1.5 1.5-1.5 1.5 1.5 1.5-1.5 1.5 1.5";
  return (
    <svg className="dmark" viewBox="0 0 14 14" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function HighlightCard({
  h,
  anchor,
  room,
  editing,
  onEdit,
  onLook,
  onNote,
  onCopy,
  onShare,
  onDelete,
}: {
  h: Highlight;
  anchor: Anchor;
  room: { w: number; h: number };
  editing: boolean;
  onEdit: (on: boolean) => void;
  onLook: (color: Colour, style: Style) => void;
  onNote: (note: string | null) => void;
  onCopy: () => void;
  /** Share as an image */
  onShare?: () => void;
  onDelete: () => void;
}) {
  const { ref, style } = useCardPlace(anchor, room);
  const [draft, setDraft] = useState(h.note ?? "");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(h.note ?? "");
      requestAnimationFrame(() => {
        const t = ta.current;
        if (t) {
          t.focus();
          t.setSelectionRange(t.value.length, t.value.length);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const save = () => {
    const n = draft.trim();
    if ((n || null) !== (h.note ?? null)) onNote(n || null);
    onEdit(false);
  };
  return (
    <div ref={ref} className="pop hcard" style={style} role="dialog" aria-label="Highlight">
      <div className="srow" role="radiogroup" aria-label="Style">
        {STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={h.style === s.id}
            className={`stile ${h.style === s.id ? "on" : ""}`}
            title={s.name}
            aria-label={s.name}
            onClick={() => onLook(h.color, s.id)}
          >
            <StylePic style={s.id} colour={h.color} />
          </button>
        ))}
      </div>
      <div className="crow" role="radiogroup" aria-label="Colour">
        {COLOURS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={h.color === c.id}
            className={`dot ${h.color === c.id ? "on" : ""}`}
            style={{ "--c": c.hex } as CSSProperties}
            aria-label={c.name}
            title={c.name}
            onClick={() => onLook(c.id, h.style)}
          />
        ))}
      </div>
      {editing ? (
        <div className="note edit">
          <textarea
            ref={ta}
            value={draft}
            rows={3}
            placeholder="Your note"
            aria-label="Note"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                onEdit(false);
              } else if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <div className="nfoot">
            <small>Enter saves · Shift Enter for a new line</small>
            <span className="grow" />
            <button type="button" className="pill tone" onClick={() => onEdit(false)}>
              Cancel
            </button>
            <button type="button" className="pill fill" onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={`note ${h.note ? "" : "empty"}`} onClick={() => onEdit(true)}>
          {h.note ? <span className="ntext">{h.note}</span> : <span className="nadd"><i className="ms">edit_note</i>Add a note</span>}
          {h.note && <small>Note · click to edit</small>}
        </button>
      )}
      <div className="iconrow">
        <button type="button" className="pbtn" aria-label="Copy the words" title="Copy the words" onClick={onCopy}>
          <i className="ms">content_copy</i>
        </button>
        {onShare && (
          <button type="button" className="pbtn" aria-label="Share as an image" title="Share as an image" onClick={onShare}>
            <i className="ms">share</i>
          </button>
        )}
        <button type="button" className="pbtn" aria-label="Delete the highlight" title="Delete the highlight (Delete)" onClick={onDelete}>
          <i className="ms">delete</i>
        </button>
      </div>
    </div>
  );
}

/** Copies text, with a fallback for when the clipboard API is refused. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* below */
  }
  const t = document.createElement("textarea");
  t.value = text;
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.append(t);
  t.select();
  document.execCommand("copy");
  t.remove();
}
