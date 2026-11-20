// Local's folder structure, worked out from each book's folder and the folders between it and the file.
import type { Book, Folder } from "./api";
import type { Place } from "./store";
import { plural } from "./format";

export type Tile = { name: string; count: string; peek: Book[]; to: Place };
export type Crumb = { label: string; to: Place | null };
export type Listing = { crumbs: Crumb[]; tiles: Tile[]; books: Book[]; label: string };

const byTitle = (a: Book, b: Book) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });

/** Two books to peek out of a folder: ones with real covers first, the most recently read first. */
const peekOf = (books: Book[]) =>
  [...books]
    .sort((a, b) => Number(!!b.cover) - Number(!!a.cover) || (b.openedAt ?? 0) - (a.openedAt ?? 0) || byTitle(a, b))
    .slice(0, 2);

const countText = (books: number, folders: number) =>
  folders ? `${plural(books, "book")} · ${plural(folders, "folder")}` : plural(books, "book");

function subTiles(inFolder: Book[], folderId: number, sub: string[]): Tile[] {
  const prefix = sub.length ? sub.join("/") + "/" : "";
  const groups = new Map<string, Book[]>();
  for (const b of inFolder) {
    if (prefix && !(b.relDir + "/").startsWith(prefix)) continue;
    const rest = prefix ? b.relDir.slice(prefix.length) : b.relDir;
    if (!rest) continue;
    const name = rest.split("/")[0];
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(b);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([name, books]) => {
      const childPrefix = prefix + name + "/";
      const subfolders = new Set(
        books
          .map((b) => (b.relDir + "/").slice(childPrefix.length).split("/")[0])
          .filter(Boolean),
      );
      return { name, count: countText(books.length, subfolders.size), peek: peekOf(books), to: { folderId, sub: [...sub, name] } };
    });
}

export function listing(folders: Folder[], books: Book[], place: Place): Listing {
  const loose = books.filter((b) => b.folderId == null).sort(byTitle);
  // with one folder, Local opens straight into it (Books › Nonfiction)
  const single = folders.length === 1 ? folders[0] : null;
  const folderId = place.folderId ?? single?.id ?? null;

  if (folderId == null) {
    const tiles = folders.map((f) => {
      const inF = books.filter((b) => b.folderId === f.id);
      const subs = new Set(inF.map((b) => b.relDir.split("/")[0]).filter(Boolean));
      return { name: f.name, count: countText(inF.length, subs.size), peek: peekOf(inF), to: { folderId: f.id, sub: [] } };
    });
    return { crumbs: [{ label: "Local", to: null }], tiles, books: loose, label: loose.length ? "Added one by one" : "" };
  }

  const folder = folders.find((f) => f.id === folderId);
  const inFolder = books.filter((b) => b.folderId === folderId);
  const here = inFolder.filter((b) => b.relDir === place.sub.join("/")).sort(byTitle);
  const atTop = place.sub.length === 0;
  const crumbs: Crumb[] = [];
  if (!single) crumbs.push({ label: "Local", to: { folderId: null, sub: [] } });
  crumbs.push({ label: folder?.name ?? "Folder", to: { folderId, sub: [] } });
  place.sub.forEach((s, i) => crumbs.push({ label: s, to: { folderId, sub: place.sub.slice(0, i + 1) } }));
  crumbs[crumbs.length - 1].to = null;

  const name = atTop ? folder?.name ?? "" : place.sub[place.sub.length - 1];
  const shown = single && atTop ? [...here, ...loose].sort(byTitle) : here;
  const tiles = subTiles(inFolder, folderId, place.sub);
  const label = shown.length ? (atTop ? `Loose in ${name}` : `In ${name}`) : "";
  return { crumbs, tiles, books: shown, label };
}

export function search(books: Book[], q: string): Book[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return books
    .filter((b) => {
      const hay = `${b.title} ${b.author ?? ""} ${b.relDir}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort(byTitle);
}
