// Footnotes in a pop-up: a link that points at a note (EPUB 3's noteref, or a small raised number
// pointing into the book) shows the note over the page instead of jumping to it.

const types = (el: Element | null) =>
  new Set((el?.getAttributeNS?.("http://www.idpf.org/2007/ops", "type") ?? el?.getAttribute?.("epub:type") ?? "").split(/\s+/));
const roles = (el: Element | null) => new Set((el?.getAttribute?.("role") ?? "").split(/\s+/));

const raised = (el: Element | null) => {
  if (!el) return false;
  if (el.matches("sup")) return true;
  const v = el.ownerDocument.defaultView?.getComputedStyle(el).verticalAlign ?? "";
  return v === "super" || v === "top" || v === "text-top" || /^\d/.test(v);
};

/** Is this link a note reference? Sure ones by their type; likely ones by being a small raised number. */
export function isNoteLink(a: HTMLAnchorElement) {
  const t = types(a);
  const r = roles(a);
  if (["noteref", "biblioref", "glossref"].some((x) => t.has(x)) || ["doc-noteref", "doc-biblioref", "doc-glossref"].some((x) => r.has(x)))
    return true;
  if (t.has("backlink") || r.has("doc-backlink")) return false;
  const text = (a.textContent ?? "").trim();
  const short = text.length > 0 && text.length <= 4;
  return short && (raised(a) || (a.children.length === 1 && raised(a.children[0])) || raised(a.parentElement));
}

const INLINE = "a, span, sup, sub, em, strong, i, b, small, big";

/** The note's element: the target, grown to its block (the paragraph or list item that holds it). */
export function noteElement(target: Element | Range | null): Element | null {
  if (!target) return null;
  let el: Element | null = target instanceof Range ? (target.startContainer as Element).parentElement ?? null : target;
  if (!el) return null;
  const start = el;
  while (el && el.matches(INLINE) && el.parentElement) el = el.parentElement;
  if (!el || el === el.ownerDocument.body) {
    const sib = start.nextElementSibling;
    return sib && !sib.matches(INLINE) ? sib : start;
  }
  return el;
}

const KEEP = new Set(["P", "DIV", "SPAN", "EM", "I", "B", "STRONG", "SUP", "SUB", "SMALL", "BR", "UL", "OL", "LI", "BLOCKQUOTE", "CITE", "Q", "ASIDE", "SECTION", "DD", "DT", "DL"]);
const BLOCK = new Set(["P", "DIV", "LI", "BLOCKQUOTE", "ASIDE", "SECTION", "DD", "DT"]);

/** Copies the note into plain, safe HTML elements of this document: text and simple formatting only. */
export function cleanNote(src: Element): DocumentFragment {
  const out = document.createDocumentFragment();
  const walk = (from: Node, to: Node) => {
    for (const n of Array.from(from.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) to.appendChild(document.createTextNode(n.textContent ?? ""));
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as Element;
        const tag = el.tagName.toUpperCase();
        if (tag === "SCRIPT" || tag === "STYLE") continue;
        // the note's own "back" link is noise in a pop-up
        if (tag === "A" && (types(el).has("backlink") || roles(el).has("doc-backlink"))) continue;
        if (KEEP.has(tag)) {
          const copy = document.createElement(BLOCK.has(tag) ? (tag === "LI" ? "li" : "p") : tag.toLowerCase());
          walk(el, copy);
          to.appendChild(copy);
        } else walk(el, to);
      }
    }
  };
  walk(src, out);
  return out;
}
