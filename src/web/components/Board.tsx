import { Lane } from './Lane.tsx';
import type { PhaseConfig, Phase, TaskWithDerived } from '../../shared/types.ts';

interface Props {
  pipeline: PhaseConfig[];
  tasks: TaskWithDerived[];
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
}

/**
 * Lanes are phases; a card sits in the lane of its displayPhase.
 *
 * Inbox and Done bracket the configured pipeline: they are states rather than
 * steps, so they are not in config.yaml, but a task has to be able to rest in
 * either of them.
 */
export function Board({ pipeline, tasks, selectedIssue, onOpen }: Props) {
  const lanes: PhaseConfig[] = [
    { id: 'inbox', label: 'Inbox', actor: 'you', gate: { type: 'manual' } },
    ...pipeline,
    { id: 'done', label: 'Done', actor: 'none', gate: { type: 'manual' } },
  ];

  const byPhase = new Map<Phase, TaskWithDerived[]>();
  for (const task of tasks) {
    const phase = task.derived.displayPhase;
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), task]);
  }

  return (
    <div className="board">
      {lanes.map((phase) => (
        <Lane
          key={phase.id}
          phase={phase}
          tasks={byPhase.get(phase.id) ?? []}
          selectedIssue={selectedIssue}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
