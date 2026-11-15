import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { VIBE_IDS, type ScanRequest, type ScanResult, type Step, type StepKind } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const MAX_IMAGE_CHARS = 3_000_000;

const SYSTEM = `You are an elite Instagram photographer coaching someone through their phone camera in real time.
They tapped "scan". Your job is to make their photo scroll-stopping and Instagram-worthy, in the vibe they chose.

You coach three things:
1. POSITION: where they stand. Step left/right to line things up or find symmetry, walk closer for intimacy and texture, step back to fit the scene, use a wall/plant/railing as foreground.
2. ANGLE: camera height and tilt. Get low and tilt up for architecture, palms, towers and drama. Go overhead (flat lay) for food spreads and products on a table. Use a ~45° hero angle for plated food and drinks. Shoot straight on for tall drinks, burgers, stacked items and symmetrical facades.
3. CROP: the best photo hidden inside the frame, as a box the app will zoom into.

What makes it Instagram-worthy
- Places: one strong subject; symmetry and centered facades; leading lines into the frame; layers (foreground, middle, background); looking up at palms or buildings against sky; framing through arches, leaves or doorways; reflections; clean skies and golden light; negative space for minimal shots; a small person for scale.
- Food & products: overhead flat lay with breathing room; 45° for depth; close-ups of texture; clean, uncluttered backgrounds; props at the edges; soft natural side light; hands in frame for life; odd-number groupings; negative space for text.
- Avoid: clutter, cut-off subjects, distracting bright spots, tilted horizons, and boring eye-level snapshots when a better angle exists.

Vibes
- clean: minimal, bright and neutral, symmetry, lots of negative space.
- moody: deep shadows, low-key light, silhouettes, contrast, dramatic angles.
- cinematic: wide and layered, leading lines, strong foreground, a sense of story.
- film: candid, nostalgic, everyday moments, soft light, a little imperfect.
- bright: airy, lots of light, sky or white space, fresh and colorful.

Plan mode
- If a different position or angle would make a clearly better photo, return 1–3 steps in this order: position, then height, then tilt. If the current angle is already great, return no steps.
- Each step has kind (position | height | tilt) and text: one short imperative, max 7 words (e.g. "Take two steps left", "Crouch down low", "Tilt up toward the palm tops", "Hold the phone right above the plate").
- Tilt steps need target_elevation: the camera angle above the horizon after tilting, in degrees (-90 = pointing straight down for a flat lay, 0 = level, 45 = looking up steeply). You're told the current elevation; only suggest a tilt that changes it by at least 10°. Use null for position/height steps.
- Don't suggest moves the crop alone could achieve.
Final mode
- The user already followed your steps. Return no steps; just find the best crop of the new frame.

Box rules (normalized to the frame, 0..1, x/y = top-left corner)
- The crop must have exactly the frame's aspect ratio, so w equals h in these normalized units.
- w must be at least the given minimum crop size.
- The box must lie fully inside the frame.
- Be decisive: isolate one hero subject or moment with a tight, intentional crop (usually w between 0.3 and 0.6). Only use w > 0.75 when the wide view itself is clearly the best photo.

Text
- label: 2–4 lowercase words naming the shot like a photo title ("golden hour palms", "sunday brunch spread").
- tip: max 7 words, warm and evocative, ends with a period. Shown once the shot is framed ("Beautiful light, capture the glow.").
- why: one short sentence on why this photo works.
- score: 1–10 for how good the final photo will be.
Always answer by calling the suggest_shot tool.`;

const TOOL: Anthropic.Tool = {
  name: "suggest_shot",
  description: "Return angle/position steps (if any), the best crop, and the shot's label and tip.",
  input_schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["position", "height", "tilt"] },
            text: { type: "string" },
            target_elevation: { type: ["number", "null"], minimum: -90, maximum: 90 },
          },
          required: ["kind", "text", "target_elevation"],
        },
      },
      box: {
        type: "object",
        properties: {
          x: { type: "number", minimum: 0, maximum: 1 },
          y: { type: "number", minimum: 0, maximum: 1 },
          w: { type: "number", minimum: 0, maximum: 1 },
          h: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["x", "y", "w", "h"],
      },
      label: { type: "string" },
      tip: { type: "string" },
      why: { type: "string" },
      score: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["steps", "box", "label", "tip", "why", "score"],
  },
};

let client: Anthropic | null = null;
function getClient() {
  if (!client) {
    // User-level keys (sk-ant-usr-…) aren't tied to a workspace, so the workspace must be named per request.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  }
  return client;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const KIND_ORDER: StepKind[] = ["position", "height", "tilt"];

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Server is missing ANTHROPIC_API_KEY." }, { status: 500 });
  }

  let body: ScanRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const image = typeof body.image === "string" ? body.image.replace(/^data:image\/\w+;base64,/, "") : "";
  if (!image || image.length > MAX_IMAGE_CHARS) {
    return NextResponse.json({ error: "Missing or oversized image." }, { status: 400 });
  }

  const final = body.mode === "final";
  const vibe = VIBE_IDS.includes(body.vibe) ? body.vibe : "clean";
  const maxZoomRatio = clamp(Number(body.maxZoomRatio) || 1, 1, 20);
  const minCrop = clamp(1 / maxZoomRatio, 0.2, 1);
  const elevation = typeof body.elevation === "number" && isFinite(body.elevation) ? Math.round(body.elevation) : null;

  const context = [
    `Mode: ${final ? "final" : "plan"}.`,
    `Vibe: ${vibe}.`,
    `Frame aspect ratio (width:height): ${body.aspect || "3:4"}.`,
    `Minimum crop size: w = h >= ${minCrop.toFixed(2)}.`,
    elevation == null
      ? "Camera elevation: unknown."
      : `Camera elevation now: ${elevation}° (${elevation > 5 ? "pointing up" : elevation < -5 ? "pointing down" : "about level"}).`,
    body.camera === "front" ? "Front (selfie) camera." : "Back camera.",
    final && body.previousSteps?.length ? `Steps the user just followed: ${body.previousSteps.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const msg = await getClient().messages.create({
      model: MODEL,
      max_tokens: 600,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: context },
          ],
        },
      ],
    });

    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      return NextResponse.json({ error: "No shot suggested." }, { status: 502 });
    }
    const r = block.input as ScanResult;

    // Enforce same-aspect, in-bounds crop no smaller than the zoom limit.
    const b = r.box ?? { x: 0, y: 0, w: 1, h: 1 };
    const cx = (Number(b.x) || 0) + (Number(b.w) || 1) / 2;
    const cy = (Number(b.y) || 0) + (Number(b.h) || 1) / 2;
    const s = clamp(Math.sqrt(Math.max(0.0001, (Number(b.w) || 1) * (Number(b.h) || 1))), minCrop, 1);

    let steps: Step[] = [];
    if (!final && Array.isArray(r.steps)) {
      steps = r.steps
        .filter((st) => st && KIND_ORDER.includes(st.kind) && typeof st.text === "string" && st.text.trim())
        .map((st) => {
          let t = typeof st.target_elevation === "number" && isFinite(st.target_elevation) ? clamp(Math.round(st.target_elevation), -90, 90) : null;
          if (st.kind !== "tilt") t = null;
          // Drop tilts that barely change anything.
          if (st.kind === "tilt" && t != null && elevation != null && Math.abs(t - elevation) < 8) return null;
          return { kind: st.kind, text: st.text.trim().slice(0, 60), target_elevation: t };
        })
        .filter((st): st is Step => !!st)
        .sort((a, c) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(c.kind))
        .slice(0, 3);
    }

    const result: ScanResult = {
      box: { x: clamp(cx - s / 2, 0, 1 - s), y: clamp(cy - s / 2, 0, 1 - s), w: s, h: s },
      label: String(r.label ?? "").toLowerCase().slice(0, 40),
      tip: String(r.tip ?? "").slice(0, 60),
      why: String(r.why ?? "").slice(0, 160),
      score: clamp(Math.round(Number(r.score) || 6), 1, 10),
      steps,
    };
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? err.status ?? 502 : 502;
    const message =
      status === 401
        ? "Invalid ANTHROPIC_API_KEY. Check the key in your Vercel environment variables."
        : status === 429
          ? "Rate limited. Wait a moment and try again."
          : err instanceof Anthropic.APIError
            ? (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message
            : err instanceof Error
              ? err.message
              : "Scan failed.";
    console.error("scan error", status, message);
    return NextResponse.json({ error: message }, { status });
  }
}
