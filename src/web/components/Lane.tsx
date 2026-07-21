import { Card } from './Card.tsx';
import type { PhaseConfig, TaskWithDerived } from '../../shared/types.ts';

interface Props {
  phase: PhaseConfig;
  tasks: TaskWithDerived[];
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
}

export function Lane({ phase, tasks, selectedIssue, onOpen }: Props) {
  const needsAttention = tasks.some((t) => t.derived.needsYou);

  return (
    <section className={`lane${needsAttention ? ' has-attention' : ''}`}>
      <header className="lane-head">
        <span className="lane-name">{phase.label}</span>
        <span className="lane-count">{tasks.length || ''}</span>
      </header>
      <div className="lane-body">
        {tasks.length === 0 ? (
          <p className="lane-empty">—</p>
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
