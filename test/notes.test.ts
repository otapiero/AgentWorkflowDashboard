import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { NotesService } from '../src/orchestrator/notes.ts';
import type { NoteTask, NotesSnapshot } from '../src/shared/notes.ts';

let home: string;
let service: NotesService;
let tasks: NoteTask[];
let snapshots: NotesSnapshot[];
const projectId = 'acme__app';
const input = (extra = {}) => ({ projectId, body: '  Remember\nthis  ', clientRequestId: randomUUID(), ...extra });
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mc-notes-'));
  tasks = [{ issue: 42, title: 'Retry policy' }];
  snapshots = [];
  service = new NotesService({ home, projectId, tasks: () => tasks, onSnapshot: value => snapshots.push(value) });
  await service.start();
});
afterEach(async () => { await service.close(); await rm(home, { recursive: true, force: true }); });

test('commits and restarts with private metadata omitted from public snapshots', async () => {
  const saved = await service.create(input());
  expect(saved.note).toMatchObject({ body: '  Remember\nthis  ', title: null, taskIssue: null, revision: 1, status: 'active' });
  expect(saved.note).not.toHaveProperty('creationFingerprint');
  expect(JSON.parse(await readFile(join(home, 'notes.json'), 'utf8')).notes[0]).toHaveProperty('creationFingerprint');
  await service.close();
  service = new NotesService({ home, projectId, tasks: () => tasks });
  await service.start();
  expect((await service.snapshot()).notes).toEqual([saved.note]);
  expect((await service.snapshot()).serverSessionId).not.toBe(saved.serverSessionId);
});
test('returns committed creation after its task is forgotten and its content is edited', async () => {
  const request = input({ taskIssue: 42 });
  const first = await service.create(request);
  await service.update(first.note.id, { projectId, expectedRevision: 1, body: 'Edited' });
  tasks = [];
  expect((await service.create(request)).note).toMatchObject({ id: first.note.id, body: 'Edited', taskIssue: 42, taskTitleAtLink: 'Retry policy' });
  expect((await service.snapshot()).notes).toHaveLength(1);
  await expect(service.create({ ...request, body: 'Changed' })).rejects.toMatchObject({ code: 'NOTE_REQUEST_CONFLICT', statusCode: 409 });
});
test('normalizes absent and null creation title/link for retries', async () => {
  const request = input();
  const first = await service.create(request);
  expect((await service.create({ ...request, title: null, taskIssue: null })).note.id).toBe(first.note.id);
});
test('serializes optimistic updates and preserves unchanged forgotten links', async () => {
  const { note } = await service.create(input({ taskIssue: 42 }));
  tasks = [];
  const results = await Promise.allSettled([
    service.update(note.id, { projectId, expectedRevision: 1, body: 'One', taskIssue: 42 }),
    service.update(note.id, { projectId, expectedRevision: 1, body: 'Two' }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'NOTE_REVISION_CONFLICT', currentNote: { revision: 2 } } });
  await expect(service.update(note.id, { projectId, expectedRevision: 2, taskIssue: 999 })).rejects.toMatchObject({ statusCode: 404 });
  expect((await service.update(note.id, { projectId, expectedRevision: 2, taskIssue: null })).note.taskTitleAtLink).toBeNull();
});
test('settles, repeats a transition without committing, and reopens', async () => {
  const { note } = await service.create(input());
  const settled = await service.update(note.id, { projectId, expectedRevision: 1, status: 'settled' });
  expect(settled.note.settledAt).toBeTruthy();
  const revision = (await service.snapshot()).revision;
  expect((await service.update(note.id, { projectId, expectedRevision: 2, status: 'settled' })).note).toEqual(settled.note);
  expect((await service.snapshot()).revision).toBe(revision);
  expect((await service.update(note.id, { projectId, expectedRevision: 2, status: 'active' })).note.settledAt).toBeNull();
});
test('rejects malformed, oversized, unknown-task and mismatched-project requests', async () => {
  for (const extra of [{ body: ' \n' }, { clientRequestId: 'invalid' }, { title: 'x'.repeat(241) }, { unknown: true }]) {
    await expect(service.create(input(extra))).rejects.toMatchObject({ statusCode: 400 });
  }
  await expect(service.create(input({ body: 'א'.repeat(32769) }))).rejects.toMatchObject({ statusCode: 413 });
  await expect(service.create(input({ taskIssue: 999 }))).rejects.toMatchObject({ statusCode: 404 });
  await expect(service.create(input({ projectId: 'other__repo' }))).rejects.toMatchObject({ code: 'NOTES_PROJECT_MISMATCH', statusCode: 409 });
});
test.each(['{"version":2,"revision":0,"notes":[]}', '{broken', '{"version":1,"revision":0,"notes":[{}]}'])('preserves unsupported or corrupt storage: %s', async contents => {
  await service.close();
  await writeFile(join(home, 'notes.json'), contents);
  service = new NotesService({ home, projectId, tasks: () => tasks, onSnapshot: value => snapshots.push(value) });
  snapshots = [];
  await service.start();
  await expect(service.snapshot()).rejects.toMatchObject({ statusCode: 503 });
  expect(snapshots).toEqual([]);
  expect(await readFile(join(home, 'notes.json'), 'utf8')).toBe(contents);
});
test('failed commit leaves memory and broadcasts untouched', async () => {
  const { note } = await service.create(input());
  const before = await service.snapshot();
  const count = snapshots.length;
  await rm(join(home, 'notes.json'));
  await mkdir(join(home, 'notes.json'));
  await expect(service.update(note.id, { projectId, expectedRevision: 1, body: 'Uncommitted' })).rejects.toMatchObject({ statusCode: 503 });
  expect(await service.snapshot()).toEqual(before);
  expect(snapshots).toHaveLength(count);
});
test('pins home despite active-project changes and keeps repositories isolated', async () => {
  const otherHome = await mkdtemp(join(tmpdir(), 'mc-notes-other-'));
  const other = new NotesService({ home: otherHome, projectId: 'acme__other', tasks: () => [] });
  await other.start();
  try {
    await service.create(input());
    expect((await other.snapshot()).notes).toEqual([]);
    expect((await service.snapshot()).projectId).toBe(projectId);
  } finally { await other.close(); await rm(otherHome, { recursive: true, force: true }); }
});
test('a publication observes the committed file and starts from a populated replay', async () => {
  const { note } = await service.create(input());
  await service.close();
  const observed: number[] = [];
  service = new NotesService({ home, projectId, tasks: () => tasks, onSnapshot: snapshot => {
    const persisted = JSON.parse(readFileSync(join(home, 'notes.json'), 'utf8'));
    expect(persisted.revision).toBe(snapshot.revision);
    expect(persisted.notes.map((record: { body: string }) => record.body)).toEqual(snapshot.notes.map(record => record.body));
    observed.push(snapshot.revision);
  } });
  await service.start();
  await service.update(note.id, { projectId, expectedRevision: 1, body: 'New content' });
  expect(observed).toEqual([1, 2]);
});
