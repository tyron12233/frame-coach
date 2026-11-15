# Frame Coach

An AI camera coach for Instagram-worthy photos of places, food and products. Pick a vibe (Clean, Moody, Cinematic, Film, Bright) and tap ✦. Claude looks at the scene and coaches you like a photographer: where to stand, how high to hold the phone and how to tilt it. Then it finds the best crop, guides the phone to it and zooms in, so you just press the shutter.

## How it works

1. **Plan:** the app grabs the wide view and sends it to `/api/coach` with the vibe and the phone's current tilt. Claude answers via a forced tool call (`suggest_shot`) with 0–3 steps (position → height → tilt), plus a crop, a label and a tip. It uses Instagram techniques for places (shooting up at palms and buildings, symmetry, leading lines, layers, framing) and for food and products (overhead flat lay, 45° hero angle, straight on, close texture, clean backgrounds).
2. **Steps:** each step shows as a card. Tilt steps carry a target angle that the phone's orientation sensor checks live, with a gauge and "Tilt up 12° more"; they complete themselves once you hold the angle. Position and height steps get a Done button.
3. **Re-check:** after the steps, Claude looks once more at the new angle and returns the final crop.
4. **Frame:** an on-device motion tracker (`lib/tracker.ts`) keeps the yellow box pinned to the scene while you move ("Move your phone right"). When the box is centered, the app zooms until it fills the viewfinder and shows the label and tip.
5. **Edit:** the editor opens with the vibe's Look preselected. Looks: Clean, Moody, Cinematic, Harbor, Dusk, Press, Film, Glow, Mono. Adjust, Effects (grain, vignette) and Frames are also available, and Save shares or downloads the photo.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project → Import** the repo (framework is auto-detected as Next.js).
3. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY`: your key from console.anthropic.com
   - `ANTHROPIC_WORKSPACE_ID` (only if your key isn't scoped to a workspace, e.g. `sk-ant-usr-…` keys): the `wrkspc_…` ID from Console → Settings → Workspaces
   - `CLAUDE_MODEL` (optional): `claude-haiku-5-5` (default, fastest) or `claude-sonnet-5-5` (richer advice)
4. Deploy, then open the URL on your phone. The camera needs HTTPS, which Vercel provides.

Or from a terminal: `npx vercel` in this folder, then `npx vercel env add ANTHROPIC_API_KEY` and `npx vercel --prod`.

## Run locally

```bash
npm install
cp .env.example .env.local   # add your key
npm run dev
```

Camera access works on `localhost`. To test on your phone over Wi-Fi you'll need HTTPS (e.g. deploy to Vercel or use a tunnel).

## Files

- `components/CameraCoach.tsx`: camera, viewfinder, scan/guide/frame flow, zoom, level, capture
- `components/Editor.tsx`, `lib/looks.ts`: edit screen and the canvas pixel pipeline for looks/adjustments/frames
- `components/Gallery.tsx`: session photo viewer
- `lib/tracker.ts`: motion tracker that keeps the box pinned to the scene
- `app/api/coach/route.ts`: Claude call, system prompt, tool schema

## Notes

- **Cost:** one image per scan (~1024px JPEG). The API is open to anyone with the URL, so add auth or rate limiting (e.g. Vercel Firewall rules or Upstash) before sharing it widely.
- **iOS:** the level needs motion permission, which is requested when you tap Start camera. Hardware zoom isn't exposed by Safari, so digital zoom is used.
- Photos live in memory for the session (the gallery clears on reload); Save shares or downloads them.
