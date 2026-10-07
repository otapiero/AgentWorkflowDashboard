import { Lane } from './Lane.tsx';
import { laneLayout } from '../board-model.ts';
import type { BoardConfig } from '../api.ts';
import type { PhaseConfig, Phase, TaskWithDerived } from '../../shared/types.ts';

interface Props {
  config: BoardConfig;
  tasks: TaskWithDerived[];
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
  onEditDefault: (phaseId: string) => void;
}

/**
 * Lanes are phases; a card sits in the lane of its displayPhase.
 *
 * Inbox, Merged and Done bracket the configured pipeline: they are states rather than
 * steps, so they are not in config.yaml, but a task must be able to rest in
 * either of them.
 */
export function Board({ config, tasks, selectedIssue, onOpen, onEditDefault }: Props) {
  const lanes: PhaseConfig[] = [
    { id: 'inbox', label: 'Inbox', actor: 'you', gate: { type: 'manual' } },
    ...config.pipeline,
    { id: 'merged', label: 'Merged', actor: 'you', gate: { type: 'manual' } },
    { id: 'done', label: 'Done', actor: 'none', gate: { type: 'manual' } },
  ];

  const byPhase = new Map<Phase, TaskWithDerived[]>();
  for (const task of tasks) {
    const phase = task.derived.displayPhase;
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), task]);
  }

  const layout = laneLayout(
    lanes.map((phase) => ({ id: phase.id, count: (byPhase.get(phase.id) ?? []).length })),
  );

  return (
    <div className="board">
      {lanes.map((phase, i) => (
        <Lane
          key={phase.id}
          phase={phase}
          tasks={byPhase.get(phase.id) ?? []}
          config={config}
          collapsed={layout[i]!.collapsed}
          grow={layout[i]!.grow}
          selectedIssue={selectedIssue}
          onOpen={onOpen}
          onEditDefault={onEditDefault}
        />
      ))}
    </div>
  );
}
