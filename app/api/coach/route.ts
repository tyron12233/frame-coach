import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { LOOK_IDS, type LookId, type ScanRequest, type ScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const MAX_IMAGE_CHARS = 3_000_000;

const SYSTEM = `You are a world-class photographer scouting through the user's phone camera.
They are holding the phone at a wide zoom and tapped "scan". Your job: find the single most beautiful photo hidden inside this frame, the crop a great photographer would zoom into and shoot.

How to choose the crop:
- Look for the strongest subject and the cleanest, most striking composition: a lone palm against clouds, a reflection, a doorway, a person against a clean wall, light hitting a facade, leading lines, symmetry, layers.
- Cut away clutter, distracting edges, ugly bright spots and dead space.
- Inside the crop, place the subject with intent (rule of thirds, or centered for symmetry), with breathing room.
- Prefer good light: golden glow, rim light, shadows with shape.
- Be decisive: isolate ONE hero subject or moment with a tight, intentional crop (typically w between 0.25 and 0.55). A good crop feels like a deliberate photo, not the same scene slightly trimmed.
- Only return a large crop (w > 0.75) when the wide view itself is clearly the best photo.

Box rules (normalized to the frame, 0..1, x/y = top-left corner):
- The crop must have EXACTLY the same aspect ratio as the frame, so w must equal h in these normalized units.
- w must be at least the given minimum crop size (the camera can't zoom in further than that).
- The box must lie fully inside the frame.

Text rules:
- label: 2–4 lowercase words naming the shot, like a photo title (e.g. "golden hour palms", "quiet blue door").
- tip: max 7 words, warm and evocative, ends with a period (e.g. "Beautiful light, capture the glow."). It is shown once the user has framed the shot.
- why: one short sentence on why this crop works.
- look: the edit preset that best fits the mood: clean (neutral), harbor (cool, calm), dusk (warm, moody sunset), press (punchy contrast), film (faded, grainy, nostalgic), glow (bright, airy, warm), mono (black and white).
- score: 1–10 for how good the suggested photo will be.
Always answer by calling the suggest_shot tool.`;

const TOOL: Anthropic.Tool = {
  name: "suggest_shot",
  description: "Return the best crop hidden in the current frame plus a label, tip and edit look.",
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
      look: { type: "string", enum: [...LOOK_IDS] },
      score: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["box", "label", "tip", "why", "look", "score"],
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

  const maxZoomRatio = clamp(Number(body.maxZoomRatio) || 1, 1, 20);
  const minCrop = clamp(1 / maxZoomRatio, 0.2, 1);

  const context = [
    `Frame aspect ratio (width:height): ${body.aspect || "3:4"}.`,
    `Minimum crop size: w = h >= ${minCrop.toFixed(2)}.`,
    body.camera === "front" ? "This is the front (selfie) camera." : "This is the back camera.",
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
    const x = clamp(cx - s / 2, 0, 1 - s);
    const y = clamp(cy - s / 2, 0, 1 - s);

    const result: ScanResult = {
      box: { x, y, w: s, h: s },
      label: String(r.label ?? "").toLowerCase().slice(0, 40),
      tip: String(r.tip ?? "").slice(0, 60),
      why: String(r.why ?? "").slice(0, 160),
      look: (LOOK_IDS as readonly string[]).includes(r.look) ? (r.look as LookId) : "clean",
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
