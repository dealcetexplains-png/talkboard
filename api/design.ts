// POST /api/design  { design: { nodes, edges }, sentence }  ->  { design: { nodes, edges } }
//
// Vercel serverless function. Deliberately self-contained (no local imports) so Vercel bundles it
// without ESM path problems. Validation mirrors src/lib/schema.ts: keep the two in sync.
// The Gemini key is read from process.env on the server and never reaches the browser.

const NODE_TYPES = ['client', 'cdn', 'loadbalancer', 'gateway', 'service', 'database', 'cache', 'queue'] as const;
type NodeType = (typeof NODE_TYPES)[number];
interface DesignNode { id: string; label: string; type: NodeType }
interface DesignEdge { from: string; to: string; label?: string }
interface Graph { nodes: DesignNode[]; edges: DesignEdge[] }

interface Req { method?: string; body?: unknown }
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

const MAX_NODES = 60;
const MAX_SENTENCE = 1500;
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash'];

const SYSTEM = `You maintain the architecture diagram for Talkboard, a voice-first system design interview coach.
You get the CURRENT_DESIGN as JSON and one SENTENCE the user just dictated. It comes from speech-to-text, so ignore filler words and fix obvious mis-hearings of tech names (e.g. "post gress" = Postgres, "ready's" = Redis, "cough ka" = Kafka).
Apply the sentence to the design and return the COMPLETE updated design as JSON: {"nodes":[...],"edges":[...]}.

Node: {"id","label","type"}. type is one of: ${NODE_TYPES.join(', ')}.
- Users, browsers, mobile and web apps are "client". API gateway, rate limiter, WAF and auth proxy are "gateway". Kafka, RabbitMQ, SQS and other brokers are "queue". Object storage like S3 is "database".
- Keep every existing id exactly as it is. New ids are short snake_case, unique, e.g. "api_2", "orders_db".
- Labels are 1 to 4 words, title case. Use product names when said (Postgres, Redis, Kafka, S3).
- A rate limiter is a "gateway" node labelled "Rate Limiter". A read replica is a "database" node with an edge from its primary labelled "replicates".
- Counts make separate nodes: "three API servers" means API Server 1, API Server 2, API Server 3, each wired the same way.

Edge: {"from","to","label"?}. Direction is the request or data flow, caller to callee. Labels are optional, max 3 words.

How to apply the sentence:
- A description builds or extends the design. Chains like "users hit X, then Y, then Z" connect in order.
- "add/remove/rename/replace/connect" edits the current design and keeps everything else unchanged.
- "add X between A and B" removes the direct A->B edge and routes A->X->B.
- "X in front of Y" puts X before Y on the path.
- Never invent components the user did not say. Obviously implied wiring is fine.
- If the sentence says nothing about architecture, return the current design unchanged.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    nodes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          label: { type: 'STRING' },
          type: { type: 'STRING', enum: [...NODE_TYPES] },
        },
        required: ['id', 'label', 'type'],
      },
    },
    edges: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { from: { type: 'STRING' }, to: { type: 'STRING' }, label: { type: 'STRING' } },
        required: ['from', 'to'],
      },
    },
  },
  required: ['nodes', 'edges'],
};

// ---------- validation (mirrors src/lib/schema.ts) ----------

const TYPE_SYNONYMS: Record<string, NodeType> = {
  'load balancer': 'loadbalancer', load_balancer: 'loadbalancer', lb: 'loadbalancer',
  'api gateway': 'gateway', api_gateway: 'gateway',
  db: 'database', storage: 'database', datastore: 'database',
  'message queue': 'queue', broker: 'queue',
  user: 'client', users: 'client',
  server: 'service', microservice: 'service', worker: 'service',
};

function coerceType(raw: unknown): NodeType {
  const t = String(raw ?? '').trim().toLowerCase();
  if ((NODE_TYPES as readonly string[]).includes(t)) return t as NodeType;
  return TYPE_SYNONYMS[t] ?? 'service';
}

const cleanLabel = (raw: unknown, fallback: string) =>
  String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseDesign(raw: unknown): Parsed<Graph> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'design is not an object' };
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.nodes)) return { ok: false, error: 'nodes must be an array' };
  if (obj.edges !== undefined && !Array.isArray(obj.edges)) return { ok: false, error: 'edges must be an array' };
  if (obj.nodes.length > MAX_NODES) return { ok: false, error: `too many nodes (max ${MAX_NODES})` };

  const nodes: DesignNode[] = [];
  const seen = new Set<string>();
  for (const n of obj.nodes) {
    if (!n || typeof n !== 'object') return { ok: false, error: 'every node must be an object' };
    const r = n as Record<string, unknown>;
    const id = String(r.id ?? '').trim();
    if (!id) return { ok: false, error: 'every node needs an id' };
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: cleanLabel(r.label, id), type: coerceType(r.type) });
  }

  const edges: DesignEdge[] = [];
  const keys = new Set<string>();
  for (const e of (obj.edges as unknown[] | undefined) ?? []) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const from = String(r.from ?? '').trim();
    const to = String(r.to ?? '').trim();
    if (!seen.has(from) || !seen.has(to) || from === to) continue;
    const key = `${from}>${to}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const label = r.label ? cleanLabel(r.label, '').slice(0, 24) : '';
    edges.push(label ? { from, to, label } : { from, to });
  }
  return { ok: true, value: { nodes, edges } };
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

/** Strict JSON, validated; one retry with the validation error if the first answer is invalid. */
async function generate(apiKey: string, preferred: string | undefined, basePrompt: string): Promise<Graph> {
  const models = [...new Set([preferred?.trim(), ...FALLBACK_MODELS].filter((m): m is string => !!m))];
  let last: UpstreamError | null = null;
  for (const model of models) {
    let prompt = basePrompt;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const text = await callGemini(model, apiKey, prompt);
        let problem: string;
        try {
          const parsed = parseDesign(parseJson(text));
          if (parsed.ok) return parsed.value;
          problem = parsed.error;
        } catch {
          problem = 'it was not valid JSON';
        }
        prompt = `${basePrompt}\n\nYour previous answer was invalid (${problem}). Reply with only the corrected JSON object.`;
        last = new UpstreamError(`Gemini returned invalid design JSON twice (${problem}).`, 502);
      }
      throw last;
    } catch (e) {
      // A retired or unknown model name gives 404: try the next fallback model.
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
  const { design, sentence } = (body ?? {}) as { design?: unknown; sentence?: unknown };
  if (typeof sentence !== 'string' || !sentence.trim()) {
    res.status(400).json({ error: '"sentence" must be a non-empty string.' });
    return;
  }
  if (sentence.length > MAX_SENTENCE) {
    res.status(413).json({ error: `Sentence is too long (max ${MAX_SENTENCE} characters).` });
    return;
  }
  const current = parseDesign(design ?? { nodes: [], edges: [] });
  if (!current.ok) {
    res.status(400).json({ error: `Invalid design: ${current.error}` });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY is not set on the server.' });
    return;
  }

  const prompt = `CURRENT_DESIGN:\n${JSON.stringify(current.value)}\n\nSENTENCE:\n${sentence.trim()}`;
  try {
    const updated = await generate(apiKey, process.env.GEMINI_MODEL, prompt);
    res.status(200).json({ design: updated });
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(String(e), 502);
    console.error('[api/design]', err.message);
    res.status(err.status === 429 ? 429 : 502).json({ error: err.message });
  }
}
