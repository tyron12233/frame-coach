export const LOOK_IDS = ["clean", "moody", "cinematic", "film", "glow", "harbor", "dusk", "press", "mono"] as const;
export type LookId = (typeof LOOK_IDS)[number];

export const VIBES = [
  { id: "clean", label: "Clean", look: "clean" },
  { id: "moody", label: "Moody", look: "moody" },
  { id: "cinematic", label: "Cinematic", look: "cinematic" },
  { id: "film", label: "Film", look: "film" },
  { id: "bright", label: "Bright", look: "glow" },
] as const;
export type VibeId = (typeof VIBES)[number]["id"];
export const VIBE_IDS = VIBES.map((v) => v.id) as VibeId[];
export const vibeLook = (v: VibeId): LookId => VIBES.find((x) => x.id === v)?.look ?? "clean";

export type Aspect = "3:4" | "4:5" | "9:16" | "1:1";
export const ASPECTS: Aspect[] = ["3:4", "4:5", "9:16", "1:1"];
export const aspectRatio = (a: Aspect) => {
  const [w, h] = a.split(":").map(Number);
  return w / h; // width / height
};

/** Normalized box in frame coordinates (0..1), top-left origin. */
export type Box = { x: number; y: number; w: number; h: number };

export type ScanResult = {
  box: Box; // the best shot hidden in the current frame (same aspect as the viewfinder)
  label: string; // 2–4 words naming the shot, e.g. "golden hour palms"
  tip: string; // short, warm line shown once framed
  why: string; // one sentence on why this works
  score: number; // 1–10
};

export type ScanRequest = {
  image: string; // base64 JPEG, no data: prefix
  aspect: Aspect;
  zoom: number;
  maxZoomRatio: number;
  camera: "back" | "front";
  vibe: VibeId;
};
