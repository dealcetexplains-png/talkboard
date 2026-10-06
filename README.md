# Talkboard

A system design interview coach you talk to.

Explain an architecture out loud ("users hit a load balancer, three API servers, Postgres with a Redis cache"). Wispr Flow types it into Talkboard and the diagram draws itself. Say "review my design" and the weak spots, like single points of failure, missing caches or no rate limiting, turn red on the diagram with short notes and a score. Fix them by voice, review again, and watch the score go up.

## Why Wispr Flow

- **Dictionary** keeps technical terms intact. Add Kafka, Redis, Postgres, Kubernetes, load balancer, CDN, sharding and rate limiter, and normal dictation stops mangling them.
- **Snippets** drop in whole designs. Saying "microservices starter" types a full base architecture; "grill me" types "review my design".

## Run it locally

Needs Node.js 20 or newer.

```bash
npm install
cp .env.example .env.local      # Windows PowerShell: copy .env.example .env.local
# paste your Gemini key into .env.local:  GEMINI_API_KEY=...
npm run dev
```

Open http://localhost:5173. `npm run dev` serves the app and the `/api` functions together, reading the key from `.env.local` on the server side only.

No key yet? It still works: Talkboard falls back to its built-in rules engine, and every history entry says whether Gemini or the rules answered. `vercel dev` also works if you prefer the Vercel CLI.

## Voice commands

| Say | What happens |
| --- | --- |
| Any description or edit | The diagram updates ("add a queue between the API and the email service") |
| undo | Reverts the last change |
| start over | Clears the board (undo brings it back) |
| review my design / grill me | Red marks, notes and a score out of 100 |
| start interview | Random prompt ("design a URL shortener") with a 10 minute timer, then a scorecard |
| end interview | Finishes early and shows the scorecard |
| export diagram | Downloads the diagram as a PNG |

## Demo script

1. "Users hit a load balancer, three API servers, Postgres with a Redis cache."
2. "Grill me." Expect the single load balancer, the replica-less Postgres and the missing rate limiting to be flagged in red.
3. "Add a second load balancer." "Add a read replica to Postgres." "Add rate limiting to the load balancer."
4. "Grill me." The score jumps and the change is shown next to it.
5. "Start over." then "microservices starter" for the full base design.

## Deploy

1. Push this folder to a GitHub repo.
2. On vercel.com, import the repo (Vite is detected automatically).
3. Settings, Environment Variables: add `GEMINI_API_KEY`. Optional: `GEMINI_MODEL` (by default the server tries `gemini-flash-latest`, then `gemini-2.5-flash`).
4. Deploy, then test the live link in an Incognito window.

## How it works

- The design is one JSON object: nodes (id, label, type), edges and issues.
- `api/design` sends the current JSON plus the new sentence to Gemini and gets the updated JSON back. Strict JSON mode, validated, retried once if invalid.
- `api/review` asks Gemini for issues tied to node ids. The score is computed in code from severities so it is consistent between reviews.
- The Mermaid diagram is generated in code from the JSON. The AI never writes diagram code.
- The Gemini key only ever exists on the server.

## Stack

React, Vite, TypeScript, Mermaid, Vercel serverless functions, Gemini.
