import { useEffect, useState } from 'react';
import type { Note } from '../../../shared/notes.ts';
import type { NotesController } from '../../use-notes.ts';
import { NotesList } from '../notes/NotesList.tsx';
interface Props { issue: number; controller: NotesController; repoUrl: string; onNew: (issue: number) => void; onEdit: (note: Note) => void; onOpenTask: (issue: number) => void; onViewAll: (issue: number) => void; revealed: Note | null }
export function NotesTab({ issue, controller, repoUrl, onNew, onEdit, onOpenTask, onViewAll, revealed }: Props) {
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [revealed]);
  return <section className="notes-task-tab">
    <div className="notes-tab-heading"><h3>Task notes</h3><button className="btn is-sm is-primary" onClick={() => onNew(issue)}>+ New note</button></div>
    <div className="notes-tab-tools"><input type="search" aria-label="Search task notes" placeholder="Search notes" value={query} onChange={event => setQuery(event.target.value)} /><button className="notes-text-button" onClick={() => onViewAll(issue)}>View in all notes</button></div>
    <NotesList controller={controller} scope={{ kind: 'task', issue }} query={query} repoUrl={repoUrl} onEdit={onEdit} onOpenTask={onOpenTask} revealed={revealed} />
  </section>;
}
