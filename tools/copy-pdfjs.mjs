// Copies PDF.js's character maps, standard fonts and WebAssembly decoders (JPEG 2000, JBIG2, colour
// profiles) from node_modules into public/pdfjs, where the reader loads them from. Run before dev and build.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "pdfjs-dist");
const to = join(root, "public", "pdfjs");
mkdirSync(to, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  if (existsSync(join(from, dir))) cpSync(join(from, dir), join(to, dir), { recursive: true });
}
cpSync(join(from, "LICENSE"), join(to, "LICENSE"));
