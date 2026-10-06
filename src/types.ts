export const NODE_TYPES = [
  'client',
  'cdn',
  'loadbalancer',
  'gateway',
  'service',
  'database',
  'cache',
  'queue',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export interface DesignNode {
  id: string;
  label: string;
  type: NodeType;
}

export interface DesignEdge {
  from: string;
  to: string;
  label?: string;
}

export type Severity = 'high' | 'medium' | 'low';

export interface Issue {
  /** Node the fix belongs on, or null for a design-wide issue. */
  nodeId: string | null;
  severity: Severity;
  note: string;
}

/** The single source of truth for what is on the board. */
export interface Design {
  nodes: DesignNode[];
  edges: DesignEdge[];
  issues: Issue[];
}

export interface ReviewResult {
  issues: Issue[];
  score: number;
}

/** Which brain produced a result: Gemini through /api, or the built-in rules. */
export type Engine = 'gemini' | 'local';

export const EMPTY_DESIGN: Design = { nodes: [], edges: [], issues: [] };

export const TYPE_NAMES: Record<NodeType, string> = {
  client: 'Client',
  cdn: 'CDN',
  loadbalancer: 'Load balancer',
  gateway: 'Gateway',
  service: 'Service',
  database: 'Database',
  cache: 'Cache',
  queue: 'Queue',
};
