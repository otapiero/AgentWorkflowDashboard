import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { AgentPicker } from '../AgentPicker.tsx';
import type { AgentSelection } from '../AgentPicker.tsx';
import { IconPlay } from '../bits.tsx';
import type { Phase } from '../../../shared/types.ts';
import type { TabProps } from './types.ts';

const EMPTY: AgentSelection = { agent: '', model: '', effort: '' };

export function RunTab({ task, config, busy, run }: TabProps) {
  const [instructions, setInstructions] = useState('');
  const [onceOpen, setOnceOpen] = useState(false);
  const [once, setOnce] = useState<AgentSelection>(EMPTY);

  useEffect(() => {
    setInstructions('');
    setOnceOpen(false);
    setOnce(EMPTY);
  }, [task.issue]);

  const spawnable = config.pipeline.filter((p) => p.spawnable && p.command);

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

  return (
    <>
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
              <p className="hint">Applies to the next phase you launch only. Nothing is saved.</p>
            </div>
          )}

          <p className="hint">
            Opens a Windows Terminal tab and hands the session over. The tab keeps
            running if you close Mission Control.
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
    </>
  );
}
