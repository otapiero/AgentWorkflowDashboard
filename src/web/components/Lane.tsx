import { Card } from './Card.tsx';
import type { BoardConfig } from '../api.ts';
import type { PhaseConfig, TaskWithDerived } from '../../shared/types.ts';

interface Props {
  phase: PhaseConfig;
  tasks: TaskWithDerived[];
  config: BoardConfig;
  collapsed: boolean;
  grow: number;
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
  onEditDefault: (phaseId: string) => void;
}

export function Lane({
  phase,
  tasks,
  config,
  collapsed,
  grow,
  selectedIssue,
  onOpen,
  onEditDefault,
}: Props) {
  const needsAttention = tasks.some((t) => t.derived.needsYou);
  const isAgentPhase = phase.actor === 'claude' || phase.actor === 'copilot';
  const override = config.phaseDefaults[phase.id];
  const defaultAgent = override?.agent ?? (isAgentPhase ? phase.actor : null);

  // An empty lane is a labelled rail: it keeps its place in the pipeline
  // without holding open a share of the width it has nothing to put in.
  if (collapsed) {
    return (
      <section className="lane is-collapsed" aria-label={`${phase.label}, empty`}>
        <button
          className="lane-rail"
          onClick={() => isAgentPhase && onEditDefault(phase.id)}
          title={
            isAgentPhase ? 'Set the default agent and model for this phase' : phase.label
          }
        >
          {phase.label}
        </button>
      </section>
    );
  }

  return (
    <section
      className={`lane${needsAttention ? ' has-attention' : ''}`}
      style={{ flexGrow: grow }}
    >
      <header className="lane-head">
        <span className="lane-name">{phase.label}</span>
        <span className="lane-count">{tasks.length || ''}</span>
        {isAgentPhase && (
          <button
            className="lane-default"
            onClick={() => onEditDefault(phase.id)}
            title="Set the default agent and model for this phase"
          >
            {defaultAgent}
            {override?.model ? ` · ${override.model}` : ''}
          </button>
        )}
      </header>
      <div className="lane-body">
        {tasks.length === 0 ? (
          <p className="lane-empty">·</p>
        ) : (
          tasks.map((task) => (
            <Card
              key={task.issue}
              task={task}
              selected={task.issue === selectedIssue}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  );
}
