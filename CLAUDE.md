# Talkboard

Voice-first system design interview coach. The user describes an architecture out loud, Wispr Flow types it into a big text box, and a diagram draws itself. Saying "review my design" (or the "grill me" snippet) gets an AI review: weak spots turn red on the diagram with one-line notes and a score out of 100. The user fixes them by voice and reviews again; the score goes up.

## Stack

- React 18 + Vite 6 + TypeScript (strict)
- Mermaid 11 for diagrams
- Two Vercel serverless functions in `api/` that call Gemini over REST
- No database, no auth. Everything lives in browser memory for the session.

## Hard rules

1. **The Gemini key lives only in the server environment** as `GEMINI_API_KEY` (Vercel env var, or `.env.local` for local dev). Never put it in code, the repo, client code, or a `VITE_` variable. `.env*` is git-ignored except `.env.example`.
2. **Mermaid code is built in code from the design JSON** (`src/lib/toMermaid.ts`). The AI never writes Mermaid.
3. **The design JSON is the single source of truth.** Every voice edit produces a new design; undo is a stack of past designs.
4. **API responses are validated** and the model is retried once if the JSON is invalid.
5. The review **score is computed in code** from issue severities (high 18, medium 9, low 4 off 100; designs under 3 nodes cap at 40). Same input, same score, so fixing an issue always raises it.
6. `api/*.ts` files are **self-contained (no local imports)** so Vercel bundles them without ESM path issues. Their validation mirrors `src/lib/schema.ts`; keep the two in sync.

## Design JSON

```ts
type NodeType = 'client' | 'cdn' | 'loadbalancer' | 'gateway' | 'service' | 'database' | 'cache' | 'queue';
interface Design {
  nodes: { id: string; label: string; type: NodeType }[];
  edges: { from: string; to: string; label?: string }[];   // direction = request/data flow
  issues: { nodeId: string | null; severity: 'high' | 'medium' | 'low'; note: string }[];
}
```

Ids are short snake_case and never change once created. Labels are 1 to 4 words. Rate limiter is a `gateway` node labelled "Rate Limiter". A read replica is a `database` node with an edge from the primary labelled "replicates".

## API

- `POST /api/design` body `{ design: {nodes, edges}, sentence }` returns `{ design: {nodes, edges} }`. Issues are carried over client side (dropped if their node is gone).
- `POST /api/review` body `{ design, previous?: Issue[], question?: string }` returns `{ issues, score }`. `previous` keeps reviews consistent; `question` is the interview prompt.
- Model: `GEMINI_MODEL` env var if set, then `gemini-flash-latest`, then `gemini-2.5-flash` (next one is tried only on HTTP 404, i.e. a retired name). JSON mode + response schema, temperature 0.2, 25 s timeout.
- Errors: 405 wrong method, 400 bad input, 413 sentence over 1500 chars, 429 Gemini quota, 500 key missing, 502 Gemini failed or invalid twice.

## Offline engine (backup)

`src/lib/localEngine.ts` is a rule-based parser + reviewer. The client uses it automatically when `/api` fails (no key, static hosting, quota hit, no network) or when the user picks "Built-in rules only". It handles the demo phrasings: chains ("users hit X, then Y, then Z"), counts ("three API servers"), lists ("auth, orders and payments services"), "each with its own X", "X in front of Y", "add X between A and B", "add a second X", "add a read replica", "add rate limiting", remove, rename, connect. Every history entry shows which engine answered.

## Voice commands (client side, before any API call)

`undo`, `start over`, `review my design` / `grill me`, `start interview`, `end interview`, `export diagram`. Matching ignores case and punctuation because Wispr adds them.

## Files

```
api/design.ts           Gemini: sentence + design -> updated design
api/review.ts           Gemini: design -> issues (+ score computed in code)
src/App.tsx             UI, state, command handling, interview mode, scorecard
src/lib/commands.ts     voice command matching
src/lib/api.ts          fetch /api with fallback to the local engine
src/lib/localEngine.ts  offline parser + reviewer
src/lib/schema.ts       validation, issue carry-over, scoring
src/lib/toMermaid.ts    design JSON -> Mermaid flowchart (shapes + styles per type, red issue marks)
src/lib/diagram.ts      Mermaid render queue + PNG export
src/lib/interview.ts    interview questions, timer helpers, verdicts
vite.config.ts          dev middleware that serves api/*.ts on localhost using .env.local
```

## Commands

- `npm install`
- `npm run dev` serves the app and `/api` on http://localhost:5173 (reads `.env.local`)
- `vercel dev` also works (Vercel CLI, serves `/api` itself)
- `npm run build` type-checks and builds to `dist/` (static; uses the offline engine if no `/api`)
- `npm run typecheck`

## Status (build plan)

1. Plan: this file. Done.
2. Scaffold: done. Repo creation and push happen on the new machine (see SETUP-NEW-LAPTOP.md).
3. Layout: text box with the exact Wispr label, Enter submits, history below, diagram on the right. Done.
4. Design API with strict JSON, validation, one retry, local testing. Done.
5. Diagram from JSON, one style per node type, new nodes animate in. Done.
6. Voice edits, undo, start over. Done.
7. Review endpoint, red nodes, issues panel, score and score change. Done.
8. Interview mode with random prompt, 10 minute timer, final scorecard. Done.
9. PNG export, landing header, Wispr tips panel. Done.
10. Deploy: import on Vercel, add `GEMINI_API_KEY`, test in Incognito. To do on the new machine.

## Style

Whiteboard look: cool board white with a dot grid, ink navy text, marker blue for actions. Red (#D7263D) is reserved for review marks and the hand-circled score. Fonts: Instrument Sans (UI), Kalam (red-pen notes, score). Diagram text uses the system font so PNG export matches the screen.
