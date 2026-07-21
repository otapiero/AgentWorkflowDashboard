import type { TaskWithDerived } from '../../shared/types.ts';

/**
 * One task.
 *
 * The left rail carries the card's whole state in a single stripe so the board
 * can be triaged by scanning colour, not by reading. Precedence matters: a live
 * session outranks everything (an agent is already on it), then a fault, then
 * a request for the operator.
 */
export type CardState = 'live' | 'fault' | 'attention' | 'nominal' | 'idle';

export function cardState(task: TaskWithDerived): CardState {
  const { derived } = task;
  if (derived.badges.some((b) => b.kind === 'live')) return 'live';
  if (derived.badges.some((b) => b.tone === 'bad')) return 'fault';
  if (derived.needsYou) return 'attention';
  if (derived.derivedPhase === 'inbox') return 'idle';
  return 'nominal';
}

interface Props {
  task: TaskWithDerived;
  selected: boolean;
  onOpen: (issue: number) => void;
}

export function Card({ task, selected, onOpen }: Props) {
  const state = cardState(task);

  return (
    <button
      type="button"
      className={`card state-${state}${selected ? ' is-selected' : ''}`}
      onClick={() => onOpen(task.issue)}
      aria-label={`Issue ${task.issue}, ${task.title}${
        task.derived.needsYouReason ? `. Needs you: ${task.derived.needsYouReason}` : ''
      }`}
    >
      <div className="card-issue">#{task.issue}</div>
      <div className="card-title">{task.title}</div>

      {task.derived.needsYouReason && (
        <div className="card-reason">{task.derived.needsYouReason}</div>
      )}

      {task.derived.badges.length > 0 && (
        <div className="badges">
          {task.derived.badges.map((badge) => (
            <span key={`${badge.kind}-${badge.label}`} className={`badge tone-${badge.tone}`}>
              {badge.label}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
