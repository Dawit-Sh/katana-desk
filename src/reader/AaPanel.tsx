// The Aa panel: reading settings for this book, "Save as default" for books without their own.
// Show, don't name: every choice with a look is a little picture of the result, its name under it.
import type { ReactNode } from "react";
import { COLOURS, FONTS, MARGINS, SPACINGS, TEXTS, pageColours, type LayoutId, type MarginId, type Prefs } from "./prefs";

/** A little page: lines drawn as bars, in the page's colours. */
function MiniPage({
  bg = "var(--k-page)",
  fg = "var(--k-ptext)",
  lines = 5,
  gap = 5,
  pad = 8,
  align = "justify",
  split,
}: {
  bg?: string;
  fg?: string;
  lines?: number;
  gap?: number;
  pad?: number;
  align?: "left" | "justify";
  split?: [string, string];
}) {
  // ragged lines for "left", full lines for "justified" (the last line short in both)
  const widths = align === "left" ? [92, 70, 84, 64, 78, 58, 88] : [100, 100, 100, 100, 100, 100, 100];
  return (
    <span
      className="mpg"
      style={{
        background: split ? `linear-gradient(135deg, ${split[0]} 50%, ${split[1]} 50%)` : bg,
        gap,
        padding: `10px ${pad}px`,
      }}
    >
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} style={{ background: split ? "#888" : fg, width: i === lines - 1 ? "62%" : `${widths[i % widths.length]}%` }} />
      ))}
    </span>
  );
}

function Tile({ on, name, title, onPick, children }: { on: boolean; name: string; title?: string; onPick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`tile ${on ? "on" : ""}`} aria-pressed={on} title={title ?? name} onClick={onPick}>
      {children}
      <span className="tn">{name}</span>
    </button>
  );
}

const Spread = ({ n, tall }: { n: number; tall?: boolean }) => (
  <span className="lay">
    {Array.from({ length: n }, (_, i) => (
      <span key={i} className={`pp ${tall ? "tall" : ""}`}>
        {Array.from({ length: tall ? 7 : 4 }, (_, j) => (
          <i key={j} />
        ))}
      </span>
    ))}
  </span>
);

export function AaPanel({
  prefs,
  set,
  own,
  isDefault,
  fixed,
  onSaveDefault,
  onUseDefault,
  footer,
}: {
  prefs: Prefs;
  set: (p: Partial<Prefs>) => void;
  own: boolean;
  /** this book's settings are the same as the default */
  isDefault: boolean;
  /** a book of fixed pages (comics, fixed-layout EPUB): text settings don't apply */
  fixed: boolean;
  onSaveDefault: () => void;
  onUseDefault: () => void;
  /** in place of the save-as-default row (Settings › Reading defaults) */
  footer?: ReactNode;
}) {
  const layouts: { id: LayoutId; name: string; title: string; pic: ReactNode }[] = [
    {
      id: "auto",
      name: "Auto",
      title: "Auto: two pages when the window is 1200 px wide or more, else one",
      pic: (
        <span className="lay">
          <span className="pp">
            <i /><i /><i /><i />
          </span>
          <span className="pp ghost">
            <i /><i /><i /><i />
          </span>
        </span>
      ),
    },
    { id: "one", name: "One page", title: "One page", pic: <Spread n={1} /> },
    { id: "two", name: "Two pages", title: "Two pages side by side", pic: <Spread n={2} /> },
    { id: "scroll", name: "Scroll", title: "Scroll down through the book", pic: <Spread n={1} tall /> },
  ];
  return (
    <div className="aa">
      {fixed && <div className="note">This book has fixed pages, so only the page colour and layout apply.</div>}
      {!fixed && (
        <>
          <div className="grpl">Font</div>
          <div className="tiles c3">
            {FONTS.map((f) => (
              <Tile key={f.id} on={prefs.font === f.id} name={f.name} onPick={() => set({ font: f.id })}>
                <span className="fpic" style={{ fontFamily: f.family || "Georgia, serif" }}>
                  Aa
                  {f.id === "book" && <i className="ms">menu_book</i>}
                </span>
              </Tile>
            ))}
          </div>
          <div className="arow">
            <span>Size</span>
            <span className="step">
              <button type="button" aria-label="Smaller" title="Smaller (Ctrl -)" onClick={() => set({ size: Math.max(70, prefs.size - 10) })}>
                <span className="sa">A</span>
              </button>
              <span className="sv">{prefs.size}%</span>
              <button type="button" aria-label="Bigger" title="Bigger (Ctrl +)" onClick={() => set({ size: Math.min(200, prefs.size + 10) })}>
                <span className="sa big">A</span>
              </button>
            </span>
          </div>
          <div className="grpl">Line spacing</div>
          <div className="tiles c4">
            {SPACINGS.map((s) => (
              <Tile key={s} on={prefs.spacing === s} name={s.toFixed(1)} title={`Line spacing ${s.toFixed(1)}`} onPick={() => set({ spacing: s })}>
                <MiniPage lines={Math.round(7 - (s - 1.4) * 5)} gap={Math.round(2 + (s - 1.4) * 12)} />
              </Tile>
            ))}
          </div>
          <div className="grpl">Alignment</div>
          <div className="tiles c4">
            <Tile on={prefs.align === "left"} name="Left" title="Lines start at the left, ragged on the right" onPick={() => set({ align: "left" })}>
              <MiniPage align="left" />
            </Tile>
            <Tile on={prefs.align === "justify"} name="Justified" title="Lines fill the column" onPick={() => set({ align: "justify" })}>
              <MiniPage align="justify" />
            </Tile>
          </div>
          <div className="grpl">Margins</div>
          <div className="tiles c4">
            {(Object.keys(MARGINS) as MarginId[]).map((m) => (
              <Tile key={m} on={prefs.margins === m} name={MARGINS[m].name} onPick={() => set({ margins: m })}>
                <MiniPage pad={{ narrow: 4, normal: 8, wide: 13 }[m]} />
              </Tile>
            ))}
          </div>
          <button type="button" className="arow sw-row" onClick={() => set({ hyphens: !prefs.hyphens })} aria-pressed={prefs.hyphens}>
            <span>
              Hyphenation
              <small>Long words split at line ends{prefs.hyphens ? "" : " (off)"}</small>
            </span>
            <span className={`sw ${prefs.hyphens ? "on" : ""}`} />
          </button>
          <button type="button" className="arow sw-row" onClick={() => set({ bookStyles: !prefs.bookStyles })} aria-pressed={prefs.bookStyles}>
            <span>
              The book's own styles
              <small>{prefs.bookStyles ? "Its fonts, sizes and spacing where you haven't chosen" : "A plain page: Katana's spacing and indents"}</small>
            </span>
            <span className={`sw ${prefs.bookStyles ? "on" : ""}`} />
          </button>
        </>
      )}
      <div className="grpl">Page colour</div>
      <div className="tiles c3">
        <Tile on={prefs.colour === "theme"} name="As the app" title="Follows the app: Paper by day, Graphite by night" onPick={() => set({ colour: "theme" })}>
          <MiniPage split={["#fdf9f2", "#1d2024"]} />
        </Tile>
        {COLOURS.map((c) => (
          <Tile key={c.id} on={prefs.colour === c.id} name={c.name} onPick={() => set({ colour: c.id })}>
            <MiniPage bg={c.bg} fg={c.fg} />
          </Tile>
        ))}
      </div>
      <button type="button" className="arow sw-row" onClick={() => set({ invert: !prefs.invert })} aria-pressed={prefs.invert}>
        <span>
          Invert colours
          <small>{prefs.invert ? "This page colour by night (or by day): Paper turns to Dusk, Black to white" : "The same page colour for the other time of day: light pages go dark, dark pages go light"}</small>
        </span>
        <span className={`sw ${prefs.invert ? "on" : ""}`} />
      </button>
      <div className="grpl">Text colour</div>
      <div className="tiles c4">
        {TEXTS.map((t) => {
          const pc = pageColours({ ...prefs, text: t.id });
          return (
            <Tile
              key={t.id}
              on={prefs.text === t.id}
              name={t.name}
              title={t.id === "auto" ? "The book's own colours on light pages, the page's text colour on dark ones" : `${t.name}: a shade for light pages and one for dark pages, over the book's own colours`}
              onPick={() => set({ text: t.id })}
            >
              <span className="txc" style={{ background: pc.bg, color: t.id === "auto" && !pc.force ? undefined : pc.fg }}>
                Aa
              </span>
            </Tile>
          );
        })}
      </div>
      {!fixed && (
        <>
          <div className="grpl">Layout</div>
          <div className="tiles c4">
            {layouts.map((l) => (
              <Tile key={l.id} on={prefs.layout === l.id} name={l.name} title={l.title} onPick={() => set({ layout: l.id })}>
                {l.pic}
              </Tile>
            ))}
          </div>
          <div className="grpl">Footnotes</div>
          <div className="tiles c4">
            <Tile on={prefs.footnotes === "popup"} name="Pop-up" title="A footnote opens over the page" onPick={() => set({ footnotes: "popup" })}>
              <span className="lay fn">
                <span className="pp">
                  <i /><i /><i /><i />
                </span>
                <span className="bub" />
              </span>
            </Tile>
            <Tile on={prefs.footnotes === "jump"} name="Go to it" title="A footnote link goes to the note" onPick={() => set({ footnotes: "jump" })}>
              <span className="lay fn">
                <span className="pp">
                  <i /><i /><i /><i />
                </span>
                <i className="ms">arrow_forward</i>
                <span className="pp">
                  <i /><i />
                </span>
              </span>
            </Tile>
          </div>
        </>
      )}
      {footer ?? <div className="pfoot">
        <button type="button" className="pill tone" onClick={onSaveDefault} disabled={isDefault} title="Books without their own settings open like this">
          <i className="ms">check</i>
          {isDefault ? "This is the default" : "Save as default"}
        </button>
        {own && !isDefault && (
          <button type="button" className="pill" onClick={onUseDefault} title="Forget this book's own settings">
            Use the default
          </button>
        )}
      </div>}
    </div>
  );
}
