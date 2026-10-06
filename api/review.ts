// POST /api/review  { design: { nodes, edges }, previous?: Issue[], question?: string }  ->  { issues, score }
//
// Vercel serverless function. Self-contained on purpose (see api/design.ts). Issue parsing and
// scoring mirror src/lib/schema.ts: keep them in sync. The score is computed here in code from the
// issue severities, never by the model, so the same design always gets the same score.

const SEVERITIES = ['high', 'medium', 'low'] as const;
type Severity = (typeof SEVERITIES)[number];
interface Issue { nodeId: string | null; severity: Severity; note: string }
interface Req { method?: string; body?: unknown }
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

const MAX_NODES = 60;
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash'];
const PENALTY: Record<Severity, number> = { high: 18, medium: 9, low: 4 };

const SYSTEM = `You are a senior system design interviewer reviewing a candidate's architecture on Talkboard.
You get the DESIGN as JSON (nodes and edges), the PREVIOUS_ISSUES from the last review, and sometimes the INTERVIEW_QUESTION being answered.
Return JSON: {"issues":[{"nodeId":"id of the node where the fix belongs, or null if design-wide","severity":"high|medium|low","note":"..."}]}

Flag what a real interviewer would push on:
- single points of failure: one app server taking all traffic, one load balancer, one database with no replica or failover
- no cache in front of a read-heavy database
- no rate limiting or API gateway at the edge
- slow or flaky work (email, notifications, payment callbacks, video, reports) done synchronously instead of through a queue
- no CDN for static or media content
- components not connected to anything
- for an interview question: core pieces that problem needs (e.g. a URL shortener needs ID generation and a cached redirect path)

Rules:
- note is one line, max 14 words, and says what to change. Example: "No replica. One DB failure takes this down."
- severity: high = will fail or not scale; medium = an interviewer will push on it; low = polish.
- At most 6 issues, most important first. nodeId must be an id from DESIGN, or null.
- Never flag something the design already solves. Drop PREVIOUS_ISSUES that are now fixed.
- When the design only improved since PREVIOUS_ISSUES, do not invent new low-severity nitpicks.
- An empty issues array is a valid answer for a solid design.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    issues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          nodeId: { type: 'STRING', nullable: true },
          severity: { type: 'STRING', enum: [...SEVERITIES] },
          note: { type: 'STRING' },
        },
        required: ['severity', 'note'],
      },
    },
  },
  required: ['issues'],
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------- validation and scoring (mirror src/lib/schema.ts) ----------

function parseNodes(raw: unknown): Parsed<{ nodes: { id: string; label: string; type: string }[]; edges: unknown[] }> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'design is not an object' };
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.nodes)) return { ok: false, error: 'nodes must be an array' };
  if (obj.nodes.length > MAX_NODES) return { ok: false, error: `too many nodes (max ${MAX_NODES})` };
  const nodes = obj.nodes
    .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object')
    .map((n) => ({
      id: String(n.id ?? '').trim(),
      label: String(n.label ?? '').slice(0, 40),
      type: String(n.type ?? '').slice(0, 20),
    }))
    .filter((n) => n.id);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(obj.edges) ? obj.edges : [])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({ from: String(e.from ?? ''), to: String(e.to ?? ''), ...(e.label ? { label: String(e.label).slice(0, 24) } : {}) }))
    .filter((e) => ids.has(e.from) && ids.has(e.to));
  return { ok: true, value: { nodes, edges } };
}

function parseIssues(raw: unknown, nodeIds: Set<string>): Parsed<Issue[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'issues must be an array' };
  const issues: Issue[] = [];
  for (const i of raw) {
    if (!i || typeof i !== 'object') continue;
    const r = i as Record<string, unknown>;
    const note = String(r.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!note) continue;
    const sev = String(r.severity ?? '').toLowerCase() as Severity;
    const nodeId = typeof r.nodeId === 'string' && nodeIds.has(r.nodeId) ? r.nodeId : null;
    issues.push({ nodeId, severity: SEVERITIES.includes(sev) ? sev : 'medium', note });
  }
  return { ok: true, value: issues.slice(0, 8) };
}

function scoreFor(issues: Issue[], nodeCount: number): number {
  if (nodeCount === 0) return 0;
  const raw = 100 - issues.reduce((sum, i) => sum + PENALTY[i.severity], 0);
  const capped = nodeCount < 3 ? Math.min(raw, 40) : raw;
  return Math.max(0, Math.min(100, Math.round(capped)));
}

// ---------- Gemini ----------

class UpstreamError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function callGemini(model: string, apiKey: string, prompt: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
        }),
      },
    );
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 240);
      if (res.status === 429) throw new UpstreamError('Gemini quota or rate limit hit. Wait a minute and try again.', 429);
      throw new UpstreamError(`Gemini (${model}) returned HTTP ${res.status}: ${detail}`, res.status);
    }
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if ((e as Error).name === 'AbortError') throw new UpstreamError('Gemini timed out after 25 seconds.', 504);
    throw new UpstreamError(`Could not reach Gemini: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  return JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''));
}

async function generate(apiKey: string, preferred: string | undefined, basePrompt: string, nodeIds: Set<string>): Promise<Issue[]> {
  const models = [...new Set([preferred?.trim(), ...FALLBACK_MODELS].filter((m): m is string => !!m))];
  let last: UpstreamError | null = null;
  for (const model of models) {
    let prompt = basePrompt;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const text = await callGemini(model, apiKey, prompt);
        let problem: string;
        try {
          const parsed = parseIssues((parseJson(text) as { issues?: unknown } | null)?.issues, nodeIds);
          if (parsed.ok) return parsed.value;
          problem = parsed.error;
        } catch {
          problem = 'it was not valid JSON';
        }
        prompt = `${basePrompt}\n\nYour previous answer was invalid (${problem}). Reply with only the corrected JSON object.`;
        last = new UpstreamError(`Gemini returned invalid review JSON twice (${problem}).`, 502);
      }
      throw last;
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) {
        last = e;
        continue;
      }
      throw e;
    }
  }
  throw last ?? new UpstreamError('No Gemini model available.', 502);
}

// ---------- handler ----------

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: 'Body must be JSON.' });
      return;
    }
  }
  const { design, previous, question } = (body ?? {}) as { design?: unknown; previous?: unknown; question?: unknown };
  const parsed = parseNodes(design);
  if (!parsed.ok) {
    res.status(400).json({ error: `Invalid design: ${parsed.error}` });
    return;
  }
  const { nodes, edges } = parsed.value;
  if (nodes.length === 0) {
    res.status(200).json({ issues: [], score: 0 });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
    return;
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const prev = parseIssues(previous ?? [], nodeIds);
  const q = typeof question === 'string' && question.trim() ? question.trim().slice(0, 200) : '';
  const prompt = [
    q ? `INTERVIEW_QUESTION:\n${q}` : '',
    `DESIGN:\n${JSON.stringify({ nodes, edges })}`,
    `PREVIOUS_ISSUES:\n${JSON.stringify(prev.ok ? prev.value : [])}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const issues = await generate(apiKey, process.env.GEMINI_MODEL, prompt, nodeIds);
    res.status(200).json({ issues, score: scoreFor(issues, nodes.length) });
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(String(e), 502);
    console.error('[api/review]', err.message);
    res.status(err.status === 429 ? 429 : 502).json({ error: err.message });
  }
}
