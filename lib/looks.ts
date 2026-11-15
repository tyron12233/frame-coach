import type { LookId } from "./types";

export type Params = {
  exposure: number; // -1..1
  contrast: number; // -1..1
  saturation: number; // -1..1
  warmth: number; // -1..1
  tint: number; // -1..1 (green ← → magenta)
  fade: number; // 0..1
  grain: number; // 0..1
  vignette: number; // 0..1
  split: number; // 0..1 teal shadows / warm highlights
};

export type FrameStyle = "none" | "white" | "film" | "polaroid";

export const ZERO: Params = { exposure: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0, fade: 0, grain: 0, vignette: 0, split: 0 };

export const LOOKS: { id: LookId; name: string; params: Params }[] = [
  { id: "clean", name: "Clean", params: { ...ZERO, contrast: 0.06, saturation: 0.04 } },
  { id: "moody", name: "Moody", params: { ...ZERO, exposure: -0.18, contrast: 0.28, saturation: -0.28, warmth: -0.05, fade: 0.1, vignette: 0.38, split: 0.25 } },
  { id: "cinematic", name: "Cinematic", params: { ...ZERO, exposure: -0.04, contrast: 0.22, saturation: -0.05, fade: 0.06, vignette: 0.2, split: 0.6 } },
  { id: "harbor", name: "Harbor", params: { ...ZERO, exposure: 0.05, contrast: 0.15, saturation: -0.15, warmth: -0.4, tint: -0.05, fade: 0.08 } },
  { id: "dusk", name: "Dusk", params: { ...ZERO, exposure: -0.05, contrast: 0.22, saturation: 0.15, warmth: 0.45, tint: 0.12, fade: 0.12, vignette: 0.3 } },
  { id: "press", name: "Press", params: { ...ZERO, exposure: 0.04, contrast: 0.45, saturation: 0.28, vignette: 0.15 } },
  { id: "film", name: "Film", params: { ...ZERO, contrast: -0.05, saturation: -0.12, warmth: 0.18, fade: 0.28, grain: 0.35 } },
  { id: "glow", name: "Glow", params: { ...ZERO, exposure: 0.14, contrast: -0.1, saturation: 0.05, warmth: 0.25, fade: 0.1 } },
  { id: "mono", name: "Mono", params: { ...ZERO, contrast: 0.3, saturation: -1, grain: 0.2, vignette: 0.22 } },
];

export const lookParams = (id: LookId) => LOOKS.find((l) => l.id === id)?.params ?? ZERO;

export function combine(a: Params, b: Params): Params {
  const c = (v: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));
  return {
    exposure: c(a.exposure + b.exposure),
    contrast: c(a.contrast + b.contrast),
    saturation: c(a.saturation + b.saturation),
    warmth: c(a.warmth + b.warmth),
    tint: c(a.tint + b.tint),
    fade: c(a.fade + b.fade, 0, 1),
    grain: c(a.grain + b.grain, 0, 1),
    vignette: c(a.vignette + b.vignette, 0, 1),
    split: c(a.split + b.split, 0, 1),
  };
}

/** Draw `src` into a new canvas of the given long side, apply params + frame, and return it. */
export function render(src: CanvasImageSource & { width: number; height: number }, p: Params, frame: FrameStyle, longSide?: number) {
  const sw = src.width;
  const sh = src.height;
  const k = longSide ? Math.min(1, longSide / Math.max(sw, sh)) : 1;
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));

  const img = document.createElement("canvas");
  img.width = w;
  img.height = h;
  const ctx = img.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  applyParams(ctx, w, h, p);
  return frame === "none" ? img : addFrame(img, frame);
}

function applyParams(ctx: CanvasRenderingContext2D, w: number, h: number, p: Params) {
  const isZero = Object.values(p).every((v) => v === 0);
  if (isZero) return;
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;

  // Per-channel tone LUTs: exposure → contrast → warmth/tint → fade.
  const lr = new Uint8ClampedArray(256);
  const lg = new Uint8ClampedArray(256);
  const lb = new Uint8ClampedArray(256);
  const ev = Math.pow(2, p.exposure);
  const cf = 1 + p.contrast * 0.8;
  const fadeLift = p.fade * 0.14;
  for (let v = 0; v < 256; v++) {
    let x = (v / 255) * ev;
    x = (x - 0.5) * cf + 0.5;
    const r = x + p.warmth * 0.07 + p.tint * 0.02;
    const g = x - p.tint * 0.04;
    const b = x - p.warmth * 0.08 + p.tint * 0.02;
    const f = (c: number) => (fadeLift + Math.min(1, Math.max(0, c)) * (1 - fadeLift * 1.4)) * 255;
    lr[v] = f(r);
    lg[v] = f(g);
    lb[v] = f(b);
  }

  const sat = 1 + p.saturation;
  const grain = p.grain * 38;
  const vig = p.vignette * 0.65;
  const split = p.split * 0.16;
  const cx = w / 2;
  const cy = h / 2;
  const maxD = Math.hypot(cx, cy);
  let seed = 1234567;

  for (let y = 0, i = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++, i += 4) {
      let r = lr[d[i]];
      let g = lg[d[i + 1]];
      let b = lb[d[i + 2]];
      if (sat !== 1) {
        const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
        r = l + (r - l) * sat;
        g = l + (g - l) * sat;
        b = l + (b - l) * sat;
      }
      if (split > 0) {
        const l = (r * 0.2126 + g * 0.7152 + b * 0.0722 - 128) * split; // + highlights warm, - shadows teal
        r += l;
        g += l * 0.15;
        b -= l * 1.1;
      }
      let m = 1;
      if (vig > 0) {
        const t = Math.hypot(x - cx, dy) / maxD; // 0 center → 1 corner
        const s = Math.min(1, Math.max(0, (t - 0.35) / 0.65));
        m = 1 - vig * s * s * (3 - 2 * s);
      }
      let n = 0;
      if (grain > 0) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        n = ((seed >>> 0) / 4294967295 - 0.5) * grain;
      }
      d[i] = r * m + n;
      d[i + 1] = g * m + n;
      d[i + 2] = b * m + n;
    }
  }
  ctx.putImageData(data, 0, 0);
}

function addFrame(img: HTMLCanvasElement, style: FrameStyle) {
  const s = Math.min(img.width, img.height);
  const pad = Math.round(s * (style === "white" ? 0.045 : 0.06));
  const bottom = style === "polaroid" ? Math.round(s * 0.22) : style === "film" ? Math.round(s * 0.1) : pad;
  const out = document.createElement("canvas");
  out.width = img.width + pad * 2;
  out.height = img.height + pad + bottom;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = style === "film" ? "#0d0d0d" : style === "polaroid" ? "#f6f3ec" : "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(img, pad, pad);
  if (style === "film") {
    ctx.fillStyle = "#e8a33a";
    ctx.font = `600 ${Math.round(bottom * 0.28)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = "middle";
    const d = new Date();
    const stamp = `'${String(d.getFullYear()).slice(2)} ${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getDate()).padStart(2, "0")}`;
    ctx.fillText(stamp, pad, img.height + pad + bottom / 2);
  }
  return out;
}
