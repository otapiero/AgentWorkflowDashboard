import { useEffect, useRef, useState } from 'react';

import { api } from '../../api.ts';
import { AgentPicker } from '../AgentPicker.tsx';
import type { AgentSelection } from '../AgentPicker.tsx';
import type { BoardConfig } from '../../api.ts';
import { IconPlay } from '../bits.tsx';
import { PromptPreview } from './PromptPreview.tsx';
import type { PhaseConfig, TaskWithDerived } from '../../../shared/types.ts';
import { selectionForPhase } from '../../../shared/agent-selection.ts';
import { isCustomRun, pipelineWith } from '../../../shared/custom-run.ts';
import { prKey } from '../../../shared/pr-stack.ts';
import type { TabProps } from './types.ts';

const EMPTY: AgentSelection = { agent: '', model: '', effort: '' };

interface LaunchComposeProps {
  task: TaskWithDerived;
  config: BoardConfig;
  phase: PhaseConfig;
  busy: string | null;
  run: TabProps['run'];
  onBack: () => void;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Compose and launch one phase.
 *
 * The box grows with its content to 40% of the drawer, past which Full window
 * is the intended escape rather than an ever-taller drawer.
 */
export function LaunchCompose({
  task,
  config,
  phase,
  busy,
  run,
  onBack,
}: LaunchComposeProps) {
  // Splice the phase in so a synthetic one's actor is reachable; see
  // pipelineWith. A no-op for every configured phase.
  const inheritedSelection = selectionForPhase(
    { ...config, pipeline: pipelineWith(config.pipeline, phase) },
    task,
    phase.id,
  );
  // A custom run never inherits the task's pinned instructions: that field is
  // shared with every phase's compose box, so a kept research prompt would
  // otherwise ride along into Implement.
  const isCustom = isCustomRun(phase);
  const layers = task.stack?.layers ?? [];
  const selectedKey = phase.id === 'plan' ? undefined : task.stack?.selectedKey ?? (layers.length === 1 ? prKey(layers[0]!) : undefined);
  const selectedLayer = layers.find(p => prKey(p) === selectedKey);
  const [includeContext, setIncludeContext] = useState(true);
  const [text, setText] = useState(isCustom ? '' : (task.overrides?.instructions ?? ''));
  const [kept, setKept] = useState(!isCustom && Boolean(task.overrides?.instructions));
  const [onceOpen, setOnceOpen] = useState(false);
  const [once, setOnce] = useState<AgentSelection>(EMPTY);
  const [previewing, setPreviewing] = useState(false);
  const [full, setFull] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
  }, [phase.id]);

  useEffect(() => {
    if (isCustom) return;
    setText(task.overrides?.instructions ?? '');
    setKept(Boolean(task.overrides?.instructions));
  }, [task.issue, task.overrides?.instructions, isCustom]);

  // Grow to fit, capped. Reset to auto first or it can only ever get taller.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      // The preview owns Escape while it is up.
      if (e.key === 'Escape' && !previewing) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, previewing]);

  /** Persist (or clear) the task-level instructions. */
  function persist(value: string | null) {
    return run('keep', () => api.overrides(task.issue, { instructions: value }));
  }

  function toggleKeep() {
    const next = !kept;
    setKept(next);
    void persist(next ? text.trim() || null : null);
  }

  // Flush a kept edit on the way out, so backing out of compose does not lose
  // it. A ref, so the cleanup reads current values rather than mount-time ones.
  const latest = useRef({ kept, text, issue: task.issue, isCustom });
  latest.current = { kept, text, issue: task.issue, isCustom };

  useEffect(() => {
    return () => {
      const { kept: k, text: t, issue, isCustom: c } = latest.current;
      if (c || !k) return;
      const value = t.trim() || null;
      // Fire-and-forget: the component is going away and the board refreshes
      // on its own poll regardless.
      void api.overrides(issue, { instructions: value });
    };
  }, []);

  // A phase run's text is optional garnish on a command file; a custom run's
  // text is the entire instruction, so there has to be some.
  const empty = text.trim() === '';
  const blocked = busy !== null || (isCustom && empty) || (phase.id !== 'plan' && layers.length > 0 && (!selectedLayer || !selectedLayer.available || selectedLayer.state !== 'OPEN'));

  async function launch() {
    if (isCustom && empty) return;
    if (kept) await persist(text.trim() || null);
    return run(phase.id, () =>
      api.spawn(task.issue, phase.id, {
        layerKey: selectedKey,
        customInstructions: text.trim() || undefined,
        agent: onceOpen ? once.agent || undefined : undefined,
        model: onceOpen ? once.model || undefined : undefined,
        effort: onceOpen ? once.effort || undefined : undefined,
        ...(isCustom ? { includeContext } : {}),
      }),
    );
  }

  return (
    <section className="section">
      {selectedLayer && <p className="hint">Target PR #{selectedLayer.number}: {selectedLayer.headBranch} → {selectedLayer.baseBranch}</p>}
      {phase.id !== 'plan' && layers.length > 1 && !selectedLayer && <p className="hint">Select a PR layer above before launching.</p>}
      <div className="compose-head">
        <button className="btn is-sm is-ghost" onClick={onBack} aria-label="Back to phases">
          ←
        </button>
        <span className="compose-crumb">
          Run a phase › <b>{phase.label}</b>
        </span>
        <button className="disclose" style={{ marginLeft: 'auto' }} onClick={() => setOnceOpen((v) => !v)}>
          {onceOpen ? 'use default agent' : 'change agent'}
        </button>
      </div>

      {onceOpen && (
        <div className="stack" style={{ marginBottom: 10 }}>
          <AgentPicker
            agents={config.agents}
            value={once}
            onChange={setOnce}
            inheritedAgent={inheritedSelection.agent}
            inheritAgentLabel="Use pinned agent"
          />
          <p className="hint">Applies to this launch only. Nothing is saved.</p>
        </div>
      )}

      <textarea
        ref={boxRef}
        className="field compose-box"
        placeholder={
          isCustom
            ? 'What should the agent do?'
            : 'Extra instructions for this run (optional)'
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!blocked) void launch();
          }
        }}
      />

      <div className="compose-meta">
        <span>{countWords(text)} words</span>
        <span>Ctrl+Enter launches</span>
      </div>

      {isCustom && (
        <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeContext}
            onChange={(e) => setIncludeContext(e.target.checked)}
          />
          Include issue context — the issue number, branch, where to write output
          and which documents already exist
        </label>
      )}

      <div className="compose-actions">
        <div className="compose-tools">
          <button className="btn is-sm" onClick={() => setFull(true)}>
            ⛶ Full window
          </button>
          <button className="btn is-sm" onClick={() => setPreviewing(true)}>
            👁 Preview prompt
          </button>
          {!isCustom && (
            <button
              className={`btn is-sm${kept ? ' is-on' : ''}`}
              onClick={toggleKeep}
              aria-pressed={kept}
              title="Keep for every run of this task"
            >
              📌 {kept ? 'Kept' : 'Keep'}
            </button>
          )}
        </div>
        <button
          className="btn is-primary is-launch"
          disabled={blocked}
          onClick={() => void launch()}
        >
          <IconPlay /> {busy === phase.id ? 'Opening…' : `Launch ${phase.label}`}
        </button>
      </div>

      <p className="hint">
        Opens a Windows Terminal tab and hands the session over. The tab keeps
        running if you close Mission Control.
      </p>

      {full && (
        <div className="plan-editor-scrim" role="dialog" aria-label="Instructions">
          <div className="plan-editor">
            <header className="plan-editor-head">
              <strong>
                Instructions · {phase.label} · #{task.issue}
              </strong>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn is-sm" onClick={() => setPreviewing(true)}>
                  👁 Preview
                </button>
                <button
                  className="btn is-sm is-primary"
                  disabled={blocked}
                  onClick={() => void launch()}
                >
                  ▶ Launch
                </button>
                <button className="btn is-sm is-ghost" onClick={() => setFull(false)}>
                  Close
                </button>
              </span>
            </header>
            <div className="plan-editor-body">
              <textarea
                className="plan-editor-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (!blocked) void launch();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
        </div>
      )}

      {previewing && (
        <PromptPreview
          layerKey={selectedKey}
          issue={task.issue}
          phase={phase.id}
          phaseLabel={phase.label}
          instructions={text}
          includeContext={isCustom ? includeContext : undefined}
          onClose={() => setPreviewing(false)}
        />
      )}
    </section>
  );
}
