/**
 * Offline engine. Used when /api is unreachable (plain `vite`, `vite preview`, no key, quota hit)
 * or when the user picks "Local rules". It understands the common phrasings from the demo script;
 * Gemini handles everything else much better.
 */
import type { Design, DesignEdge, DesignNode, Issue, NodeType, ReviewResult } from '../types';
import { carryIssues, scoreFor } from './schema';

// ---------- text helpers ----------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, single: 1, two: 2, pair: 2, couple: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, several: 3, multiple: 3, few: 3,
};

const STOP = new Set([
  'a', 'an', 'the', 'some', 'our', 'my', 'its', 'their', 'own', 'each', 'every', 'all', 'other', 'new',
  'and', 'or', 'with', 'then', 'also', 'plus', 'that', 'which', 'it', 'they', 'this', 'these', 'those',
  'to', 'of', 'for', 'in', 'on', 'at', 'from', 'by', 'into', 'up', 'is', 'are', 'be', 'both', 'more', 'extra',
  ...Object.keys(NUMBER_WORDS),
]);

const VERBISH = new Set([
  'is', 'are', 'was', 'be', 'has', 'have', 'uses', 'using', 'used', 'does', 'do', 'goes', 'replicated',
  'cached', 'stored', 'stores', 'handles', 'handle', 'runs', 'run', 'need', 'needs', 'should', 'will',
  'can', 'could', 'would', 'everything', 'something', 'thing', 'things', 'stuff', 'here', 'there', 'okay',
]);

const ACRONYMS = new Set(['api', 'cdn', 'db', 'sqs', 'sns', 's3', 'lb', 'elb', 'alb', 'id', 'url', 'ml', 'ai', 'sms']);

const BRANDS: Record<string, string> = {
  postgres: 'Postgres', postgresql: 'Postgres', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB',
  mongodb: 'MongoDB', dynamodb: 'DynamoDB', cassandra: 'Cassandra', sqlite: 'SQLite', cockroachdb: 'CockroachDB',
  elasticsearch: 'Elasticsearch', s3: 'S3', bigtable: 'Bigtable', spanner: 'Spanner', firestore: 'Firestore',
  supabase: 'Supabase', redis: 'Redis', memcache: 'Memcached', memcached: 'Memcached', valkey: 'Valkey',
  kafka: 'Kafka', rabbitmq: 'RabbitMQ', sqs: 'SQS', sns: 'SNS', kinesis: 'Kinesis', nats: 'NATS',
  pubsub: 'Pub/Sub', celery: 'Celery', nginx: 'Nginx', haproxy: 'HAProxy', envoy: 'Envoy', elb: 'ELB',
  alb: 'ALB', cdn: 'CDN', cloudfront: 'CloudFront', cloudflare: 'Cloudflare', akamai: 'Akamai', fastly: 'Fastly',
};

function brand(raw: string): string {
  const k = raw.toLowerCase().replace(/[\s/]/g, '');
  return BRANDS[k] ?? cap(raw);
}

function cap(word: string): string {
  return word
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function singular(w: string): string {
  if (w.length > 3 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const GENERIC_WORDS = new Set([
  'service', 'server', 'database', 'cache', 'queue', 'api', 'balancer', 'load', 'gateway', 'client',
  'user', 'app', 'backend', 'worker', 'node', 'instance', 'microservice', 'storage', 'store',
]);

const TOKEN_SYNONYMS: Record<string, string> = { db: 'database', lb: 'balancer', svc: 'service', postgresql: 'postgres' };

/** Significant, singular, lowercase tokens. */
function sig(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, ' ')
    .split(/[\s/-]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => TOKEN_SYNONYMS[w] ?? singular(w));
}

function norm(text: string): string {
  return sig(text).join(' ');
}

function clean(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:!?-]+|[\s,.;:!?]+$/g, '')
    .trim();
}

const LEAD_IN =
  /^(?:(?:ok(?:ay)?|so|now|also|and|then|alright|right|next|let's|lets|let us|i want to|i'd like to|i'd|i would|we need to|we should|we'll|please|can you|could you|go ahead and|just)\s+)+/i;

// ---------- components ----------

interface Comp {
  label: string;
  type: NodeType;
  count: number;
  plural: boolean;
  generic: boolean;
}

type Rule = { re: RegExp; type: NodeType; label: (m: RegExpMatchArray) => string; generic?: boolean };

const CLIENT_LABELS: Record<string, string> = {
  'mobile app': 'Mobile App', 'web app': 'Web App', browser: 'Browser', frontend: 'Frontend',
  'front end': 'Frontend', user: 'Users', client: 'Clients', customer: 'Customers', people: 'Users',
  rider: 'Riders', driver: 'Drivers', player: 'Players', visitor: 'Visitors',
};

const RULES: Rule[] = [
  { re: /\brate[\s-]?limit(?:er|ing)?s?\b/, type: 'gateway', label: () => 'Rate Limiter' },
  { re: /\bapi[\s-]?gateways?\b/, type: 'gateway', label: () => 'API Gateway', generic: true },
  { re: /\bgateways?\b/, type: 'gateway', label: () => 'Gateway', generic: true },
  { re: /\b(nginx|haproxy|envoy|elb|alb)\b/, type: 'loadbalancer', label: (m) => brand(m[1]) },
  { re: /\b(?:load[\s-]?balancers?|lbs?)\b/, type: 'loadbalancer', label: () => 'Load Balancer', generic: true },
  { re: /\b(cloudfront|cloudflare|akamai|fastly)\b/, type: 'cdn', label: (m) => brand(m[1]) },
  { re: /\bcdns?\b/, type: 'cdn', label: () => 'CDN', generic: true },
  { re: /\b(redis|memcached?|valkey)\b/, type: 'cache', label: (m) => brand(m[1]) },
  { re: /\b(kafka|rabbit\s?mq|sqs|sns|kinesis|nats|pub\s?\/?\s?sub|celery)\b/, type: 'queue', label: (m) => brand(m[1]) },
  { re: /\b(?:(?:message|event|job|task)\s+)?(?:queues?|bus|brokers?)\b/, type: 'queue', label: () => 'Queue', generic: true },
  { re: /\b(?:read\s+)?replicas?\b/, type: 'database', label: () => 'Read Replica' },
  {
    re: /\b(postgres(?:ql)?|mysql|maria\s?db|mongo(?:db)?|dynamo\s?db|cassandra|sqlite|cockroach\s?db|elasticsearch|s3|bigtable|spanner|firestore|supabase)\b/,
    type: 'database',
    label: (m) => brand(m[1]),
  },
  { re: /\b(?:blob|object|file)\s+(?:storage|store)\b/, type: 'database', label: () => 'Object Storage' },
  { re: /\bcaches?\b/, type: 'cache', label: () => 'Cache', generic: true },
  { re: /\b(?:databases?|dbs?|data\s?stores?)\b/, type: 'database', label: () => 'Database', generic: true },
  {
    re: /\b([a-z]+)[\s-]+(?:micro)?services?\b/,
    type: 'service',
    label: (m) => (STOP.has(m[1]) || m[1] === 'micro' ? 'Service' : `${cap(m[1])} Service`),
  },
  {
    re: /\b(mobile\s+apps?|web\s+apps?|browsers?|frontends?|front\s+ends?|users?|clients?|customers?|people|riders?|drivers?|players?|visitors?)\b/,
    type: 'client',
    label: (m) => CLIENT_LABELS[singular(m[1].toLowerCase().replace(/\s+/g, ' '))] ?? 'Users',
    generic: true,
  },
  { re: /\b(api|app|application|web|backend)\s+servers?\b/, type: 'service', label: (m) => `${cap(m[1])} Server` },
  { re: /\b(?:servers?|backends?)\b/, type: 'service', label: () => 'Server' },
  { re: /\bworkers?\b/, type: 'service', label: () => 'Worker' },
  { re: /\bapis?\b/, type: 'service', label: () => 'API' },
  { re: /\bmicroservices?\b/, type: 'service', label: () => 'Service' },
  {
    re: /\b(auth|authentication|orders?|payments?|billing|checkout|email|notifications?|search|feed|timeline|inventory|chat|media|uploads?|analytics|recommendations?|profiles?|cart|shipping|catalog|accounts?|messaging|matching|pricing|trips?|bookings?|redirect|shortener|encoding|transcoding)\b/,
    type: 'service',
    label: (m) => `${cap(m[1])} Service`,
  },
];

const GENERIC_SHORT: Partial<Record<NodeType, string>> = { database: 'DB', cache: 'Cache', queue: 'Queue' };

function parseComponent(phrase: string): Comp | null {
  const p = ` ${phrase.toLowerCase()} `;
  for (const rule of RULES) {
    const m = p.match(rule.re);
    if (!m) continue;
    let label = rule.label(m);
    let generic = !!rule.generic;
    const before = p.slice(0, m.index ?? 0);
    const matched = m[0].trim();
    const plural = /s$/.test(matched) && !/ss$/.test(matched) && !/(redis|kinesis|celery|nats|sqs|sns|s3|bus)$/.test(matched);

    let count = 1;
    const numMatch = before.match(/\b(\d+|one|single|two|pair|couple|three|four|five|six|seven|eight|nine|ten|several|multiple|few)\b(?:\s+of)?\s*(?:\w+\s+)?$/);
    if (numMatch) count = /^\d+$/.test(numMatch[1]) ? parseInt(numMatch[1], 10) : NUMBER_WORDS[numMatch[1]] ?? 1;
    count = Math.max(1, Math.min(count, 20));

    // "orders database" -> "Orders DB", "session cache" -> "Session Cache"
    if (generic && GENERIC_SHORT[rule.type]) {
      const qual = sig(before).filter((w) => !/^\d+$/.test(w));
      if (qual.length === 1 && !VERBISH.has(qual[0])) {
        label = `${cap(qual[0])} ${GENERIC_SHORT[rule.type]}`;
        generic = false;
      }
    }
    if (plural && count === 1 && rule.type !== 'client' && !/s$/.test(label)) label = `${label}s`;
    return { label, type: rule.type, count, plural: plural || count > 1, generic };
  }
  return null;
}

/** Unknown short noun phrases ("search index") become services; chatter is ignored. */
function unknownComp(phrase: string): Comp | null {
  const words = phrase.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!words.length || words.length > 3) return null;
  if (words.some((w) => VERBISH.has(w) || /ing$|ed$|ly$/.test(w))) return null;
  return { label: cap(words.join(' ')), type: 'service', count: 1, plural: false, generic: false };
}

function compOf(phrase: string): Comp | null {
  return parseComponent(phrase) ?? unknownComp(phrase);
}

// ---------- working copy of a design ----------

class Work {
  nodes: DesignNode[];
  edges: DesignEdge[];

  constructor(d: Design) {
    this.nodes = d.nodes.map((n) => ({ ...n }));
    this.edges = d.edges.map((e) => ({ ...e }));
  }

  node(id: string) {
    return this.nodes.find((n) => n.id === id);
  }
  preds(id: string) {
    return this.edges.filter((e) => e.to === id).map((e) => e.from);
  }
  succs(id: string) {
    return this.edges.filter((e) => e.from === id).map((e) => e.to);
  }
  ofType(t: NodeType) {
    return this.nodes.filter((n) => n.type === t);
  }

  addNode(label: string, type: NodeType): string {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || type;
    let id = base;
    for (let i = 2; this.node(id); i++) id = `${base}_${i}`;
    this.nodes.push({ id, label, type });
    return id;
  }

  /** Always creates a node; makes the label unique ("Queue 2"). */
  create(comp: Comp): string {
    let label = comp.label;
    if (this.nodes.some((n) => n.label.toLowerCase() === label.toLowerCase())) {
      for (let i = 2; ; i++) {
        const l = `${comp.label} ${i}`;
        if (!this.nodes.some((n) => n.label.toLowerCase() === l.toLowerCase())) {
          label = l;
          break;
        }
      }
    }
    return this.addNode(label, comp.type);
  }

  addEdge(from: string, to: string, label?: string) {
    if (from === to || !this.node(from) || !this.node(to)) return;
    if (this.edges.some((e) => e.from === from && e.to === to)) return;
    this.edges.push(label ? { from, to, label } : { from, to });
  }
  removeEdge(from: string, to: string) {
    this.edges = this.edges.filter((e) => !(e.from === from && e.to === to));
  }
  removeNode(id: string) {
    this.nodes = this.nodes.filter((n) => n.id !== id);
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
  }

  /** Nodes a spoken phrase most likely refers to ("the API" -> all API servers). */
  resolve(phrase: string): string[] {
    const p = norm(phrase);
    if (!p) return [];
    const tokens = sig(phrase);
    const specific = tokens.filter((t) => !GENERIC_WORDS.has(t));
    // "the email service" must match on "email", not on the generic word "service".
    const matchOn = new Set(specific.length ? specific : tokens);
    const comp = parseComponent(phrase);
    const typeOnly = !specific.length || !!comp?.generic;
    const wantsAll = /\b(all|every|each|both)\b/i.test(phrase);
    let best = 0;
    const scored = this.nodes.map((n) => {
      const nl = norm(n.label);
      let s = 0;
      if (nl === p) s = 100;
      else if (nl.includes(p) || (p.includes(nl) && nl.length > 2)) s = 80;
      else {
        const overlap = sig(n.label).filter((w) => matchOn.has(w)).length;
        if (overlap) s = Math.min(75, 40 + 15 * overlap);
      }
      if (comp && n.type === comp.type) s += s > 0 ? 10 : typeOnly ? 45 : 0;
      best = Math.max(best, s);
      return { id: n.id, s };
    });
    if (best < 45) return [];
    return scored.filter((x) => (wantsAll ? x.s >= 45 : x.s === best)).map((x) => x.id);
  }

  /** Finds the node(s) a component refers to, or creates them. */
  ensure(comp: Comp, phrase: string): string[] {
    if (comp.count >= 2 && comp.count <= 5) {
      const base = comp.label.replace(/s$/, '');
      return Array.from({ length: comp.count }, (_, i) => {
        const label = `${base} ${i + 1}`;
        const hit = this.nodes.find((n) => n.label.toLowerCase() === label.toLowerCase());
        return hit ? hit.id : this.addNode(label, comp.type);
      });
    }
    if (comp.count > 5) {
      const label = `${comp.label.replace(/s$/, '')}s ×${comp.count}`;
      const hit = this.nodes.find((n) => n.label === label);
      return [hit ? hit.id : this.addNode(label, comp.type)];
    }
    const exact = this.nodes.find((n) => n.label.toLowerCase() === comp.label.toLowerCase());
    if (exact) return [exact.id];
    if (comp.generic) {
      const same = this.ofType(comp.type);
      if (same.length && (same.length === 1 || comp.type === 'client')) return [same[0].id];
    }
    const resolved = this.resolve(phrase).filter((id) => this.node(id)?.type === comp.type);
    if (resolved.length && (comp.generic || comp.plural || comp.type === 'service')) {
      const hit = resolved.filter((id) => norm(this.node(id)!.label).includes(norm(comp.label).replace(/ \d+$/, '')));
      if (hit.length) return hit;
    }
    return [this.addNode(comp.label, comp.type)];
  }

  /** Where requests enter: what clients talk to (minus CDN), or nodes with no inbound edges. */
  entryHops(): string[] {
    const clients = this.ofType('client').map((n) => n.id);
    const hops = new Set<string>();
    for (const c of clients) for (const s of this.succs(c)) if (this.node(s)?.type !== 'cdn') hops.add(s);
    if (hops.size) return [...hops];
    return this.nodes.filter((n) => n.type !== 'client' && !this.preds(n.id).length).map((n) => n.id);
  }

  design(issues: Issue[]): Design {
    return { nodes: this.nodes, edges: this.edges, issues: carryIssues(issues, this.nodes) };
  }
}

// ---------- sentence handling ----------

const CONNECTOR =
  /(\s*,?\s*\b(?:(?:which|that|and|it|they)\s+)?(?:(?:then|hits?|routes?(?:\s+traffic)?\s+to|forwards?(?:\s+requests?)?\s+to|sends?(?:\s+requests?)?\s+to|talks?\s+to|calls|goes\s+to|go\s+to|connects?\s+to|points?\s+to|feeds?\s+into|writes?\s+to|reads?\s+from|passes?\s+(?:it\s+)?to|hands?\s+off\s+to|publishes\s+to|pushes\s+to|leads?\s+to|flows?\s+to)\b)\s*|\s*(?:->|→|=>)\s*)/i;

const FRONT_CLAUSE = /(?:,\s*)?(?:\band\s+)?(?:\bwith\s+)?([^,]+?)\s+in front of\s+(?:the\s+|each\s+|every\s+)?([^,]+)/i;
const EACH_OWN = /,?\s*(?:and\s+)?each\s+(?:with|has|having|gets|getting|owns|backed by)\s+(?:its|their)\s+own\s+(.+)$/i;
const LIST_FORM = /^(.*?)\s+(services|microservices|servers|workers|databases|dbs|caches|queues)$/i;

function stripPiece(piece: string): string {
  return piece.replace(/^(?:and|then|also|plus|with|which|that|it|they|both)\s+/i, '').trim();
}

/** "auth, orders and payments services" -> three services. Returns null if not a list. */
function listComps(seg: string): Comp[] | null {
  const m = seg.match(LIST_FORM);
  if (!m || !/,|\band\b/i.test(m[1])) return null;
  const items = m[1].split(/\s*,\s*|\s+and\s+/i).map(stripPiece).filter(Boolean);
  if (items.length < 2 || items.some((i) => i.split(/\s+/).length > 2)) return null;
  if (items.some((i) => {
    const c = parseComponent(i);
    return c && c.type !== 'service';
  })) return null;
  const kind = m[2].toLowerCase();
  const type: NodeType = /database|dbs/.test(kind) ? 'database' : /cache/.test(kind) ? 'cache' : /queue/.test(kind) ? 'queue' : 'service';
  const suffixes: Partial<Record<NodeType, string>> = {
    service: /server/.test(kind) ? 'Server' : /worker/.test(kind) ? 'Worker' : 'Service',
    database: 'DB',
    cache: 'Cache',
    queue: 'Queue',
  };
  const suffix = suffixes[type] ?? 'Service';
  return items.map((i) => ({
    label: `${cap(i.replace(/^(?:a|an|the)\s+/i, ''))} ${suffix}`,
    type,
    count: 1,
    plural: false,
    generic: false,
  }));
}

function baseName(label: string): string {
  return label.replace(/\s+(service|server|worker|api|svc)(\s+\d+)?$/i, '').trim() || label;
}

function attachEachOwn(w: Work, owners: string[], phrase: string) {
  const comp = compOf(phrase);
  if (!comp) return;
  for (const id of owners) {
    const owner = w.node(id);
    if (!owner || owner.type !== 'service') continue;
    const short = GENERIC_SHORT[comp.type] ?? cap(TYPE_LABEL[comp.type]);
    const label = comp.generic ? `${baseName(owner.label)} ${short}` : `${baseName(owner.label)} ${short} (${comp.label})`;
    const existing = w.nodes.find((n) => n.label === label);
    w.addEdge(id, existing ? existing.id : w.addNode(label, comp.type));
  }
}

const TYPE_LABEL: Record<NodeType, string> = {
  client: 'client', cdn: 'CDN', loadbalancer: 'LB', gateway: 'gateway', service: 'service',
  database: 'DB', cache: 'cache', queue: 'queue',
};

function applyFront(w: Work, compPhrase: string, targetPhrase: string) {
  const comp = compOf(compPhrase);
  if (!comp) return;
  let targets = w.resolve(targetPhrase);
  if (!targets.length) {
    const tc = compOf(targetPhrase);
    if (!tc) return;
    targets = w.ensure(tc, targetPhrase);
  }
  const xs = comp.generic ? [w.create(comp)] : w.ensure(comp, compPhrase);
  for (const t of targets) {
    const tn = w.node(t);
    if (!tn) continue;
    for (const x of xs) {
      if (comp.type === 'cache' && tn.type === 'service') w.addEdge(t, x);
      else if (comp.type === 'cache' && tn.type === 'database') {
        const preds = w.preds(t).filter((p) => p !== x);
        if (preds.length) preds.forEach((p) => w.addEdge(p, x));
        else w.addEdge(x, t);
      } else insertBefore(w, x, t);
    }
  }
}

function insertBefore(w: Work, x: string, t: string) {
  const preds = w.preds(t).filter((p) => p !== x);
  for (const p of preds) {
    w.removeEdge(p, t);
    w.addEdge(p, x);
  }
  w.addEdge(x, t);
}

function insertAfter(w: Work, x: string, t: string) {
  const succs = w.succs(t).filter((s) => s !== x);
  for (const s of succs) {
    const sType = w.node(s)?.type;
    if (sType === 'cdn') continue;
    w.removeEdge(t, s);
    w.addEdge(x, s);
  }
  w.addEdge(t, x);
}

function applyDescription(w: Work, text: string) {
  const sentences = text.split(/(?<=[.!?;])\s+|\n+/).map(clean).filter(Boolean);
  for (const sentence of sentences) {
    const fronts: [string, string][] = [];
    let t = sentence;
    for (let guard = 0; guard < 4; guard++) {
      const m = t.match(FRONT_CLAUSE);
      if (!m) break;
      fronts.push([m[1], m[2]]);
      t = (t.slice(0, m.index) + t.slice((m.index ?? 0) + m[0].length)).trim();
    }

    let prev: string[] = [];
    let subject: string[] | null = null;
    const parts = t.split(CONNECTOR);
    for (let pi = 0; pi < parts.length; pi += 2) {
      let seg = (parts[pi] ?? '').trim();
      const conn = pi > 0 ? parts[pi - 1] ?? '' : '';
      // "the feed service reads from Redis and writes to Cassandra": "and <verb>" goes back to the subject.
      if (subject && /^\s*,?\s*and\b/i.test(conn)) prev = subject;
      if (!seg) continue;
      let eachOwn: string | null = null;
      const em = seg.match(EACH_OWN);
      if (em) {
        eachOwn = em[1];
        seg = seg.slice(0, em.index).trim();
      }

      const list = listComps(seg);
      const stages: { comps: Comp[]; phrases: string[] }[] = list
        ? [{ comps: list, phrases: list.map((c) => c.label) }]
        : seg
            .split(/\s*,\s*/)
            .map(stripPiece)
            .filter(Boolean)
            .map((piece) => {
              const parts = piece.split(/\s+(?:and|with|plus|alongside|&)\s+/i).map(stripPiece).filter(Boolean);
              const comps: Comp[] = [];
              const phrases: string[] = [];
              for (const part of parts) {
                const c = compOf(part);
                if (c) {
                  comps.push(c);
                  phrases.push(part);
                }
              }
              return { comps, phrases };
            })
            .filter((s) => s.comps.length);

      for (const stage of stages) {
        const ids: string[] = [];
        stage.comps.forEach((c, i) => ids.push(...w.ensure(c, stage.phrases[i])));
        for (const p of prev) for (const id of ids) w.addEdge(p, id);
        const multi = ids.length > 1;
        prev = ids.filter((id) => !(multi && w.node(id)?.type === 'cdn'));
        if (!subject) subject = prev;
      }
      if (eachOwn) attachEachOwn(w, prev, eachOwn);
    }

    for (const [c, target] of fronts) applyFront(w, c, target);
  }
}

function duplicate(w: Work, id: string, n: number) {
  const node = w.node(id);
  if (!node) return;
  const base = node.label.replace(/\s+\d+$/, '');
  const siblings = w.nodes.filter((x) => x.type === node.type && x.label.replace(/\s+\d+$/, '') === base);
  if (!/\s\d+$/.test(node.label) && siblings.length === 1) node.label = `${base} 1`;
  let idx = siblings.length + 1;
  for (let k = 0; k < n; k++, idx++) {
    const nid = w.addNode(`${base} ${idx}`, node.type);
    for (const p of w.preds(id)) w.addEdge(p, nid);
    for (const s of w.succs(id)) w.addEdge(nid, s);
  }
}

function defaultAttach(w: Work, x: string, type: NodeType) {
  const services = w.ofType('service').map((n) => n.id).filter((id) => id !== x);
  const clients = w.ofType('client').map((n) => n.id).filter((id) => id !== x);
  switch (type) {
    case 'client':
      w.entryHops().forEach((h) => w.addEdge(x, h));
      break;
    case 'cdn':
      clients.forEach((c) => w.addEdge(c, x));
      break;
    case 'loadbalancer': {
      const hops = w.entryHops().filter((h) => h !== x);
      if (clients.length) {
        for (const c of clients) {
          for (const s of w.succs(c)) {
            if (w.node(s)?.type === 'cdn' || s === x) continue;
            w.removeEdge(c, s);
            w.addEdge(x, s);
          }
          w.addEdge(c, x);
        }
      } else hops.forEach((h) => w.addEdge(x, h));
      break;
    }
    case 'gateway': {
      const lbs = w.ofType('loadbalancer').map((n) => n.id);
      if (lbs.length) lbs.forEach((lb) => insertAfter(w, x, lb));
      else defaultAttach(w, x, 'loadbalancer');
      break;
    }
    case 'service': {
      const front = [...w.ofType('gateway'), ...w.ofType('loadbalancer')].map((n) => n.id).filter((id) => id !== x);
      (front.length ? front.slice(0, 1) : clients).forEach((f) => w.addEdge(f, x));
      break;
    }
    case 'database':
      services.filter((s) => !w.succs(s).some((t) => w.node(t)?.type === 'database')).forEach((s) => w.addEdge(s, x));
      if (!w.preds(x).length) services.forEach((s) => w.addEdge(s, x));
      break;
    case 'cache': {
      const dbUsers = services.filter((s) => w.succs(s).some((t) => w.node(t)?.type === 'database'));
      (dbUsers.length ? dbUsers : services).forEach((s) => w.addEdge(s, x));
      break;
    }
    case 'queue': {
      const consumers = services.filter((s) => /email|notif|worker|sms|push|analytic|consumer/i.test(w.node(s)!.label));
      const producers = services.filter((s) => !consumers.includes(s));
      (producers.length ? producers : services).forEach((s) => w.addEdge(s, x));
      consumers.forEach((c) => {
        producers.forEach((p) => w.removeEdge(p, c));
        w.addEdge(x, c);
      });
      break;
    }
  }
}

function applyAdd(w: Work, compPhrase: string, prep?: string, targetPhrase?: string) {
  // "a second load balancer", "two more API servers", "a standby database"
  const dup = compPhrase.match(
    /^(?:a\s+|an\s+)?(second|third|another|one more|extra|an extra|standby|backup|redundant|(\w+)\s+more)\s+(.+)$/i,
  );
  if (dup) {
    const what = dup[3];
    const c = compOf(what);
    const n = dup[2] ? NUMBER_WORDS[dup[2].toLowerCase()] ?? (parseInt(dup[2], 10) || 1) : 1;
    const existing = w.resolve(what).filter((id) => !c || w.node(id)?.type === c.type);
    if (existing.length && c?.type === 'database' && !/replica/i.test(what)) {
      existing.slice(0, 1).forEach((t) => {
        const r = w.addNode(`${baseName(w.node(t)!.label)} Replica`, 'database');
        w.addEdge(t, r, 'replicates');
      });
      return;
    }
    if (existing.length) {
      duplicate(w, existing[existing.length - 1], n);
      return;
    }
  }

  const comp = compOf(compPhrase);
  if (!comp) return;

  if (comp.label === 'Read Replica' || (comp.type === 'database' && /replica|standby|failover/i.test(compPhrase))) {
    let targets = targetPhrase ? w.resolve(targetPhrase).filter((id) => w.node(id)?.type === 'database') : [];
    if (!targets.length) {
      targets = w
        .ofType('database')
        .filter((d) => !/replica/i.test(d.label) && !w.succs(d.id).some((s) => /replica/i.test(w.node(s)!.label)))
        .map((d) => d.id);
    }
    if (!targets.length) targets = [w.addNode('Database', 'database')];
    for (const t of targets) {
      const r = w.addNode(`${baseName(w.node(t)!.label.replace(/\s*\(.*\)$/, ''))} Replica`, 'database');
      w.addEdge(t, r, 'replicates');
    }
    return;
  }

  if (comp.label === 'Rate Limiter') {
    const targets = targetPhrase ? w.resolve(targetPhrase) : w.entryHops();
    const existing = w.nodes.find((n) => /rate limit/i.test(n.label));
    const rl = existing ? existing.id : w.addNode('Rate Limiter', 'gateway');
    if (!targets.length) {
      defaultAttach(w, rl, 'gateway');
      return;
    }
    for (const t of targets) {
      const tt = w.node(t)?.type;
      if (tt === 'loadbalancer' || tt === 'gateway' || tt === 'cdn' || tt === 'client') insertAfter(w, rl, t);
      else insertBefore(w, rl, t);
    }
    return;
  }

  if (targetPhrase) {
    let targets = w.resolve(targetPhrase);
    if (!targets.length) {
      const tc = compOf(targetPhrase);
      if (tc) targets = w.ensure(tc, targetPhrase);
    }
    const xs = comp.generic ? [w.create(comp)] : w.ensure(comp, compPhrase);
    for (const t of targets) {
      for (const x of xs) {
        const before = prep === 'before' || ['loadbalancer', 'gateway', 'cdn'].includes(comp.type);
        if (before) insertBefore(w, x, t);
        else w.addEdge(t, x);
      }
    }
    if (targets.length) return;
    xs.forEach((x) => defaultAttach(w, x, comp.type));
    return;
  }

  const before = new Set(w.nodes.map((n) => n.id));
  const xs = comp.generic ? [w.create(comp)] : w.ensure(comp, compPhrase);
  xs.filter((x) => !before.has(x)).forEach((x) => defaultAttach(w, x, comp.type));
}

/** Applies one spoken sentence to the design. Returns the new design (issues carried over). */
export function localDesign(design: Design, sentence: string): Design {
  const w = new Work(design);
  const s = clean(sentence).replace(LEAD_IN, '');
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^(?:rename|relabel)\s+(?:the\s+)?(.+?)\s+(?:to|as)\s+(.+)$/i))) {
    for (const id of w.resolve(m[1])) w.node(id)!.label = cap(clean(m[2]));
  } else if ((m = s.match(/^(?:remove|delete|drop|get rid of|kill|take out)\s+(?:the\s+)?(.+)$/i))) {
    for (const id of w.resolve(m[1])) {
      const t = w.node(id)?.type;
      if (t === 'loadbalancer' || t === 'gateway' || t === 'cdn' || t === 'queue') {
        for (const p of w.preds(id)) for (const x of w.succs(id)) w.addEdge(p, x);
      }
      w.removeNode(id);
    }
  } else if ((m = s.match(/^(?:add|put|insert|place|stick)\s+(.+?)\s+between\s+(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+)$/i))) {
    const comp = compOf(m[1]);
    const resolveOrMake = (p: string) => {
      const r = w.resolve(p);
      if (r.length) return r;
      const c = compOf(p);
      return c ? w.ensure(c, p) : [];
    };
    const a = resolveOrMake(m[2]);
    const b = resolveOrMake(m[3]);
    if (comp && a.length && b.length) {
      const xs = comp.generic ? [w.create(comp)] : w.ensure(comp, m[1]);
      for (const x of xs) {
        for (const from of a) for (const to of b) {
          w.removeEdge(from, to);
          w.addEdge(from, x);
          w.addEdge(x, to);
        }
      }
    }
  } else if ((m = s.match(/^(?:add|put|insert|place|stick)\s+(.+?)\s+in front of\s+(?:the\s+)?(.+)$/i))) {
    applyFront(w, m[1], m[2]);
  } else if ((m = s.match(/^(?:connect|link|wire(?:\s+up)?)\s+(?:the\s+)?(.+?)\s+(?:to|with|and)\s+(?:the\s+)?(.+)$/i))) {
    const a = w.resolve(m[1]);
    const b = w.resolve(m[2]);
    for (const from of a) for (const to of b) w.addEdge(from, to);
  } else if (
    (m = s.match(
      /^(?:add|include|introduce|use|throw in|stick|attach|scale(?:\s+out)?(?:\s+with)?)\s+(.+?)(?:\s+(to|for|on|after|behind|under|next to|before|from|at|in)\s+(?:the\s+)?(.+))?$/i,
    ))
  ) {
    applyAdd(w, m[1], m[2]?.toLowerCase(), m[3]);
  } else {
    applyDescription(w, s);
  }
  return w.design(design.issues);
}

// ---------- review ----------

const SLOW_WORK = /email|notif|sms|push|analytic|report|video|image|upload|transcod|encod|webhook|export/i;

export function localReview(design: Design): ReviewResult {
  const nodes = design.nodes;
  if (!nodes.length) return { issues: [], score: 0 };
  const issues: Issue[] = [];
  const node = (id: string) => nodes.find((n) => n.id === id)!;
  const preds = (id: string) => design.edges.filter((e) => e.to === id).map((e) => e.from);
  const succs = (id: string) => design.edges.filter((e) => e.from === id).map((e) => e.to);
  const of = (t: NodeType) => nodes.filter((n) => n.type === t);
  const add = (nodeId: string | null, severity: Issue['severity'], note: string) => {
    if (!issues.some((i) => i.nodeId === nodeId && i.note === note)) issues.push({ nodeId, severity, note });
  };

  // Clients reaching storage directly
  for (const c of of('client')) {
    for (const s of succs(c.id)) {
      if (['database', 'cache', 'queue'].includes(node(s).type)) add(s, 'high', 'Clients hit storage directly. Put a service in between.');
    }
  }

  // Load balancer redundancy
  const lbs = of('loadbalancer');
  if (lbs.length === 1) add(lbs[0].id, 'high', 'Single load balancer is a SPOF. Add a standby.');

  // Only one server behind the entry point
  const services = of('service').filter((s) => !/rate limit/i.test(s.label));
  for (const lb of lbs) {
    const behind = succs(lb.id).filter((s) => node(s).type === 'service');
    if (behind.length === 1 && !/s$|×/.test(node(behind[0]).label)) {
      add(behind[0], 'medium', 'One instance behind the LB. Scale out horizontally.');
    }
  }
  if (!lbs.length && services.length) {
    const direct = of('client').flatMap((c) => succs(c.id)).filter((s) => node(s).type === 'service');
    if (direct.length) add(direct[0], 'medium', 'No load balancer. One server takes all traffic.');
  }

  // Database replicas
  const dbs = of('database');
  const isReplica = (n: DesignNode) => /replica|standby|follower|secondary/i.test(n.label);
  const primaries = dbs.filter((d) => !isReplica(d));
  for (const d of primaries) {
    const hasReplica = succs(d.id).some((s) => isReplica(node(s)));
    if (!hasReplica) add(d.id, primaries.length === 1 ? 'high' : 'medium', 'No replica. One DB failure takes this down.');
  }

  // Cache
  if (primaries.length && !of('cache').length) {
    const busiest = [...primaries].sort((a, b) => preds(b.id).length - preds(a.id).length)[0];
    add(busiest.id, 'medium', 'Every read hits the DB. Add a Redis cache.');
  }

  // Rate limiting
  const hasLimiter = nodes.some((n) => /rate[\s-]?limit/i.test(n.label));
  if (!hasLimiter && nodes.length >= 3) {
    const edge = of('gateway')[0] ?? lbs[0] ?? services[0];
    if (edge) add(edge.id, 'medium', 'No rate limiting. One client can flood the API.');
  }

  // Synchronous slow work
  const hasQueue = of('queue').length > 0;
  for (const s of services) {
    if (!SLOW_WORK.test(s.label)) continue;
    const callers = preds(s.id).filter((p) => node(p).type === 'service' || node(p).type === 'gateway');
    if (callers.length) add(s.id, 'medium', 'Slow work called synchronously. Put a queue in front.');
  }
  if (!hasQueue) {
    for (const s of services) {
      const calls = succs(s.id).filter((t) => node(t).type === 'service').length;
      if (calls >= 3) add(s.id, 'low', `Calls ${calls} services in a row. Consider async events.`);
    }
  }

  // Shared database between services
  for (const d of primaries) {
    const users = preds(d.id).filter((p) => node(p).type === 'service');
    const distinct = new Set(users.map((u) => node(u).label.replace(/\s+\d+$/, '')));
    if (distinct.size >= 3) add(d.id, 'low', 'Several services share one DB. Coupling risk.');
  }

  // Queue with no consumer
  for (const q of of('queue')) if (!succs(q.id).length) add(q.id, 'low', 'Nothing consumes this queue. Add a worker.');

  // Disconnected nodes
  if (nodes.length > 1) {
    for (const n of nodes) if (!preds(n.id).length && !succs(n.id).length) add(n.id, 'low', 'Not connected to anything.');
  }

  // No storage at all
  if (!dbs.length && nodes.length >= 3) add(null, 'medium', 'No database. Where does data live?');

  const order = { high: 0, medium: 1, low: 2 };
  const top = issues.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 8);
  return { issues: top, score: scoreFor(top, nodes.length) };
}
