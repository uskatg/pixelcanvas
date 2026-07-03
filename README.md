# Pixel-Canvas — retromania seminar

Collaborative retro pixel canvas. Everyone joins via QR code, picks a character,
and paints a shared low-res canvas together. The host picks a reference image
("Bild 1"/"Bild 2"), a shared 3-minute countdown runs, and at the end an AI
judge (Claude) rates the result 0–10 with feedback.

## Architecture

- `public/` — static client (single `index.html`, no build step)
- `api/` — serverless functions (Vercel) / local routes: boot, poll, paint, task, timer, clear, evaluate
- `lib/core.js` — shared state logic; canvas lives in Upstash Redis (production) or in memory + `canvas.json` (local dev)
- `server.js` — local dev server (`node server.js`, port 3000)

Live sync is via polling (~1.2 s) — Vercel's serverless model has no long-lived
processes, so SSE/WebSockets aren't an option without extra infra.

## Roles

- **Players** (default): paint pixels, see the reference, timer, and rating.
- **Host** (admin): additionally chooses/closes the reference image, controls the
  timer, and can clear the canvas. Open the app as
  `https://<deployment>/?admin=<ADMIN_TOKEN>` once — the token is stored in the
  browser and stripped from the URL (safe to project on the beamer).

## Environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Secret for host controls (clear, choose image, timer). Unset = everything open (local dev). |
| `ANTHROPIC_API_KEY` | AI rating at the end of the countdown. Unset = rating shows "nicht verfügbar". |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Shared canvas state (or `KV_REST_API_URL`/`KV_REST_API_TOKEN`). Unset = in-memory (local dev only). |

## Deploy (Vercel)

1. Import the GitHub repo in Vercel (or `vercel link` + `vercel deploy`).
2. Storage → add **Upstash Redis** (free tier) — this injects the Redis env vars.
3. Add `ADMIN_TOKEN` and `ANTHROPIC_API_KEY` under Settings → Environment Variables.
4. Deploy. Host opens `/?admin=<token>`, everyone else scans the QR.

## Local dev

```
node server.js
# → http://localhost:3000  (admin: http://localhost:3000/?admin=<ADMIN_TOKEN from .env>)
```
