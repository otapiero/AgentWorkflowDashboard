import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '../../../shared/notes.ts';
import type { NotesController } from '../../use-notes.ts';
import { selectNotes } from '../../notes-model.ts';
import type { NotesScope } from '../../notes-model.ts';
import { NoteCard } from './NoteCard.tsx';
import { usePagedItems } from '../../use-paged-items.ts';
import { ListPagination } from '../ListPagination.tsx';

export interface NotesListProps { controller: NotesController; scope: NotesScope; query: string; repoUrl: string; onEdit: (note: Note) => void; onOpenTask: (issue: number) => void; revealed?: Note | null }
export function NotesList({ controller, scope, query, repoUrl, onEdit, onOpenTask, revealed }: NotesListProps) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopened, setReopened] = useState<Note | null>(null);
  const [now, setNow] = useState(Date.now);
  const list = useRef<HTMLDivElement>(null);
  const { active, settled } = useMemo(() => selectNotes(controller.notes, controller.tasks, scope, query), [controller.notes, controller.tasks, scope, query]);
  const target = reopened ?? revealed;
  const resetKey = `${controller.projectId}/${scope.kind}/${scope.kind === 'task' ? scope.issue : ''}/${query}`;
  const activePage = usePagedItems(active, 20, resetKey, target, note => note.id);
  const settledPage = usePagedItems(settled, 20, resetKey, target, note => note.id);
  useEffect(() => {
    const updateAge = () => setNow(Date.now());
    const timer = window.setInterval(updateAge, 60_000);
    window.addEventListener('focus', updateAge);
    document.addEventListener('visibilitychange', updateAge);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', updateAge);
      document.removeEventListener('visibilitychange', updateAge);
    };
  }, []);
  useEffect(() => {
    setReopened(null);
    if (revealed?.status === 'settled') setExpanded(true);
  }, [revealed]);
  useEffect(() => {
    if (!target) return;
    const frame = requestAnimationFrame(() => list.current?.querySelector(`[data-note-id="${target.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, [target, expanded, activePage.page, settledPage.page]);
  async function changeStatus(note: Note) {
    setBusy(note.id); setError(null);
    try { const saved = await controller.setStatus(note, note.status === 'active' ? 'settled' : 'active'); if (saved.status === 'active') setReopened(saved); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); void controller.refresh(); }
    finally { setBusy(null); }
  }
  const card = (note: Note) => <NoteCard key={note.id} note={note} tasks={controller.tasks} repoUrl={repoUrl} onOpen={onEdit} onOpenTask={onOpenTask} onStatus={note => void changeStatus(note)} busy={busy === note.id} disabled={!controller.available || !controller.connected} revealed={(reopened ?? revealed)?.id === note.id} now={now} />;
  return <div className="notes-list" ref={list} aria-busy={controller.loading}>
    {!controller.connected && !controller.loading && <p className="notes-notice" role="status">Offline. Showing the last received notes. Drafts stay on this browser.</p>}
    {controller.error && <div className="notes-notice is-error" role="alert"><strong>{!controller.available ? 'Notes storage is unavailable.' : 'Could not load notes.'}</strong> {controller.error} <button className="btn is-sm" onClick={() => void controller.refresh()}>Retry</button></div>}
    {error && <p className="notes-notice is-error" role="alert">{error}</p>}
    {controller.loading ? <p className="notes-empty" role="status">Loading notes…</p> : <>
      {active.length > 0 && <><div className="notes-grid">{activePage.items.map(card)}</div><ListPagination label="Active note pages" {...activePage} /></>}
      {!active.length && !controller.error && <div className="notes-empty">{query.trim() ? settled.length ? 'Matching notes are in Settled below.' : 'No notes match this search.' : settled.length ? 'All notes here are settled.' : scope.kind === 'all' ? 'No notes yet. Create one to keep a reminder or finding.' : scope.kind === 'general' ? 'No general notes yet.' : 'No notes for this task yet.'}</div>}
      {settled.length > 0 && <section className="notes-settled"><button className="notes-settled-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span aria-hidden="true">{expanded ? '⌄' : '›'}</span> Settled notes <span className="notes-count">{settled.length}</span></button>{expanded && <><div className="notes-grid">{settledPage.items.map(card)}</div><ListPagination label="Settled note pages" {...settledPage} /></>}</section>}
    </>}
  </div>;
}
