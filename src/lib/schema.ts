import { NODE_TYPES, type Design, type DesignEdge, type DesignNode, type Issue, type NodeType, type Severity } from '../types';

// NOTE: api/design.ts and api/review.ts carry their own copy of these rules on purpose
// (Vercel functions stay import-free). Keep both in sync.

const TYPE_SYNONYMS: Record<string, NodeType> = {
  'load balancer': 'loadbalancer',
  load_balancer: 'loadbalancer',
  lb: 'loadbalancer',
  'api gateway': 'gateway',
  api_gateway: 'gateway',
  db: 'database',
  storage: 'database',
  datastore: 'database',
  'message queue': 'queue',
  broker: 'queue',
  user: 'client',
  users: 'client',
  server: 'service',
  microservice: 'service',
  worker: 'service',
};

export const MAX_NODES = 60;

export function coerceType(raw: unknown): NodeType {
  const t = String(raw ?? '').trim().toLowerCase();
  if ((NODE_TYPES as readonly string[]).includes(t)) return t as NodeType;
  return TYPE_SYNONYMS[t] ?? 'service';
}

function cleanLabel(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || fallback;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validates and repairs nodes + edges. Structural problems are errors (caller may retry);
 * small problems (unknown type, dangling edge, duplicate) are repaired silently.
 */
export function parseDesign(raw: unknown): Parsed<Omit<Design, 'issues'>> {
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
  const edgeKeys = new Set<string>();
  for (const e of (obj.edges as unknown[] | undefined) ?? []) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const from = String(r.from ?? '').trim();
    const to = String(r.to ?? '').trim();
    if (!seen.has(from) || !seen.has(to) || from === to) continue;
    const key = `${from}>${to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    const label = r.label ? cleanLabel(r.label, '').slice(0, 24) : '';
    edges.push(label ? { from, to, label } : { from, to });
  }
  return { ok: true, value: { nodes, edges } };
}

const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

export function parseIssues(raw: unknown, nodes: DesignNode[]): Parsed<Issue[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'issues must be an array' };
  const ids = new Set(nodes.map((n) => n.id));
  const issues: Issue[] = [];
  for (const i of raw) {
    if (!i || typeof i !== 'object') continue;
    const r = i as Record<string, unknown>;
    const note = String(r.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!note) continue;
    const sev = String(r.severity ?? '').toLowerCase() as Severity;
    const nodeId = typeof r.nodeId === 'string' && ids.has(r.nodeId) ? r.nodeId : null;
    issues.push({ nodeId, severity: SEVERITIES.includes(sev) ? sev : 'medium', note });
  }
  return { ok: true, value: issues.slice(0, 8) };
}

export const PENALTY: Record<Severity, number> = { high: 18, medium: 9, low: 4 };

/** Score is computed in code from severities so it is deterministic: fix an issue, score goes up. */
export function scoreFor(issues: Issue[], nodeCount: number): number {
  if (nodeCount === 0) return 0;
  const raw = 100 - issues.reduce((sum, i) => sum + PENALTY[i.severity], 0);
  const capped = nodeCount < 3 ? Math.min(raw, 40) : raw;
  return Math.max(0, Math.min(100, Math.round(capped)));
}

/** Keeps only issues whose node still exists after an edit. */
export function carryIssues(issues: Issue[], nodes: DesignNode[]): Issue[] {
  const ids = new Set(nodes.map((n) => n.id));
  return issues.filter((i) => i.nodeId === null || ids.has(i.nodeId));
}
