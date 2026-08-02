import { attentionTasks } from '../board-model.ts';
import type { BoardConfig } from '../api.ts';
import { IconAlert } from './bits.tsx';
import type { TaskWithDerived } from '../../shared/types.ts';

interface Props {
  tasks: TaskWithDerived[];
  config: BoardConfig;
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
}

/**
 * What needs you, above everything else.
 *
 * The rail's emptiness is the signal: from across the room, no orange means
 * nothing is waiting. That is the whole reason it is permanent rather than a
 * filter you have to remember to click.
 */
export function AttentionRail({ tasks, config, selectedIssue, onOpen }: Props) {
  const needing = attentionTasks(tasks);
  if (needing.length === 0) return null;

  const label = (id: string) =>
    config.pipeline.find((p) => p.id === id)?.label ?? id;

  return (
    <section className="rail" aria-label={`${needing.length} tasks need you`}>
      <div className="rail-head">Needs you — {needing.length}</div>
      <div className="rail-row">
        {needing.map((task) => (
          <button
            key={task.issue}
            type="button"
            className={`rail-card${task.issue === selectedIssue ? ' is-selected' : ''}`}
            onClick={() => onOpen(task.issue)}
            aria-label={`Issue ${task.issue}, ${task.title}. ${task.derived.needsYouReason ?? ''}`}
          >
            <div className="rail-top">
              <span className="card-issue">#{task.issue}</span>
              <span className="badge">{label(task.derived.displayPhase)}</span>
            </div>
            <div className="card-title">{task.title}</div>
            <div className="card-status status-attention">
              <IconAlert /> {task.derived.needsYouReason}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
