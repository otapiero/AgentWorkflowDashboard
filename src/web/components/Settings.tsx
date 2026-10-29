import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '../api.ts';
import type { BoardConfig } from '../api.ts';
import { AgentPicker } from './AgentPicker.tsx';
import type { AgentSelection } from './AgentPicker.tsx';
import { AgentChip, IconCheck, IconCode, IconTerminal, IconThreads, IconX } from './bits.tsx';
import type { LauncherKind, PhaseConfig, TaskWithDerived } from '../../shared/types.ts';

interface Props {
  config: BoardConfig;
  focusPhase: string | null;
  onClose: () => void;
  onChanged: (tasks: TaskWithDerived[]) => void;
}

const LAUNCHERS: { kind: LauncherKind; name: string; blurb: string; icon: ReactNode }[] = [
  { kind: 'wt', name: 'Windows Terminal', blurb: 'A new terminal tab per run', icon: <IconTerminal /> },
  { kind: 'vscode', name: 'VS Code', blurb: "The worktree's integrated terminal", icon: <IconCode /> },
  { kind: 't3', name: 'T3 Code', blurb: 'A T3 thread with live session status', icon: <IconThreads /> },
];

function savedSelection(config: BoardConfig, phaseId: string): AgentSelection {
  return {
    agent: config.phaseDefaults[phaseId]?.agent ?? '',
    model: config.phaseDefaults[phaseId]?.model ?? '',
    effort: config.phaseDefaults[phaseId]?.effort ?? '',
  };
}

const same = (a: AgentSelection, b: AgentSelection) =>
  a.agent === b.agent && a.model === b.model && a.effort === b.effort;

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
    Object.fromEntries(agentPhases.map((p) => [p.id, savedSelection(config, p.id)])),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Opened from a lane's agent button: bring that phase into view.
  useEffect(() => {
    if (!focusPhase) return;
    dialog.current
      ?.querySelector(`[data-phase="${focusPhase}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [focusPhase]);

  async function act(label: string, action: () => Promise<TaskWithDerived[]>) {
    setBusy(label);
    setError(null);
    setSaved(null);
    try {
      onChanged(await action());
      setSaved(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function savePhase(phase: PhaseConfig, value: AgentSelection) {
    return act(phase.id, () =>
      api.phaseDefault(phase.id, {
        agent: value.agent || undefined,
        model: value.model || undefined,
        effort: value.effort || undefined,
      }),
    );
  }

  const launcher = LAUNCHERS.find((l) => l.kind === config.launcher);

  return (
    <div className="settings-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialog}>
        <header className="settings-head">
          <div>
            <h2 id="settings-title">Agents &amp; launch</h2>
            <p>Where agent sessions open, and which agent runs each step by default.</p>
          </div>
          <button type="button" className="btn is-sm is-icon is-ghost" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
            <IconX />
          </button>
        </header>

        <div className="settings-body">
          {error && <p className="error">{error}</p>}

          <section className="settings-section" aria-labelledby="launcher-title">
            <div className="settings-section-head">
              <h3 id="launcher-title">Where agents open</h3>
              {saved === 'launcher' && <span className="settings-saved"><IconCheck /> Saved</span>}
            </div>
            <div className="launcher-grid" role="radiogroup" aria-labelledby="launcher-title">
              {LAUNCHERS.map((l) => {
                const on = config.launcher === l.kind;
                return (
                  <button
                    key={l.kind}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`launcher-option${on ? ' is-on' : ''}`}
                    disabled={busy !== null}
                    onClick={() => !on && act('launcher', () => api.setLauncher(l.kind))}
                  >
                    <span className="launcher-icon">{l.icon}</span>
                    <span className="launcher-text">
                      <span className="launcher-name">{l.name}</span>
                      <span className="launcher-blurb">{l.blurb}</span>
                    </span>
                    <span className="launcher-radio" aria-hidden>
                      {on && <IconCheck />}
                    </span>
                  </button>
                );
              })}
            </div>
            {launcher?.kind === 'vscode' && (
              <p className="settings-note">
                Opens the task's worktree in VS Code and runs the agent in the integrated
                terminal. The window opens with workspace trust off so the agent starts
                without a prompt; your trust settings for other folders are untouched.
              </p>
            )}
            {launcher?.kind === 't3' && (
              <p className="settings-note">
                Runs each phase as a T3 Code thread bound to the same worktree, so T3
                reports whether a session is really running and when it is blocked on an
                approval. Needs T3 Code running, an agent with a <code>t3Instance</code> in
                config.yaml, and a pairing credential at{' '}
                <code>~/.mission-control/t3-credential</code>. Create one in T3 under
                Settings → Create pairing link.
              </p>
            )}
          </section>

          <section className="settings-section" aria-labelledby="defaults-title">
            <div className="settings-section-head">
              <h3 id="defaults-title">Phase defaults</h3>
            </div>
            <p className="settings-lede">
              The agent, model and effort each step uses by default. A task can pin its own,
              and any single run can override once.
            </p>
            <div className="phase-list">
              {agentPhases.map((phase) => {
                const value = draft[phase.id]!;
                const stored = savedSelection(config, phase.id);
                const dirty = !same(value, stored);
                const overridden = Boolean(stored.agent || stored.model || stored.effort);
                const empty: AgentSelection = { agent: '', model: '', effort: '' };
                return (
                  <div
                    key={phase.id}
                    data-phase={phase.id}
                    className={`phase-row${phase.id === focusPhase ? ' is-focus' : ''}${dirty ? ' is-dirty' : ''}`}
                  >
                    <div className="phase-row-head">
                      <span className="phase-name">{phase.label}</span>
                      <span className="phase-source">
                        {overridden ? (
                          'Custom default'
                        ) : (
                          <>
                            From config.yaml · <AgentChip agent={phase.actor} showAgent />
                          </>
                        )}
                      </span>
                      <span className="phase-actions">
                        {saved === phase.id && !dirty && (
                          <span className="settings-saved"><IconCheck /> Saved</span>
                        )}
                        {dirty && (
                          <>
                            <button
                              type="button"
                              className="btn is-sm is-ghost"
                              disabled={busy !== null}
                              onClick={() => setDraft((d) => ({ ...d, [phase.id]: stored }))}
                            >
                              Discard
                            </button>
                            <button
                              type="button"
                              className="btn is-sm is-primary"
                              disabled={busy !== null}
                              onClick={() => void savePhase(phase, value)}
                            >
                              {busy === phase.id ? 'Saving…' : 'Save'}
                            </button>
                          </>
                        )}
                        {!dirty && overridden && (
                          <button
                            type="button"
                            className="btn is-sm is-ghost"
                            disabled={busy !== null}
                            title={`Go back to ${phase.actor} from config.yaml`}
                            onClick={() => {
                              setDraft((d) => ({ ...d, [phase.id]: empty }));
                              void savePhase(phase, empty);
                            }}
                          >
                            Reset
                          </button>
                        )}
                      </span>
                    </div>
                    <AgentPicker
                      labelled
                      agents={config.agents}
                      value={value}
                      onChange={(next) => setDraft((d) => ({ ...d, [phase.id]: next }))}
                      inheritedAgent={phase.actor}
                      inheritAgentLabel={`Default (${phase.actor})`}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
