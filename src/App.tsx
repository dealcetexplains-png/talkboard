import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EMPTY_DESIGN, TYPE_NAMES, type Design, type Engine, type Issue, type NodeType } from './types';
import { classify, type Command } from './lib/commands';
import { requestDesign, requestReview, type EngineMode } from './lib/api';
import { toMermaid, safeId, type Direction } from './lib/toMermaid';
import { carryIssues } from './lib/schema';
import { renderMermaid, exportPng } from './lib/diagram';
import { INTERVIEW_SECONDS, clock, pickPrompt, verdict, type InterviewPrompt } from './lib/interview';

// ---------- state ----------

type Kind = Command['kind'];

interface HistoryItem {
  id: number;
  text: string;
  kind: Kind;
  status: 'pending' | 'done' | 'error';
  engine?: Engine;
  note?: string;
}

interface ReviewState {
  score: number;
  prevScore: number | null;
  issues: Issue[];
  engine: Engine;
  stale: boolean;
}

interface InterviewState {
  prompt: InterviewPrompt;
  startedAt: number;
  endsAt: number;
  sentences: number;
}

interface Scorecard {
  prompt: InterviewPrompt;
  score: number;
  issues: Issue[];
  components: number;
  sentences: number;
  seconds: number;
}

interface AppState {
  design: Design;
  past: Design[];
  history: HistoryItem[];
  review: ReviewState | null;
  newIds: string[];
  interview: InterviewState | null;
  scorecard: Scorecard | null;
  notice: string | null;
}

const INITIAL: AppState = {
  design: EMPTY_DESIGN,
  past: [],
  history: [],
  review: null,
  newIds: [],
  interview: null,
  scorecard: null,
  notice: null,
};

const KIND_LABEL: Record<Kind, string> = {
  edit: 'Edit',
  review: 'Review',
  undo: 'Undo',
  reset: 'Start over',
  'interview-start': 'Interview',
  'interview-end': 'Interview',
  export: 'Export',
};

const DICTIONARY = ['Kafka', 'Redis', 'Postgres', 'Kubernetes', 'load balancer', 'CDN', 'sharding', 'rate limiter'];

const SNIPPETS = [
  {
    say: 'microservices starter',
    types:
      'Users hit a CDN and a load balancer, which routes to an API gateway, then auth, orders and payments services, each with its own Postgres database, and a Redis cache in front of orders.',
  },
  { say: 'grill me', types: 'review my design' },
];

const TRY_SAYING = [
  'Users hit a load balancer, three API servers, Postgres with a Redis cache.',
  'Add a queue between the API and the email service.',
  'Add a second load balancer.',
  'Add a read replica to Postgres.',
  'Add rate limiting to the load balancer.',
];

const LEGEND: NodeType[] = ['client', 'cdn', 'loadbalancer', 'gateway', 'service', 'database', 'cache', 'queue'];

function diffNote(before: Design, after: Design): string {
  const bn = new Set(before.nodes.map((n) => n.id));
  const an = new Set(after.nodes.map((n) => n.id));
  const key = (e: { from: string; to: string }) => `${e.from}>${e.to}`;
  const be = new Set(before.edges.map(key));
  const ae = new Set(after.edges.map(key));
  const addedN = [...an].filter((x) => !bn.has(x)).length;
  const removedN = [...bn].filter((x) => !an.has(x)).length;
  const addedE = [...ae].filter((x) => !be.has(x)).length;
  const removedE = [...be].filter((x) => !ae.has(x)).length;
  const renamed = after.nodes.filter((n) => before.nodes.some((b) => b.id === n.id && b.label !== n.label)).length;
  const parts: string[] = [];
  if (addedN) parts.push(`+${addedN} component${addedN > 1 ? 's' : ''}`);
  if (removedN) parts.push(`−${removedN} component${removedN > 1 ? 's' : ''}`);
  if (addedE) parts.push(`+${addedE} link${addedE > 1 ? 's' : ''}`);
  if (removedE) parts.push(`−${removedE} link${removedE > 1 ? 's' : ''}`);
  if (renamed) parts.push(`${renamed} renamed`);
  return parts.join(', ');
}

function sameShape(a: Design, b: Design): boolean {
  return JSON.stringify([a.nodes, a.edges]) === JSON.stringify([b.nodes, b.edges]);
}

// ---------- app ----------

export default function App() {
  const [state, setState] = useState<AppState>(INITIAL);
  const ref = useRef<AppState>(INITIAL);
  const update = useCallback((fn: (s: AppState) => AppState) => {
    ref.current = fn(ref.current);
    setState(ref.current);
  }, []);

  const [text, setText] = useState('');
  const [mode, setMode] = useState<EngineMode>('auto');
  const modeRef = useRef<EngineMode>('auto');
  modeRef.current = mode;
  const [direction, setDirection] = useState<Direction>('LR');
  const [showIntro, setShowIntro] = useState(true);
  const [showTips, setShowTips] = useState(true);
  const [busy, setBusy] = useState(0);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const nextId = useRef(1);
  const finishing = useRef(false);

  const patchItem = useCallback(
    (id: number, patch: Partial<HistoryItem>) =>
      update((s) => ({ ...s, history: s.history.map((h) => (h.id === id ? { ...h, ...patch } : h)) })),
    [update],
  );

  const lastReason = useRef('');
  const notify = useCallback(
    (reason: string | undefined) => {
      // Say it once per distinct reason; the history tags ("Rules") show it per sentence after that.
      if (!reason || reason === lastReason.current) return;
      lastReason.current = reason;
      update((s) => ({ ...s, notice: `Gemini unavailable: ${reason.replace(/[.\s]+$/, "")}. Used the built-in rules instead.` }));
    },
    [update],
  );

  // ----- actions -----

  const runReview = useCallback(
    async (itemId: number | null, question: string | null) => {
      const s = ref.current;
      if (!s.design.nodes.length) {
        if (itemId) patchItem(itemId, { status: 'done', note: 'The board is empty. Describe a system first.' });
        return null;
      }
      const r = await requestReview(s.design, s.review?.issues ?? [], question, modeRef.current);
      notify(r.fallbackReason);
      update((st) => ({
        ...st,
        design: { ...st.design, issues: r.value.issues },
        review: {
          score: r.value.score,
          prevScore: st.review ? st.review.score : null,
          issues: r.value.issues,
          engine: r.engine,
          stale: false,
        },
      }));
      if (itemId) {
        const n = r.value.issues.length;
        patchItem(itemId, {
          status: 'done',
          engine: r.engine,
          note: `Score ${r.value.score}/100, ${n ? `${n} issue${n > 1 ? 's' : ''}` : 'no issues'}`,
        });
      }
      return r.value;
    },
    [notify, patchItem, update],
  );

  const finishInterview = useCallback(
    async (itemId: number | null) => {
      const iv = ref.current.interview;
      if (!iv || finishing.current) {
        if (itemId) patchItem(itemId, { status: 'done', note: 'No interview is running.' });
        return;
      }
      finishing.current = true;
      try {
        const result = await runReview(null, `${iv.prompt.title}. ${iv.prompt.brief}`);
        const s = ref.current;
        update((st) => ({
          ...st,
          interview: null,
          scorecard: {
            prompt: iv.prompt,
            score: result?.score ?? 0,
            issues: result?.issues ?? [],
            components: s.design.nodes.length,
            sentences: iv.sentences,
            seconds: Math.min(INTERVIEW_SECONDS, Math.round((Date.now() - iv.startedAt) / 1000)),
          },
        }));
        if (itemId) patchItem(itemId, { status: 'done', note: `Final score ${result?.score ?? 0}/100` });
      } finally {
        finishing.current = false;
      }
    },
    [patchItem, runReview, update],
  );

  const handle = useCallback(
    async (itemId: number, raw: string) => {
      const cmd = classify(raw);
      patchItem(itemId, { kind: cmd.kind });
      try {
        switch (cmd.kind) {
          case 'undo': {
            const s = ref.current;
            if (!s.past.length) {
              patchItem(itemId, { status: 'done', note: 'Nothing to undo.' });
              return;
            }
            const prev = s.past[s.past.length - 1];
            update((st) => ({
              ...st,
              // Keep the latest review's marks (where the node still exists), not the snapshot's old ones.
              design: { ...prev, issues: carryIssues(st.design.issues, prev.nodes) },
              past: st.past.slice(0, -1),
              newIds: [],
              review: st.review ? { ...st.review, stale: true } : null,
            }));
            patchItem(itemId, { status: 'done', note: 'Reverted the last change.' });
            return;
          }
          case 'reset': {
            update((st) => ({
              ...st,
              past: st.design.nodes.length ? [...st.past, st.design].slice(-50) : st.past,
              design: EMPTY_DESIGN,
              review: null,
              newIds: [],
            }));
            patchItem(itemId, { status: 'done', note: 'Board cleared. Say "undo" to bring it back.' });
            return;
          }
          case 'review': {
            const iv = ref.current.interview;
            await runReview(itemId, iv ? `${iv.prompt.title}. ${iv.prompt.brief}` : null);
            return;
          }
          case 'interview-start': {
            const prompt = pickPrompt(ref.current.interview?.prompt.title);
            const t = Date.now();
            update((st) => ({
              ...st,
              past: st.design.nodes.length ? [...st.past, st.design].slice(-50) : st.past,
              design: EMPTY_DESIGN,
              review: null,
              newIds: [],
              scorecard: null,
              interview: { prompt, startedAt: t, endsAt: t + INTERVIEW_SECONDS * 1000, sentences: 0 },
            }));
            patchItem(itemId, { status: 'done', note: `${prompt.title}. 10 minutes on the clock.` });
            return;
          }
          case 'interview-end':
            await finishInterview(itemId);
            return;
          case 'export': {
            const svg = boardRef.current?.querySelector('svg');
            if (!svg) {
              patchItem(itemId, { status: 'done', note: 'Nothing to export yet.' });
              return;
            }
            await exportPng(svg as SVGSVGElement);
            patchItem(itemId, { status: 'done', note: 'Saved talkboard-diagram.png' });
            return;
          }
          case 'edit': {
            const before = ref.current.design;
            const r = await requestDesign(before, cmd.text, modeRef.current);
            notify(r.fallbackReason);
            if (sameShape(before, r.value)) {
              patchItem(itemId, {
                status: 'done',
                engine: r.engine,
                note: 'No change. Name a component, like "add a Redis cache".',
              });
              return;
            }
            const beforeIds = new Set(before.nodes.map((n) => n.id));
            update((st) => ({
              ...st,
              past: [...st.past, before].slice(-50),
              design: r.value,
              newIds: r.value.nodes.filter((n) => !beforeIds.has(n.id)).map((n) => n.id),
              review: st.review ? { ...st.review, stale: true } : null,
              interview: st.interview ? { ...st.interview, sentences: st.interview.sentences + 1 } : null,
            }));
            patchItem(itemId, { status: 'done', engine: r.engine, note: diffNote(before, r.value) });
            return;
          }
        }
      } catch (e) {
        patchItem(itemId, { status: 'error', note: (e as Error).message });
      }
    },
    [finishInterview, notify, patchItem, runReview, update],
  );

  const submit = useCallback(
    (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      const id = nextId.current++;
      const item: HistoryItem = { id, text: value, kind: classify(value).kind, status: 'pending' };
      update((s) => ({ ...s, history: [item, ...s.history].slice(0, 200) }));
      setBusy((b) => b + 1);
      queue.current = queue.current.then(() => handle(id, value)).finally(() => setBusy((b) => b - 1));
    },
    [handle, update],
  );

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(text);
      setText('');
    }
  };

  // Interview clock
  useEffect(() => {
    if (!state.interview) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [state.interview]);

  useEffect(() => {
    if (state.interview && now >= state.interview.endsAt && !finishing.current) {
      queue.current = queue.current.then(() => finishInterview(null));
    }
  }, [now, state.interview, finishInterview]);

  useEffect(() => {
    if (!state.notice) return;
    const t = setTimeout(() => update((s) => ({ ...s, notice: null })), 7000);
    return () => clearTimeout(t);
  }, [state.notice, update]);

  // ----- derived -----

  const { design, review, interview, scorecard, history } = state;
  const labelOf = (id: string | null) => (id ? design.nodes.find((n) => n.id === id)?.label ?? id : 'Whole design');
  const lastEngine = history.find((h) => h.engine)?.engine ?? null;
  const delta = review && review.prevScore !== null ? review.score - review.prevScore : null;
  const remaining = interview ? (interview.endsAt - now) / 1000 : 0;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand-row">
          <div className="brand">
            <span className="logo" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="30" height="30">
                <rect width="32" height="32" rx="7" fill="currentColor" />
                <rect x="6" y="9" width="8" height="6" rx="1.5" fill="none" stroke="#F7F8F6" strokeWidth="2" />
                <rect x="18" y="17" width="8" height="6" rx="1.5" fill="none" stroke="#F7F8F6" strokeWidth="2" />
                <path d="M14 12h4v8" fill="none" stroke="#F7F8F6" strokeWidth="2" />
                <circle cx="25" cy="8" r="3" fill="#D7263D" />
              </svg>
            </span>
            <span className="brand-name">Talkboard</span>
          </div>
          <nav className="toolbar" aria-label="Board controls">
            <label className="engine">
              <span className="sr-only">Engine</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as EngineMode)}>
                <option value="auto">Gemini, rules as backup</option>
                <option value="local">Built-in rules only</option>
              </select>
            </label>
            <button
              className="btn ghost"
              onClick={() => setDirection((d) => (d === 'LR' ? 'TD' : 'LR'))}
              title="Switch diagram direction"
            >
              {direction === 'LR' ? 'Left to right' : 'Top to bottom'}
            </button>
            <button className="btn ghost" onClick={() => submit('export diagram')} disabled={!design.nodes.length}>
              Export PNG
            </button>
            <button
              className={`btn ${interview ? 'danger' : 'solid'}`}
              onClick={() => submit(interview ? 'end interview' : 'start interview')}
            >
              {interview ? 'End interview' : 'Start interview'}
            </button>
          </nav>
        </div>

        {showIntro && (
          <section className="intro" aria-label="What Talkboard does">
            <h1>Say your architecture out loud. Watch it draw itself. Then get grilled on it.</h1>
            <ol className="steps">
              <li>
                <strong>Speak.</strong> Hold your Wispr Flow hotkey and describe the system, like you would to an
                interviewer.
              </li>
              <li>
                <strong>Watch.</strong> Each sentence edits the diagram. Say “undo” or “start over” any time.
              </li>
              <li>
                <strong>Get reviewed.</strong> Say “review my design”. Weak spots get marked in red with a note and a
                score. Fix them by voice and review again.
              </li>
            </ol>
            <button className="link" onClick={() => setShowIntro(false)}>
              Hide intro
            </button>
          </section>
        )}
      </header>

      {interview && (
        <div className={`interview-bar ${remaining < 60 ? 'urgent' : ''}`} role="status">
          <div>
            <strong>{interview.prompt.title}</strong>
            <span className="brief">{interview.prompt.brief}</span>
          </div>
          <span className="clock" aria-label="Time left">
            {clock(remaining)}
          </span>
        </div>
      )}

      {state.notice && (
        <div className="notice" role="status">
          {state.notice}
          <button className="link" onClick={() => update((s) => ({ ...s, notice: null }))}>
            Dismiss
          </button>
        </div>
      )}

      <main className="workspace">
        <section className="left" aria-label="Your words">
          <div className="composer">
            <label htmlFor="speech" className="composer-label">
              Describe your system, hold your Wispr Flow hotkey and speak
            </label>
            <textarea
              id="speech"
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Users hit a load balancer, three API servers, Postgres with a Redis cache."
              rows={5}
              autoFocus
            />
            <div className="composer-foot">
              <span className="hint">
                Enter adds it to the board. Shift+Enter for a new line.
                {busy > 0 && <span className="working"> Drawing…</span>}
              </span>
              <button
                className="btn solid"
                onClick={() => {
                  submit(text);
                  setText('');
                  inputRef.current?.focus();
                }}
                disabled={!text.trim()}
              >
                Add to board
              </button>
            </div>
          </div>

          <div className="history">
            <h2>What you said</h2>
            {history.length === 0 ? (
              <p className="empty-note">Nothing yet. Your sentences show up here, newest first.</p>
            ) : (
              <ol>
                {history.map((h) => (
                  <li key={h.id} className={`h-item ${h.status}`}>
                    <p className="h-text">{h.text}</p>
                    <p className="h-meta">
                      <span className={`chip k-${h.kind}`}>{KIND_LABEL[h.kind]}</span>
                      {h.status === 'pending' && <span className="pending">working</span>}
                      {h.engine && (
                        <span className="engine-tag" title={h.engine === 'gemini' ? 'Answered by Gemini' : 'Answered by built-in rules'}>
                          {h.engine === 'gemini' ? 'Gemini' : 'Rules'}
                        </span>
                      )}
                      {h.note && <span className="h-note">{h.note}</span>}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="tips">
            <button className="tips-toggle" onClick={() => setShowTips((v) => !v)} aria-expanded={showTips}>
              Wispr Flow setup and voice commands
              <span aria-hidden="true">{showTips ? '−' : '+'}</span>
            </button>
            {showTips && (
              <div className="tips-body">
                <h3>Add these to your Wispr Dictionary</h3>
                <p className="small">Normal dictation mangles them. With the Dictionary they come out right every time.</p>
                <ul className="terms">
                  {DICTIONARY.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <h3>Create these Wispr Snippets</h3>
                <dl className="snippets">
                  {SNIPPETS.map((s) => (
                    <div key={s.say}>
                      <dt>Say “{s.say}”</dt>
                      <dd>{s.types}</dd>
                    </div>
                  ))}
                </dl>
                <h3>Voice commands</h3>
                <p className="small">
                  “undo”, “start over”, “review my design”, “start interview”, “end interview”, “export diagram”.
                </p>
                <h3>Try saying</h3>
                <ul className="try">
                  {TRY_SAYING.map((t) => (
                    <li key={t}>
                      <button
                        className="try-btn"
                        onClick={() => {
                          setText(t);
                          inputRef.current?.focus();
                        }}
                      >
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className="right" aria-label="Diagram and review">
          <div className="board-wrap">
            <Board design={design} newIds={state.newIds} direction={direction} focus={focusNode} hostRef={boardRef} />

            {review && (
              <div className={`grade ${review.stale ? 'stale' : ''}`} aria-live="polite">
                <span className="grade-num">{review.score}</span>
                <span className="grade-of">/100</span>
                {delta !== null && delta !== 0 && !review.stale && (
                  <span className={`grade-delta ${delta > 0 ? 'up' : 'down'}`}>
                    {delta > 0 ? `+${delta}` : delta}
                  </span>
                )}
              </div>
            )}

            <div className="board-meta">
              {lastEngine && <span className="engine-now">Last answer: {lastEngine === 'gemini' ? 'Gemini' : 'built-in rules'}</span>}
              <ul className="legend" aria-label="Shape legend">
                {LEGEND.filter((t) => design.nodes.some((n) => n.type === t)).map((t) => (
                  <li key={t} className={`lg lg-${t}`}>
                    {TYPE_NAMES[t]}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="review" aria-label="Review notes">
            <div className="review-head">
              <h2>Review</h2>
              {review && (
                <span className="review-engine">
                  {review.engine === 'gemini' ? 'by Gemini' : 'by built-in rules'}
                </span>
              )}
            </div>
            {!review && (
              <p className="empty-note">
                When you’re ready, say “review my design” (or your “grill me” snippet). Problems get circled in red here and
                on the diagram.
              </p>
            )}
            {review?.stale && (
              <p className="stale-note">The design changed since this review. Say “review my design” to re-score it.</p>
            )}
            {review && review.issues.length === 0 && (
              <p className="clean-note">No weak spots found. Try interview mode for a harder question.</p>
            )}
            {review && review.issues.length > 0 && (
              <ol className="issues">
                {review.issues.map((i, idx) => (
                  <li
                    key={`${i.nodeId}-${idx}`}
                    className={`issue sev-${i.severity}`}
                    onMouseEnter={() => setFocusNode(i.nodeId)}
                    onMouseLeave={() => setFocusNode(null)}
                    onFocus={() => setFocusNode(i.nodeId)}
                    onBlur={() => setFocusNode(null)}
                    tabIndex={0}
                  >
                    <span className="sev">{i.severity === 'high' ? 'High' : i.severity === 'medium' ? 'Medium' : 'Low'}</span>
                    <span className="issue-node">{labelOf(i.nodeId)}</span>
                    <span className="issue-note">{i.note}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </main>

      {scorecard && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="scorecard-title">
          <div className="modal">
            <p className="modal-kicker">Time’s up</p>
            <h2 id="scorecard-title">{scorecard.prompt.title}</h2>
            <div className="final">
              <span className="grade-num big">{scorecard.score}</span>
              <span className="grade-of">/100</span>
              <span className="verdict">{verdict(scorecard.score)}</span>
            </div>
            <dl className="stats">
              <div>
                <dt>Components</dt>
                <dd>{scorecard.components}</dd>
              </div>
              <div>
                <dt>Sentences spoken</dt>
                <dd>{scorecard.sentences}</dd>
              </div>
              <div>
                <dt>Time used</dt>
                <dd>{clock(scorecard.seconds)}</dd>
              </div>
              <div>
                <dt>Issues left</dt>
                <dd>{scorecard.issues.length}</dd>
              </div>
            </dl>
            {scorecard.issues.length > 0 && (
              <ul className="issues compact">
                {scorecard.issues.map((i, idx) => (
                  <li key={idx} className={`issue sev-${i.severity}`}>
                    <span className="sev">{i.severity}</span>
                    <span className="issue-note">{i.note}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => update((s) => ({ ...s, scorecard: null }))}>
                Keep the diagram
              </button>
              <button
                className="btn solid"
                onClick={() => {
                  update((s) => ({ ...s, scorecard: null }));
                  submit('start interview');
                }}
              >
                Try another question
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- board ----------

function Board({
  design,
  newIds,
  direction,
  focus,
  hostRef,
}: {
  design: Design;
  newIds: string[];
  direction: Direction;
  focus: string | null;
  hostRef: React.RefObject<HTMLDivElement>;
}) {
  const [error, setError] = useState<string | null>(null);
  const code = useMemo(
    () => toMermaid(design, { direction, newIds: new Set(newIds) }),
    [design, direction, newIds],
  );
  const empty = design.nodes.length === 0;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (empty) {
      host.innerHTML = '';
      setError(null);
      return;
    }
    let live = true;
    renderMermaid(code)
      .then((svg) => {
        if (!live || !hostRef.current) return;
        hostRef.current.innerHTML = svg;
        // Let small diagrams grow a little, but never balloon: cap at 1.4x Mermaid's natural width.
        const el = hostRef.current.querySelector('svg');
        const natural = el ? parseFloat(el.style.maxWidth) || el.viewBox.baseVal.width : 0;
        if (el && natural) {
          el.style.maxWidth = `${Math.round(natural * 1.4)}px`;
          el.style.width = '100%';
        }
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [code, empty, hostRef]);

  // Hovering an issue lights up its node on the diagram.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.querySelectorAll('g.node.tb-focus').forEach((el) => el.classList.remove('tb-focus'));
    if (!focus) return;
    const sid = safeId(focus);
    host.querySelectorAll<SVGGElement>('g.node').forEach((el) => {
      if (el.id.includes(`-${sid}-`) || el.getAttribute('data-id') === sid) el.classList.add('tb-focus');
    });
  }, [focus, hostRef, code]);

  return (
    <div className="board">
      <div ref={hostRef} className="diagram" aria-label="Architecture diagram" role="img" />
      {empty && (
        <div className="board-empty">
          <p className="board-empty-title">Your diagram draws itself here.</p>
          <p>Start with who uses the system and where their requests go.</p>
        </div>
      )}
      {error && <p className="board-error">Couldn’t draw that: {error}. Say “undo” and try rephrasing.</p>}
    </div>
  );
}
