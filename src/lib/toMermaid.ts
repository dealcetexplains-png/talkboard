import type { Design, NodeType, Severity } from '../types';

export type Direction = 'LR' | 'TD';

// One shape per node type so the diagram reads at a glance.
const SHAPES: Record<NodeType, [string, string]> = {
  client: ['([', '])'], // stadium
  cdn: ['[/', '/]'], // parallelogram
  loadbalancer: ['{{', '}}'], // hexagon
  gateway: ['[\\', '/]'], // trapezoid
  service: ['(', ')'], // rounded box
  database: ['[(', ')]'], // cylinder
  cache: ['[[', ']]'], // double-sided box
  queue: ['>', ']'], // flag
};

// Light fills + ink text everywhere, so labels stay readable and PNG export needs no extra CSS.
const TYPE_STYLES: Record<NodeType, string> = {
  client: 'fill:#FFFFFF,stroke:#1D2433,stroke-width:1.5px,color:#1D2433',
  cdn: 'fill:#EEF1F7,stroke:#5D6675,stroke-width:1.5px,color:#1D2433',
  loadbalancer: 'fill:#E3E9F6,stroke:#2457C5,stroke-width:2px,color:#1D2433',
  gateway: 'fill:#E8E6F7,stroke:#4B3FA8,stroke-width:2px,color:#1D2433',
  service: 'fill:#FFFFFF,stroke:#2457C5,stroke-width:2px,color:#1D2433',
  database: 'fill:#DCE7F8,stroke:#1D3E8A,stroke-width:2px,color:#1D2433',
  cache: 'fill:#FBEFD9,stroke:#A86400,stroke-width:2px,color:#1D2433',
  queue: 'fill:#EDE3F3,stroke:#6B3D8F,stroke-width:2px,color:#1D2433',
};

// Defined after the type styles so they win: the red-pen review marks.
const ISSUE_STYLES: Record<Severity, string> = {
  high: 'fill:#FBE3E6,stroke:#D7263D,stroke-width:3.5px,color:#8E1022',
  medium: 'fill:#FDECEC,stroke:#D7263D,stroke-width:2.5px,stroke-dasharray:6 3,color:#8E1022',
  low: 'fill:#FFF6F0,stroke:#E0707D,stroke-width:2px,stroke-dasharray:3 3,color:#1D2433',
};

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** Mermaid ids must be simple and must avoid keywords like "end". */
export function safeId(id: string): string {
  return 'n_' + id.replace(/[^A-Za-z0-9_]/g, '_');
}

function esc(text: string): string {
  return text
    .replace(/["`]/g, "'")
    .replace(/[<>{}[\]|#;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MermaidOptions {
  direction: Direction;
  newIds?: Set<string>;
  /** Show red marks? Off when the review is hidden. */
  showIssues?: boolean;
}

export function toMermaid(design: Design, opts: MermaidOptions): string {
  const lines: string[] = [`flowchart ${opts.direction}`];

  for (const n of design.nodes) {
    const [open, close] = SHAPES[n.type];
    lines.push(`  ${safeId(n.id)}${open}"${esc(n.label) || n.id}"${close}`);
  }

  for (const e of design.edges) {
    const label = e.label ? esc(e.label) : '';
    lines.push(label ? `  ${safeId(e.from)} -->|"${label}"| ${safeId(e.to)}` : `  ${safeId(e.from)} --> ${safeId(e.to)}`);
  }

  for (const t of Object.keys(TYPE_STYLES) as NodeType[]) {
    lines.push(`  classDef t_${t} ${TYPE_STYLES[t]}`);
  }
  for (const s of Object.keys(ISSUE_STYLES) as Severity[]) {
    lines.push(`  classDef issue_${s} ${ISSUE_STYLES[s]}`);
  }
  // Marker class only: the page CSS animates g.node.tb_new; the style itself changes nothing.
  lines.push('  classDef tb_new opacity:1');

  const byType = new Map<NodeType, string[]>();
  for (const n of design.nodes) {
    byType.set(n.type, [...(byType.get(n.type) ?? []), safeId(n.id)]);
  }
  for (const [t, ids] of byType) lines.push(`  class ${ids.join(',')} t_${t}`);

  if (opts.showIssues !== false) {
    const worst = new Map<string, Severity>();
    for (const i of design.issues) {
      if (!i.nodeId) continue;
      const prev = worst.get(i.nodeId);
      if (!prev || SEV_RANK[i.severity] > SEV_RANK[prev]) worst.set(i.nodeId, i.severity);
    }
    for (const [id, sev] of worst) {
      if (design.nodes.some((n) => n.id === id)) lines.push(`  class ${safeId(id)} issue_${sev}`);
    }
  }

  const fresh = design.nodes.filter((n) => opts.newIds?.has(n.id)).map((n) => safeId(n.id));
  if (fresh.length) lines.push(`  class ${fresh.join(',')} tb_new`);

  return lines.join('\n');
}
