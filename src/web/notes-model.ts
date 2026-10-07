import type { Note, NoteTask, NoteResult, NotesSnapshot, NotesStatus } from '../shared/notes.ts';
import { MAX_NOTE_BODY_BYTES, MAX_NOTE_TITLE_LENGTH } from '../shared/notes.ts';
export type NotesScope = { kind: 'all' } | { kind: 'general' } | { kind: 'task'; issue: number };
/** Keep in step with the server's projectSlug without importing Node path helpers. */
export function notesProjectId(owner: string, name: string): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return `${clean(owner)}__${clean(name)}`;
}
export interface NoteDraft { noteId: string; clientRequestId: string; title: string; body: string; taskIssue: number | null; expectedRevision?: number; uncertainCreate?: boolean }
export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface NotesState { projectId: string; serverSessionId: string | null; notesSessionId: string | null; generation: number; revision: number; notes: Note[]; loading: boolean; available: boolean; error: string | null }
export function selectNotes(notes: Note[], tasks: NoteTask[], scope: NotesScope, query: string): { active: Note[]; settled: Note[] } {
  const search = query.trim().toLocaleLowerCase();
  const selected = notes.filter(note => {
    if (scope.kind === 'general' && note.taskIssue !== null) return false;
    if (scope.kind === 'task' && note.taskIssue !== scope.issue) return false;
    const taskTitle = tasks.find(task => task.issue === note.taskIssue)?.title ?? note.taskTitleAtLink;
    return !search || [note.title, note.body, note.taskIssue === null ? '' : `#${note.taskIssue}`, taskTitle].join('\n').toLocaleLowerCase().includes(search);
  });
  const order = (field: 'updatedAt' | 'settledAt') => (a: Note, b: Note) => (b[field] ?? '').localeCompare(a[field] ?? '') || a.id.localeCompare(b.id);
  return { active: selected.filter(n => n.status === 'active').sort(order('updatedAt')), settled: selected.filter(n => n.status === 'settled').sort(order('settledAt')) };
}
export function noteCounts(notes: Note[]) {
  const counts = { all: 0, general: 0, tasks: {} as Record<number, number> };
  for (const note of notes) if (note.status === 'active') {
    counts.all++; if (note.taskIssue === null) counts.general++; else counts.tasks[note.taskIssue] = (counts.tasks[note.taskIssue] ?? 0) + 1;
  }
  return counts;
}
export function taskChoices(notes: Note[], tasks: NoteTask[]) {
  const choices = new Map(tasks.map(t => [t.issue, { ...t, retained: false }]));
  for (const note of notes) if (note.taskIssue !== null && !choices.has(note.taskIssue)) choices.set(note.taskIssue, { issue: note.taskIssue, title: note.taskTitleAtLink ?? 'Untitled task', retained: true });
  return [...choices.values()].sort((a, b) => a.issue - b.issue);
}
export function newDraft(taskIssue: number | null): NoteDraft { return { noteId: 'new', clientRequestId: crypto.randomUUID(), title: '', body: '', taskIssue }; }
export function draftFromNote(note: Note): NoteDraft { return { noteId: note.id, clientRequestId: note.clientRequestId, title: note.title ?? '', body: note.body, taskIssue: note.taskIssue, expectedRevision: note.revision }; }
const draftKey = (projectId: string, noteId: string) => `mc-notes-draft:${projectId}:${noteId}`;
export function saveDraft(storage: DraftStorage, projectId: string, draft: NoteDraft): boolean {
  try { storage.setItem(draftKey(projectId, draft.noteId), JSON.stringify(draft)); return true; } catch { return false; }
}
export function loadDraft(storage: DraftStorage, projectId: string, noteId: string): NoteDraft | null {
  try {
    const draft: unknown = JSON.parse(storage.getItem(draftKey(projectId, noteId)) ?? 'null');
    if (!draft || typeof draft !== 'object') return null;
    const d = draft as NoteDraft;
    return d.noteId === noteId && typeof d.clientRequestId === 'string' && /^[0-9a-f-]{36}$/i.test(d.clientRequestId) && typeof d.title === 'string' && typeof d.body === 'string' && (d.taskIssue === null || Number.isSafeInteger(d.taskIssue) && d.taskIssue > 0) && (noteId === 'new' || Number.isSafeInteger(d.expectedRevision) && d.expectedRevision! > 0) ? d : null;
  } catch { return null; }
}
export function removeDraft(storage: DraftStorage, projectId: string, noteId: string) { try { storage.removeItem(draftKey(projectId, noteId)); } catch { /* Storage may be disabled. */ } }
export function validateDraft(draft: NoteDraft): { title?: string; body?: string } {
  const errors: { title?: string; body?: string } = {};
  if (draft.title.length > MAX_NOTE_TITLE_LENGTH) errors.title = 'Keep the title to 240 characters.';
  if (!draft.body.trim()) errors.body = 'Write a note before saving.';
  else if (new TextEncoder().encode(draft.body).length > MAX_NOTE_BODY_BYTES) errors.body = 'The note must be 64 KiB or less.';
  return errors;
}
export function initialNotesState(projectId: string): NotesState { return { projectId, serverSessionId: null, notesSessionId: null, generation: 0, revision: -1, notes: [], loading: true, available: true, error: null }; }
export function reconnectNotes(state: NotesState): NotesState { return { ...state, generation: state.generation + 1, serverSessionId: null, revision: -1 }; }
function belongs(state: NotesState, result: { projectId: string; serverSessionId: string }, generation: number) { return state.projectId === result.projectId && state.generation === generation && (state.serverSessionId === null || state.serverSessionId === result.serverSessionId); }
export function acceptSnapshot(state: NotesState, snapshot: NotesSnapshot, generation: number): NotesState {
  if (!belongs(state, snapshot, generation) || snapshot.revision < state.revision) return state;
  const sameSession = state.notesSessionId === snapshot.serverSessionId;
  const notes = snapshot.notes.map(note => { const current = sameSession ? state.notes.find(n => n.id === note.id) : undefined; return current && current.revision > note.revision ? current : note; });
  // A mutation may arrive before its full collection snapshot.
  if (sameSession) for (const note of state.notes) if (!notes.some(n => n.id === note.id)) notes.push(note);
  // Cached replay and delayed GETs cannot supersede an unavailable status.
  const keepUnavailable = !state.available && (state.serverSessionId ?? state.notesSessionId) === snapshot.serverSessionId;
  return { ...state, ...snapshot, notesSessionId: snapshot.serverSessionId, notes, loading: false, available: !keepUnavailable, error: keepUnavailable ? state.error : null };
}
export function acceptNote(state: NotesState, result: NoteResult, generation: number): NotesState {
  if (!belongs(state, result, generation)) return state;
  const notes = state.notesSessionId === result.serverSessionId ? state.notes : [];
  const current = notes.find(n => n.id === result.note.id);
  if (current && current.revision > result.note.revision) return state;
  return { ...state, serverSessionId: result.serverSessionId, notesSessionId: result.serverSessionId, notes: [...notes.filter(n => n.id !== result.note.id), result.note] };
}
export function acceptStatus(state: NotesState, status: NotesStatus, generation: number): NotesState {
  if (!belongs(state, status, generation)) return state;
  return { ...state, serverSessionId: status.serverSessionId, available: status.available, loading: status.available ? state.loading : false, error: status.available ? null : status.error ?? 'Notes storage is unavailable.' };
}
