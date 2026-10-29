import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { AgentPicker } from '../AgentPicker.tsx';
import type { AgentSelection } from '../AgentPicker.tsx';
import type { Phase } from '../../../shared/types.ts';
import type { TabProps } from './types.ts';

const EMPTY: AgentSelection = { agent: '', model: '', effort: '' };

export function SetupTab({ task, config, busy, run, onClose }: TabProps) {
  const [pin, setPin] = useState<AgentSelection>(EMPTY);

  useEffect(() => {
    setPin({
      agent: task.overrides?.agent ?? '',
      model: task.overrides?.model ?? '',
      effort: task.overrides?.effort ?? '',
    });
    // Re-seed only when switching to a different task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.issue]);

  const pinDirty =
    pin.agent !== (task.overrides?.agent ?? '') ||
    pin.model !== (task.overrides?.model ?? '') ||
    pin.effort !== (task.overrides?.effort ?? '');

  return (
    <>
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
                    agent: pin.agent || null,
                    model: pin.model || null,
                    effort: pin.effort || null,
                  }),
                )
              }
            >
              {busy === 'pin' ? 'Saving…' : 'Save pin'}
            </button>
          </div>
          <p className="hint">
            Applies to every run of this task, unless overridden for a single run.
          </p>
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
          {['inbox', ...config.pipeline.map((p) => p.id), 'merged', 'done'].map((id) => (
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
            onClick={() => run('cleanup', () => api.cleanup(task.issue))}
          >
            Remove worktree
          </button>
          <button
            className="btn is-sm is-danger"
            disabled={busy !== null}
            onClick={() =>
              run('forget', async () => {
                const tasks = await api.forget(task.issue);
                onClose();
                return tasks;
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
    </>
  );
}
