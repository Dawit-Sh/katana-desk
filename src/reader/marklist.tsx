// One list of a book's marks, in reading order under their chapters: highlights with their colour and
// note, bookmarks with their name, first words and note. Used by the reader's marks panel and by the
// Bookmarks page. Bookmarks are named and given a note right in the list.
import { useState } from "react";
import { compare as cfiCompare } from "foliate-js/epubcfi.js";
import { fmtWhen } from "../lib/format";
import { hexOf, placeLabel, styleName, type Bookmark, type Highlight } from "./marks";

export type Tab = "all" | "highlights" | "notes" | "bookmarks";
export type Mark = { kind: "hl"; h: Highlight; cfi: string; frac: number | null } | { kind: "bm"; b: Bookmark; cfi: string; frac: number | null };

const chapterOf = (m: Mark) => (m.kind === "hl" ? m.h.chapter : m.b.chapter)?.trim() || "";
const noteOf = (m: Mark) => (m.kind === "hl" ? m.h.note : m.b.note);
const keyOf = (m: Mark) => `${m.kind}${m.kind === "hl" ? m.h.id : m.b.id}`;

/** Reading order: by place in the book (CFI), how far through when two CFIs can't be compared. */
export function byPlace(a: { cfi: string; frac: number | null }, b: { cfi: string; frac: number | null }) {
  try {
    const c = cfiCompare(a.cfi, b.cfi);
    if (c !== 0) return c;
  } catch {
    /* below */
  }
  return (a.frac ?? 0) - (b.frac ?? 0);
}

export function allMarks(highlights: Highlight[], bookmarks: Bookmark[]): Mark[] {
  const list: Mark[] = [
    ...highlights.map((h) => ({ kind: "hl" as const, h, cfi: h.cfi, frac: h.fraction })),
    ...bookmarks.map((b) => ({ kind: "bm" as const, b, cfi: b.cfi, frac: b.fraction })),
  ];
  return list.sort(byPlace);
}

export function inTab(m: Mark, tab: Tab) {
  if (tab === "highlights") return m.kind === "hl";
  if (tab === "bookmarks") return m.kind === "bm";
  if (tab === "notes") return !!noteOf(m)?.trim();
  return true;
}

/** A mark matches on its words, name, note, chapter and page ("page 120" works too). */
export function matches(m: Mark, needle: string) {
  if (!needle) return true;
  const pl = m.kind === "hl" ? m.h.pageLabel : m.b.pageLabel;
  const hay =
    m.kind === "hl"
      ? [m.h.text, m.h.note, m.h.chapter, styleName(m.h.style)]
      : [m.b.title, m.b.note, m.b.excerpt, m.b.chapter, "bookmark"];
  return [...hay, pl ? `page ${pl} p. ${pl}` : ""].join(" ").toLowerCase().includes(needle);
}

export function Tabs({ tab, setTab, counts }: { tab: Tab; setTab: (t: Tab) => void; counts: Record<Tab, number> }) {
  const tabs: [Tab, string][] = [
    ["all", "All"],
    ["highlights", "Highlights"],
    ["notes", "Notes"],
    ["bookmarks", "Bookmarks"],
  ];
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([t, name]) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
          {name}
          {t !== "all" && <em>{counts[t]}</em>}
        </button>
      ))}
    </div>
  );
}

export function MarkRows({
  marks,
  here,
  hereAt,
  hereLabel,
  onGo,
  onRemove,
  onSaveBookmark,
  empty,
}: {
  marks: Mark[];
  /** bookmarks on the page you're on */
  here?: Set<number>;
  /** "You're here" goes before this row (marks.length: after the last), or nowhere */
  hereAt?: number | null;
  hereLabel?: string;
  onGo: (m: Mark) => void;
  onRemove: (m: Mark) => void;
  onSaveBookmark: (b: Bookmark, title: string | null, note: string | null) => void;
  empty: React.ReactNode;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const startEdit = (b: Bookmark) => {
    setEditing(b.id);
    setName(b.title ?? "");
    setNote(b.note ?? "");
  };
  const save = (b: Bookmark) => {
    onSaveBookmark(b, name.trim() || null, note.trim() || null);
    setEditing(null);
  };
  const youre = hereLabel != null && <div className="herel">You're here · {hereLabel}</div>;

  const row = (m: Mark) => {
    if (m.kind === "hl") {
      const h = m.h;
      const where = placeLabel(h);
      return (
        <div key={keyOf(m)} className="mr">
          <button type="button" className="mgo" onClick={() => onGo(m)}>
            <i className="cbar" style={{ "--c": hexOf(h.color) } as React.CSSProperties} />
            <div>
              <q className={`hq ${h.style}`} style={{ "--c": hexOf(h.color) } as React.CSSProperties}>
                {h.text}
              </q>
              {h.note && <span className="mnote">{h.note}</span>}
              <small>
                {[styleName(h.style), where].filter(Boolean).join(" · ")} · {fmtWhen(h.createdAt)}
              </small>
            </div>
          </button>
          <button type="button" className="pbtn del" aria-label="Delete the highlight" title="Delete" onClick={() => onRemove(m)}>
            <i className="ms">delete</i>
          </button>
        </div>
      );
    }
    const b = m.b;
    if (editing === b.id) {
      return (
        <div key={keyOf(m)} className="mr bmedit">
          <i className="ms f ribbon-ic">bookmark</i>
          <div className="bmf">
            <input
              value={name}
              placeholder={b.pageLabel ? `p. ${b.pageLabel}` : "Name"}
              aria-label="Name"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") save(b);
                if (e.key === "Escape") setEditing(null);
              }}
            />
            <textarea
              value={note}
              placeholder="Note"
              aria-label="Note"
              rows={2}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  save(b);
                }
                if (e.key === "Escape") setEditing(null);
              }}
            />
            <div className="nfoot">
              <span className="grow" />
              <button type="button" className="pill tone" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="pill fill" onClick={() => save(b)}>
                Save
              </button>
            </div>
          </div>
        </div>
      );
    }
    const where = placeLabel(b);
    return (
      <div key={keyOf(m)} className={`mr ${here?.has(b.id) ? "here" : ""}`}>
        <button type="button" className="mgo" onClick={() => onGo(m)}>
          <i className="ms f ribbon-ic">bookmark</i>
          <div>
            <span className="mt">{b.title || where || "Bookmark"}</span>
            {b.excerpt && <q>{b.excerpt}</q>}
            {b.note && <span className="mnote">{b.note}</span>}
            <small>
              {b.title && where ? `${where} · ` : ""}
              {fmtWhen(b.createdAt)}
            </small>
          </div>
        </button>
        <button type="button" className="pbtn del" aria-label="Name the bookmark and add a note" title="Name and note" onClick={() => startEdit(b)}>
          <i className="ms">edit</i>
        </button>
        <button type="button" className="pbtn del" aria-label="Remove the bookmark" title="Remove" onClick={() => onRemove(m)}>
          <i className="ms">delete</i>
        </button>
      </div>
    );
  };

  if (!marks.length)
    return (
      <div className="mrows">
        {youre}
        <div className="empty">{empty}</div>
      </div>
    );
  const out: React.ReactNode[] = [];
  let chapter: string | null = null;
  marks.forEach((m, i) => {
    if (i === hereAt) out.push(<div key="here">{youre}</div>);
    const c = chapterOf(m);
    if (c && c !== chapter) out.push(<div key={`g${i}`} className="gl">{c}</div>);
    if (c) chapter = c;
    out.push(row(m));
  });
  if (hereAt === marks.length) out.push(<div key="here">{youre}</div>);
  return <div className="mrows">{out}</div>;
}
