import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { beforeEach, afterEach, expect, test } from 'vitest';
import { NotesService } from '../src/orchestrator/notes.ts';
import { registerNotesRoutes } from '../src/server/notes-routes.ts';
import { Broadcaster } from '../src/server/sse.ts';
import { registerRoutes } from '../src/server/routes.ts';
import { createHealthResponse } from '../src/server/health.ts';
import type { Config } from '../src/shared/types.ts';

let home: string;
let service: NotesService;
let app: ReturnType<typeof Fastify>;
let broadcaster: Broadcaster;
const projectId = 'acme__app';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mc-notes-http-'));
  broadcaster = new Broadcaster();
  service = new NotesService({ home, projectId, tasks: () => [{ issue: 42, title: 'Task' }], onSnapshot: value => broadcaster.send('notes', value), onStatus: value => broadcaster.send('notes-status', value) });
  await service.start();
  app = Fastify();
  registerNotesRoutes(app, { service });
});
afterEach(async () => { await app.close(); await service.close(); await rm(home, { recursive: true, force: true }); });
const create = (extra = {}) => app.inject({ method: 'POST', url: '/api/notes', payload: { projectId, body: 'Text', clientRequestId: randomUUID(), ...extra } });
test('serves collection, task choices, note and revision-aware edits', async () => {
  expect((await app.inject('/api/notes')).json()).toMatchObject({ projectId, revision: 0, notes: [] });
  expect((await app.inject(`/api/notes/tasks?projectId=${projectId}`)).json()).toEqual({ projectId, tasks: [{ issue: 42, title: 'Task' }] });
  const saved = (await create()).json();
  expect((await app.inject(`/api/notes/${saved.note.id}`)).json()).toEqual(saved);
  const patch = await app.inject({ method: 'PATCH', url: `/api/notes/${saved.note.id}`, payload: { projectId, expectedRevision: 1, status: 'settled' } });
  expect(patch.json()).toMatchObject({ serverSessionId: saved.serverSessionId, note: { revision: 2, status: 'settled' } });
  const stale = await app.inject({ method: 'PATCH', url: `/api/notes/${saved.note.id}`, payload: { projectId, expectedRevision: 1, body: 'Stale' } });
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({ code: 'NOTE_REVISION_CONFLICT', currentNote: { revision: 2 } });
});
test('checks project identity on every route and requires it on writes', async () => {
  for (const url of ['/api/notes', '/api/notes/tasks', `/api/notes/${randomUUID()}`]) {
    expect((await app.inject(`${url}?projectId=other__repo`)).statusCode).toBe(409);
  }
  expect((await create({ projectId: undefined })).statusCode).toBe(400);
  expect((await create({ projectId: 'other__repo' })).statusCode).toBe(409);
  expect((await app.inject('/api/notes/not-a-uuid')).statusCode).toBe(400);
  expect((await app.inject(`/api/notes/${randomUUID()}`)).statusCode).toBe(404);
  expect((await create({ unknown: true })).statusCode).toBe(400);
  expect((await create({ body: 'x'.repeat(65537) })).statusCode).toBe(413);
});
test('replays empty and committed snapshots, and suppresses replay when requested', async () => {
  const capture = (replay: boolean) => {
    const chunks: string[] = [];
    const raw = new PassThrough();
    raw.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    broadcaster.add({ raw } as never, { replay });
    return chunks;
  };
  const empty = capture(true).join('');
  expect(empty).toContain('event: notes\n');
  expect(empty).toContain('"available":true');
  expect(empty).toContain('"notes":[]');
  await create();
  expect(capture(true).join('')).toContain('"body":"Text"');
  expect(capture(false)).toEqual([]);
});
test('lease conflict disables notes routes and publishes only unavailable status', async () => {
  const chunks: string[] = [];
  const secondBroadcaster = new Broadcaster();
  const second = new NotesService({ home, projectId, tasks: () => [], onSnapshot: value => secondBroadcaster.send('notes', value), onStatus: value => secondBroadcaster.send('notes-status', value) });
  await second.start();
  const secondApp = Fastify();
  const config = {
    repo: { path: home, owner: 'acme', name: 'app', baseBranch: 'main', branchPrefix: 'alice/' },
    github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' }, agents: {}, pipeline: [], server: { port: 4317 },
  } satisfies Config;
  let reconciles = 0;
  registerRoutes(secondApp, { config, broadcaster: secondBroadcaster, refresh: async () => { reconciles++; return []; }, health: createHealthResponse('0.1.0'), notes: second });
  const raw = new PassThrough();
  raw.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  secondBroadcaster.add({ raw } as never);
  expect(chunks.join('')).toContain('NOTES_ALREADY_OPEN');
  expect(chunks.join('')).not.toContain('event: notes\n');
  expect((await secondApp.inject('/api/notes')).statusCode).toBe(503);
  expect((await secondApp.inject('/api/health')).statusCode).toBe(200);
  expect((await secondApp.inject('/api/tasks')).statusCode).toBe(200);
  expect(reconciles).toBe(1);
  await secondApp.close();
  await second.close();
});
