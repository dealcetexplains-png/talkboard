import type { Design, Engine, Issue, ReviewResult } from '../types';
import { carryIssues, parseDesign, parseIssues, scoreFor } from './schema';
import { localDesign, localReview } from './localEngine';

export type EngineMode = 'auto' | 'local';

export interface EngineResult<T> {
  value: T;
  engine: Engine;
  /** Set when Gemini was tried and failed, so the UI can say why it fell back. */
  fallbackReason?: string;
}

// When the server says Gemini isn't set up (no key, no /api on a static host), stop asking for a
// minute instead of failing on every sentence. Real errors (quota, timeout) are retried each time.
let apiDownUntil = 0;
let apiDownReason = '';
const SETUP_ERROR = /not set on the server|No API at|did not return JSON/i;

async function post(path: string, body: unknown): Promise<unknown> {
  if (Date.now() < apiDownUntil) throw new Error(apiDownReason);
  try {
    return await rawPost(path, body);
  } catch (e) {
    const msg = (e as Error).message;
    if (SETUP_ERROR.test(msg)) {
      apiDownUntil = Date.now() + 60_000;
      apiDownReason = msg;
    }
    throw e;
  }
}

async function rawPost(path: string, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // A static host (vite preview, plain file server) answers /api with HTML or 404.
      throw new Error(res.ok ? 'API did not return JSON' : `No API at ${path} (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error;
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return data;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('Gemini request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestDesign(design: Design, sentence: string, mode: EngineMode): Promise<EngineResult<Design>> {
  if (mode === 'auto') {
    try {
      const data = (await post('/api/design', {
        design: { nodes: design.nodes, edges: design.edges },
        sentence,
      })) as { design?: unknown };
      const parsed = parseDesign(data?.design);
      if (!parsed.ok) throw new Error(`Bad design from API: ${parsed.error}`);
      return {
        value: { ...parsed.value, issues: carryIssues(design.issues, parsed.value.nodes) },
        engine: 'gemini',
      };
    } catch (e) {
      return { value: localDesign(design, sentence), engine: 'local', fallbackReason: (e as Error).message };
    }
  }
  return { value: localDesign(design, sentence), engine: 'local' };
}

export async function requestReview(
  design: Design,
  previous: Issue[],
  question: string | null,
  mode: EngineMode,
): Promise<EngineResult<ReviewResult>> {
  if (mode === 'auto') {
    try {
      const data = (await post('/api/review', {
        design: { nodes: design.nodes, edges: design.edges },
        previous,
        question: question ?? undefined,
      })) as { issues?: unknown; score?: unknown };
      const parsed = parseIssues(data?.issues, design.nodes);
      if (!parsed.ok) throw new Error(`Bad review from API: ${parsed.error}`);
      const score = typeof data?.score === 'number' ? data.score : scoreFor(parsed.value, design.nodes.length);
      return { value: { issues: parsed.value, score }, engine: 'gemini' };
    } catch (e) {
      return { value: localReview(design), engine: 'local', fallbackReason: (e as Error).message };
    }
  }
  return { value: localReview(design), engine: 'local' };
}
