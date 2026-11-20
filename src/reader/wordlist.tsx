// A book's saved words, for the marks panel's Words tab: the word with its meaning, the sentence it
// came from and its page. A click goes to the sentence.
import { fmtWhen } from "../lib/format";
import { posName } from "../components/DictView";
import { wordAt, type Word } from "../lib/words";

export const wordMatches = (w: Word, needle: string) =>
  !needle || [w.word, w.headword, w.meaning, w.sentence, w.note, w.bookTitle].join(" ").toLowerCase().includes(needle);

/** The sentence with the word bold. */
export function SentenceQ({ w }: { w: Word }) {
  if (!w.sentence) return null;
  const i = wordAt(w.sentence, w.word);
  if (i < 0) return <q>{w.sentence}</q>;
  return (
    <q>
      {w.sentence.slice(0, i)}
      <b>{w.sentence.slice(i, i + w.word.length)}</b>
      {w.sentence.slice(i + w.word.length)}
    </q>
  );
}

export function WordRows({ list, onGo, onRemove, empty }: { list: Word[]; onGo: (w: Word) => void; onRemove: (w: Word) => void; empty: React.ReactNode }) {
  if (!list.length)
    return (
      <div className="mrows">
        <div className="empty">{empty}</div>
      </div>
    );
  return (
    <div className="mrows">
      {list.map((w) => (
        <div key={w.id} className="mr">
          <button type="button" className="mgo" onClick={() => onGo(w)} disabled={!w.cfi} title={w.cfi ? "Go to the sentence" : undefined}>
            <i className="ms ribbon-ic">dictionary</i>
            <div>
              <span className="mw">
                {w.word}
                {w.pos && <em> · {posName(w.pos)}</em>}
              </span>
              {w.meaning && <span className="mnote">{w.meaning}</span>}
              <SentenceQ w={w} />
              <small>
                {w.pageLabel ? `p. ${w.pageLabel} · ` : w.fraction != null ? `${Math.round(w.fraction * 100)}% · ` : ""}
                {fmtWhen(w.createdAt)}
              </small>
            </div>
          </button>
          <button type="button" className="pbtn del" aria-label={`Take “${w.word}” out of My words`} title="Take out of My words" onClick={() => onRemove(w)}>
            <i className="ms">delete</i>
          </button>
        </div>
      ))}
    </div>
  );
}
