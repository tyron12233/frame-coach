# Frame Coach

Point your phone camera, tap **Coach me**, and Claude looks at the frame and tells you how to make it a better photo: where to step, how to angle the phone, and how much to zoom (zoom is applied automatically).

## How it works

1. The browser shows the live camera (`getUserMedia`) with a rule-of-thirds grid and a live horizon level (from the accelerometer, so it costs nothing and has no lag).
2. Tapping **Coach me** grabs exactly what's on screen, downsizes it to 1024px, and POSTs it to `/api/coach`.
3. The API route sends the image to Claude with a photography-coach system prompt and a forced tool call (`give_coaching`), so the reply is always structured JSON:
   ```json
   { "score": 5, "verdict": "adjust", "headline": "Step left and lower the phone a little",
     "moves": ["move_left", "lower_camera"], "zoom_factor": 1.4,
     "subject": {"x": 0.5, "y": 0.45}, "target": {"x": 0.66, "y": 0.38}, "progress": "first", ... }
   ```
4. The app speaks the headline, shows move chips, draws an arrow from the subject to where it should sit, and applies the zoom (hardware zoom on Android Chrome, digital crop elsewhere).
5. **Check again** sends the previous advice along with the new frame, so Claude says things like "Better! Now just lower the phone."
6. **Shoot** saves/shares the frame you see.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project → Import** the repo (framework is auto-detected as Next.js).
3. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY`: your key from console.anthropic.com
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

- `components/CameraCoach.tsx`: camera, overlay, level, zoom, coach/capture logic
- `app/api/coach/route.ts`: Claude call, system prompt, tool schema
- `lib/types.ts`: shared types and move labels

## Notes

- **Cost:** one image per tap (~1024px JPEG). The API is open to anyone with the URL, so add auth or rate limiting (e.g. Vercel Firewall rules or Upstash) before sharing it widely.
- **iOS:** the level needs motion permission, which is requested when you tap Start camera. Hardware zoom isn't exposed by Safari, so digital zoom is used.
