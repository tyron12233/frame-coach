/**
 * Tiny global-motion tracker: estimates how far the scene has shifted in the viewfinder
 * since reset(), using coarse-to-fine block matching on small grayscale frames.
 * Used to keep the suggested-shot box pinned to the scene while the user moves the phone.
 */
export type Crop = { sx: number; sy: number; sw: number; sh: number };

type Frame = { full: Float32Array; half: Float32Array };

export class MotionTracker {
  readonly W: number;
  readonly H: number;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ref: Frame | null = null;
  private refOffset = { x: 0, y: 0 }; // px (full level) of current frame vs ref
  private base = { x: 0, y: 0 }; // px accumulated from previous refs

  constructor(aspect: number /* width / height */) {
    this.W = 96;
    this.H = Math.max(48, Math.round(96 / aspect));
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  reset() {
    this.ref = null;
    this.refOffset = { x: 0, y: 0 };
    this.base = { x: 0, y: 0 };
  }

  /** Normalized scene shift since reset (fraction of frame width/height). */
  get shift() {
    return { x: (this.base.x + this.refOffset.x) / this.W, y: (this.base.y + this.refOffset.y) / this.H };
  }

  update(source: CanvasImageSource, crop: Crop) {
    const { W, H } = this;
    this.ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
    const cur = this.toFrame(this.ctx.getImageData(0, 0, W, H).data);
    if (!this.ref) {
      this.ref = cur;
      return this.shift;
    }

    const w2 = W >> 1;
    const h2 = H >> 1;
    // Coarse search on half-res around the predicted offset.
    const px = Math.round(this.refOffset.x / 2);
    const py = Math.round(this.refOffset.y / 2);
    const R1 = 8;
    let best = { x: px, y: py, s: Infinity };
    for (let dy = py - R1; dy <= py + R1; dy++) {
      for (let dx = px - R1; dx <= px + R1; dx++) {
        const s = sad(this.ref.half, cur.half, w2, h2, dx, dy, 1);
        if (s < best.s) best = { x: dx, y: dy, s };
      }
    }
    // Fine search on full-res.
    const fx = best.x * 2;
    const fy = best.y * 2;
    let fine = { x: fx, y: fy, s: Infinity };
    for (let dy = fy - 2; dy <= fy + 2; dy++) {
      for (let dx = fx - 2; dx <= fx + 2; dx++) {
        const s = sad(this.ref.full, cur.full, W, H, dx, dy, 1);
        if (s < fine.s) fine = { x: dx, y: dy, s };
      }
    }
    if (!isFinite(fine.s)) return this.shift; // lost overlap — keep last estimate

    // Sub-pixel refinement (parabola fit).
    const sx0 = sad(this.ref.full, cur.full, W, H, fine.x - 1, fine.y, 1);
    const sx1 = sad(this.ref.full, cur.full, W, H, fine.x + 1, fine.y, 1);
    const sy0 = sad(this.ref.full, cur.full, W, H, fine.x, fine.y - 1, 1);
    const sy1 = sad(this.ref.full, cur.full, W, H, fine.x, fine.y + 1, 1);
    const subX = parabola(sx0, fine.s, sx1);
    const subY = parabola(sy0, fine.s, sy1);
    this.refOffset = { x: fine.x + subX, y: fine.y + subY };

    // Re-key when the overlap gets small to limit drift and keep matching reliable.
    if (Math.abs(this.refOffset.x) > W * 0.22 || Math.abs(this.refOffset.y) > H * 0.22) {
      this.base = { x: this.base.x + this.refOffset.x, y: this.base.y + this.refOffset.y };
      this.refOffset = { x: 0, y: 0 };
      this.ref = cur;
    }
    return this.shift;
  }

  private toFrame(rgba: Uint8ClampedArray): Frame {
    const { W, H } = this;
    const full = new Float32Array(W * H);
    let mean = 0;
    for (let i = 0, p = 0; i < full.length; i++, p += 4) {
      const g = rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114;
      full[i] = g;
      mean += g;
    }
    mean /= full.length;
    for (let i = 0; i < full.length; i++) full[i] -= mean; // exposure-change tolerant
    const w2 = W >> 1;
    const h2 = H >> 1;
    const half = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        const i = y * 2 * W + x * 2;
        half[y * w2 + x] = (full[i] + full[i + 1] + full[i + W] + full[i + W + 1]) * 0.25;
      }
    }
    return { full, half };
  }
}

/** Mean absolute difference where cur(x, y) ≈ ref(x - dx, y - dy). */
function sad(ref: Float32Array, cur: Float32Array, w: number, h: number, dx: number, dy: number, step: number) {
  const x0 = Math.max(0, dx);
  const x1 = Math.min(w, w + dx);
  const y0 = Math.max(0, dy);
  const y1 = Math.min(h, h + dy);
  const ow = x1 - x0;
  const oh = y1 - y0;
  if (ow < w * 0.4 || oh < h * 0.4) return Infinity;
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    const rc = y * w;
    const rr = (y - dy) * w - dx;
    for (let x = x0; x < x1; x += step) {
      sum += Math.abs(cur[rc + x] - ref[rr + x]);
      n++;
    }
  }
  return sum / n;
}

function parabola(a: number, b: number, c: number) {
  if (!isFinite(a) || !isFinite(c)) return 0;
  const d = a - 2 * b + c;
  if (d <= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)));
}
