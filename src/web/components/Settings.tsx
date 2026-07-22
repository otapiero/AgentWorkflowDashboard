import { useState } from 'react';

import { api } from '../api.ts';
import type { BoardConfig } from '../api.ts';
import { AgentPicker } from './AgentPicker.tsx';

interface Props {
  config: BoardConfig;
  focusPhase: string | null;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Per-phase default agent and model — the single place to change "who runs this
 * step by default." Stored as an override layer, so config.yaml (and its
 * comments) is never rewritten, and clearing a row restores the configured
 * actor.
 */
export function Settings({ config, focusPhase, onClose, onChanged }: Props) {
  const agentPhases = config.pipeline.filter(
    (p) => p.actor === 'claude' || p.actor === 'copilot',
  );

  const [draft, setDraft] = useState<Record<string, { agent: string; model: string }>>(() =>
    Object.fromEntries(
      agentPhases.map((p) => [
        p.id,
        {
          agent: config.phaseDefaults[p.id]?.agent ?? '',
          model: config.phaseDefaults[p.id]?.model ?? '',
        },
      ]),
    ),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(phaseId: string) {
    setBusy(phaseId);
    setError(null);
    try {
      const d = draft[phaseId]!;
      await api.phaseDefault(phaseId, {
        agent: d.agent || undefined,
        model: d.model || undefined,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close settings" />
      <aside className="drawer" role="dialog" aria-label="Phase defaults">
        <header className="drawer-head">
          <div className="drawer-eyebrow">
            <span>Settings</span>
            <span style={{ marginLeft: 'auto' }}>
              <button className="btn is-sm is-ghost" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <h2 className="drawer-title">Phase defaults</h2>
          <p className="hint">
            The agent and model each step uses by default. A task can pin its own, and
            any single run can override once.
          </p>
        </header>

        {error && (
          <div className="section">
            <p className="error">{error}</p>
          </div>
        )}

        <section className="section stack">
          {agentPhases.map((phase) => (
            <div
              key={phase.id}
              className="stack"
              style={{
                paddingBottom: 12,
                borderBottom: '1px solid var(--line-soft)',
                ...(phase.id === focusPhase
                  ? { boxShadow: '0 0 0 1px var(--live)', borderRadius: 8, padding: 10 }
                  : {}),
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="settings-phase">{phase.label}</span>
                <span className="note" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                  actor: {phase.actor}
                </span>
              </div>
              <AgentPicker
                agents={config.agents}
                agent={draft[phase.id]?.agent ?? ''}
                model={draft[phase.id]?.model ?? ''}
                onAgent={(agent) =>
                  setDraft((d) => ({ ...d, [phase.id]: { ...d[phase.id]!, agent } }))
                }
                onModel={(model) =>
                  setDraft((d) => ({ ...d, [phase.id]: { ...d[phase.id]!, model } }))
                }
                inheritLabel={`Default (${phase.actor})`}
              />
              <div className="actions">
                <button
                  className="btn is-sm"
                  disabled={busy !== null}
                  onClick={() => save(phase.id)}
                >
                  {busy === phase.id ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ))}
        </section>
      </aside>
    </>
  );
}
