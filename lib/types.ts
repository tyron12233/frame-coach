export const LOOK_IDS = ["clean", "harbor", "dusk", "press", "film", "glow", "mono"] as const;
export type LookId = (typeof LOOK_IDS)[number];

export type Aspect = "3:4" | "9:16" | "1:1";
export const ASPECTS: Aspect[] = ["3:4", "9:16", "1:1"];
export const aspectRatio = (a: Aspect) => (a === "3:4" ? 3 / 4 : a === "9:16" ? 9 / 16 : 1); // width / height

/** Normalized box in frame coordinates (0..1), top-left origin. */
export type Box = { x: number; y: number; w: number; h: number };

export type ScanResult = {
  box: Box; // the best shot hidden in the current frame (same aspect as the viewfinder)
  label: string; // 2–4 words naming the shot, e.g. "golden hour palms"
  tip: string; // short, warm line shown once framed, e.g. "Beautiful light, capture the glow."
  why: string; // one sentence on why this crop works
  look: LookId; // suggested edit preset
  score: number; // 1–10 for the suggested shot
};

export type ScanRequest = {
  image: string; // base64 JPEG, no data: prefix
  aspect: Aspect;
  zoom: number; // current zoom
  maxZoomRatio: number; // how much further we can zoom in from here
  camera: "back" | "front";
};
