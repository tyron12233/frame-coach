# Frame Coach

An AI camera that finds the most Instagram-worthy shot in your scene. Pick a vibe (Clean, Moody, Cinematic, Film, Bright) and tap ✦. Claude picks the best photo hidden in the wide view and draws a yellow box around it. The box stays pinned to the scene as you move ("Move your phone right"); once it's centered the app zooms in to fill the frame and shows the shot's name and a tip. Then you press the shutter and edit.

## How it works

1. **Scan:** the app zooms out to the widest view, grabs exactly what's in the viewfinder and sends it to `/api/coach` with the vibe. Claude answers via a forced tool call (`suggest_shot`) with a crop box in the viewfinder's aspect ratio, a label and a tip. It's tuned for places and for food and products.
2. **Guide:** an on-device motion tracker (`lib/tracker.ts`, coarse-to-fine block matching on tiny grayscale frames, ~30 fps) keeps the box pinned to the scene while you move. That includes the ~2 s while Claude is thinking.
3. **Frame:** when the box is centered, the app smoothly zooms (hardware zoom on Android Chrome, digital crop elsewhere) until the box fills the viewfinder, then shows the green label and tip.
4. **Edit:** the editor opens with the vibe's Look preselected. Looks: Clean, Moody, Cinematic, Harbor, Dusk, Press, Film, Glow, Mono. Adjust, Effects (grain, vignette) and Frames are also available, and Save shares or downloads the photo.

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
