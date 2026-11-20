#!/usr/bin/env python3
# Katana Desk, the desktop version of Katana.
# SPDX-License-Identifier: GPL-3.0-or-later
"""Builds Katana Desk's offline dictionaries, once, as compact SQLite files the app downloads.

    python -I tools/build-dictionary.py wiktionary <kaikki English .jsonl(.gz)> <out.sqlite> [--edition "Oct 2026"]
    python -I tools/build-dictionary.py wordnet <english-wordnet-YYYY.xml(.gz)> <out.sqlite>
    python -I tools/build-dictionary.py manifest <out folder> "" <file.sqlite> [<file.sqlite> ...]   ("" = files beside the list)

Sources (download them outside the repo; they never go into git):
  - English Wiktionary as extracted by wiktextract (https://github.com/tatuylonen/wiktextract):
    https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz  (CC BY-SA 4.0 and GFDL)
  - Open English WordNet (https://github.com/globalwordnet/english-wordnet), the release's
    english-wordnet-YYYY.xml.gz  (CC BY 4.0)

Both become the same shape, so the app reads them with one piece of code (src-tauri/src/dict/builtin.rs):

    meta(key, value)            format (1), id, name, edition, source, licence, licence_url, credit, entries
    entries(id, word, pos, body)  body = zlib(JSON): {"p": pos, "i": [IPA], "e": origin,
                                   "s": [{"g": gloss, "x": example, "t": [tags], "y": [synonyms]}],
                                   "y": [similar words]}
    keys(key, entry)            lowercase headword -> entries, in the source's order
    forms(form, lemma, rank)    inflected or other forms -> headword (geese -> goose, ran -> run); rank 0 an
                                inflection, 2 a spelling or abbreviation, +1 when the form isn't lowercase

Keys are lowercase with curly apostrophes made straight. Regular endings (-s, -ed, -ing ...) the app
tries itself when a form isn't listed. `manifest` gzips each file for download and writes
katana-dictionaries.json (id, name, file, size, sha256, gzip size and sha256, licence, credit), the
file the app's download URL points at.
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
import xml.etree.ElementTree as ET
import zlib

FORMAT = 1

SCHEMA = """
PRAGMA page_size = 4096;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entries (id INTEGER PRIMARY KEY, word TEXT NOT NULL, pos TEXT, body BLOB NOT NULL);
CREATE TABLE keys (key TEXT NOT NULL, entry INTEGER NOT NULL, PRIMARY KEY (key, entry)) WITHOUT ROWID;
CREATE TABLE forms (form TEXT NOT NULL, lemma TEXT NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (form, lemma)) WITHOUT ROWID;
"""


def key_of(word):
    return word.strip().replace("’", "'").replace("‘", "'").lower()


def clip(text, n):
    text = " ".join(text.split())
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"


def pack(obj):
    return zlib.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9)


class Out:
    def __init__(self, path, meta):
        if os.path.exists(path):
            os.remove(path)
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)
        self.db.execute("PRAGMA journal_mode = OFF")
        self.db.execute("PRAGMA synchronous = OFF")
        self.meta = dict(meta, format=str(FORMAT))
        self.next_id = 1
        self.rows, self.keys, self.forms = [], [], {}
        self.count = 0

    def entry(self, word, pos, body):
        eid = self.next_id
        self.next_id += 1
        self.rows.append((eid, word, pos, pack(body)))
        self.keys.append((key_of(word), eid))
        self.count += 1
        if len(self.rows) >= 20000:
            self.flush()

    def form(self, form, lemma, rank=0):
        f, l = key_of(form), key_of(lemma)
        if f and l and f != l:
            if form.strip() != f:
                rank += 1
            self.forms[(f, l)] = min(rank, self.forms.get((f, l), 9))

    def flush(self):
        self.db.executemany("INSERT INTO entries VALUES (?, ?, ?, ?)", self.rows)
        self.db.executemany("INSERT OR IGNORE INTO keys VALUES (?, ?)", self.keys)
        self.rows, self.keys = [], []

    def close(self):
        self.flush()
        # a form that is itself a headword with its own meaning stays a headword; the form row is kept
        # too, so "lay" finds both "lay" and "lie"
        self.db.executemany("INSERT OR IGNORE INTO forms VALUES (?, ?, ?)", sorted((f, l, r) for (f, l), r in self.forms.items()))
        self.meta["entries"] = str(self.count)
        self.db.executemany("INSERT INTO meta VALUES (?, ?)", sorted(self.meta.items()))
        self.db.commit()
        self.db.execute("VACUUM")
        self.db.close()


# ---------- Wiktionary (wiktextract) ----------

# the tags worth showing beside a sense; the rest (grammar bookkeeping) stays out
SHOW_TAGS = {
    "archaic", "obsolete", "dated", "rare", "informal", "colloquial", "slang", "vulgar", "offensive",
    "derogatory", "humorous", "literary", "poetic", "formal", "figuratively", "dialectal", "regional",
    "British", "UK", "US", "Australia", "Canada", "Ireland", "Scotland", "India", "New-Zealand",
    "South-Africa", "transitive", "intransitive", "uncountable", "countable", "historical", "nonstandard",
    "euphemistic", "technical", "jargon", "Internet", "childish", "pejorative", "ironic",
}
# an origin written out, as opposed to a node of wiktextract's "Etymology tree" ("Old French sensbor.")
PROSE = re.compile(r"(From|Borrowed|Inherited|Coined|Equivalent|Clipping|Blend|Back-formation|Short|Abbreviation|Uncertain|Unknown|Probably|Possibly|Compound|Calque|Univerbation|Of|A|An|The|See)\b")
TREE_NODE = re.compile(r"(der|bor|lbor|inh|calq|der\.\?|bor\.\?)\.?\??$")
# forms that aren't words to look up
SKIP_FORM_TAGS = {"table-tags", "inflection-template", "class", "romanization"}
PREFERRED_IPA = ("Received-Pronunciation", "General-American", "UK", "US")


def ipa_of(sounds):
    seen, first, preferred = set(), [], []
    for s in sounds or []:
        ipa = s.get("ipa")
        if not ipa or ipa in seen:
            continue
        seen.add(ipa)
        (preferred if any(t in PREFERRED_IPA for t in s.get("tags", [])) else first).append(ipa)
    return (preferred + first)[:2]


def words_of(items, n):
    out = []
    for it in items or []:
        w = it.get("word")
        if w and w not in out and len(w) < 40:
            out.append(w)
        if len(out) >= n:
            break
    return out


def wiktionary(src, dest, edition):
    out = Out(dest, {
        "id": "wiktionary-en",
        "name": "Wiktionary",
        "edition": edition,
        "source": "English Wiktionary, extracted by wiktextract (kaikki.org)",
        "licence": "CC BY-SA 4.0",
        "licence_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "credit": "Definitions from Wiktionary (https://en.wiktionary.org), by its contributors, "
                  "extracted with wiktextract by Tatu Ylonen (https://kaikki.org). CC BY-SA 4.0.",
    })
    opener = gzip.open if src.endswith(".gz") else open
    started, n, kept = time.time(), 0, 0
    with opener(src, "rt", encoding="utf-8") as f:
        for line in f:
            n += 1
            if n % 200000 == 0:
                print(f"  {n:,} read, {kept:,} kept, {time.time() - started:.0f} s", flush=True)
            e = json.loads(line)
            if e.get("lang_code") != "en":
                continue
            word, pos = e.get("word"), e.get("pos")
            if not word:
                continue
            senses, own = [], 0
            for s in e.get("senses", []):
                tags = s.get("tags", [])
                glosses = s.get("glosses")
                if not glosses or "no-gloss" in tags:
                    continue
                form_of = s.get("form_of") or s.get("alt_of")
                if form_of:
                    rank = 0 if s.get("form_of") and not {"alternative", "abbreviation", "initialism", "acronym", "misspelling"} & set(tags) else 2
                    for fo in form_of:
                        if fo.get("word"):
                            out.form(word, fo["word"], rank)
                else:
                    own += 1
                sense = {"g": clip(glosses[-1], 400)}
                if len(glosses) > 1:
                    sense["sub"] = 1
                shown = [t for t in tags if t in SHOW_TAGS][:3]
                if shown:
                    sense["t"] = shown
                # a made-up example reads best; a quotation only when it's short and in today's spelling
                ex = None
                for x in s.get("examples", []):
                    t = x.get("text")
                    if not t:
                        continue
                    if x.get("type") != "quotation":
                        ex = t
                        break
                    if not ex and len(t) <= 150 and "ſ" not in t:
                        ex = t
                if ex:
                    sense["x"] = clip(ex, 220)
                syn = [y for y in words_of(s.get("synonyms"), 7) if y != word][:6]
                if syn:
                    sense["y"] = syn
                senses.append(sense)
            for fm in e.get("forms", []):
                form, ftags = fm.get("form"), set(fm.get("tags", []))
                if not form or form in ("-", word) or ftags & SKIP_FORM_TAGS or " " in form and " " not in word:
                    continue
                out.form(form, word, 2 if ftags & {"alternative", "abbreviation", "misspelling"} else 0)
            if not own:
                # only "plural of", "simple past of" and the like: the forms table finds the headword
                continue
            body = {"p": pos, "s": senses[:40]}
            ipa = ipa_of(e.get("sounds"))
            if ipa:
                body["i"] = ipa
            # the first line of the origin in words; some entries start with an "Etymology tree" (one
            # short ancestor per line), skipped up to the first line that reads like a sentence
            et = [l.strip() for l in (e.get("etymology_text") or "").split("\n") if l.strip()]
            if et and et[0] == "Etymology tree":
                et = [l for l in et[1:] if (len(l.split()) > 6 or PROSE.match(l)) and not TREE_NODE.search(l)]
            if et:
                body["e"] = clip(et[0], 420)
            similar = [y for y in words_of(e.get("synonyms"), 11) if y != word][:10]
            for s in senses:
                for y in s.get("y", []):
                    if y not in similar and len(similar) < 10:
                        similar.append(y)
            if similar:
                body["y"] = similar
            out.entry(word, pos, body)
            kept += 1
    print(f"  {n:,} read, {kept:,} entries, {len(out.forms):,} forms; writing", flush=True)
    out.close()


# ---------- Open English WordNet (LMF XML) ----------

WN_POS = {"n": "noun", "v": "verb", "a": "adj", "s": "adj", "r": "adv"}


def wordnet(src, dest):
    opener = gzip.open if src.endswith(".gz") else open
    with opener(src, "rb") as f:
        root = ET.parse(f).getroot()
    lex = root.find("Lexicon")
    version = lex.get("version", "")
    out = Out(dest, {
        "id": "wordnet-en",
        "name": "WordNet",
        "edition": f"Open English WordNet {version}",
        "source": "Open English WordNet (https://github.com/globalwordnet/english-wordnet)",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "credit": f"Open English WordNet {version} (https://en-word.net), by John P. McCrae and its contributors, "
                  "based on Princeton WordNet 3.0 (Princeton University). CC BY 4.0.",
    })
    synsets, members, lemma_of = {}, {}, {}
    for ss in lex.iter("Synset"):
        d = ss.find("Definition")
        ex = ss.find("Example")
        rel = [r.get("target") for r in ss.findall("SynsetRelation") if r.get("relType") in ("similar", "hypernym")]
        synsets[ss.get("id")] = (d.text if d is not None else "", ex.text if ex is not None else None, rel)
        members[ss.get("id")] = (ss.get("members") or "").split()
    entries = list(lex.iter("LexicalEntry"))
    for le in entries:
        lemma_of[le.get("id")] = le.find("Lemma").get("writtenForm")

    def names(ids, but):
        return [lemma_of[m] for m in ids if m in lemma_of and lemma_of[m] != but]

    # one entry per word and part of speech, senses in WordNet's order (most common first)
    for le in entries:
        lem = le.find("Lemma")
        word, pos = lem.get("writtenForm"), WN_POS.get(lem.get("partOfSpeech"), lem.get("partOfSpeech"))
        senses, similar = [], []
        for s in le.findall("Sense"):
            d, ex, rel = synsets.get(s.get("synset"), ("", None, []))
            if not d:
                continue
            sense = {"g": clip(d, 400)}
            if ex:
                sense["x"] = clip(ex.strip('"'), 220)
            syn = names(members.get(s.get("synset"), []), word)[:6]
            if not syn:
                # no synonyms in the synset: the nearest broader or similar word
                for r in rel:
                    syn = names(members.get(r, []), word)[:3]
                    if syn:
                        break
            if syn:
                sense["y"] = syn
                for y in syn:
                    if y not in similar and len(similar) < 10:
                        similar.append(y)
            senses.append(sense)
        if not senses:
            continue
        body = {"p": pos, "s": senses}
        prons = []
        for p in lem.findall("Pronunciation"):
            if p.text and f"/{p.text}/" not in prons:
                prons.append(f"/{p.text}/")
        if prons:
            body["i"] = prons[:2]
        if similar:
            body["y"] = similar
        out.entry(word, pos, body)
        for fm in le.findall("Form"):
            if fm.get("writtenForm"):
                out.form(fm.get("writtenForm"), word)
    print(f"  {out.count:,} entries, {len(out.forms):,} forms; writing", flush=True)
    out.close()


# ---------- the download manifest ----------

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(out_dir, base, files):
    os.makedirs(out_dir, exist_ok=True)
    items = []
    for path in files:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        meta = dict(db.execute("SELECT key, value FROM meta"))
        db.close()
        name = os.path.basename(path)
        gz = os.path.join(out_dir, name + ".gz")
        with open(path, "rb") as src, gzip.open(gz, "wb", compresslevel=9) as dst:
            shutil.copyfileobj(src, dst, 1 << 20)
        items.append({
            "id": meta["id"],
            "name": meta["name"],
            "edition": meta.get("edition", ""),
            "format": int(meta["format"]),
            "file": name,
            "size": os.path.getsize(path),
            "sha256": sha256(path),
            # relative to the list unless a base is given, so the same list works wherever it's hosted
            "url": (base.rstrip("/") + "/" if base else "") + name + ".gz",
            "gzip": True,
            "downloadSize": os.path.getsize(gz),
            "downloadSha256": sha256(gz),
            "entries": int(meta.get("entries", 0)),
            "licence": meta["licence"],
            "licenceUrl": meta["licence_url"],
            "credit": meta["credit"],
        })
        print(f"  {name}: {items[-1]['size']:,} bytes, {items[-1]['downloadSize']:,} gzipped")
    with open(os.path.join(out_dir, "katana-dictionaries.json"), "w", encoding="utf-8") as f:
        json.dump({"format": FORMAT, "dictionaries": items}, f, ensure_ascii=False, indent=2)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("wiktionary")
    w.add_argument("src")
    w.add_argument("dest")
    w.add_argument("--edition", default=time.strftime("%b %Y"))
    n = sub.add_parser("wordnet")
    n.add_argument("src")
    n.add_argument("dest")
    m = sub.add_parser("manifest")
    m.add_argument("out_dir")
    m.add_argument("base")
    m.add_argument("files", nargs="+")
    a = ap.parse_args()
    if a.cmd == "wiktionary":
        wiktionary(a.src, a.dest, a.edition)
    elif a.cmd == "wordnet":
        wordnet(a.src, a.dest)
    else:
        manifest(a.out_dir, a.base, a.files)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
