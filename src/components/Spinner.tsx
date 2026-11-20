/** A small ring that turns while something works (syncing, signing in, looking): in the text's colour,
 *  the size of an icon, so it sits where the icon was. */
export function Spinner({ big = false }: { big?: boolean }) {
  return <span className={`spinner ${big ? "big" : ""}`} aria-hidden="true" />;
}
