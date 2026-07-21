import { useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import type { BoardConfig } from '../api.ts';
import type { Phase, TaskWithDerived } from '../../shared/types.ts';

interface Props {
  task: TaskWithDerived;
  config: BoardConfig;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Everything about one task, and every action available on it.
 *
 * Actions are deliberately never disabled purely because a phase is not the
 * current one — the human is the manager and may re-run any step. What is
 * disabled is what genuinely cannot work, such as spawning a phase whose
 * prompt has no command configured.
 */
export function Drawer({ task, config, onClose, onChanged }: Props) {
  const [instructions, setInstructions] = useState('');
  const [plan, setPlan] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    api
      .plan(task.issue)
      .then((r) => setPlan(r.content))
      .catch(() => setPlan(null));
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

  const spawnable = config.pipeline.filter((p) => p.spawnable && p.command);
  const issueUrl = `https://github.com/${config.repo.owner}/${config.repo.name}/issues/${task.issue}`;

  return (
    <>
      <button className="drawer-scrim" onClick={onClose} aria-label="Close details" />
      <aside className="drawer" role="dialog" aria-label={`Issue ${task.issue}`}>
        <header className="drawer-head">
          <div className="drawer-issue">
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
              <button ref={closeRef} className="btn" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <h2 className="drawer-title">{task.title}</h2>
          <div className="drawer-branch">{task.branch}</div>
        </header>

        {error && (
          <div className="drawer-section">
            <p className="error">{error}</p>
          </div>
        )}

        <section className="drawer-section">
          <div className="drawer-label">Status</div>
          <div className="badges">
            {task.derived.badges.length === 0 ? (
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
            <p className="card-reason" style={{ marginTop: 10, marginBottom: 0 }}>
              {task.derived.needsYouReason}
            </p>
          )}
        </section>

        <section className="drawer-section">
          <div className="drawer-label">Run a phase</div>
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
                  className={`btn${
                    phase.id === task.derived.derivedPhase ? ' is-primary' : ''
                  }`}
                  disabled={busy !== null}
                  onClick={() =>
                    run(phase.id, () =>
                      api.spawn(task.issue, phase.id, instructions.trim() || undefined),
                    )
                  }
                >
                  {busy === phase.id ? 'Opening…' : phase.label}
                </button>
              ))}
            </div>
            <p className="note">
              Opens a Windows Terminal tab and hands the session over. The tab keeps
              running if you close Mission Control.
            </p>
          </div>
        </section>

        <section className="drawer-section">
          <div className="drawer-label">Mark progress</div>
          <div className="actions">
            {config.pipeline
              .filter((p) => p.gate.type === 'manual' && p.id !== 'merge')
              .map((phase) => {
                const done = task.derived.gates[phase.id];
                return (
                  <button
                    key={phase.id}
                    className="btn"
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

        <section className="drawer-section">
          <div className="drawer-label">Placement</div>
          <div className="row">
            <select
              className="field"
              value={task.manualPhase ?? ''}
              onChange={(e) =>
                run('move', () =>
                  api.move(task.issue, (e.target.value || null) as Phase | null),
                )
              }
            >
              <option value="">Follow real status</option>
              {['inbox', ...config.pipeline.map((p) => p.id), 'done'].map((id) => (
                <option key={id} value={id}>
                  Pin to {id}
                </option>
              ))}
            </select>
          </div>
          {task.manualPhase && (
            <p className="note" style={{ marginTop: 8 }}>
              Pinned to {task.manualPhase}. Badges still show real status —
              derived phase is {task.derived.derivedPhase}.
            </p>
          )}
        </section>

        <section className="drawer-section">
          <div className="drawer-label">Plan</div>
          {plan ? (
            <pre className="plan">{plan}</pre>
          ) : (
            <p className="note">
              No plan attached. Run Plan to have an agent write one to the task
              workspace.
            </p>
          )}
        </section>

        {task.spawnHistory.length > 0 && (
          <section className="drawer-section">
            <div className="drawer-label">Sessions</div>
            <div className="history">
              {[...task.spawnHistory].reverse().map((s, i) => (
                <div key={`${s.startedAt}-${i}`}>
                  {new Date(s.startedAt).toLocaleString()} · {s.phase} · {s.agent}
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="drawer-section">
          <div className="drawer-label">Workspace</div>
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
              className="btn"
              disabled={busy !== null}
              onClick={() => run('cleanup', () => api.cleanup(task.issue))}
            >
              Remove worktree
            </button>
            <button
              className="btn is-danger"
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
          <p className="note" style={{ marginTop: 8 }}>
            Removing from the board forgets the card only. Your branch, PR and
            commits are untouched.
          </p>
        </section>
      </aside>
    </>
  );
}
