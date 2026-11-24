// The share card's picture effects (his ask, 2026-11-24: "the only effect we have is blur. I want you to add
// dither and all the other effects"), the same on Katana and Katana Desk: the rules are in
// Universe/projects/katana/2026-11-24-card-effects.md. Plain maths on RGBA pixels, so `npm test` checks them.

export type Effect = "none" | "blur" | "dither" | "halftone" | "grain" | "mono" | "duotone" | "pixel";

/** The effects as the chips show them, in order. */
export const EFFECTS: { id: Effect; name: string }[] = [
  { id: "none", name: "None" },
  { id: "blur", name: "Blur" },
  { id: "dither", name: "Dither" },
  { id: "halftone", name: "Halftone" },
  { id: "grain", name: "Grain" },
  { id: "mono", name: "Mono" },
  { id: "duotone", name: "Duotone" },
  { id: "pixel", name: "Pixel" },
];

/** Dither and Halftone's two inks. */
export const INK_DARK = [0x1b, 0x1b, 0x1f] as const;
export const INK_LIGHT = [0xef, 0xe9, 0xdc] as const;
/** Duotone's ends. */
export const DUO_SHADOW = [0x1d, 0x2b, 0x45] as const;
export const DUO_HIGHLIGHT = [0xf0, 0xc4, 0x8a] as const;

/** Dither works at a third of the card, then is scaled back up without smoothing. */
export const DITHER_SCALE = 3;
export const HALFTONE_CELL = 12;
export const PIXEL_BLOCK = 36;
const GRAIN_DESATURATE = 0.4;
const GRAIN_AMPLITUDE = 28;
const GRAIN_SEED = 1234567;
const MONO_CONTRAST = 1.15;

export const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Atkinson dithering of `px` (RGBA, `w` × `h`) to the two inks, in place. */
export function dither(px: Uint8ClampedArray, w: number, h: number) {
  const l = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) l[i] = lum(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  const spread = (x: number, y: number, e: number) => {
    if (x >= 0 && x < w && y < h) l[y * w + x] += e;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dark = l[i] < 128;
      const e = (l[i] - (dark ? 0 : 255)) / 8;
      spread(x + 1, y, e);
      spread(x + 2, y, e);
      spread(x - 1, y + 1, e);
      spread(x, y + 1, e);
      spread(x + 1, y + 1, e);
      spread(x, y + 2, e);
      const ink = dark ? INK_DARK : INK_LIGHT;
      px[i * 4] = ink[0];
      px[i * 4 + 1] = ink[1];
      px[i * 4 + 2] = ink[2];
    }
  }
}

/** Halftone's dots: one per cell of `cell` px, its radius from the cell's mean luminance (black: a full dot). */
export function halftoneDots(px: Uint8ClampedArray, w: number, h: number, cell = HALFTONE_CELL) {
  const dots: { x: number; y: number; r: number }[] = [];
  for (let cy = 0; cy < h; cy += cell) {
    for (let cx = 0; cx < w; cx += cell) {
      let sum = 0;
      let n = 0;
      for (let y = cy; y < Math.min(h, cy + cell); y++) {
        for (let x = cx; x < Math.min(w, cx + cell); x++) {
          const i = (y * w + x) * 4;
          sum += lum(px[i], px[i + 1], px[i + 2]);
          n++;
        }
      }
      const r = (cell / 2) * Math.sqrt(1 - sum / n / 255);
      if (r > 0.05) dots.push({ x: cx + cell / 2, y: cy + cell / 2, r });
    }
  }
  return dots;
}

/** Grain: 40% towards grey, then the same fixed-seed noise on every channel of a pixel. In place. */
export function grain(px: Uint8ClampedArray) {
  let seed = GRAIN_SEED;
  for (let i = 0; i < px.length; i += 4) {
    const l = lum(px[i], px[i + 1], px[i + 2]);
    // (seed × 1103515245 + 12345) mod 2^31, in 32-bit integer maths (mod 2^32 keeps mod 2^31 right)
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    const n = Math.round((seed / 2147483648) * 2 * GRAIN_AMPLITUDE - GRAIN_AMPLITUDE);
    for (let c = 0; c < 3; c++) px[i + c] = px[i + c] + GRAIN_DESATURATE * (l - px[i + c]) + n;
  }
}

/** Mono: grey from luminance, a little more contrast. In place. */
export function mono(px: Uint8ClampedArray) {
  for (let i = 0; i < px.length; i += 4) {
    const g = (lum(px[i], px[i + 1], px[i + 2]) - 128) * MONO_CONTRAST + 128;
    px[i] = px[i + 1] = px[i + 2] = g;
  }
}

/** Duotone: luminance mapped from deep blue to warm sand. In place. */
export function duotone(px: Uint8ClampedArray) {
  for (let i = 0; i < px.length; i += 4) {
    const t = lum(px[i], px[i + 1], px[i + 2]) / 255;
    for (let c = 0; c < 3; c++) px[i + c] = DUO_SHADOW[c] + (DUO_HIGHLIGHT[c] - DUO_SHADOW[c]) * t;
  }
}

/** Pixel: blocks of `block` px, each its mean colour. In place. */
export function pixelate(px: Uint8ClampedArray, w: number, h: number, block = PIXEL_BLOCK) {
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      const ye = Math.min(h, by + block);
      const xe = Math.min(w, bx + block);
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = by; y < ye; y++) {
        for (let x = bx; x < xe; x++) {
          const i = (y * w + x) * 4;
          sum[0] += px[i];
          sum[1] += px[i + 1];
          sum[2] += px[i + 2];
          n++;
        }
      }
      for (let y = by; y < ye; y++) {
        for (let x = bx; x < xe; x++) {
          const i = (y * w + x) * 4;
          px[i] = sum[0] / n;
          px[i + 1] = sum[1] / n;
          px[i + 2] = sum[2] / n;
        }
      }
    }
  }
}
