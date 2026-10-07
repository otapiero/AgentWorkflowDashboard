import { useEffect, useId, useRef, useState } from 'react';
import type { Note } from '../../../shared/notes.ts';
import { ApiError } from '../../api.ts';
import { draftFromNote, loadDraft, newDraft, removeDraft, saveDraft, validateDraft } from '../../notes-model.ts';
import type { NoteDraft } from '../../notes-model.ts';
import type { NotesController } from '../../use-notes.ts';
import { TaskSelect } from './TaskSelect.tsx';

interface Props { controller: NotesController; note: Note | null; taskIssue: number | null; onClose: () => void; onSaved: (note: Note) => void }
export function NoteEditor({ controller, note, taskIssue, onClose, onSaved }: Props) {
  const [storage] = useState(() => { try { return window.localStorage; } catch { return null; } });
  const [baseline, setBaseline] = useState(() => note ? draftFromNote(note) : newDraft(taskIssue));
  const [draft, setDraft] = useState<NoteDraft>(baseline);
  const [resume, setResume] = useState(() => storage ? loadDraft(storage, controller.projectId, baseline.noteId) : null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Note | null>(null);
  const [storageFailed, setStorageFailed] = useState(!storage);
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const titleId = useId(); const bodyId = useId(); const headingId = useId();
  const dirty = draft.title !== baseline.title || draft.body !== baseline.body || draft.taskIssue !== baseline.taskIssue || !!draft.uncertainCreate;
  const close = () => { if (saving.current) return; if (dirty || resume) setConfirmClose(true); else onClose(); };
  const closeRef = useRef(close); closeRef.current = close;
  const saveRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!storage || resume) return;
    if (dirty) setStorageFailed(!saveDraft(storage, controller.projectId, draft));
    else removeDraft(storage, controller.projectId, draft.noteId);
  }, [draft, dirty, resume, storage, controller.projectId]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('[data-first-focus]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); saveRef.current(); }
      if (event.key === 'Tab') {
        const root = panel.current?.querySelector('[data-close-confirm]') ?? panel.current;
        const focusable = Array.from(root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
        const first = focusable[0]; const last = focusable.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !root?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (confirmClose) panel.current?.querySelector<HTMLElement>('[data-close-confirm] button')?.focus();
    closeRef.current = () => { if (confirmClose) setConfirmClose(false); else close(); };
  });
  function discard() { if (storage) removeDraft(storage, controller.projectId, draft.noteId); onClose(); }
  function change(fields: Partial<NoteDraft>) { setDraft(value => ({ ...value, ...fields })); setCopied(false); }
  async function save() {
    if (saving.current || resume || confirmClose || !controller.available || !controller.connected) return;
    const validation = validateDraft(draft); setErrors(validation);
    if (Object.keys(validation).length) {
      (validation.title ? titleInput : bodyInput).current?.focus();
      return;
    }
    saving.current = true; setBusy(true); setError(null); setConflict(null);
    // Freeze an uncertain creation payload so retries use both its original ID and text.
    if (draft.noteId === 'new') {
      const pending = { ...draft, uncertainCreate: true }; setDraft(pending);
      if (storage) setStorageFailed(!saveDraft(storage, controller.projectId, pending));
    }
    try {
      const saved = draft.noteId === 'new'
        ? await controller.create({ clientRequestId: draft.clientRequestId, title: draft.title || null, body: draft.body, taskIssue: draft.taskIssue })
        : await controller.update(draft.noteId, { expectedRevision: draft.expectedRevision!, title: draft.title || null, body: draft.body, ...(draft.taskIssue !== baseline.taskIssue ? { taskIssue: draft.taskIssue } : {}) });
      if (storage) removeDraft(storage, controller.projectId, draft.noteId);
      onSaved(saved);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      if (error instanceof ApiError) {
        if (error.currentNote) setConflict(error.currentNote);
        if (error.status < 500) setDraft(value => ({ ...value, uncertainCreate: false }));
      }
    } finally { saving.current = false; setBusy(false); }
  }
  saveRef.current = () => void save();
  const locked = busy || !!resume || !!draft.uncertainCreate;
  const editorTasks = controller.tasks;
  const retained = note?.taskIssue !== null && note?.taskIssue !== undefined && !editorTasks.some(task => task.issue === note.taskIssue);
  return <div className="notes-editor-scrim" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="notes-editor" role="dialog" aria-modal="true" aria-labelledby={headingId} ref={panel}>
      <header className="notes-editor-head"><div><h2 id={headingId}>{note ? 'Edit note' : 'New note'}</h2><p>{note?.status === 'settled' ? 'Settled note' : 'Saved in this repository'}</p></div><button className="btn is-sm is-ghost" aria-label="Close note editor" onClick={close} disabled={busy}>Close</button></header>
      {confirmClose && <div className="notes-close-confirm" role="alertdialog" aria-label="Discard unsaved changes?" data-close-confirm><p>Discard this draft?</p><div><button className="btn" onClick={() => { setConfirmClose(false); panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }}>Keep editing</button><button className="btn" onClick={discard}>Discard</button></div></div>}
      {resume && <div className="notes-notice notes-resume"><p>A saved draft is available on this browser.</p><div><button data-first-focus className="btn" onClick={() => { setDraft(resume); setResume(null); }}>Resume draft</button><button className="btn is-ghost" onClick={() => { if (storage) removeDraft(storage, controller.projectId, baseline.noteId); setResume(null); }}>Discard draft</button></div></div>}
      <form inert={confirmClose} onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="notes-editor-fields">
          <label htmlFor={titleId}>Title <span className="notes-hint">optional</span></label>
          <input ref={titleInput} id={titleId} dir="auto" value={draft.title} onChange={event => change({ title: event.target.value })} disabled={locked} aria-invalid={!!errors.title} aria-describedby={errors.title ? `${titleId}-error` : undefined} placeholder="A short heading" />
          {errors.title && <p className="notes-field-error" id={`${titleId}-error`}>{errors.title}</p>}
          <label htmlFor={bodyId}>Note</label>
          <textarea ref={bodyInput} data-first-focus={!resume || undefined} id={bodyId} dir="auto" value={draft.body} onChange={event => change({ body: event.target.value })} disabled={locked} aria-invalid={!!errors.body} aria-describedby={errors.body ? `${bodyId}-error` : undefined} placeholder="What do you want to remember?" rows={9} />
          {errors.body && <p className="notes-field-error" id={`${bodyId}-error`}>{errors.body}</p>}
          <label>Linked task</label>
          <TaskSelect label="Link to task" tasks={editorTasks} value={draft.taskIssue} onChange={taskIssue => change({ taskIssue })} disabled={locked} />
          {retained && <p className="notes-hint">This task is no longer on the board. You can keep its link, choose another task, or make the note General.</p>}
          {controller.tasksError && <p className="notes-field-error">Could not load task choices. <button type="button" className="notes-text-button" onClick={() => void controller.refreshTasks()}>Retry</button></p>}
          {storageFailed && <p className="notes-notice">Browser storage is unavailable. Keep this editor open until you save, or copy your text.</p>}
          {!controller.connected && <p className="notes-notice">{draft.uncertainCreate ? 'Offline. Retry save when the connection returns.' : 'Offline. You can keep writing and save when the connection returns.'}</p>}
          {!controller.available && <p className="notes-notice is-error">Notes storage is unavailable. {controller.error} <button type="button" className="notes-text-button" onClick={() => void controller.refresh()}>Retry connection</button></p>}
          {draft.uncertainCreate && !busy && <p className="notes-notice" role="status">The save result is unconfirmed. Choose Retry save to confirm this note. Its text stays locked until the result is known.</p>}
          {error && <div role="alert" className="notes-notice is-error"><p>{error}</p>{conflict && <><p>Your draft is kept. Copy it before loading the saved version if you want to compare.</p><button type="button" className="btn is-sm" onClick={() => { const latest = draftFromNote(conflict); setBaseline(latest); setDraft(latest); setConflict(null); setError(null); if (storage) removeDraft(storage, controller.projectId, latest.noteId); }}>Load saved version</button></>}</div>}
        </div>
        <footer className="notes-editor-foot"><button type="button" className="notes-text-button" onClick={async () => { try { await navigator.clipboard.writeText([draft.title, draft.body].filter(Boolean).join('\n\n')); setCopied(true); } catch { setError('Could not copy. Select the text and copy it manually.'); } }}>{copied ? 'Copied' : 'Copy text'}</button><span className="notes-hint">Ctrl+Enter to save</span><button type="submit" className="btn is-primary" disabled={busy || !!resume || !controller.available || !controller.connected || confirmClose}>{busy ? 'Saving…' : draft.uncertainCreate ? 'Retry save' : 'Save note'}</button></footer>
      </form>
    </div>
  </div>;
}
