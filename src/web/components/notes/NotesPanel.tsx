import type { Note } from '../../../shared/notes.ts';
import { noteCounts, taskChoices } from '../../notes-model.ts';
import type { NotesScope } from '../../notes-model.ts';
import type { NotesController } from '../../use-notes.ts';
import { IconPlus, IconSidebar } from '../bits.tsx';
import { NotesList } from './NotesList.tsx';
import { TaskSelect } from './TaskSelect.tsx';

interface Props {
  controller: NotesController;
  scope: NotesScope;
  onScope: (scope: NotesScope) => void;
  query: string;
  onQuery: (query: string) => void;
  repoUrl: string;
  onNew: (taskIssue: number | null) => void;
  onEdit: (note: Note) => void;
  onOpenTask: (issue: number) => void;
  onClose: () => void;
  revealed: Note | null;
}

/**
 * Notes beside the board rather than on a page of their own, so a reminder
 * and the task it is about are on screen together.
 */
export function NotesPanel({ controller, scope, onScope, query, onQuery, repoUrl, onNew, onEdit, onOpenTask, onClose, revealed }: Props) {
  const counts = noteCounts(controller.notes);
  const choices = taskChoices(controller.notes, controller.tasks);
  const currentTask = scope.kind === 'task' && controller.tasks.some((task) => task.issue === scope.issue) ? scope.issue : null;
  return (
    <aside className="notes-panel" aria-label="Notes">
      <div className="notes-panel-top">
        <header className="notes-panel-head">
          <h2>Notes</h2>
          <span className="count">{counts.all}</span>
          <button type="button" className="btn is-sm is-icon is-ghost" onClick={onClose} title="Hide notes" aria-label="Hide notes">
            <IconSidebar />
          </button>
        </header>
        <button type="button" className="notes-quick" onClick={() => onNew(currentTask)}>
          <IconPlus /> {currentTask === null ? 'New note' : `New note on #${currentTask}`}
          <kbd>N</kbd>
        </button>
        <div className="notes-panel-filters">
          <div className="notes-chips" role="group" aria-label="Notes scope">
            <button aria-pressed={scope.kind === 'all'} onClick={() => onScope({ kind: 'all' })}>
              All <span>{counts.all}</span>
            </button>
            <button aria-pressed={scope.kind === 'general'} onClick={() => onScope({ kind: 'general' })}>
              General <span>{counts.general}</span>
            </button>
          </div>
          <TaskSelect
            tasks={choices}
            value={scope.kind === 'task' ? scope.issue : null}
            onChange={(issue) => onScope(issue === null ? { kind: 'all' } : { kind: 'task', issue })}
            label="Filter by task"
            nullLabel="Any task"
          />
          <input
            className="notes-search"
            type="search"
            aria-label="Search notes"
            placeholder="Search notes"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
      </div>
      <div className="notes-panel-body">
        <NotesList controller={controller} scope={scope} query={query} repoUrl={repoUrl} onEdit={onEdit} onOpenTask={onOpenTask} revealed={revealed} />
      </div>
    </aside>
  );
}
