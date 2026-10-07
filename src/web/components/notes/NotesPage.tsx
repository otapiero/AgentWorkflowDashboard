import type { Note } from '../../../shared/notes.ts';
import { noteCounts, taskChoices } from '../../notes-model.ts';
import type { NotesScope } from '../../notes-model.ts';
import type { NotesController } from '../../use-notes.ts';
import { NotesList } from './NotesList.tsx';
import { TaskSelect } from './TaskSelect.tsx';
interface Props { controller: NotesController; scope: NotesScope; onScope: (scope: NotesScope) => void; query: string; onQuery: (query: string) => void; repoUrl: string; onNew: (taskIssue: number | null) => void; onEdit: (note: Note) => void; onOpenTask: (issue: number) => void; revealed: Note | null }
export function NotesPage({ controller, scope, onScope, query, onQuery, repoUrl, onNew, onEdit, onOpenTask, revealed }: Props) {
  const counts = noteCounts(controller.notes);
  const choices = taskChoices(controller.notes, controller.tasks);
  const currentTask = scope.kind === 'task' && controller.tasks.some(task => task.issue === scope.issue) ? scope.issue : null;
  return <main className="notes-page">
    <header className="notes-heading"><div><h1>Notes</h1><p>Reminders and findings for this repository.</p></div><button className="btn is-primary" onClick={() => onNew(currentTask)}>+ New note</button></header>
    <div className="notes-toolbar">
      <div className="notes-scopes" role="group" aria-label="Notes scope"><button aria-pressed={scope.kind === 'all'} onClick={() => onScope({ kind: 'all' })}>All notes <span>{counts.all}</span></button><button aria-pressed={scope.kind === 'general'} onClick={() => onScope({ kind: 'general' })}>General <span>{counts.general}</span></button></div>
      <TaskSelect tasks={choices} value={scope.kind === 'task' ? scope.issue : null} onChange={issue => onScope(issue === null ? { kind: 'all' } : { kind: 'task', issue })} label="Filter by task" nullLabel="Choose a task" />
      <input className="notes-search" type="search" aria-label="Search notes" placeholder="Search notes" value={query} onChange={event => onQuery(event.target.value)} />
    </div>
    <NotesList controller={controller} scope={scope} query={query} repoUrl={repoUrl} onEdit={onEdit} onOpenTask={onOpenTask} revealed={revealed} />
  </main>;
}
