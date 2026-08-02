import { useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import type { BoardConfig } from '../api.ts';
import { AgentPicker } from './AgentPicker.tsx';
import { PlanEditor } from './PlanEditor.tsx';
import type { AgentSelection } from './AgentPicker.tsx';
import { AgentChip, IconPlay } from './bits.tsx';
import type { Phase, TaskWithDerived } from '../../shared/types.ts';

const EMPTY: AgentSelection = { agent: '', model: '', effort: '' };

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface Props {
  task: TaskWithDerived;
  config: BoardConfig;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Everything about one task, and every action on it.
 *
 * Actions are not disabled merely because a phase is not the current one — the
 * human is the manager and may re-run any step. What is disabled is what
 * genuinely cannot work.
 */
export function Drawer({ task, config, onClose, onChanged }: Props) {
  const [instructions, setInstructions] = useState('');
  const [plan, setPlan] = useState<string | null>(null);
  const [usage, setUsage] = useState<import('../api.ts').MissionUsage | null>(null);
  const [editingPlan, setEditingPlan] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // per-task pin
  const [pin, setPin] = useState<AgentSelection>(EMPTY);

  // one-time override for the next spawn
  const [onceOpen, setOnceOpen] = useState(false);
  const [once, setOnce] = useState<AgentSelection>(EMPTY);

  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, [task.issue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setPlan(null);
    setInstructions('');
    setPin({
      agent: task.overrides?.agent ?? '',
      model: task.overrides?.model ?? '',
      effort: task.overrides?.effort ?? '',
    });
    setOnceOpen(false);
    setOnce(EMPTY);
    setEditingPlan(false);
    api
      .plan(task.issue)
      .then((r) => setPlan(r.content))
      .catch(() => setPlan(null));
    setUsage(null);
    api
      .usage(task.issue)
      .then(setUsage)
      .catch(() => setUsage(null));
    // Reset only when switching to a different task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.issue]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function spawn(phase: Phase) {
    return run(phase, () =>
      api.spawn(task.issue, phase, {
        customInstructions: instructions.trim() || undefined,
        agent: onceOpen ? once.agent || undefined : undefined,
        model: onceOpen ? once.model || undefined : undefined,
        effort: onceOpen ? once.effort || undefined : undefined,
      }),
    );
  }

  const spawnable = config.pipeline.filter((p) => p.spawnable && p.command);
  const issueUrl = `https://github.com/${config.repo.owner}/${config.repo.name}/issues/${task.issue}`;
  const pinDirty =
    pin.agent !== (task.overrides?.agent ?? '') ||
    pin.model !== (task.overrides?.model ?? '') ||
    pin.effort !== (task.overrides?.effort ?? '');

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close details" />
      <aside className="drawer" role="dialog" aria-label={`Issue ${task.issue}`}>
        <header className="drawer-head">
          <div className="drawer-eyebrow">
            <span>#{task.issue}</span>
            <a className="link" href={issueUrl} target="_blank" rel="noreferrer">
              issue
            </a>
            {task.prUrl && (
              <a className="link" href={task.prUrl} target="_blank" rel="noreferrer">
                PR #{task.prNumber}
              </a>
            )}
            <span style={{ marginLeft: 'auto' }}>
              <button ref={closeRef} className="btn is-sm is-ghost" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <h2 className="drawer-title">{task.title}</h2>
          <div className="drawer-branch">{task.branch}</div>
        </header>

        {error && (
          <div className="section">
            <p className="error">{error}</p>
          </div>
        )}

        <section className="section">
          <div className="section-label">Status</div>
          <div className="badges">
            {task.pinned.agent && (
              <AgentChip
                agent={task.pinned.agent}
                model={task.pinned.model}
                effort={task.pinned.effort}
              />
            )}
            {task.derived.badges.length === 0 && !task.pinned.agent ? (
              <span className="badge">not started</span>
            ) : (
              task.derived.badges.map((b) => (
                <span key={`${b.kind}-${b.label}`} className={`badge tone-${b.tone}`}>
                  {b.label}
                </span>
              ))
            )}
          </div>
          {task.derived.needsYouReason && (
            <p className="card-status status-attention" style={{ marginTop: 11, marginBottom: 0 }}>
              {task.derived.needsYouReason}
            </p>
          )}
        </section>

        <section className="section">
          <div className="section-label">Run a phase</div>
          <div className="stack">
            <textarea
              className="field textarea"
              placeholder="Extra instructions for this run (optional)"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <div className="actions">
              {spawnable.map((phase) => (
                <button
                  key={phase.id}
                  className={`btn is-sm${
                    phase.id === task.derived.derivedPhase ? ' is-primary' : ''
                  }`}
                  disabled={busy !== null}
                  onClick={() => spawn(phase.id)}
                >
                  <IconPlay /> {busy === phase.id ? 'Opening…' : phase.label}
                </button>
              ))}
            </div>

            {!onceOpen ? (
              <button className="disclose" onClick={() => setOnceOpen(true)}>
                Run once with a different agent…
              </button>
            ) : (
              <div className="stack">
                <AgentPicker
                  agents={config.agents}
                  value={once}
                  onChange={setOnce}
                  inheritedAgent={task.pinned.agent}
                  inheritAgentLabel="Use pinned agent"
                />
                <p className="hint">
                  Applies to the next phase you launch only. Nothing is saved.
                </p>
              </div>
            )}

            <p className="hint">
              Opens a Windows Terminal tab and hands the session over. The tab keeps
              running if you close Mission Control.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="section-label">Pinned agent, model &amp; effort</div>
          <div className="stack">
            <AgentPicker
              agents={config.agents}
              value={pin}
              onChange={setPin}
              inheritedAgent={task.pinned.agent}
              inheritAgentLabel="Use phase default"
            />
            <div className="actions">
              <button
                className="btn is-sm"
                disabled={busy !== null || !pinDirty}
                onClick={() =>
                  run('pin', () =>
                    api.overrides(task.issue, {
                      agent: pin.agent || undefined,
                      model: pin.model || undefined,
                      effort: pin.effort || undefined,
                    }),
                  )
                }
              >
                {busy === 'pin' ? 'Saving…' : 'Save pin'}
              </button>
            </div>
            <p className="hint">
              Applies to every run of this task, unless overridden for a single run above.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="section-label">Mark progress</div>
          <div className="actions">
            {config.pipeline
              .filter((p) => p.gate.type === 'manual' && p.id !== 'merge')
              .map((phase) => {
                const done = task.derived.gates[phase.id];
                return (
                  <button
                    key={phase.id}
                    className="btn is-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`mark-${phase.id}`, () =>
                        done
                          ? api.unmarkDone(task.issue, phase.id)
                          : api.markDone(task.issue, phase.id),
                      )
                    }
                  >
                    {done ? `Undo ${phase.label}` : `${phase.label} done`}
                  </button>
                );
              })}
          </div>
        </section>

        <section className="section">
          <div className="section-label">Placement</div>
          <select
            className="field"
            style={{ width: '100%' }}
            value={task.manualPhase ?? ''}
            onChange={(e) =>
              run('move', () => api.move(task.issue, (e.target.value || null) as Phase | null))
            }
          >
            <option value="">Follow real status</option>
            {['inbox', ...config.pipeline.map((p) => p.id), 'done'].map((id) => (
              <option key={id} value={id}>
                Pin to {id}
              </option>
            ))}
          </select>
          {task.manualPhase && (
            <p className="hint">
              Pinned to {task.manualPhase}; badges still show real status (derived:{' '}
              {task.derived.derivedPhase}).
            </p>
          )}
        </section>

        <section className="section">
          <div className="section-label">
            Plan
            <button
              className="disclose"
              style={{ marginLeft: 8 }}
              onClick={() => setEditingPlan(true)}
            >
              {plan ? 'Expand / edit' : 'Write a plan'}
            </button>
          </div>
          {plan ? (
            <pre className="plan">{plan}</pre>
          ) : (
            <p className="note">
              No plan attached. Run Plan to have an agent write one, or write one yourself.
            </p>
          )}
        </section>

        {task.derived.artifacts.length > 0 && (
          <section className="section">
            <div className="section-label">Artifacts</div>
            <div className="stack">
              {task.derived.artifacts.map((a) => (
                <div
                  key={a.name}
                  className="actions"
                  style={{ justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span>
                    {a.name}
                    {a.origin === 'repo' && (
                      <span className="badge tone-warn" style={{ marginLeft: 8 }}>
                        in checkout
                      </span>
                    )}
                  </span>
                  <button
                    className="btn is-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`artifact-${a.name}`, () => api.openArtifact(task.issue, a.name))
                    }
                  >
                    {busy === `artifact-${a.name}` ? 'Opening…' : 'Open'}
                  </button>
                </div>
              ))}
            </div>
            <p className="hint">
              Collected from the plan run. Files marked “in checkout” were written into the
              repo; they were copied here, not moved.
            </p>
          </section>
        )}

        <section className="section">
          <div className="section-label">Sessions &amp; usage</div>
          {usage && usage.tracked ? (
            <>
              <div className="usage-total">
                <strong>{fmtTokens(usage.total.total)}</strong> tokens
                <span className="usage-breakdown">
                  {' '}· in {fmtTokens(usage.total.input)} · out {fmtTokens(usage.total.output)} ·
                  cache {fmtTokens(usage.total.cacheCreate + usage.total.cacheRead)}
                </span>
              </div>
              <div className="history">
                {usage.sessions.map((s) => (
                  <div key={s.sessionId}>
                    {s.startedAt ? new Date(s.startedAt).toLocaleString() : 'session'} ·{' '}
                    {s.models.join(', ') || 'claude'} · {fmtTokens(s.tokens.total)} tok
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="note">
              {usage
                ? 'Usage not tracked for this agent (only Claude Code sessions are counted).'
                : 'Loading usage…'}
            </p>
          )}
          {task.spawnHistory.length > 0 && (
            <div className="history" style={{ marginTop: 8 }}>
              {[...task.spawnHistory].reverse().map((s, i) => (
                <div key={`${s.startedAt}-${i}`}>
                  spawn: {new Date(s.startedAt).toLocaleString()} · {s.phase} · {s.agent}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="section">
          <div className="section-label">Workspace</div>
          <dl className="meta">
            <div className="meta-row">
              <dt>Derived phase</dt>
              <dd>{task.derived.derivedPhase}</dd>
            </div>
            <div className="meta-row">
              <dt>Last checked</dt>
              <dd>
                {task.lastReconciledAt
                  ? new Date(task.lastReconciledAt).toLocaleTimeString()
                  : 'never'}
              </dd>
            </div>
          </dl>
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="btn is-sm"
              disabled={busy !== null}
              onClick={() => run('open-code', () => api.openCode(task.issue))}
            >
              {busy === 'open-code' ? 'Opening…' : 'Open in VS Code'}
            </button>
            <button
              className="btn is-sm"
              disabled={busy !== null}
              onClick={() => run('cleanup', () => api.cleanup(task.issue))}
            >
              Remove worktree
            </button>
            <button
              className="btn is-sm is-danger"
              disabled={busy !== null}
              onClick={() =>
                run('forget', async () => {
                  await api.forget(task.issue);
                  onClose();
                })
              }
            >
              Remove from board
            </button>
          </div>
          <p className="hint">
            Removing from the board forgets the card only. Your branch, PR and commits
            are untouched.
          </p>
        </section>
      </aside>
      {editingPlan && (
        <PlanEditor
          issue={task.issue}
          initial={plan ?? ''}
          onClose={() => setEditingPlan(false)}
          onSaved={(content) => {
            setPlan(content);
            onChanged();
          }}
        />
      )}
    </>
  );
}
