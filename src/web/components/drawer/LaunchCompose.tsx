import { useEffect, useRef, useState } from 'react';

import { api } from '../../api.ts';
import { AgentPicker } from '../AgentPicker.tsx';
import type { AgentSelection } from '../AgentPicker.tsx';
import type { BoardConfig } from '../../api.ts';
import { IconPlay } from '../bits.tsx';
import type { PhaseConfig, TaskWithDerived } from '../../../shared/types.ts';
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
  const [text, setText] = useState('');
  const [onceOpen, setOnceOpen] = useState(false);
  const [once, setOnce] = useState<AgentSelection>(EMPTY);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
  }, [phase.id]);

  // Grow to fit, capped. Reset to auto first or it can only ever get taller.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  function launch() {
    return run(phase.id, () =>
      api.spawn(task.issue, phase.id, {
        customInstructions: text.trim() || undefined,
        agent: onceOpen ? once.agent || undefined : undefined,
        model: onceOpen ? once.model || undefined : undefined,
        effort: onceOpen ? once.effort || undefined : undefined,
      }),
    );
  }

  return (
    <section className="section">
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
            inheritedAgent={task.pinned.agent}
            inheritAgentLabel="Use pinned agent"
          />
          <p className="hint">Applies to this launch only. Nothing is saved.</p>
        </div>
      )}

      <textarea
        ref={boxRef}
        className="field compose-box"
        placeholder="Extra instructions for this run (optional)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (busy === null) void launch();
          }
        }}
      />

      <div className="compose-meta">
        <span>{countWords(text)} words</span>
        <span>Ctrl+Enter launches</span>
      </div>

      <div className="compose-actions">
        <div className="compose-tools" />
        <button
          className="btn is-primary is-launch"
          disabled={busy !== null}
          onClick={() => void launch()}
        >
          <IconPlay /> {busy === phase.id ? 'Opening…' : `Launch ${phase.label}`}
        </button>
      </div>

      <p className="hint">
        Opens a Windows Terminal tab and hands the session over. The tab keeps
        running if you close Mission Control.
      </p>
    </section>
  );
}
