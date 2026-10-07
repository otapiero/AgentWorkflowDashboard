import type { Note, NoteTask } from '../../../shared/notes.ts';
interface Props { note: Note; tasks: NoteTask[]; repoUrl: string; onOpen: (note: Note) => void; onOpenTask: (issue: number) => void; onStatus: (note: Note) => void; busy: boolean; disabled: boolean; revealed?: boolean; now?: number }
export function NoteCard({ note, tasks, repoUrl, onOpen, onOpenTask, onStatus, busy, disabled, revealed, now = Date.now() }: Props) {
  const task = tasks.find(task => task.issue === note.taskIssue);
  const heading = note.title?.trim() || note.body.split(/\r?\n/).find(line => line.trim()) || 'Untitled note';
  const ageDays = Math.floor((now - Date.parse(note.createdAt)) / 86_400_000);
  const warningCount = note.status === 'active' && ageDays >= 2 ? ageDays === 2 ? 1 : Math.min(5, ageDays - 2) : 0;
  const warningLabel = `Unsettled for ${ageDays} days. Settle this note to clear the warning.`;
  return <article data-note-id={note.id} className={`notes-card${note.status === 'settled' ? ' is-settled' : ''}${revealed ? ' is-revealed' : ''}`}>
    <h3 dir="auto">{heading}</h3>
    <div className="notes-association">
      <div className="notes-association-label">
      {note.taskIssue === null ? <span>General</span> : task ? <button type="button" className="notes-task-badge" onClick={() => onOpenTask(task.issue)}><span className="notes-issue">#{task.issue}</span> <span dir="auto">{task.title}</span></button> : <a className="notes-task-badge" href={`${repoUrl}/issues/${note.taskIssue}`} target="_blank" rel="noreferrer"><span className="notes-issue">#{note.taskIssue}</span> <span dir="auto">{note.taskTitleAtLink}</span><small>No longer on board</small></a>}
      </div>
      {warningCount > 0 && <span className={`notes-age ${ageDays === 2 ? 'is-warning' : 'is-overdue'}`} role="img" aria-label={warningLabel} title={warningLabel}>
        {Array.from({ length: warningCount }, (_, index) => <svg key={index} className="notes-age-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5" /><circle cx="12" cy="17.5" r=".5" fill="currentColor" /></svg>)}
      </span>}
    </div>
    <p className="notes-preview" dir="auto">{note.body}</p>
    <footer><time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>Updated {new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
      <div className="notes-card-actions"><button className="btn is-sm" onClick={() => onOpen(note)}>Open</button><button className="btn is-sm is-ghost" disabled={busy || disabled} onClick={() => onStatus(note)}>{busy ? 'Saving…' : note.status === 'active' ? 'Settle' : 'Reopen'}</button></div>
    </footer>
  </article>;
}
