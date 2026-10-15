import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { LaunchCompose } from './LaunchCompose.tsx';
import { IconPlay } from '../bits.tsx';
import { CUSTOM_RUN_ID, customPhase } from '../../../shared/custom-run.ts';
import type { TabProps } from './types.ts';

export function RunTab({ task, config, busy, run }: TabProps) {
  const [armed, setArmed] = useState<string | null>(null);

  // A different task is a different launch; never carry a phase across.
  useEffect(() => setArmed(null), [task.issue]);

  const spawnable = config.pipeline.filter((p) => p.spawnable && p.command);
  const custom = customPhase({
    pipeline: config.pipeline,
    agentNames: config.agents.map((a) => a.name),
  });
  const phase =
    armed === CUSTOM_RUN_ID ? custom : (spawnable.find((p) => p.id === armed) ?? null);

  return (
    <>
      {phase ? (
        <LaunchCompose
          task={task}
          config={config}
          phase={phase}
          busy={busy}
          run={run}
          onBack={() => setArmed(null)}
        />
      ) : (
        <section className="section">
          <div className="section-label">Run a phase</div>
          <div className="actions">
            {spawnable.map((p) => (
              <button
                key={p.id}
                className={`btn is-sm${
                  p.id === task.derived.derivedPhase ? ' is-current' : ''
                }`}
                onClick={() => setArmed(p.id)}
              >
                <IconPlay /> {p.label}
              </button>
            ))}
            <button
              className="btn is-sm"
              onClick={() => setArmed(CUSTOM_RUN_ID)}
              title="Write the whole prompt yourself"
            >
              ⚡ Custom…
            </button>
          </div>
          <p className="hint">
            Underlined is where this task sits now — but any phase can be
            re-run. Custom writes the whole prompt yourself; it never moves the
            card.
          </p>
          <button className="btn is-sm is-ghost" disabled={busy !== null} onClick={() => run('cancel-launch', () => api.cancelLaunch(task.issue))}>Cancel pending launch</button>
        </section>
      )}

      <section className="section">
        <div className="section-label">Mark progress</div>
        <div className="actions">
          {task.derived.derivedPhase === 'merged' && (
            <button
              className="btn is-sm"
              disabled={busy !== null}
              onClick={() => run('complete', () => api.move(task.issue, task.manualPhase === 'done' ? null : 'done'))}
            >
              {busy === 'complete' ? 'Saving…' : task.manualPhase === 'done' ? 'Return to Merged' : 'Mark Done'}
            </button>
          )}
          {config.pipeline
            .filter((p) => p.gate.type === 'manual' && p.id !== 'merge')
            .map((p) => {
              const done = task.derived.gates[p.id];
              return (
                <button
                  key={p.id}
                  className="btn is-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    run(`mark-${p.id}`, () =>
                      done ? api.unmarkDone(task.issue, p.id) : api.markDone(task.issue, p.id),
                    )
                  }
                >
                  {done ? `Undo ${p.label}` : `${p.label} done`}
                </button>
              );
            })}
        </div>
        {task.derived.derivedPhase === 'merged' && task.manualPhase !== 'done' && (
          <p className="hint">Mark Done removes this issue's worktree and saves uncommitted files in its task folder.</p>
        )}
      </section>
    </>
  );
}
