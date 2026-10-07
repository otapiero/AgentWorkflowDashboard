import type { CSSProperties, ReactNode } from 'react';

import { Lane, laneDomId } from './Lane.tsx';
import { laneLayout } from '../board-model.ts';
import type { BoardConfig } from '../api.ts';
import type { PhaseConfig, Phase, TaskWithDerived } from '../../shared/types.ts';

interface Props {
  config: BoardConfig;
  tasks: TaskWithDerived[];
  selectedIssue: number | null;
  noteCounts: Record<number, number>;
  onOpen: (issue: number) => void;
  onOpenNotes: (issue: number) => void;
  onEditDefault: (phaseId: string) => void;
  onShowDone: () => void;
  /** Rendered above the lanes, inside the same scroller (the Needs-you rail). */
  children?: ReactNode;
}

export function boardLanes(config: BoardConfig): PhaseConfig[] {
  return [
    { id: 'inbox', label: 'Inbox', actor: 'you', gate: { type: 'manual' } },
    ...config.pipeline,
    { id: 'merged', label: 'Merged', actor: 'you', gate: { type: 'manual' } },
    { id: 'done', label: 'Done', actor: 'none', gate: { type: 'manual' } },
  ];
}

/**
 * Lanes are phases; a card sits in the lane of its displayPhase.
 *
 * Inbox, Merged and Done bracket the configured pipeline: they are states rather than
 * steps, so they are not in config.yaml, but a task must be able to rest in
 * either of them.
 *
 * The pipeline bar lists every stage with its count; only stages holding tasks
 * get a lane, so empty ones cost no width. The board scrolls as one page
 * rather than lane by lane.
 */
export function Board({
  config,
  tasks,
  selectedIssue,
  noteCounts,
  onOpen,
  onOpenNotes,
  onEditDefault,
  onShowDone,
  children,
}: Props) {
  const lanes = boardLanes(config);

  const byPhase = new Map<Phase, TaskWithDerived[]>();
  for (const task of tasks) {
    const phase = task.derived.displayPhase;
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), task]);
  }

  const layout = laneLayout(
    lanes.map((phase) => ({ id: phase.id, count: (byPhase.get(phase.id) ?? []).length })),
  );
  const shown = lanes.filter((_, i) => !layout[i]!.collapsed);

  function jumpTo(phase: PhaseConfig, count: number) {
    const isAgentPhase = config.agents.some((agent) => agent.name === phase.actor);
    if (count === 0) {
      if (isAgentPhase) onEditDefault(phase.id);
      return;
    }
    const lane = document.getElementById(laneDomId(phase.id));
    if (!lane) return;
    lane.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    lane.classList.remove('is-flash');
    void lane.offsetWidth; // restart the highlight
    lane.classList.add('is-flash');
    setTimeout(() => lane.classList.remove('is-flash'), 900);
  }

  return (
    <>
      <nav className="pipeline" aria-label="Pipeline">
        {lanes.map((phase, i) => {
          const phaseTasks = byPhase.get(phase.id) ?? [];
          const count = layout[i]!.count;
          const isAgentPhase = config.agents.some((agent) => agent.name === phase.actor);
          return (
            <button
              key={phase.id}
              type="button"
              className={`stage${count > 0 ? ' has-tasks' : ''}${
                phaseTasks.some((t) => t.derived.needsYou) ? ' has-attention' : ''
              }${phaseTasks.some((t) => t.derived.badges.some((b) => b.kind === 'live')) ? ' has-live' : ''}`}
              onClick={() => jumpTo(phase, count)}
              title={
                count > 0
                  ? `Show ${phase.label}`
                  : isAgentPhase
                    ? 'Set the default agent and model for this phase'
                    : `${phase.label} is empty`
              }
            >
              {phase.label}
              <span className="stage-n">{count}</span>
            </button>
          );
        })}
      </nav>

      <div className="board-scroll">
        {children}
        {tasks.length === 0 ? (
          <p className="board-empty">No tasks yet. Use “New from issue” to add one.</p>
        ) : (
          <div className="board" style={{ '--lanes': shown.length } as CSSProperties}>
            {shown.map((phase) => (
              <Lane
                key={phase.id}
                phase={phase}
                tasks={byPhase.get(phase.id) ?? []}
                config={config}
                selectedIssue={selectedIssue}
                noteCounts={noteCounts}
                onOpen={onOpen}
                onOpenNotes={onOpenNotes}
                onEditDefault={onEditDefault}
                onShowDone={onShowDone}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
