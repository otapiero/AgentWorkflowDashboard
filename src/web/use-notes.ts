import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import type { Note, NoteCreateInput, NoteUpdateInput, NotesSnapshot, NotesStatus, NoteTask } from '../shared/notes.ts';
import { acceptNote, acceptSnapshot, acceptStatus, initialNotesState, reconnectNotes } from './notes-model.ts';
import type { NotesState } from './notes-model.ts';

/** One controller feeds navigation, the page, and every task drawer. */
export function useNotes(projectId: string) {
  const [state, render] = useState(() => initialNotesState(projectId));
  const current = useRef(state);
  const [tasks, setTasks] = useState<NoteTask[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const apply = useCallback((change: (state: NotesState) => NotesState) => { current.current = change(current.current); render(current.current); }, []);

  const refreshTasks = useCallback(async () => {
    if (!projectId) return;
    const generation = current.current.generation;
    try {
      const result = await api.noteTasks(projectId);
      if (generation === current.current.generation && result.projectId === current.current.projectId) { setTasks(result.tasks); setTasksError(null); }
    } catch (error) {
      if (generation === current.current.generation && projectId === current.current.projectId) setTasksError(error instanceof Error ? error.message : String(error));
    }
  }, [projectId]);
  const refresh = useCallback(async () => {
    if (!projectId) return;
    const generation = current.current.generation;
    void refreshTasks();
    try { const result = await api.notes(projectId); apply(state => acceptSnapshot(state, result, generation)); }
    catch (error) {
      apply(state => generation !== state.generation || projectId !== state.projectId ? state : { ...state, loading: false, available: !(error instanceof ApiError && error.status === 503), error: error instanceof Error ? error.message : String(error) });
    }
  }, [projectId, apply, refreshTasks]);
  useEffect(() => {
    apply(previous => ({ ...initialNotesState(projectId), generation: previous.generation + 1 }));
    setTasks([]); setTasksError(null);
    void refresh();
    return () => { current.current = reconnectNotes(current.current); };
  }, [projectId, refresh, apply]);

  const onOpen = useCallback(() => { apply(reconnectNotes); void refresh(); }, [apply, refresh]);
  const onConnection = useCallback((online: boolean) => { setConnected(online); if (!online) apply(reconnectNotes); }, [apply]);
  const onNotes = useCallback((snapshot: NotesSnapshot) => apply(state => acceptSnapshot(state, snapshot, state.generation)), [apply]);
  const onNotesStatus = useCallback((status: NotesStatus) => apply(state => acceptStatus(state, status, state.generation)), [apply]);
  const mutate = useCallback(async (action: () => ReturnType<typeof api.createNote>) => {
    const generation = current.current.generation;
    const result = await action();
    if (generation !== current.current.generation || result.projectId !== current.current.projectId || current.current.serverSessionId !== null && current.current.serverSessionId !== result.serverSessionId) {
      throw new Error('Connection changed while saving. Your draft is kept. Retry to confirm the save.');
    }
    apply(state => acceptNote(state, result, generation));
    return current.current.notes.find(n => n.id === result.note.id) ?? result.note;
  }, [apply]);
  const create = useCallback((input: Omit<NoteCreateInput, 'projectId'>) => mutate(() => api.createNote({ ...input, projectId })), [projectId, mutate]);
  const update = useCallback((id: string, input: Omit<NoteUpdateInput, 'projectId'>) => mutate(() => api.updateNote(id, { ...input, projectId })), [projectId, mutate]);
  const setStatus = useCallback((note: Note, status: Note['status']) => update(note.id, { expectedRevision: note.revision, status }), [update]);
  return { ...state, tasks, tasksError, connected, refresh, refreshTasks, create, update, setStatus, onOpen, onConnection, onNotes, onNotesStatus };
}
export type NotesController = ReturnType<typeof useNotes>;
