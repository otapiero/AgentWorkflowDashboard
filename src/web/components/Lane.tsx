import { Card } from './Card.tsx';
import { AgentChip, IconCheck, IconPullRequest } from './bits.tsx';
import type { BoardConfig } from '../api.ts';
import type { PhaseConfig } from '../../shared/types.ts';
import type { BoardTask } from '../board-model.ts';
import { usePagedItems } from '../use-paged-items.ts';
import { ListPagination } from './ListPagination.tsx';

/** Done keeps its history short on the board: the rest is in the Done view. */
const DONE_PREVIEW = 8;

export function laneDomId(phaseId: string): string {
  return `lane-${phaseId}`;
}

/** Finished tasks as one-line rows, with the PR they shipped in. */
export function DoneList({
  tasks,
  selectedIssue,
  onOpen,
  limit,
  onShowAll,
}: {
  tasks: BoardTask[];
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
  limit?: number;
  onShowAll?: () => void;
}) {
  const page = usePagedItems(tasks, limit ?? 50, 'done', null, task => task.issue);
  const shown = page.items;
  return (
    <div className="done-list">
      {shown.map((task) => {
        const pr = task.derived.badges.find((b) => b.kind === 'pr');
        return (
          <button
            key={task.issue}
            type="button"
            className={`done-item${task.issue === selectedIssue ? ' is-selected' : ''}`}
            onClick={() => onOpen(task.issue)}
          >
            <IconCheck />
            <span className="card-issue">#{task.issue}</span>
            <span className="done-title" dir="auto">
              {task.title}
            </span>
            {pr && (
              <span className="done-pr" title={`Pull request ${pr.label}`}>
                <IconPullRequest />
              </span>
            )}
          </button>
        );
      })}
      {shown.length < tasks.length && onShowAll && (
        <button type="button" className="done-more" onClick={onShowAll}>
          Show {tasks.length - shown.length} more
        </button>
      )}
      {limit === undefined && <ListPagination label="Finished task pages" {...page} />}
    </div>
  );
}

interface Props {
  phase: PhaseConfig;
  tasks: BoardTask[];
  config: BoardConfig;
  selectedIssue: number | null;
  noteCounts: Record<number, number>;
  onOpen: (issue: number) => void;
  onOpenNotes: (issue: number) => void;
  onEditDefault: (phaseId: string) => void;
  onShowDone: () => void;
}

export function Lane({
  phase,
  tasks,
  config,
  selectedIssue,
  noteCounts,
  onOpen,
  onOpenNotes,
  onEditDefault,
  onShowDone,
}: Props) {
  const needsAttention = tasks.some((t) => t.derived.needsYou);
  const isAgentPhase = config.agents.some((agent) => agent.name === phase.actor);
  const override = config.phaseDefaults[phase.id];
  const defaultAgent = override?.agent ?? (isAgentPhase ? phase.actor : null);
  const isDone = phase.id === 'done';

  return (
    <section
      id={laneDomId(phase.id)}
      className={`lane${needsAttention ? ' has-attention' : ''}${isAgentPhase ? ' is-agent' : ''}${
        isDone ? ' is-done' : ''
      }`}
      aria-label={`${phase.label}, ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
    >
      <header className="lane-head">
        <span className="lane-dot" aria-hidden />
        <span className="lane-name">{phase.label}</span>
        <span className="lane-count">{tasks.length}</span>
        {isAgentPhase && defaultAgent && (
          <button
            className="lane-default"
            onClick={() => onEditDefault(phase.id)}
            title="Set the default agent and model for this phase"
          >
            <AgentChip agent={defaultAgent} model={override?.model} showAgent />
          </button>
        )}
      </header>
      <div className="lane-body">
        {isDone ? (
          <DoneList
            tasks={tasks}
            selectedIssue={selectedIssue}
            onOpen={onOpen}
            limit={DONE_PREVIEW}
            onShowAll={onShowDone}
          />
        ) : (
          tasks.map((task) => (
            <Card
              key={task.issue}
              task={task}
              selected={task.issue === selectedIssue}
              noteCount={noteCounts[task.issue] ?? 0}
              onOpen={onOpen}
              onOpenNotes={onOpenNotes}
            />
          ))
        )}
      </div>
    </section>
  );
}
