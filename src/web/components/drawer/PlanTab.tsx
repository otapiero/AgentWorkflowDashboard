import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { DocumentWorkbench } from '../DocumentWorkbench.tsx';
import type { DocId } from '../../doc-model.ts';
import type { TabProps } from './types.ts';

export function PlanTab({ task, busy, run, onChanged }: TabProps) {
  const [plan, setPlan] = useState<string | null>(null);
  const [open, setOpen] = useState<DocId | null>(null);

  useEffect(() => {
    setPlan(null);
    setOpen(null);
    api
      .plan(task.issue)
      .then((r) => setPlan(r.content))
      .catch(() => setPlan(null));
  }, [task.issue]);

  return (
    <>
      <section className="section">
        <div className="section-label">
          Documents
          <button
            className="disclose"
            style={{ marginLeft: 8 }}
            onClick={() => setOpen({ kind: 'plan' })}
          >
            {plan ? 'Open documents' : 'Write a plan'}
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
                <span className="actions" style={{ gap: 6 }}>
                  <button
                    className="btn is-sm is-primary"
                    onClick={() => setOpen({ kind: 'artifact', name: a.name })}
                  >
                    View
                  </button>
                  <button
                    className="btn is-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`artifact-${a.name}`, () => api.openArtifact(task.issue, a.name))
                    }
                  >
                    {busy === `artifact-${a.name}` ? 'Opening…' : 'VS Code'}
                  </button>
                </span>
              </div>
            ))}
          </div>
          <p className="hint">
            Collected from the plan run. Files marked “in checkout” were written into the
            repo; they were copied here, not moved.
          </p>
        </section>
      )}

      {open && (
        <DocumentWorkbench
          issue={task.issue}
          artifacts={task.derived.artifacts}
          initial={open}
          onClose={() => setOpen(null)}
          onPlanSaved={(content) => {
            setPlan(content);
            onChanged();
          }}
        />
      )}
    </>
  );
}
