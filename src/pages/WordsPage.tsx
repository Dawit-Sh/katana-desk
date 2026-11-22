// My words: every word saved from the word card, newest first, with its meaning from the built-in
// dictionary, the sentence it was met in and the book. A row opens the full entry, the note, and the
// way back to the sentence. Review cards, search, a book filter and Markdown export. List | Graph: the
// graph (components/WordGraph.tsx) shows the words round their books, words of the same meaning joined.
import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../lib/store";
import { api } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { Entries, posName, useDictStatus } from "../components/DictView";
import { Review } from "../components/Review";
import { WordGraph } from "../components/WordGraph";
import { SentenceQ, wordMatches } from "../reader/wordlist";
import { dict, exportWords, isDue, learning, words, type Lookup, type Word } from "../lib/words";

type View = "list" | "graph";

/** List | Graph, kept for next time. */
function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div className="seg wview" role="radiogroup" aria-label="View">
      <button type="button" role="radio" aria-checked={view === "list"} className={view === "list" ? "on" : ""} title="The words as a list" onClick={() => onChange("list")}>
        <i className="ms">view_list</i>List
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={view === "graph"}
        className={view === "graph" ? "on" : ""}
        title="The words round their books, words of the same meaning joined"
        onClick={() => onChange("graph")}
      >
        <i className="ms">hub</i>Graph
      </button>
    </div>
  );
}

function Detail({ w, onRemove, onNote }: { w: Word; onRemove: () => void; onNote: (n: string | null) => void }) {
  const open = useStore((s) => s.open);
  const books = useStore((s) => s.books);
  const [res, setRes] = useState<Lookup | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [note, setNote] = useState(w.note ?? "");
  const [st] = useDictStatus();
  const installed = st?.builtin.filter((b) => b.installed).length ?? 0;
  useEffect(() => {
    dict.lookup(w.headword).then((r) => {
      setRes(r);
      setTab(r.found[0]?.id ?? null);
    });
  }, [w.headword, installed]);
  const found = res?.found.find((f) => f.id === tab) ?? res?.found[0];
  const inLibrary = w.bookId != null && books.some((b) => b.id === w.bookId);
  return (
    <div className="wx">
      <div className="wxd">
        {res && res.found.length > 1 && (
          <div className="dtabs">
            {res.found.map((f) => (
              <button key={f.id} type="button" className={f.id === found?.id ? "on" : ""} onClick={() => setTab(f.id)}>
                {f.name}
              </button>
            ))}
          </div>
        )}
        {found ? (
          <Entries found={found} full />
        ) : (
          res && <p className="dnote">{res.missing.length ? "The full entry shows once the dictionaries are on this PC (Settings › Dictionaries)." : `“${w.headword}” isn't in the dictionaries.`}</p>
        )}
      </div>
      <div className="wxs">
        <label className="wnote">
          <span>Your note</span>
          <textarea
            value={note}
            rows={3}
            placeholder="What it means to you, a better example…"
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note.trim() !== (w.note ?? "") && onNote(note.trim() || null)}
          />
        </label>
        <div className="pills">
          {inLibrary && w.cfi && (
            <button
              type="button"
              className="pill fill"
              onClick={() => {
                learning.revisit("word", w.uuid, w.bookId);
                open(w.bookId!, w.cfi);
              }}
            >
              <i className="ms">menu_book</i>Go to the sentence
            </button>
          )}
          <button type="button" className="pill" onClick={() => dict.openUrl(`https://en.wiktionary.org/wiki/${encodeURIComponent(w.headword.replace(/ /g, "_"))}`)}>
            <i className="ms">travel_explore</i>Online
          </button>
          <button type="button" className="pill" onClick={onRemove}>
            <i className="ms">delete</i>Take out
          </button>
        </div>
        <small className="wmeta">
          {w.reviewedAt
            ? `Reviewed ${fmtWhen(w.reviewedAt)} · ${w.reviewLevel >= 3 ? "learned" : "learning"}${w.reviewDueAt ? ` · back ${w.reviewDueAt <= Date.now() ? "now" : fmtWhen(w.reviewDueAt).replace(/^Today, /, "today at ")}` : ""}`
            : "Not reviewed yet"}
        </small>
      </div>
    </div>
  );
}

export function WordsPage() {
  const open = useStore((s) => s.open);
  const [list, setList] = useState<Word[] | null>(null);
  const [q, setQ] = useState("");
  const [book, setBook] = useState<number | "all">("all");
  const [openId, setOpenId] = useState<number | null>(null);
  const [review, setReview] = useState<false | true | Word>(false);
  const [msg, setMsg] = useState<{ text: string; undo?: () => void } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [version, setVersion] = useState(0);
  const [seek, setSeek] = useState(0);
  const [st] = useDictStatus();
  const installed = st?.builtin.filter((b) => b.installed).length ?? 0;
  useEffect(() => {
    api
      .getSetting("words.view")
      .then((v) => setView(v === "graph" ? "graph" : "list"))
      .catch(() => setView("list"));
  }, []);
  const changeView = (v: View) => {
    setView(v);
    api.setSetting("words.view", v).catch(() => {});
  };

  const load = useCallback(
    () =>
      words
        .list()
        .then(setList)
        .catch(() => setList([]))
        .finally(() => setVersion((n) => n + 1)),
    [],
  );
  useEffect(() => {
    // words saved before the dictionaries came get their meanings now
    words
      .fillMeanings()
      .catch(() => 0)
      .finally(load);
  }, [load, installed]);
  useEffect(() => {
    const un = listen("library-changed", () => load());
    return () => {
      un.then((f) => f());
    };
  }, [load]);

  const books = useMemo(() => {
    const m = new Map<number, string>();
    for (const w of list ?? []) if (w.bookId != null && w.bookTitle) m.set(w.bookId, w.bookTitle);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [list]);
  const needle = q.trim().toLowerCase();
  const shown = (list ?? []).filter((w) => (book === "all" || w.bookId === book) && wordMatches(w, needle));
  const due = (list ?? []).filter((w) => (book === "all" || w.bookId === book) && isDue(w)).length;

  const remove = async (w: Word) => {
    const gone = await words.remove(w.id).catch(() => null);
    if (!gone) return;
    setOpenId(null);
    load();
    setMsg({
      text: `“${w.word}” taken out of My words`,
      undo: async () => {
        await words.restore(gone).catch(() => null);
        setMsg(null);
        load();
      },
    });
  };

  if (list && !list.length)
    return (
      <div className={`scroll ${view === "graph" ? "wgpage" : ""}`}>
        <div className="sech">
          <span className="h">My words</span>
          <div className="pills">{view && <ViewToggle view={view} onChange={changeView} />}</div>
        </div>
        {view === "graph" ? (
          <WordGraph book="all" query="" seek={0} version={version} active onAllBooks={() => {}} onOpen={() => {}} onReview={() => {}} />
        ) : (
          <div className="soon">
            <i className="ms">dictionary</i>
            <b>My words</b>
            <p>
              Double-click a word while you read, or select it and press <kbd>L</kbd>. The word card shows what it means, and Save to My
              words keeps it here with its sentence and book, for review cards later.
            </p>
          </div>
        )}
      </div>
    );

  const graph = view === "graph";
  return (
    <div className={`scroll ${graph ? "wgpage" : ""}`}>
      <div className="sech">
        <span className="h">
          My words<span className="c">{list?.length ?? ""}</span>
        </span>
        <div className="pills">
          {view && <ViewToggle view={view} onChange={changeView} />}
          <div className="sfield wsearch">
            <i className="ms">search</i>
            <input
              value={q}
              placeholder="Search words"
              aria-label="Search words"
              title={graph ? "Words that don't match fade; Enter goes to the first one" : undefined}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && graph) setSeek((n) => n + 1);
              }}
            />
            {q && (
              <button type="button" className="clear" aria-label="Clear" onClick={() => setQ("")}>
                <i className="ms">close</i>
              </button>
            )}
          </div>
          {books.length > 1 && (
            <label className="pill selpill" title="Words from one book">
              <i className="ms">filter_list</i>
              <select value={book} onChange={(e) => setBook(e.target.value === "all" ? "all" : Number(e.target.value))} aria-label="Book">
                <option value="all">All books</option>
                {books.map(([id, t]) => (
                  <option key={id} value={id}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className={`pill ${due ? "fill" : ""}`} onClick={() => setReview(true)} title="Flashcards: the word and its sentence, then its meaning">
            <i className="ms">style</i>
            {due ? `Review · ${due} due` : "Review"}
          </button>
          <button
            type="button"
            className="pill"
            title="Save these words, their meanings and sentences as a Markdown file"
            onClick={async () => {
              const p = await exportWords(book === "all" ? null : book).catch((e) => (setMsg({ text: String(e) }), null));
              if (p) setMsg({ text: `Saved ${p.split(/[\\/]/).pop()}` });
            }}
          >
            <i className="ms">download</i>Export
          </button>
        </div>
      </div>
      {msg && (
        <div className="bmmsg wmsg">
          <span>{msg.text}</span>
          {msg.undo && (
            <button type="button" className="pill tone" onClick={msg.undo}>
              Undo
            </button>
          )}
          <button type="button" className="pbtn" aria-label="Close" onClick={() => setMsg(null)}>
            <i className="ms">close</i>
          </button>
        </div>
      )}
      {graph ? (
        <WordGraph
          book={book}
          query={q}
          seek={seek}
          version={version}
          active={!review}
          onAllBooks={() => setBook("all")}
          onOpen={(w) => {
            if (w.bookId == null) return;
            learning.revisit("word", w.uuid, w.bookId);
            open(w.bookId, w.cfi);
          }}
          onReview={(w) => setReview(w)}
        />
      ) : (
      <div className="wt" role="table">
        <div className="hd" role="row">
          <span>Word and meaning</span>
          <span>Where you met it</span>
          <span>Book</span>
          <span>Saved</span>
        </div>
        {shown.map((w) => (
          <div key={w.id} className={`wrow ${openId === w.id ? "on" : ""}`}>
            <button type="button" className="wline" role="row" aria-expanded={openId === w.id} onClick={() => setOpenId(openId === w.id ? null : w.id)}>
              <span className="w">
                {w.word}
                {w.pos && <em> {posName(w.pos)}</em>}
                <span className="def">{w.meaning ?? (st?.builtin.some((b) => !b.installed) ? "Meaning shows once the dictionaries are here" : "")}</span>
              </span>
              <span className="s">{w.sentence ? <SentenceQ w={w} /> : ""}</span>
              <span className="b">
                {w.bookTitle ?? ""}
                {w.pageLabel ? ` · p. ${w.pageLabel}` : ""}
              </span>
              <span className="d">{fmtWhen(w.createdAt).replace(/, \d.*$/, "")}</span>
            </button>
            {openId === w.id && (
              <Detail
                w={w}
                onRemove={() => remove(w)}
                onNote={async (n) => {
                  await words.note(w.id, n).catch(() => {});
                  load();
                }}
              />
            )}
          </div>
        ))}
        {list && !shown.length && <div className="empty wempty">Nothing matches.</div>}
      </div>
      )}
      {review && (
        <Review
          bookId={book === "all" ? null : book}
          word={review === true ? undefined : review}
          onClose={() => {
            setReview(false);
            load();
          }}
        />
      )}
    </div>
  );
}
