// Review cards: a simple spaced repetition of My words, Katana's schedule (known moves a word on to
// 1, 3, 7, 14, then 30 days; Again starts it over and brings it back later in the same round).
// The word and its sentence first; Space shows the meaning; 1 Again, 2 I know it; Esc closes.
import { useEffect, useMemo, useRef, useState } from "react";
import { Sentence, posName } from "./DictView";
import { dict, words, type Word } from "../lib/words";

type Meaning = { ipa: string | null; pos: string | null; senses: string[] };

const nextLabel = (w: Word | undefined) => {
  if (!w?.reviewDueAt) return null;
  const days = Math.round((w.reviewDueAt - Date.now()) / 864e5);
  return days <= 0 ? "later today" : days === 1 ? "tomorrow" : `in ${days} days`;
};

export function Review({ bookId, onClose, onChanged }: { bookId: number | null; onClose: () => void; onChanged?: () => void }) {
  const [all, setAll] = useState(false);
  const [list, setList] = useState<Word[] | null>(null);
  const [queue, setQueue] = useState<number[]>([]);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [known, setKnown] = useState(0);
  const [firstTry, setFirstTry] = useState(0);
  const [shown, setShown] = useState(false);
  const [meaning, setMeaning] = useState<Meaning | null>(null);
  const [last, setLast] = useState<Map<number, Word>>(new Map());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    words
      .due(bookId, all)
      .then((l) => {
        setList(l);
        setQueue(l.map((w) => w.id));
        setSeen(new Set());
        setKnown(0);
        setFirstTry(0);
        setShown(false);
      })
      .catch(() => setList([]));
  }, [bookId, all]);

  const byId = useMemo(() => new Map((list ?? []).map((w) => [w.id, w])), [list]);
  const cur = queue.length ? byId.get(queue[0]) : undefined;

  // the meaning from the dictionary when it's here, else the one saved with the word
  useEffect(() => {
    setMeaning(null);
    if (!cur) return;
    let alive = true;
    dict
      .lookup(cur.headword)
      .then((r) => {
        const f = r.found[0];
        const e = f?.entries[0];
        if (!alive) return;
        if (e) setMeaning({ ipa: e.ipa[0] ?? null, pos: e.pos, senses: e.senses.filter((s) => !s.sub).slice(0, 3).map((s) => s.gloss) });
        else if (f?.texts[0]) setMeaning({ ipa: f.texts[0].phonetic, pos: null, senses: [f.texts[0].text.slice(0, 400)] });
        else setMeaning({ ipa: null, pos: cur.pos, senses: cur.meaning ? [cur.meaning] : [] });
      })
      .catch(() => alive && setMeaning({ ipa: null, pos: cur.pos, senses: cur.meaning ? [cur.meaning] : [] }));
    return () => {
      alive = false;
    };
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (k: boolean) => {
    if (!cur || !shown) return;
    const first = !seen.has(cur.id);
    setSeen((s) => new Set(s).add(cur.id));
    const after = await words.answer(cur.id, k, first).catch(() => null);
    if (after) setLast((m) => new Map(m).set(after.id, after));
    if (k) {
      setKnown((n) => n + 1);
      if (first) setFirstTry((n) => n + 1);
      setQueue((q) => q.slice(1));
    } else {
      setQueue((q) => [...q.slice(1), q[0]]);
    }
    setShown(false);
    onChanged?.();
  };

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return (e.preventDefault(), e.stopPropagation(), onClose());
      if ((e.target as HTMLElement)?.closest?.("button") && (e.key === " " || e.key === "Enter")) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        setShown(true);
      } else if (shown && e.key === "1") void answer(false);
      else if (shown && e.key === "2") void answer(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const total = list?.length ?? 0;
  const done = list != null && queue.length === 0;
  const nextDue = done ? [...last.values()].map((w) => w.reviewDueAt ?? Infinity).sort((a, b) => a - b)[0] : null;

  return (
    <div className="rvscrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rv" role="dialog" aria-label="Review your words" tabIndex={-1} ref={box}>
        <div className="rvh">
          <span className="h3">
            <i className="ms">style</i>Review
          </span>
          {total > 0 && !done && (
            <span className="rvn">
              {Math.min(known + 1, total)} of {total}
            </span>
          )}
          <span className="grow" />
          <button type="button" className="pill sq" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <i className="ms">close</i>
          </button>
        </div>
        {total > 0 && (
          <div className="dlbar rvbar" aria-hidden="true">
            <i style={{ width: `${(known / total) * 100}%` }} />
          </div>
        )}
        {list == null ? null : total === 0 ? (
          <div className="rvend">
            <i className="ms">task_alt</i>
            <b>Nothing to review right now</b>
            <p>Words come back a day after you first know them, then after 3, 7, 14 and 30 days.</p>
            <button type="button" className="pill" onClick={() => setAll(true)}>
              Review every word anyway
            </button>
          </div>
        ) : done ? (
          <div className="rvend">
            <i className="ms">task_alt</i>
            <b>
              {total} {total === 1 ? "word" : "words"} reviewed
            </b>
            <p>
              {firstTry} known on the first try.
              {nextDue && nextDue !== Infinity ? ` The next one comes back ${nextLabel({ reviewDueAt: nextDue } as Word)}.` : ""}
            </p>
            <button type="button" className="pill fill" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          cur && (
            <>
              <div className="rvcard" onClick={() => !shown && setShown(true)}>
                <div className="rvw">{cur.word}</div>
                {cur.sentence && <Sentence text={cur.sentence} word={cur.word} />}
                {cur.bookTitle && (
                  <small className="rvsrc">
                    {cur.bookTitle}
                    {cur.pageLabel ? ` · p. ${cur.pageLabel}` : ""}
                  </small>
                )}
                {shown ? (
                  <div className="rvback">
                    <div className="rvmeta">{[meaning?.ipa, posName(meaning?.pos ?? cur.pos)].filter(Boolean).join(" · ")}</div>
                    {meaning && meaning.senses.length ? (
                      <ol>
                        {meaning.senses.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="dnote">{meaning ? "No meaning on this PC yet: the dictionaries are still coming." : "…"}</p>
                    )}
                    {cur.note && <p className="rvnote">{cur.note}</p>}
                  </div>
                ) : (
                  <div className="rvhint">Do you know what it means here?</div>
                )}
              </div>
              <div className="rvacts">
                {shown ? (
                  <>
                    <button type="button" className="pill" onClick={() => answer(false)}>
                      Again<kbd>1</kbd>
                    </button>
                    <button type="button" className="pill fill" onClick={() => answer(true)}>
                      I know it<kbd>2</kbd>
                    </button>
                  </>
                ) : (
                  <button type="button" className="pill fill" onClick={() => setShown(true)}>
                    Show the meaning<kbd>Space</kbd>
                  </button>
                )}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
