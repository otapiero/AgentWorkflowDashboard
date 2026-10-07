import { afterEach, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Broadcaster } from '../src/server/sse.ts';
import { api, ApiError, subscribe } from '../src/web/api.ts';
import { initialNotesState, reconnectNotes, acceptSnapshot, acceptNote, acceptStatus } from '../src/web/notes-model.ts';
import type { Note, NotesSnapshot, NotesStatus } from '../src/shared/notes.ts';
const n: Note = { id: 'a', title: null, body: 'old', taskIssue: null, taskTitleAtLink: null, status: 'active', createdAt: '', updatedAt: '', settledAt: null, revision: 1, clientRequestId: 'request' };
const snapshot = (revision = 1, session = 's1'): NotesSnapshot => ({ projectId: 'p', serverSessionId: session, revision, notes: [n] });
const unavailable: NotesStatus = { projectId: 'p', serverSessionId: 's1', available: false, code: 'NOTES_LEASE_LOST', error: 'Lease lost' };
test('lower collection revision cannot replace latest snapshot', () => {
  const state = acceptSnapshot(initialNotesState('p'), snapshot(4), 0);
  expect(acceptSnapshot(state, snapshot(2), 0)).toBe(state);
});
test('pre-reconnect fetch and mutation responses are ignored', () => {
  const state = acceptSnapshot(reconnectNotes(acceptSnapshot(initialNotesState('p'), snapshot(5), 0)), snapshot(1, 's2'), 1);
  expect(acceptSnapshot(state, snapshot(99), 0)).toBe(state);
  expect(acceptNote(state, { ...snapshot(), note: { ...n, revision: 99 } }, 0)).toBe(state);
  expect(state.serverSessionId).toBe('s2');
});
test('acknowledgments never lower a note revision or advance collection revision', () => {
  const state = acceptSnapshot(initialNotesState('p'), snapshot(5), 0);
  const updated = acceptNote(state, { ...snapshot(), note: { ...n, revision: 3, body: 'new' } }, 0);
  expect(updated.revision).toBe(5);
  expect(acceptNote(updated, { ...snapshot(), note: n }, 0)).toBe(updated);
  expect(acceptSnapshot(updated, snapshot(6), 0).notes[0]?.body).toBe('new');
});
test('new session resets the collection baseline and note revisions', () => {
  const state = acceptSnapshot(reconnectNotes(acceptSnapshot(initialNotesState('p'), snapshot(9), 0)), snapshot(1, 's2'), 1);
  expect(state.revision).toBe(1); expect(state.serverSessionId).toBe('s2');
});
test('a new-session status arriving before snapshot cannot carry old notes into the new session', () => {
  const previous = acceptSnapshot(initialNotesState('p'), { ...snapshot(9), notes: [{ ...n, revision: 9 }, { ...n, id: 'old-only' }] }, 0);
  const ready = acceptStatus(reconnectNotes(previous), { projectId: 'p', serverSessionId: 's2', available: true }, 1);
  const next = acceptSnapshot(ready, snapshot(1, 's2'), 1);
  expect(next.notes.map(note => [note.id, note.revision])).toEqual([['a', 1]]);
});
test('new-session mutation acknowledgment does not compare against old-session note revisions', () => {
  const previous = acceptSnapshot(initialNotesState('p'), { ...snapshot(9), notes: [{ ...n, revision: 9 }] }, 0);
  const ready = acceptStatus(reconnectNotes(previous), { projectId: 'p', serverSessionId: 's2', available: true }, 1);
  expect(acceptNote(ready, { projectId: 'p', serverSessionId: 's2', note: n }, 1).notes[0]?.revision).toBe(1);
});
test('wrong repository and unexpected sessions cannot replace collection', () => {
  const state = acceptSnapshot(initialNotesState('p'), snapshot(), 0);
  expect(acceptSnapshot(state, { ...snapshot(9), projectId: 'other' }, 0)).toBe(state);
  expect(acceptNote(state, { ...snapshot(9, 'other'), note: n }, 0)).toBe(state);
});
test('unavailable status preserves collection and remains separate from loading', () => {
  const state = acceptStatus(acceptSnapshot(initialNotesState('p'), snapshot(), 0), { projectId: 'p', serverSessionId: 's1', available: false, code: 'NOTES_STORE_INVALID', error: 'Cannot read notes' }, 0);
  expect(state.notes).toEqual([n]); expect(state.loading).toBe(false); expect(state.error).toBe('Cannot read notes'); expect(state.available).toBe(false);
});
test.each([1, 2])('same-session snapshot revision %s cannot clear unavailable status', revision => {
  const state = acceptStatus(acceptSnapshot(initialNotesState('p'), snapshot(), 0), unavailable, 0);
  const next = acceptSnapshot(state, snapshot(revision), 0);
  expect(next.notes).toEqual([n]);
  expect(next).toMatchObject({ revision, loading: false, available: false, error: 'Lease lost' });
});

test('successful GET started before unavailable status cannot restore availability', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = api.notes('p');
  const state = acceptStatus(acceptSnapshot(initialNotesState('p'), snapshot(), 0), unavailable, 0);
  finish(new Response(JSON.stringify(snapshot()), { status: 200 }));
  const next = acceptSnapshot(state, await pending, 0);
  expect(next.notes).toEqual([n]);
  expect(next).toMatchObject({ available: false, error: 'Lease lost' });
});

test('Broadcaster status-before-notes replay preserves unavailable status and cached notes', () => {
  const broadcaster = new Broadcaster();
  broadcaster.send('notes-status', { projectId: 'p', serverSessionId: 's1', available: true });
  broadcaster.send('notes', snapshot());
  broadcaster.send('notes-status', unavailable);
  const raw = new PassThrough();
  const chunks: string[] = [];
  raw.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  broadcaster.add({ raw } as never);
  let state = initialNotesState('p');
  const events: string[] = [];
  for (const chunk of chunks) {
    const [event, data] = chunk.trim().split('\n');
    const name = event!.slice('event: '.length);
    const payload = JSON.parse(data!.slice('data: '.length));
    events.push(name);
    state = name === 'notes-status' ? acceptStatus(state, payload, 0) : acceptSnapshot(state, payload, 0);
  }
  raw.destroy();
  expect(events).toEqual(['notes-status', 'notes']);
  expect(state.notes).toEqual([n]);
  expect(state).toMatchObject({ loading: false, available: false, error: 'Lease lost' });
});

test.each([false, true])('new healthy session recovers with status first = %s', statusFirst => {
  const failed = acceptStatus(acceptSnapshot(initialNotesState('p'), snapshot(9), 0), unavailable, 0);
  let state = reconnectNotes(failed);
  if (statusFirst) state = acceptStatus(state, { projectId: 'p', serverSessionId: 's2', available: true }, 1);
  const next = acceptSnapshot(state, snapshot(1, 's2'), 1);
  expect(next).toMatchObject({ serverSessionId: 's2', revision: 1, available: true, error: null });
  expect(next.notes).toEqual([n]);
});

test('same-session reconnect preserves last notes and unavailable error', () => {
  const failed = acceptStatus(acceptSnapshot(initialNotesState('p'), snapshot(), 0), unavailable, 0);
  const reconnecting = reconnectNotes(failed);
  expect(reconnecting.notes).toEqual([n]);
  const next = acceptSnapshot(reconnecting, snapshot(), 1);
  expect(next.notes).toEqual([n]);
  expect(next).toMatchObject({ available: false, error: 'Lease lost' });
});

test('explicit same-session available status restores availability', () => {
  const failed = acceptStatus(acceptSnapshot(initialNotesState('p'), snapshot(), 0), unavailable, 0);
  const ready = acceptStatus(failed, { projectId: 'p', serverSessionId: 's1', available: true }, 0);
  expect(ready).toMatchObject({ available: true, error: null });
  expect(acceptSnapshot(ready, snapshot(2), 0)).toMatchObject({ available: true, error: null });
});
afterEach(() => vi.unstubAllGlobals());
test('API preserves conflict code and current note for recovery', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 'REVISION_CONFLICT', error: 'Changed elsewhere', currentNote: { ...n, revision: 2 } }), { status: 409 }));
  await expect(api.updateNote('a', { projectId: 'p', expectedRevision: 1, body: 'mine' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', currentNote: { revision: 2 }, status: 409 });
});
test('SSE notes and lifecycle callbacks share the board subscription', () => {
  class Source extends EventTarget { close() {} }
  const source = new Source(); vi.stubGlobal('EventSource', class { constructor() { return source; } });
  const events: string[] = [];
  const stop = subscribe({ onTasks: () => events.push('tasks'), onPoll: () => {}, onStatus: connected => events.push(connected ? 'connected' : 'offline'), onOpen: () => events.push('open'), onNotes: notes => events.push(notes.projectId), onNotesStatus: status => events.push(status.available ? 'available' : 'unavailable') });
  source.dispatchEvent(new Event('open'));
  source.dispatchEvent(new MessageEvent('notes', { data: JSON.stringify(snapshot()) }));
  source.dispatchEvent(new MessageEvent('notes-status', { data: JSON.stringify({ available: false }) }));
  source.dispatchEvent(new MessageEvent('tasks', { data: '[]' }));
  source.dispatchEvent(new Event('error')); stop();
  expect(events).toEqual(['open', 'connected', 'p', 'unavailable', 'tasks', 'offline']);
});
