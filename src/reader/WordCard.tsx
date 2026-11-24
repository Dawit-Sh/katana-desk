// The word card: Look up (L) on selected words, or a double-click on a word. Every dictionary that
// knows the word gets a tab (Wiktionary, WordNet, his StarDict files), with the senses, pronunciation,
// origin, similar words and the sentence from the book; Save to My words, the full entry, and a small
// button to look it up online. The built-in dictionaries download on the first look up.
import { useEffect, useRef, useState } from "react";
import { useCardPlace, type Anchor } from "./cards";
import { DownloadLine, Entries, Sentence, useDictStatus } from "../components/DictView";
import { dict, learning, onlineUrl, words, type Found, type Lookup, type Word } from "../lib/words";
import { wordAdded } from "../lib/undoable";

/** What the card was asked: the words, where they are, the sentence around them. */
export type WordAsk = {
  text: string;
  sentence: string | null;
  anchor: Anchor;
  cfi: string | null;
  fraction: number | null;
  pageLabel: string | null;
  chapter: string | null;
};

let autoStarted = false;

export function WordCard({
  ask,
  room,
  bookId,
  onClose,
  onSaved,
  onRemoved,
}: {
  ask: WordAsk;
  room: { w: number; h: number };
  bookId: number;
  onClose: () => void;
  onSaved: (w: Word) => void;
  onRemoved: (w: Word) => void;
}) {
  const { ref, style } = useCardPlace(ask.anchor, room);
  const [stack, setStack] = useState<string[]>([ask.text]);
  const q = stack[stack.length - 1];
  const original = stack.length === 1;
  const [res, setRes] = useState<Lookup | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [saved, setSaved] = useState<Word | null>(null);
  const [busy, setBusy] = useState(false);
  const [st] = useDictStatus();
  const installed = st?.builtin.filter((b) => b.installed).map((b) => b.id).join(",") ?? "";
  const logged = useRef(false);

  useEffect(() => {
    let alive = true;
    dict
      .lookup(q)
      .then(async (r) => {
        if (!alive) return;
        setRes(r);
        setTab((t) => (r.found.some((f) => f.id === t) ? t : r.found[0]?.id ?? null));
        const head = r.found[0]?.headword ?? q;
        setSaved(await words.find(head).catch(() => null));
        if (original && !logged.current && r.found.length) {
          logged.current = true;
          learning.lookup(head, bookId);
        }
      })
      .catch(() => alive && setRes({ word: q, found: [], missing: [], broken: [] }));
    return () => {
      alive = false;
    };
    // a dictionary arriving looks the word up again
  }, [q, installed]); // eslint-disable-line react-hooks/exhaustive-deps

  // the built-in dictionaries come down on the first look up (once; a pause he made stays)
  useEffect(() => {
    if (!st || autoStarted) return;
    const todo = st.builtin.filter((b) => !b.installed);
    if (todo.length && todo.every((b) => !b.progress && b.kept === 0)) {
      autoStarted = true;
      dict.download(null).catch(() => {});
    }
  }, [st]);

  const found: Found | null = res?.found.find((f) => f.id === tab) ?? res?.found[0] ?? null;
  const missing = st?.builtin.filter((b) => !b.installed) ?? [];
  const first = found?.entries[0];
  const meaning = found?.kind === "builtin" ? first?.senses[0]?.gloss ?? null : found?.texts[0]?.text.split("\n").find((l) => l.trim().length > 2)?.trim() ?? null;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (saved) {
        const gone = await words.remove(saved.id);
        setSaved(null);
        if (gone) onRemoved(gone);
      } else {
        const w = await words.save({
          word: original ? ask.text : q,
          headword: found?.headword ?? q,
          bookId,
          sentence: original ? ask.sentence : null,
          chapter: original ? ask.chapter : null,
          cfi: original ? ask.cfi : null,
          fraction: original ? ask.fraction : null,
          pageLabel: original ? ask.pageLabel : null,
          meaning: meaning ? meaning.slice(0, 400) : null,
          pos: first?.pos ?? null,
        });
        setSaved(w);
        onSaved(w);
        wordAdded(w);
      }
    } finally {
      setBusy(false);
    }
  };

  const credit = found
    ? found.kind === "builtin"
      ? `Offline · ${found.name}${found.edition ? `, ${found.edition}` : ""} · ${found.id === "wordnet-en" ? "CC BY 4.0" : "CC BY-SA 4.0"}`
      : `Offline · ${found.name} (your StarDict file)`
    : null;

  return (
    <div ref={ref} className="pop dcard" style={{ ...style, maxHeight: Math.max(260, (room.h || 700) - 112) }} role="dialog" aria-label={`Dictionary: ${q}`}>
      <div className="pad">
        {(stack.length > 1 || (res && res.found.length > 1)) && (
          <div className="dtop">
            {stack.length > 1 && (
              <button type="button" className="pbtn" aria-label="Back" title={`Back to “${stack[stack.length - 2]}”`} onClick={() => setStack((s) => s.slice(0, -1))}>
                <i className="ms">arrow_back</i>
              </button>
            )}
            {res && res.found.length > 1 && (
              <div className="dtabs" role="tablist">
                {res.found.map((f) => (
                  <button key={f.id} type="button" role="tab" aria-selected={f.id === found?.id} className={f.id === found?.id ? "on" : ""} onClick={() => setTab(f.id)}>
                    {f.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {!res ? (
          <div className="dw dim">{q}</div>
        ) : found ? (
          <Entries
            found={found}
            full={full}
            onWord={(w) => {
              setFull(false);
              setStack((s) => [...s, w]);
            }}
            sentence={original && ask.sentence ? <Sentence text={ask.sentence} word={ask.text} /> : null}
          />
        ) : (
          <>
            <div className="dw">{q}</div>
            {missing.length > 0 && !res.found.length ? (
              <p className="dnote">The dictionaries come down once, then every word is looked up on this PC, offline.</p>
            ) : (
              <p className="dnote">
                “{q}” isn't in {[...(st?.builtin.filter((b) => b.installed).map((b) => b.name) ?? []), ...(st?.stardict.map((s) => s.name) ?? [])].join(" or ") || "the dictionaries"}.
              </p>
            )}
            {original && ask.sentence && <Sentence text={ask.sentence} word={ask.text} />}
          </>
        )}
        {missing.length > 0 && (
          <div className="dls">
            {missing.map((b) => (
              <DownloadLine key={b.id} b={b} />
            ))}
          </div>
        )}
        {credit && (
          <div className="dmeta">
            <i className="ms" style={{ fontSize: 16 }}>
              cloud_done
            </i>
            <span>{credit}</span>
          </div>
        )}
        {res && res.broken.length > 0 && <div className="dmeta err">Couldn't read {res.broken.join(", ")}: moved or deleted? See Settings › Dictionaries.</div>}
      </div>
      <div className="row2">
        <button type="button" className={`pill ${saved ? "tone" : "fill"}`} onClick={save} disabled={busy || !res} title={saved ? "In My words: click to take it out" : "Save the word, its meaning and this sentence to My words"}>
          <i className={`ms ${saved ? "f" : ""}`}>{saved ? "check_circle" : "dictionary"}</i>
          {saved ? "In My words" : "Save to My words"}
        </button>
        {found && (found.kind === "builtin" ? found.entries.length > 1 || found.entries.some((e) => e.senses.length > 3) || (first?.similar.length ?? 0) > 5 : found.texts.length > 1 || (found.texts[0]?.text.length ?? 0) > 400) && (
          <button type="button" className="pill" onClick={() => setFull((f) => !f)}>
            <i className="ms">{full ? "unfold_less" : "menu_book"}</i>
            {full ? "Less" : "Full entry"}
          </button>
        )}
        <span className="grow" />
        <button type="button" className="pill sq" aria-label="Look it up online" title={`Look up “${found?.headword ?? q}” on Wiktionary online`} onClick={() => dict.openUrl(onlineUrl(found?.headword ?? q))}>
          <i className="ms">travel_explore</i>
        </button>
        <button type="button" className="pill sq" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <i className="ms">close</i>
        </button>
      </div>
    </div>
  );
}
