import { useEffect, useRef, useState } from 'react';
import type { Note } from '../../../shared/notes.ts';
import type { NotesController } from '../../use-notes.ts';
import { selectNotes } from '../../notes-model.ts';
import type { NotesScope } from '../../notes-model.ts';
import { NoteCard } from './NoteCard.tsx';

export interface NotesListProps { controller: NotesController; scope: NotesScope; query: string; repoUrl: string; onEdit: (note: Note) => void; onOpenTask: (issue: number) => void; revealed?: Note | null }
export function NotesList({ controller, scope, query, repoUrl, onEdit, onOpenTask, revealed }: NotesListProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopened, setReopened] = useState<Note | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const { active, settled } = selectNotes(controller.notes, controller.tasks, scope, query);
  useEffect(() => {
    setReopened(null);
    if (revealed?.status === 'settled') setExpanded(true);
  }, [revealed]);
  useEffect(() => {
    const target = reopened ?? revealed;
    if (!target) return;
    const frame = requestAnimationFrame(() => list.current?.querySelector(`[data-note-id="${target.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, [revealed, reopened, expanded]);
  async function changeStatus(note: Note) {
    setBusy(note.id); setError(null);
    try { const saved = await controller.setStatus(note, note.status === 'active' ? 'settled' : 'active'); if (saved.status === 'active') setReopened(saved); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); void controller.refresh(); }
    finally { setBusy(null); }
  }
  const card = (note: Note) => <NoteCard key={note.id} note={note} tasks={controller.tasks} repoUrl={repoUrl} onOpen={onEdit} onOpenTask={onOpenTask} onStatus={note => void changeStatus(note)} busy={busy === note.id} disabled={!controller.available || !controller.connected} revealed={(reopened ?? revealed)?.id === note.id} />;
  return <div className="notes-list" ref={list} aria-busy={controller.loading}>
    {!controller.connected && !controller.loading && <p className="notes-notice" role="status">Offline. Showing the last received notes. Drafts stay on this browser.</p>}
    {controller.error && <div className="notes-notice is-error" role="alert"><strong>{!controller.available ? 'Notes storage is unavailable.' : 'Could not load notes.'}</strong> {controller.error} <button className="btn is-sm" onClick={() => void controller.refresh()}>Retry</button></div>}
    {error && <p className="notes-notice is-error" role="alert">{error}</p>}
    {controller.loading ? <p className="notes-empty" role="status">Loading notes…</p> : <>
      {active.length > 0 && <div className="notes-grid">{active.map(card)}</div>}
      {!active.length && !controller.error && <div className="notes-empty">{query.trim() ? settled.length ? 'Matching notes are in Settled below.' : 'No notes match this search.' : settled.length ? 'All notes here are settled.' : scope.kind === 'all' ? 'No notes yet. Create one to keep a reminder or finding.' : scope.kind === 'general' ? 'No general notes yet.' : 'No notes for this task yet.'}</div>}
      {settled.length > 0 && <section className="notes-settled"><button className="notes-settled-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span aria-hidden="true">{expanded ? '⌄' : '›'}</span> Settled notes <span className="notes-count">{settled.length}</span></button>{expanded && <div className="notes-grid">{settled.map(card)}</div>}</section>}
    </>}
  </div>;
}
