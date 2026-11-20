// PDF covers for the library: PDF.js draws each PDF's first page once, in the background, and Rust keeps
// it as the cover (src-tauri/src/pages.rs). A PDF that can't be drawn is tried once and left without one.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fileUrl } from "./api";
import { useStore } from "./store";
import { pdfjs, pdfOpts } from "../reader/pagesrc";

const WIDTH = 360;

async function firstPage(path: string): Promise<number[]> {
  const lib = await pdfjs();
  const task = lib.getDocument(pdfOpts(fileUrl(path)));
  const timer = window.setTimeout(() => task.destroy(), 20000);
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d", { alpha: false })!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
    return blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : [];
  } finally {
    clearTimeout(timer);
    task.destroy().catch(() => {});
  }
}

let running = false;

async function run() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const todo = await invoke<[number, string][]>("pdf_covers_todo");
      if (!todo.length) break;
      let since = 0;
      for (const [id, path] of todo) {
        // a book open in the reader goes first: covers wait
        while (useStore.getState().readingId != null) await new Promise((r) => setTimeout(r, 3000));
        let bytes: number[] = [];
        try {
          bytes = await firstPage(path);
        } catch {
          /* no cover for this one */
        }
        const ok = await invoke<boolean>("pdf_cover", { id, png: bytes }).catch(() => false);
        if (ok && ++since >= 24) {
          since = 0;
          useStore.getState().reload();
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      useStore.getState().reload();
    }
  } finally {
    running = false;
  }
}

/** Starts the covers once the library is up, and again whenever it changes. */
export function startPdfCovers() {
  setTimeout(run, 4000);
  const un = listen("library-changed", () => setTimeout(run, 2000));
  return () => {
    un.then((f) => f());
  };
}
