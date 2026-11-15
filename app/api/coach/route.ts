import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { VIBE_IDS, type ScanRequest, type ScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const MAX_IMAGE_CHARS = 3_000_000;

const SYSTEM = `You are an elite Instagram photographer scouting through the user's phone camera.
They are holding the phone at a wide zoom and tapped "scan". Find the single most Instagram-worthy photo hidden inside this frame, in the vibe they chose: the crop a great photographer would zoom into and shoot. The app will guide their phone to it and zoom in.

What makes it Instagram-worthy
- Places: one strong subject; symmetry and centered facades; leading lines; layers (foreground, middle, background); palms or buildings against sky; framing through arches, leaves or doorways; reflections; clean skies and golden light; negative space for minimal shots; a small person for scale.
- Food & products: a hero item with breathing room; close-ups of texture; clean, uncluttered backgrounds; props at the edges; soft natural light; odd-number groupings; negative space for text.
- Cut away clutter, cut-off subjects, distracting bright spots and dead space.

Vibes
- clean: minimal, bright and neutral, symmetry, lots of negative space.
- moody: deep shadows, low-key light, silhouettes, contrast, drama.
- cinematic: wide and layered, leading lines, strong foreground, a sense of story.
- film: candid, nostalgic, everyday moments, soft light, a little imperfect.
- bright: airy, lots of light, sky or white space, fresh and colorful.

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
  description: "Return the best crop hidden in the frame plus the shot's label and tip.",
  input_schema: {
    type: "object",
    properties: {
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
    required: ["box", "label", "tip", "why", "score"],
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

  const vibe = VIBE_IDS.includes(body.vibe) ? body.vibe : "clean";
  const maxZoomRatio = clamp(Number(body.maxZoomRatio) || 1, 1, 20);
  const minCrop = clamp(1 / maxZoomRatio, 0.2, 1);

  const context = [
    `Vibe: ${vibe}.`,
    `Frame aspect ratio (width:height): ${body.aspect || "3:4"}.`,
    `Minimum crop size: w = h >= ${minCrop.toFixed(2)}.`,
    body.camera === "front" ? "Front (selfie) camera." : "Back camera.",
  ].join("\n");

  try {
    const msg = await getClient().messages.create({
      model: MODEL,
      max_tokens: 500,
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

    const result: ScanResult = {
      box: { x: clamp(cx - s / 2, 0, 1 - s), y: clamp(cy - s / 2, 0, 1 - s), w: s, h: s },
      label: String(r.label ?? "").toLowerCase().slice(0, 40),
      tip: String(r.tip ?? "").slice(0, 60),
      why: String(r.why ?? "").slice(0, 160),
      score: clamp(Math.round(Number(r.score) || 6), 1, 10),
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
