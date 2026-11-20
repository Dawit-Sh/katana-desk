// Reading settings: per book, with "Save as default" for books without their own.
// Every choice with a look is drawn as a little picture in the Aa panel (AaPanel.tsx).
import { api } from "../lib/api";
import { invoke } from "@tauri-apps/api/core";
import serif400 from "@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2?url";
import serif400i from "@fontsource/noto-serif/files/noto-serif-latin-400-italic.woff2?url";
import serif700 from "@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff2?url";
import serif700i from "@fontsource/noto-serif/files/noto-serif-latin-700-italic.woff2?url";
import literata from "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url";
import literataI from "@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url";
import source from "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2?url";
import sourceI from "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-italic.woff2?url";
import manrope from "@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url";
import atk400 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?url";
import atk400i from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff2?url";
import atk700 from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?url";
import atk700i from "@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-italic.woff2?url";

export type FontId = "book" | "noto" | "literata" | "source" | "manrope" | "atkinson";
export type ColourId = "theme" | "paper" | "sepia" | "grey" | "dusk" | "black";
export type LayoutId = "auto" | "one" | "two" | "scroll";
export type MarginId = "narrow" | "normal" | "wide";
/** the text's colour: "auto" = the book's own on light pages, the page's on dark ones; anything else always */
export type TextId = "auto" | "page" | "white" | "cream" | "amber" | "grey" | "ink";

export type Prefs = {
  font: FontId;
  /** percent of the base size (18 px) */
  size: number;
  spacing: number;
  align: "left" | "justify";
  margins: MarginId;
  hyphens: boolean;
  /** the book's own styles (its fonts, colours, spacing); off = Katana's plain page */
  bookStyles: boolean;
  colour: ColourId;
  /** page and text colours swapped */
  invert: boolean;
  text: TextId;
  layout: LayoutId;
  footnotes: "popup" | "jump";
};

export const BUILT_IN: Prefs = {
  font: "noto",
  size: 100,
  spacing: 1.6,
  align: "justify",
  margins: "normal",
  hyphens: true,
  bookStyles: true,
  colour: "theme",
  invert: false,
  text: "auto",
  layout: "auto",
  footnotes: "popup",
};

const abs = (u: string) => new URL(u, location.href).href;

type Face = { url: string; weight: string; style: "normal" | "italic" };
export const FONTS: { id: FontId; name: string; family: string; faces: Face[] }[] = [
  { id: "book", name: "The book's own", family: "", faces: [] },
  {
    id: "noto",
    name: "Noto Serif",
    family: '"Noto Serif"',
    faces: [
      { url: serif400, weight: "400", style: "normal" },
      { url: serif400i, weight: "400", style: "italic" },
      { url: serif700, weight: "700", style: "normal" },
      { url: serif700i, weight: "700", style: "italic" },
    ],
  },
  {
    id: "literata",
    name: "Literata",
    family: '"Literata Variable"',
    faces: [
      { url: literata, weight: "200 900", style: "normal" },
      { url: literataI, weight: "200 900", style: "italic" },
    ],
  },
  {
    id: "source",
    name: "Source Serif",
    family: '"Source Serif 4 Variable"',
    faces: [
      { url: source, weight: "200 900", style: "normal" },
      { url: sourceI, weight: "200 900", style: "italic" },
    ],
  },
  { id: "manrope", name: "Manrope", family: '"Manrope Variable"', faces: [{ url: manrope, weight: "200 800", style: "normal" }] },
  {
    id: "atkinson",
    name: "Atkinson",
    family: '"Atkinson Hyperlegible"',
    faces: [
      { url: atk400, weight: "400", style: "normal" },
      { url: atk400i, weight: "400", style: "italic" },
      { url: atk700, weight: "700", style: "normal" },
      { url: atk700i, weight: "700", style: "italic" },
    ],
  },
];

/** The fonts also load in the app itself, so the Aa panel can show each one in its own letters. */
let uiFontsLoaded = false;
export function loadUiFonts() {
  if (uiFontsLoaded) return;
  uiFontsLoaded = true;
  const css = FONTS.flatMap((f) =>
    f.faces.map(
      (x) =>
        `@font-face { font-family: ${f.family}; src: url("${abs(x.url)}") format("woff2"); font-weight: ${x.weight}; font-style: ${x.style}; font-display: swap; }`,
    ),
  ).join("\n");
  const el = document.createElement("style");
  el.dataset.katana = "reader-fonts";
  el.textContent = css;
  document.head.append(el);
}

export const COLOURS: { id: ColourId; name: string; bg: string; fg: string; dark: boolean }[] = [
  { id: "paper", name: "Paper", bg: "#fdf9f2", fg: "#24201b", dark: false },
  { id: "sepia", name: "Sepia", bg: "#f1e4c8", fg: "#3a2e1d", dark: false },
  { id: "grey", name: "Grey", bg: "#d9d9d6", fg: "#222222", dark: false },
  { id: "dusk", name: "Dusk", bg: "#1d2024", fg: "#d9d5cc", dark: true },
  { id: "black", name: "Black", bg: "#000000", fg: "#c9c9c9", dark: true },
];

/** Text colours to choose from ("page" = the page colour's own text colour, on every page). */
export const TEXTS: { id: TextId; name: string; fg?: string }[] = [
  { id: "auto", name: "Automatic" },
  { id: "page", name: "The page's" },
  { id: "white", name: "White", fg: "#f2f0ea" },
  { id: "cream", name: "Cream", fg: "#e8dcc0" },
  { id: "amber", name: "Amber", fg: "#f0b860" },
  { id: "grey", name: "Grey", fg: "#9a9a96" },
  { id: "ink", name: "Ink", fg: "#14120f" },
];

export const SPACINGS = [1.4, 1.6, 1.8, 2.0];

/** Margins: how wide a column may be and the gap around it. */
export const MARGINS: Record<MarginId, { inline: number; gap: number; name: string }> = {
  narrow: { inline: 860, gap: 4, name: "Narrow" },
  normal: { inline: 720, gap: 6, name: "Normal" },
  wide: { inline: 600, gap: 10, name: "Wide" },
};

export type PageColours = { bg: string; fg: string; dark: boolean; force: boolean };

/** The page's colours: the chosen page colour (or the app theme's page when "As the theme"), swapped when
 *  inverted, and the text colour. `force` = the text colour wins over the book's own colours. */
export function pageColours(p: Prefs): PageColours {
  let c = COLOURS.find((x) => x.id === p.colour);
  if (!c) c = document.documentElement.dataset.tone !== "light" ? COLOURS[3] : COLOURS[0];
  let { bg, fg, dark } = c;
  if (p.invert) [bg, fg, dark] = [fg, bg, !dark];
  const t = TEXTS.find((x) => x.id === p.text);
  if (t?.fg) fg = t.fg;
  return { bg, fg, dark, force: dark || p.invert || (p.text ?? "auto") !== "auto" };
}

export function normalise(x: unknown): Prefs {
  const o = (x && typeof x === "object" ? x : {}) as Partial<Prefs>;
  const p = { ...BUILT_IN, ...o };
  if (!FONTS.some((f) => f.id === p.font)) p.font = BUILT_IN.font;
  if (p.colour !== "theme" && !COLOURS.some((c) => c.id === p.colour)) p.colour = "theme";
  if (!TEXTS.some((t) => t.id === p.text)) p.text = "auto";
  p.invert = !!p.invert;
  if (!["auto", "one", "two", "scroll"].includes(p.layout)) p.layout = "auto";
  if (!(p.margins in MARGINS)) p.margins = "normal";
  p.size = Math.min(200, Math.max(70, Math.round(Number(p.size) || 100)));
  p.spacing = Number(p.spacing) || 1.6;
  return p;
}

const parse = (s: string | null) => {
  if (!s) return null;
  try {
    return normalise(JSON.parse(s));
  } catch {
    return null;
  }
};

/** This book's settings, or the default, or Katana's own. `own` = the book has settings of its own. */
export async function loadPrefs(bookId: number): Promise<{ prefs: Prefs; own: boolean; def: Prefs }> {
  const r = await invoke<{ book: string | null; default: string | null }>("reader_prefs", { bookId }).catch(() => ({
    book: null,
    default: null,
  }));
  const def = parse(r.default) ?? BUILT_IN;
  const own = parse(r.book);
  return { prefs: own ?? def, own: !!own, def };
}

export const saveBookPrefs = (bookId: number, p: Prefs | null) =>
  invoke<void>("set_book_prefs", { bookId, prefs: p ? JSON.stringify(p) : null });
export const saveDefaultPrefs = (p: Prefs) => api.setSetting("reader.defaults", JSON.stringify(p));

/** The styles put into the book's pages. */
export function bookCss(p: Prefs, theme: { fg: string; dark: boolean; force?: boolean }) {
  const font = FONTS.find((f) => f.id === p.font)!;
  // with the book's own styles off and no font chosen, the page uses Katana's book serif
  const useFont = font.id === "book" && !p.bookStyles ? FONTS[1] : font;
  const faces = [...FONTS[1].faces.map((x) => ({ ...x, family: FONTS[1].family })), ...useFont.faces.map((x) => ({ ...x, family: useFont.family }))]
    .map(
      (x) =>
        `@font-face { font-family: ${x.family}; src: url("${abs(x.url)}") format("woff2"); font-weight: ${x.weight}; font-style: ${x.style}; }`,
    )
    .join("\n");
  const link = theme.dark ? "#9cc4ec" : "#2f5f8a";
  const base = (18 * p.size) / 100;
  const notCode = ":not(code, pre, kbd, samp, tt, code *, pre *, kbd *, samp *)";
  const family = useFont.family ? `${useFont.family}, Georgia, serif` : "";
  const hy = p.hyphens ? "auto" : "manual";
  return `
${faces}
html { color-scheme: ${theme.dark ? "dark" : "light"}; color: ${theme.fg}; font-size: ${base}px !important; }
html, body { background: transparent !important; }
body { ${family ? `font-family: ${family};` : `font-family: "Noto Serif", Georgia, serif;`} line-height: ${p.spacing}; hyphens: ${hy}; -webkit-hyphens: ${hy}; }
${family ? `body, body *${notCode} { font-family: ${family} !important; }` : ""}
body :is(p, li, blockquote, dd, dt, div, td) { line-height: ${p.spacing} !important; }
body :is(p, li, blockquote, dd) { text-align: ${p.align}; }
body, body * { hyphens: ${hy} !important; -webkit-hyphens: ${hy} !important; }
a:any-link { color: ${link}; }
${
  theme.force || theme.dark
    ? `html, body { color: ${theme.fg} !important; }
body :is(p, div, span, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, em, i, b, strong, small, sup, sub, section, article, font, center, cite, q, u, s, mark, abbr, label, table, tr, tbody, ul, ol, dl, figcaption) { color: inherit !important; }
body :is(div, section, article, p, td, th, blockquote, span, table, tr, center) { background-color: transparent !important; }`
    : ""
}
${
  p.bookStyles
    ? ""
    : `
body :is(p, div, li, blockquote, dd, dt, section, article, td, th) { font-size: 1rem !important; margin-inline: 0 !important; padding-inline: 0 !important; }
body :is(p, div, span, li, td, th, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, em, i, b, strong, small, a, font) { color: inherit !important; background-color: transparent !important; letter-spacing: normal !important; word-spacing: normal !important; }
body p { margin-block: 0 !important; text-indent: 1.4em !important; text-align: ${p.align} !important; }
body :is(h1, h2, h3, h4, h5, h6) { font-family: ${family || '"Noto Serif", Georgia, serif'} !important; line-height: 1.3 !important; text-indent: 0 !important; margin: 1.2em 0 .6em !important; }
body :is(h1, h2, h3, h4, h5, h6) + p { text-indent: 0 !important; }
`
}
`;
}
