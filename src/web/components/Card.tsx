import type { Badge, TaskWithDerived } from '../../shared/types.ts';
import {
  AgentChip,
  IconAlert,
  IconArrowUp,
  IconCheck,
  IconCommit,
  IconNote,
  IconPullRequest,
  IconSpinner,
} from './bits.tsx';

/**
 * One task.
 *
 * A status dot and one status line carry the card's whole state, so the board
 * is triaged by scanning colour, not by reading. Precedence follows urgency: a
 * live session outranks everything (an agent is already on it), then a fault,
 * then a request for the operator.
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
        <IconSpinner /> {live?.label ?? 'Session running'}
      </div>
    );
  }
  if (derived.needsYouReason) {
    return (
      <div className={`card-status status-${state === 'fault' ? 'fault' : 'attention'}`}>
        <span className="status-dot" /> {derived.needsYouReason}
      </div>
    );
  }
  if (state === 'nominal') {
    const gateOpen = derived.gates[derived.displayPhase];
    return (
      <div className="card-status status-nominal">
        <span className="status-dot" /> {gateOpen ? 'Ready to advance' : 'In progress'}
      </div>
    );
  }
  return (
    <div className="card-status status-idle">
      <span className="status-dot" /> Not started
    </div>
  );
}

/** Git state and the PR read as quiet icon counts; everything else as a soft chip. */
function BadgeItem({ badge }: { badge: Badge }) {
  const count = /^\d+/.exec(badge.label)?.[0];
  if (badge.kind === 'dirty' && count) {
    return (
      <span className={`meta-item tone-${badge.tone}`} title={badge.label}>
        <IconCommit /> {count}
      </span>
    );
  }
  if (badge.kind === 'unpushed' && count) {
    return (
      <span className={`meta-item tone-${badge.tone}`} title={badge.label}>
        <IconArrowUp /> {count}
      </span>
    );
  }
  if (badge.kind === 'plan-ready') {
    return (
      <span className="meta-item" title="A plan is ready">
        <IconCheck /> plan
      </span>
    );
  }
  if (badge.kind === 'pr') {
    return (
      <span className="meta-item" title={`Pull request ${badge.label}`}>
        <IconPullRequest /> {badge.label.replace(/^#/, '')}
      </span>
    );
  }
  return <span className={`badge tone-${badge.tone}`}>{badge.label}</span>;
}

interface Props {
  task: TaskWithDerived;
  selected: boolean;
  noteCount: number;
  onOpen: (issue: number) => void;
  onOpenNotes: (issue: number) => void;
}

export function Card({ task, selected, noteCount, onOpen, onOpenNotes }: Props) {
  const state = cardState(task);
  // Secondary badges only — the status line already states the primary thing.
  const badges = task.derived.badges.filter((b) => b.kind !== 'live');

  return (
    <div
      className={`card state-${state}${selected ? ' is-selected' : ''}${
        task.unreachable ? ' is-stale' : ''
      }${noteCount > 0 ? ' has-notes' : ''}`}
    >
      <button
        type="button"
        className="card-main"
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

        <div className="card-title" dir="auto">
          {task.title}
        </div>

        <div className="card-foot">
          {task.unreachable ? (
            <div className="card-status status-stale">
              <IconAlert /> Couldn&apos;t reach GitHub
            </div>
          ) : (
            <StatusLine task={task} state={state} />
          )}
          {badges.length > 0 && (
            <span className="card-meta">
              {badges.map((badge) => (
                <BadgeItem key={`${badge.kind}-${badge.label}`} badge={badge} />
              ))}
            </span>
          )}
        </div>
      </button>

      {noteCount > 0 && (
        <button
          type="button"
          className="card-note"
          onClick={() => onOpenNotes(task.issue)}
          title={`${noteCount} open ${noteCount === 1 ? 'note' : 'notes'}`}
          aria-label={`Open ${noteCount} ${noteCount === 1 ? 'note' : 'notes'} for issue ${task.issue}`}
        >
          <IconNote /> {noteCount}
        </button>
      )}
    </div>
  );
}
