// Settings › Dictionaries: the built-in ones (download, pause, go on, remove), his StarDict files
// (added by their .ifo, read where they are), the address the built-in ones come from, and the
// credits and licences (also under About).
import { useEffect, useState } from "react";
import { DownloadLine, useDictStatus } from "../components/DictView";
import { plural } from "../lib/format";
import { dict, mb } from "../lib/words";

export function DictSettings() {
  const [st, setSt] = useDictStatus();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setUrl(st?.url ?? ""), [st?.url]);
  if (!st) return null;
  const changed = url.trim() !== st.url;
  const add = async () => {
    setError("");
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: [{ name: "StarDict dictionary (.ifo)", extensions: ["ifo"] }] });
    if (typeof path !== "string") return;
    try {
      setSt(await dict.addStarDict(path));
    } catch (e) {
      setError(String(e));
    }
  };
  const saveUrl = async (u: string) => {
    setError("");
    try {
      setSt(await dict.setUrl(u));
      setSt(await dict.refresh().catch(() => dict.status()));
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="grp">
      {st.builtin.map((b) =>
        b.installed && !(b.progress && ["queued", "running", "unpacking"].includes(b.progress.state)) ? (
          <div className="srow" key={b.id}>
            <i className="ms" style={{ color: "var(--k-var)" }}>
              dictionary
            </i>
            <div className="tx">
              <b>{b.name}</b>
              <small>
                On this PC, offline · {b.edition ? `${b.edition} · ` : ""}
                {mb(b.size)} · {b.licence}
              </small>
            </div>
            <button type="button" className="ib" title={`Remove ${b.name} from this PC (it can be downloaded again)`} onClick={async () => setSt(await dict.remove(b.id))}>
              <i className="ms">remove_circle_outline</i>
            </button>
          </div>
        ) : (
          <div className="srow" key={b.id}>
            <i className="ms" style={{ color: "var(--k-var)" }}>
              dictionary
            </i>
            <div className="tx">
              <DownloadLine b={b} />
            </div>
            {(b.kept > 0 || b.progress?.state === "paused") && (
              <button type="button" className="ib" title="Stop and throw away what came so far" onClick={() => dict.cancel(b.id)}>
                <i className="ms">close</i>
              </button>
            )}
          </div>
        ),
      )}
      {st.stardict.map((s) => (
        <div className="srow" key={s.id}>
          <i className="ms" style={{ color: "var(--k-var)" }}>
            menu_book
          </i>
          <div className="tx">
            <b>{s.name}</b>
            <small>
              Your StarDict file · {plural(s.words, "word")} · {s.path}
            </small>
          </div>
          <button type="button" className="ib" title="Stop using this dictionary (the files stay where they are)" onClick={async () => setSt(await dict.removeStarDict(s.id))}>
            <i className="ms">remove_circle_outline</i>
          </button>
        </div>
      ))}
      <div className="srow">
        <div className="tx">
          <b>Your own dictionaries</b>
          <small>StarDict files (.ifo with its .idx and .dict or .dict.dz) are read where they are and get their own tab in the word card.</small>
          {error && <small className="err">{error}</small>}
        </div>
        <button type="button" className="pill" onClick={add}>
          <i className="ms">add</i>Add StarDict
        </button>
      </div>
      <div className="srow">
        <div className="tx">
          <b>Where the built-in dictionaries come from</b>
          <small>The list of files (katana-dictionaries.json). Leave it empty for the default.</small>
        </div>
        <span className="field" style={{ width: 300 }}>
          <input
            value={url}
            placeholder={st.defaultUrl}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => e.key === "Enter" && changed && saveUrl(url)}
            aria-label="Dictionary list address"
          />
        </span>
        <button type="button" className="pill" disabled={!changed} onClick={() => saveUrl(url)}>
          Save
        </button>
      </div>
    </div>
  );
}

/** The dictionaries' credits and licences, for About. */
export function DictCredits() {
  const [st] = useDictStatus();
  if (!st) return null;
  return (
    <>
      {st.builtin.map((b) => (
        <div className="srow" key={b.id}>
          <div className="tx">
            <b>{b.name}</b>
            <small>{b.credit}</small>
          </div>
          <button type="button" className="pill" title={b.licenceUrl} onClick={() => dict.openUrl(b.licenceUrl)}>
            {b.licence}
            <i className="ms">open_in_new</i>
          </button>
        </div>
      ))}
    </>
  );
}
