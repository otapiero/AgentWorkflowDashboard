import type { Note, NoteTask } from '../../../shared/notes.ts';
interface Props { note: Note; tasks: NoteTask[]; repoUrl: string; onOpen: (note: Note) => void; onOpenTask: (issue: number) => void; onStatus: (note: Note) => void; busy: boolean; disabled: boolean; revealed?: boolean }
export function NoteCard({ note, tasks, repoUrl, onOpen, onOpenTask, onStatus, busy, disabled, revealed }: Props) {
  const task = tasks.find(task => task.issue === note.taskIssue);
  const heading = note.title?.trim() || note.body.split(/\r?\n/).find(line => line.trim()) || 'Untitled note';
  return <article data-note-id={note.id} className={`notes-card${note.status === 'settled' ? ' is-settled' : ''}${revealed ? ' is-revealed' : ''}`}>
    <h3 dir="auto">{heading}</h3>
    <div className="notes-association">
      {note.taskIssue === null ? <span>General</span> : task ? <button type="button" className="notes-task-badge" onClick={() => onOpenTask(task.issue)}><span className="notes-issue">#{task.issue}</span> <span dir="auto">{task.title}</span></button> : <a className="notes-task-badge" href={`${repoUrl}/issues/${note.taskIssue}`} target="_blank" rel="noreferrer"><span className="notes-issue">#{note.taskIssue}</span> <span dir="auto">{note.taskTitleAtLink}</span><small>No longer on board</small></a>}
    </div>
    <p className="notes-preview" dir="auto">{note.body}</p>
    <footer><time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>Updated {new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
      <div className="notes-card-actions"><button className="btn is-sm" onClick={() => onOpen(note)}>Open</button><button className="btn is-sm is-ghost" disabled={busy || disabled} onClick={() => onStatus(note)}>{busy ? 'Saving…' : note.status === 'active' ? 'Settle' : 'Reopen'}</button></div>
    </footer>
  </article>;
}
