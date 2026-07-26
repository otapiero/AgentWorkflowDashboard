import type { TaskWithDerived } from '../../shared/types.ts';
import { AgentChip, IconAlert, IconCheck, IconDot, IconSpinner } from './bits.tsx';

/**
 * One task.
 *
 * The card's left border and its single status line carry its whole state, so
 * the board is triaged by scanning colour, not by reading. Precedence follows
 * urgency: a live session outranks everything (an agent is already on it), then
 * a fault, then a request for the operator.
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

function StatusLine({ task, state }: { task: TaskWithDerived; state: CardState }) {
  const { derived } = task;
  if (state === 'live') {
    const live = derived.badges.find((b) => b.kind === 'live');
    return (
      <div className="card-status status-live">
        <IconSpinner /> {live?.label ?? 'session running'}
      </div>
    );
  }
  if (derived.needsYouReason) {
    return (
      <div className={`card-status status-${state === 'fault' ? 'fault' : 'attention'}`}>
        <IconAlert /> {derived.needsYouReason}
      </div>
    );
  }
  if (state === 'nominal') {
    const gateOpen = derived.gates[derived.displayPhase];
    return (
      <div className="card-status status-nominal">
        {gateOpen ? <IconCheck /> : <IconDot />}{' '}
        {gateOpen ? 'ready to advance' : 'in progress'}
      </div>
    );
  }
  return (
    <div className="card-status status-idle">
      <IconDot /> not started
    </div>
  );
}

interface Props {
  task: TaskWithDerived;
  selected: boolean;
  onOpen: (issue: number) => void;
}

export function Card({ task, selected, onOpen }: Props) {
  const state = cardState(task);
  // Secondary badges only — the status line already states the primary thing.
  const badges = task.derived.badges.filter((b) => b.kind !== 'live');

  return (
    <button
      type="button"
      className={`card state-${state}${selected ? ' is-selected' : ''}${
        task.unreachable ? ' is-stale' : ''
      }`}
      onClick={() => onOpen(task.issue)}
      aria-label={`Issue ${task.issue}, ${task.title}${
        task.unreachable
          ? '. Could not reach GitHub; showing last known state'
          : task.derived.needsYouReason
            ? `. ${task.derived.needsYouReason}`
            : ''
      }`}
    >
      <div className="card-top">
        <span className="card-issue">#{task.issue}</span>
        {task.pinned.agent && (
          <AgentChip
            agent={task.pinned.agent}
            model={task.pinned.model}
            effort={task.pinned.effort}
          />
        )}
      </div>

      <div className="card-title">{task.title}</div>

      {task.unreachable ? (
        <div className="card-status status-stale">
          <IconAlert /> couldn&apos;t reach GitHub
        </div>
      ) : (
        <StatusLine task={task} state={state} />
      )}

      {badges.length > 0 && (
        <div className="badges">
          {badges.map((badge) => (
            <span key={`${badge.kind}-${badge.label}`} className={`badge tone-${badge.tone}`}>
              {badge.label}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
