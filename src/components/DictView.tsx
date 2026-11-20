// What the word card, My words and the review cards share: a dictionary's entry drawn the Katana way
// (headword, pronunciation and part of speech, numbered senses, origin, similar words), the status of
// the built-in dictionaries kept fresh from Rust's events, and the download line with Pause and Go on.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { dict, mb, wordAt, type BuiltinState, type DictStatus, type DlProgress, type Found } from "../lib/words";

let refreshed = false;

/** The dictionaries' status, with live download progress. Fetches the list once per run. */
export function useDictStatus() {
  const [st, setSt] = useState<DictStatus | null>(null);
  useEffect(() => {
    let alive = true;
    dict.status().then((s) => alive && setSt(s)).catch(() => {});
    if (!refreshed) {
      refreshed = true;
      dict.refresh().then((s) => alive && setSt(s)).catch(() => {});
    }
    const a = listen<DictStatus>("dict-status", (e) => setSt(e.payload));
    const b = listen<DlProgress>("dict-download", (e) => {
      const p = e.payload;
      setSt((s) => (s ? { ...s, builtin: s.builtin.map((x) => (x.id === p.id ? { ...x, progress: p } : x)) } : s));
      if (p.state === "done") dict.status().then((s) => alive && setSt(s)).catch(() => {});
    });
    return () => {
      alive = false;
      a.then((f) => f());
      b.then((f) => f());
    };
  }, []);
  return [st, setSt] as const;
}

const going = (p: DlProgress | null) => !!p && ["queued", "running", "waiting", "unpacking"].includes(p.state);

/** One built-in dictionary's download: a bar, how far, and Pause / Go on / Try again. */
export function DownloadLine({ b }: { b: BuiltinState }) {
  const p = b.progress;
  const total = p?.total || b.downloadSize;
  const done = p?.done ?? b.kept;
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  const words =
    p?.state === "unpacking"
      ? "Setting it up…"
      : p?.state === "waiting"
        ? `Waiting for the connection · ${Math.round(pct)}%`
        : p?.state === "failed"
          ? p.error ?? "The download stopped."
          : p?.state === "paused" || (!going(p) && done > 0)
            ? `Paused · ${mb(done)} of ${mb(total)}`
            : going(p)
              ? `${Math.round(pct)}% · ${mb(done)} of ${total ? mb(total) : "…"}`
              : total
                ? `${mb(total)} download, then offline`
                : "Downloads once, then works offline";
  return (
    <div className="dl">
      <div className="dlt">
        <b>{b.name}</b>
        <span className={p?.state === "failed" ? "err" : ""}>{words}</span>
      </div>
      {(going(p) || done > 0) && p?.state !== "failed" && (
        <div className="dlbar" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {going(p) ? (
        p?.state !== "unpacking" && (
          <button type="button" className="pill sq" aria-label={`Pause ${b.name}`} title="Pause" onClick={() => dict.pause(b.id)}>
            <i className="ms">pause</i>
          </button>
        )
      ) : (
        <button
          type="button"
          className="pill sq"
          aria-label={p?.state === "failed" ? "Try again" : done > 0 ? "Go on" : `Download ${b.name}`}
          title={p?.state === "failed" ? "Try again" : done > 0 ? "Go on" : "Download"}
          onClick={() => dict.download(b.id)}
        >
          <i className="ms">{p?.state === "failed" ? "refresh" : done > 0 ? "play_arrow" : "download"}</i>
        </button>
      )}
    </div>
  );
}

/** A part of speech as words ("adj" -> adjective). */
export const posName = (p: string | null) =>
  p ? ({ adj: "adjective", adv: "adverb", prep: "preposition", conj: "conjunction", intj: "interjection", pron: "pronoun", det: "determiner", num: "number", name: "name", abbrev: "abbreviation", phrase: "phrase", prep_phrase: "phrase" } as Record<string, string>)[p] ?? p : "";

/** A dictionary's senses for a word: compact (the first entry, three senses) or the full entry. */
export function Entries({
  found,
  full,
  onWord,
  sentence,
}: {
  found: Found;
  full: boolean;
  /** a similar word clicked: look it up */
  onWord?: (w: string) => void;
  sentence?: React.ReactNode;
}) {
  if (found.kind === "stardict") {
    const list = full ? found.texts : found.texts.slice(0, 1);
    return (
      <>
        <div className="dw">
          {list[0]?.word ?? found.headword}
          {list[0]?.phonetic && <small>{list[0].phonetic}</small>}
        </div>
        {list.map((t, i) => (
          <div key={i} className={`dtext ${full ? "" : "clip"}`}>
            {t.text}
          </div>
        ))}
        {sentence}
      </>
    );
  }
  const entries = full ? found.entries : found.entries.slice(0, 1);
  const first = found.entries[0];
  const ipa = first?.ipa[0];
  const others = [...new Set(found.entries.slice(1).map((e) => posName(e.pos)).filter(Boolean))].filter((p) => p !== posName(first?.pos ?? null));
  const similar = full ? [...new Set(found.entries.flatMap((e) => e.similar))].slice(0, 14) : first?.similar.slice(0, 5) ?? [];
  const origin = full ? found.entries.find((e) => e.origin)?.origin : first?.origin;
  const via = first?.form && first.form !== first.word.toLowerCase() ? first.form : null;
  return (
    <>
      <div className="dw">
        {first?.word ?? found.headword}
        <small>{[ipa, !full && posName(first?.pos ?? null)].filter(Boolean).join(" · ")}</small>
      </div>
      {via && <div className="dvia">“{via}” is a form of this word</div>}
      {entries.map((e, n) => {
        const senses = full ? e.senses : e.senses.slice(0, 3);
        let k = 0;
        return (
          <div key={n} className="dent">
            {full && (
              <div className="dpos">
                {posName(e.pos)}
                {e.word !== first?.word && <em> · {e.word}</em>}
                {e.form && e.form !== e.word.toLowerCase() && e.word !== first?.word && <em> (“{e.form}”)</em>}
                {e.ipa[0] && e.ipa[0] !== ipa && <em> · {e.ipa[0]}</em>}
              </div>
            )}
            <div className="dsense">
              {senses.map((s, i) => {
                k++;
                return (
                  <div key={i} className="ds">
                    <b>{k}</b>
                    <span>
                      {s.tags.length > 0 && <em className="dtags">{s.tags.join(", ").replace(/-/g, " ")} </em>}
                      {s.gloss}
                      {s.example && (full || i === 0) && <i className="dex">{s.example}</i>}
                    </span>
                  </div>
                );
              })}
              {!full && e.senses.length > 3 && <div className="dmore">+{e.senses.length - 3} more</div>}
            </div>
          </div>
        );
      })}
      {(origin || similar.length > 0 || (!full && others.length > 0)) && (
        <div className="dmeta col">
          {origin && <span className="dorig">{origin}</span>}
          {similar.length > 0 && (
            <span className="dsim">
              Similar:{" "}
              {similar.map((w, i) => (
                <span key={w}>
                  {onWord ? (
                    <button type="button" className="dlink" onClick={() => onWord(w)} title={`Look up “${w}”`}>
                      {w}
                    </button>
                  ) : (
                    w
                  )}
                  {i < similar.length - 1 ? ", " : ""}
                </span>
              ))}
            </span>
          )}
          {!full && others.length > 0 && <span>Also as {others.join(", ")} in the full entry.</span>}
        </div>
      )}
      {sentence}
    </>
  );
}

/** The sentence from the book with the word in it set apart. */
export function Sentence({ text, word }: { text: string; word: string }) {
  const i = wordAt(text, word);
  if (i < 0 || !word) return <div className="dsent">{text}</div>;
  return (
    <div className="dsent">
      {text.slice(0, i)}
      <b>{text.slice(i, i + word.length)}</b>
      {text.slice(i + word.length)}
    </div>
  );
}
