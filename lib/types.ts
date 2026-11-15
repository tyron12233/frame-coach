export const MOVES = [
  "move_left",
  "move_right",
  "move_closer",
  "step_back",
  "raise_camera",
  "lower_camera",
  "tilt_up",
  "tilt_down",
  "pan_left",
  "pan_right",
  "rotate_clockwise",
  "rotate_counterclockwise",
  "go_landscape",
  "go_portrait",
] as const;

export type Move = (typeof MOVES)[number];

export type Point = { x: number; y: number };

export type Coaching = {
  score: number; // 1–10
  scene: string; // short description of what Claude sees
  verdict: "adjust" | "take_it";
  headline: string; // short, spoken tip
  issues: string[]; // up to 3 short observations
  moves: Move[]; // up to 3 physical moves, most important first
  zoom_factor: number; // relative zoom: 1 = keep, >1 zoom in, <1 zoom out
  subject: Point | null; // where the main subject is now (0–1, frame coords)
  target: Point | null; // where the subject should sit (0–1, frame coords)
  progress: "first" | "better" | "same" | "worse";
};

export type CoachRequest = {
  image: string; // base64 JPEG (no data: prefix)
  orientation: "portrait" | "landscape";
  zoom: number; // current zoom level
  camera?: "back" | "front";
  previous?: Coaching | null;
};

export const MOVE_LABELS: Record<Move, { label: string; icon: string }> = {
  move_left: { label: "Step left", icon: "←" },
  move_right: { label: "Step right", icon: "→" },
  move_closer: { label: "Move closer", icon: "⇡" },
  step_back: { label: "Step back", icon: "⇣" },
  raise_camera: { label: "Raise camera", icon: "↑" },
  lower_camera: { label: "Lower camera", icon: "↓" },
  tilt_up: { label: "Tilt up", icon: "⤴" },
  tilt_down: { label: "Tilt down", icon: "⤵" },
  pan_left: { label: "Turn left", icon: "↶" },
  pan_right: { label: "Turn right", icon: "↷" },
  rotate_clockwise: { label: "Rotate clockwise", icon: "↻" },
  rotate_counterclockwise: { label: "Rotate counter-clockwise", icon: "↺" },
  go_landscape: { label: "Turn sideways", icon: "▭" },
  go_portrait: { label: "Hold upright", icon: "▯" },
};
