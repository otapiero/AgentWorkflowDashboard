import { useState } from 'react';

import { api } from '../api.ts';
import type { BoardConfig } from '../api.ts';
import { AgentPicker } from './AgentPicker.tsx';
import type { AgentSelection } from './AgentPicker.tsx';
import type { LauncherKind } from '../../shared/types.ts';

interface Props {
  config: BoardConfig;
  focusPhase: string | null;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Global preferences: how a spawn opens its terminal, and the default agent /
 * model / effort per phase.
 *
 * Phase defaults are stored as an override layer, so config.yaml (and its
 * comments) is never rewritten and clearing a row restores the configured
 * actor.
 */
export function Settings({ config, focusPhase, onClose, onChanged }: Props) {
  const agentNames = new Set(config.agents.map((agent) => agent.name));
  const agentPhases = config.pipeline.filter((p) => agentNames.has(p.actor));

  const [draft, setDraft] = useState<Record<string, AgentSelection>>(() =>
    Object.fromEntries(
      agentPhases.map((p) => [
        p.id,
        {
          agent: config.phaseDefaults[p.id]?.agent ?? '',
          model: config.phaseDefaults[p.id]?.model ?? '',
          effort: config.phaseDefaults[p.id]?.effort ?? '',
        },
      ]),
    ),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(label: string, action: () => Promise<unknown>) {
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

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close settings" />
      <aside className="drawer" role="dialog" aria-label="Settings">
        <header className="drawer-head">
          <div className="drawer-eyebrow">
            <span>Settings</span>
            <span style={{ marginLeft: 'auto' }}>
              <button className="btn is-sm is-ghost" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <h2 className="drawer-title">Agents &amp; launch</h2>
        </header>

        {error && (
          <div className="section">
            <p className="error">{error}</p>
          </div>
        )}

        <section className="section">
          <div className="section-label">Where agents open</div>
          <div className="actions">
            {(['wt', 'vscode', 't3'] as LauncherKind[]).map((kind) => (
              <button
                key={kind}
                className={`btn is-sm${config.launcher === kind ? ' is-on' : ''}`}
                disabled={busy !== null}
                onClick={() => act('launcher', () => api.setLauncher(kind))}
              >
                {kind === 'wt' ? 'Windows Terminal' : kind === 'vscode' ? 'VS Code' : 'T3 Code'}
              </button>
            ))}
          </div>
          {config.launcher === 'vscode' && (
            <p className="hint">
              Opens the task's worktree in VS Code and runs the agent in the integrated
              terminal. The window opens with workspace trust off so the agent starts
              without a prompt; your trust settings for other folders are untouched.
            </p>
          )}
          {config.launcher === 't3' && (
            <p className="hint">
              Runs each phase as a T3 Code thread bound to the same worktree, so T3
              reports whether a session is really running and when it is blocked on an
              approval. Needs T3 Code running, an agent with a <code>t3Instance</code> in
              config.yaml, and a pairing credential at{' '}
              <code>~/.mc/t3-credential</code> — create one in T3 under Settings →
              Create pairing link.
            </p>
          )}
        </section>

        <section className="section">
          <div className="section-label">Phase defaults</div>
          <p className="hint" style={{ marginTop: -4, marginBottom: 12 }}>
            The agent, model and effort each step uses by default. A task can pin its own,
            and any single run can override once.
          </p>
          <div className="stack">
            {agentPhases.map((phase) => (
              <div
                key={phase.id}
                className="default-row"
                style={
                  phase.id === focusPhase
                    ? { boxShadow: '0 0 0 1px var(--live)', borderRadius: 8, padding: 10 }
                    : undefined
                }
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="settings-phase">{phase.label}</span>
                  <span className="meta" style={{ fontSize: 11 }}>
                    actor: {phase.actor}
                  </span>
                </div>
                <AgentPicker
                  agents={config.agents}
                  value={draft[phase.id]!}
                  onChange={(value) => setDraft((d) => ({ ...d, [phase.id]: value }))}
                  inheritedAgent={phase.actor}
                  inheritAgentLabel={`Default (${phase.actor})`}
                />
                <div className="actions">
                  <button
                    className="btn is-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      act(phase.id, () =>
                        api.phaseDefault(phase.id, {
                          agent: draft[phase.id]!.agent || undefined,
                          model: draft[phase.id]!.model || undefined,
                          effort: draft[phase.id]!.effort || undefined,
                        }),
                      )
                    }
                  >
                    {busy === phase.id ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </>
  );
}
