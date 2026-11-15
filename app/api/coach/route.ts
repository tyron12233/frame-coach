import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { MOVES, type Coaching, type CoachRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const MAX_IMAGE_CHARS = 3_000_000; // ~2.2 MB of JPEG

const SYSTEM = `You are a world-class photography coach looking through the user's phone camera in real time.
They have framed a shot and tapped "Coach me". Judge the composition of THIS frame and tell them exactly how to make it a better photo.

What to evaluate (only what is actually visible):
- Subject placement: rule of thirds / intentional centering for symmetry, enough lead room and headroom.
- Horizon and verticals: level horizons, straight building lines.
- Background: clutter, distracting bright spots, objects "growing" out of heads, awkward edge cuts.
- Cropping: don't cut people at joints (wrists, knees, ankles); fill the frame when the subject is small.
- Angle and height: eye-level for people, lower angles for drama/height, higher for food/flat-lays.
- Light: harsh backlight, faces in shadow, using light direction.
- Leading lines, foreground interest, negative space, balance.

Directions are always from the photographer's point of view, holding the phone:
- move_left/move_right = physically step sideways. move_closer/step_back = walk toward/away.
- raise_camera/lower_camera = change camera height. tilt_up/tilt_down = angle the camera up/down.
- pan_left/pan_right = turn the camera left/right without stepping.
- rotate_clockwise/rotate_counterclockwise = rotate the phone in its plane to fix a tilted horizon.
- go_landscape/go_portrait = change phone orientation.

Rules:
- Give at most 3 moves, most impactful first. Prefer 1–2. Never contradict yourself.
- zoom_factor is RELATIVE to the current zoom: 1 = keep, 1.5 = zoom in 50%, 0.7 = zoom out. Use step_back instead if they need a wider view and are probably at minimum zoom.
- headline: one short spoken instruction, max 10 words, no emojis (e.g. "Step left and lower the phone a little").
- issues: up to 3 short, specific observations (max ~12 words each).
- subject/target: normalized frame coordinates (0,0 = top-left, 1,1 = bottom-right). subject = where the main subject is now; target = where it should sit after the user adjusts. Use null if there's no clear subject (e.g. a landscape).
- If the shot is already strong (score 8+) and further moves wouldn't clearly improve it, set verdict "take_it", moves [] and a headline like "Looks great, take the shot".
- Be honest with scores; a cluttered, tilted snapshot is a 3–4, a clean well-composed frame is 8+.
- If previous advice is provided, compare: set progress to better/same/worse and acknowledge it in the headline when relevant (e.g. "Better! Now just lower the phone"). Stay consistent with the previous advice unless the scene changed.
Always respond by calling the give_coaching tool.`;

const point = {
  type: ["object", "null"],
  properties: {
    x: { type: "number", minimum: 0, maximum: 1 },
    y: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["x", "y"],
};

const TOOL: Anthropic.Tool = {
  name: "give_coaching",
  description: "Return structured composition coaching for the current camera frame.",
  input_schema: {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 1, maximum: 10, description: "Composition quality right now" },
      scene: { type: "string", description: "What the frame shows, under 10 words" },
      verdict: { type: "string", enum: ["adjust", "take_it"] },
      headline: { type: "string", description: "One short spoken instruction" },
      issues: { type: "array", items: { type: "string" }, maxItems: 3 },
      moves: { type: "array", items: { type: "string", enum: [...MOVES] }, maxItems: 3 },
      zoom_factor: { type: "number", minimum: 0.5, maximum: 3 },
      subject: point,
      target: point,
      progress: { type: "string", enum: ["first", "better", "same", "worse"] },
    },
    required: ["score", "scene", "verdict", "headline", "issues", "moves", "zoom_factor", "subject", "target", "progress"],
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

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Server is missing ANTHROPIC_API_KEY." }, { status: 500 });
  }

  let body: CoachRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const image = typeof body.image === "string" ? body.image.replace(/^data:image\/\w+;base64,/, "") : "";
  if (!image || image.length > MAX_IMAGE_CHARS) {
    return NextResponse.json({ error: "Missing or oversized image." }, { status: 400 });
  }

  const context = [
    `Phone orientation: ${body.orientation === "landscape" ? "landscape" : "portrait"}.`,
    `Current zoom: ${Number(body.zoom) || 1}x.`,
    body.camera === "front"
      ? "Front (selfie) camera: the user is likely both photographer and subject; phrase advice for holding the phone at arm's length."
      : "Back camera.",
    body.previous
      ? `Previous advice you gave for this shot: ${JSON.stringify({
          score: body.previous.score,
          headline: body.previous.headline,
          moves: body.previous.moves,
          zoom_factor: body.previous.zoom_factor,
        })}. The user has since adjusted (zoom changes were applied automatically).`
      : "This is the first look at this shot (progress = first).",
  ].join("\n");

  try {
    const msg = await getClient().messages.create({
      model: MODEL,
      max_tokens: 700,
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
      return NextResponse.json({ error: "Coach returned no advice." }, { status: 502 });
    }

    const c = block.input as Coaching;
    const coaching: Coaching = {
      score: Math.min(10, Math.max(1, Math.round(Number(c.score) || 5))),
      scene: String(c.scene ?? ""),
      verdict: c.verdict === "take_it" ? "take_it" : "adjust",
      headline: String(c.headline ?? ""),
      issues: Array.isArray(c.issues) ? c.issues.slice(0, 3).map(String) : [],
      moves: Array.isArray(c.moves) ? c.moves.filter((m) => (MOVES as readonly string[]).includes(m)).slice(0, 3) : [],
      zoom_factor: Math.min(3, Math.max(0.5, Number(c.zoom_factor) || 1)),
      subject: validPoint(c.subject),
      target: validPoint(c.target),
      progress: ["first", "better", "same", "worse"].includes(c.progress) ? c.progress : "first",
    };

    return NextResponse.json(coaching);
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
              : "Coaching failed.";
    console.error("coach error", status, message);
    return NextResponse.json({ error: message }, { status });
  }
}

function validPoint(p: unknown) {
  if (!p || typeof p !== "object") return null;
  const { x, y } = p as { x: unknown; y: unknown };
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
