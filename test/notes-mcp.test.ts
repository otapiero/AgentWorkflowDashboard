import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { NotesService } from '../src/orchestrator/notes.ts';
import { registerNotesRoutes } from '../src/server/notes-routes.ts';
import { createNotesMcpServer } from '../src/mcp/server.ts';
import { NotesApiClient } from '../src/mcp/client.ts';
import type { NoteResult, NoteTask } from '../src/shared/notes.ts';

const projectId = 'acme__widgets';
let home: string;
let service: NotesService;
let app: FastifyInstance;
let serverUrl: string;
let tasks: NoteTask[];
let captured: { method: string; url: string; body: any }[];
let intercept: ((req: FastifyRequest, reply: FastifyReply) => Promise<void> | void) | undefined;
let dropCreates = 0;
let dropUpdates = 0;
const cleanup: (() => Promise<unknown>)[] = [];
const cliArgs = () => ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
  resolve('src/orchestrator/cli.ts'), 'mcp', '--project', projectId, '--server-url', serverUrl];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'mc-mcp-'));
  tasks = [{ issue: 42, title: 'Release timing' }, { issue: 53, title: 'Retry policy' }];
  captured = []; intercept = undefined; dropCreates = 0; dropUpdates = 0;
  service = new NotesService({ home, projectId, tasks: () => tasks });
  await service.start();
  app = Fastify({ logger: false });
  app.addHook('preHandler', async (req, reply) => {
    captured.push({ method: req.method, url: req.url, body: req.body });
    await intercept?.(req, reply);
  });
  app.addHook('onSend', async (req, reply, payload) => {
    if ((req.method === 'POST' && dropCreates-- > 0) || (req.method === 'PATCH' && dropUpdates-- > 0)) {
      reply.raw.destroy();
    }
    return payload;
  });
  registerNotesRoutes(app, { service });
  serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await app.close(); await service.close();
  if (!resolve(home).startsWith(resolve(tmpdir()) + '\\')) throw new Error('Unexpected MCP fixture cleanup target');
  await rm(home, { recursive: true, force: true });
});

async function protocol(mode: 'legacy' | 'modern' = 'legacy', options = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createNotesMcpServer({ projectId, serverUrl, ...options }), { transport: serverTransport });
  const client = new Client({ name: 'notes-test', version: '1.0' }, {
    versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
  });
  cleanup.push(() => handle.close(), () => client.close());
  await client.connect(clientTransport);
  return client;
}
function structured(result: any): any { return result.structuredContent; }
async function create(client: Client, args: Record<string, unknown> = {}): Promise<NoteResult> {
  const result = await client.callTool({ name: 'notes_create', arguments: { body: 'Check release timing', ...args } });
  expect(result.isError).not.toBe(true);
  return structured(result);
}

test.each(['legacy', 'modern'] as const)('discovers six tools with read and write annotations over %s protocol', async mode => {
  const client = await protocol(mode);
  expect(client.getNegotiatedProtocolVersion()).toBe(mode === 'modern' ? '2026-07-28' : '2025-11-25');
  const { tools } = await client.listTools();
  expect(tools.map(tool => tool.name).sort()).toEqual(['notes_create', 'notes_get', 'notes_list', 'notes_set_status', 'notes_update', 'tasks_list']);
  for (const tool of tools) {
    expect(tool.annotations?.readOnlyHint).toBe(['tasks_list', 'notes_list', 'notes_get'].includes(tool.name));
    expect(tool.annotations?.openWorldHint).toBe(false);
  }
  expect(tools.find(tool => tool.name === 'notes_create')?.annotations?.idempotentHint).toBe(false);
  expect(tools.find(tool => tool.name === 'notes_update')?.annotations?.destructiveHint).toBe(true);
  const saved = await create(client);
  expect(saved.note).toMatchObject({ taskIssue: null, status: 'active' });
});

test('creation without taskIssue is General and every read/write pins the project', async () => {
  const client = await protocol();
  const saved = await create(client, { body: '  Check\nrelease timing  ' });
  expect(saved.note).toMatchObject({ title: null, taskIssue: null, body: '  Check\nrelease timing  ' });
  expect(captured[0]!.body).toMatchObject({ projectId, taskIssue: null });
  expect(captured[0]!.body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  await client.callTool({ name: 'tasks_list', arguments: { search: '42' } });
  await client.callTool({ name: 'notes_list', arguments: {} });
  await client.callTool({ name: 'notes_get', arguments: { id: saved.note.id } });
  await client.callTool({ name: 'notes_update', arguments: { id: saved.note.id, expectedRevision: 1, title: 'Changed' } });
  await client.callTool({ name: 'notes_set_status', arguments: { id: saved.note.id, expectedRevision: 2, status: 'settled' } });
  for (const request of captured) {
    if (request.method === 'GET') expect(new URL(request.url, serverUrl).searchParams.get('projectId')).toBe(projectId);
    else expect(request.body.projectId).toBe(projectId);
  }
});

test('links by issue number, filters active/general/task/settled/search, and settles and reopens', async () => {
  const client = await protocol('modern');
  const general = await create(client);
  const linked = await create(client, { taskIssue: 42, title: 'Deployment' });
  expect(linked.note).toMatchObject({ taskIssue: 42, taskTitleAtLink: 'Release timing' });
  const taskResult = structured(await client.callTool({ name: 'tasks_list', arguments: { search: 'retry' } }));
  expect(taskResult.tasks).toEqual([{ issue: 53, title: 'Retry policy' }]);
  const list = async (args = {}) => structured(await client.callTool({ name: 'notes_list', arguments: args })).notes;
  expect((await list({ scope: 'general' })).map((n: any) => n.id)).toEqual([general.note.id]);
  expect((await list({ scope: 'task', taskIssue: 42 })).map((n: any) => n.id)).toEqual([linked.note.id]);
  expect((await list({ search: 'Deployment' })).map((n: any) => n.id)).toEqual([linked.note.id]);
  expect((await list({ search: '#42' })).map((n: any) => n.id)).toEqual([linked.note.id]);
  const settled = structured(await client.callTool({ name: 'notes_set_status', arguments: { id: linked.note.id, expectedRevision: 1, status: 'settled' } }));
  expect(settled.note).toMatchObject({ revision: 2, status: 'settled' });
  expect(settled.note.settledAt).toBeTruthy();
  expect((await list()).map((n: any) => n.id)).toEqual([general.note.id]);
  expect((await list({ status: 'settled' })).map((n: any) => n.id)).toEqual([linked.note.id]);
  expect(await list({ status: 'all' })).toHaveLength(2);
  const reopened = structured(await client.callTool({ name: 'notes_set_status', arguments: { id: linked.note.id, expectedRevision: 2, status: 'active' } }));
  expect(reopened.note).toMatchObject({ revision: 3, status: 'active', settledAt: null });
});

test('unknown tasks, stale revisions and project changes return structured errors without writes', async () => {
  const client = await protocol();
  const unknown = await client.callTool({ name: 'notes_create', arguments: { body: 'Invalid link', taskIssue: 999 } });
  expect(unknown.isError).toBe(true); expect(structured(unknown).code).toBe('TASK_NOT_FOUND');
  const saved = await create(client);
  await client.callTool({ name: 'notes_update', arguments: { id: saved.note.id, expectedRevision: 1, body: 'Changed' } });
  const conflict = await client.callTool({ name: 'notes_set_status', arguments: { id: saved.note.id, expectedRevision: 1, status: 'settled' } });
  expect(conflict.isError).toBe(true);
  expect(structured(conflict)).toMatchObject({ code: 'NOTE_REVISION_CONFLICT', currentNote: { revision: 2, body: 'Changed' } });
  const wrong = await protocol('legacy', { projectId: 'other__repo' });
  for (const [name, args] of [['tasks_list', {}], ['notes_list', {}], ['notes_get', { id: saved.note.id }], ['notes_create', { body: 'Wrong repo' }], ['notes_update', { id: saved.note.id, expectedRevision: 2, body: 'Wrong' }], ['notes_set_status', { id: saved.note.id, expectedRevision: 2, status: 'settled' }]] as const) {
    const result = await wrong.callTool({ name, arguments: args });
    expect(result.isError).toBe(true); expect(structured(result).code).toBe('NOTES_PROJECT_MISMATCH');
  }
  expect((await service.snapshot()).notes).toHaveLength(1);
});

test('lost creation acknowledgement retries the exact request ID and survives task removal', async () => {
  const client = await protocol();
  dropCreates = 1;
  const saved = await create(client, { taskIssue: 42 });
  expect(captured.filter(req => req.method === 'POST')).toHaveLength(2);
  expect(captured[0]!.body).toEqual(captured[1]!.body);
  expect((await service.snapshot()).notes).toHaveLength(1);
  tasks = [];
  const retry = await create(client, { taskIssue: 42, clientRequestId: saved.note.clientRequestId });
  expect(retry.note.id).toBe(saved.note.id);
  const different = await client.callTool({ name: 'notes_create', arguments: { body: 'Different', taskIssue: 42, clientRequestId: saved.note.clientRequestId } });
  expect(structured(different).code).toBe('NOTE_REQUEST_CONFLICT');
});

test('uncertain creation exposes its request ID for a safe later tool retry', async () => {
  const client = await protocol();
  dropCreates = 2;
  const result = await client.callTool({ name: 'notes_create', arguments: { body: 'One durable note' } });
  expect(result.isError).toBe(true);
  expect(structured(result)).toMatchObject({ code: 'MC_UNAVAILABLE', clientRequestId: captured[0]!.body.clientRequestId });
  expect(captured[0]!.body).toEqual(captured[1]!.body);
  expect((await service.snapshot()).notes).toHaveLength(1);
  const saved = await create(client, { body: 'One durable note', clientRequestId: structured(result).clientRequestId });
  expect(saved.note.id).toBe((await service.snapshot()).notes[0]!.id);
});

test('uncertain revision mutation is not retried and a fresh get reveals the committed edit', async () => {
  const client = await protocol();
  const saved = await create(client, { taskIssue: 42, title: 'Original' });
  dropUpdates = 1;
  const result = await client.callTool({ name: 'notes_update', arguments: { id: saved.note.id, expectedRevision: 1, title: null, taskIssue: null, body: '  Edited  ' } });
  expect(result.isError).toBe(true); expect(structured(result).code).toBe('MC_UNAVAILABLE');
  expect(captured.filter(req => req.method === 'PATCH')).toHaveLength(1);
  const latest = structured(await client.callTool({ name: 'notes_get', arguments: { id: saved.note.id } }));
  expect(latest.note).toMatchObject({ revision: 2, title: null, taskIssue: null, taskTitleAtLink: null, body: '  Edited  ' });
});

test('write confirmation stays short while notes_get supplies the full text', async () => {
  const client = await protocol();
  const body = 'x'.repeat(65536);
  const result = await client.callTool({ name: 'notes_create', arguments: { body } });
  expect(result.isError).not.toBe(true);
  const saved = structured(result);
  const text = (result.content as { type: string; text?: string }[]).map(item => item.text ?? '').join('');
  expect(text).toContain(saved.note.id); expect(text).toContain(projectId);
  expect(text).toContain('General'); expect(text).toContain('active');
  expect(text.length).toBeLessThan(400);
  const read = await client.callTool({ name: 'notes_get', arguments: { id: saved.note.id } });
  expect(structured(read).note.body).toBe(body);
  expect((read.content as { text?: string }[]).map(item => item.text ?? '').join('')).toContain(body);
});

test('API errors preserve storage diagnostics and unknown note codes; malformed errors are rejected', async () => {
  const client = await protocol();
  const missing = await client.callTool({ name: 'notes_get', arguments: { id: randomUUID() } });
  expect(structured(missing).code).toBe('NOTE_NOT_FOUND');
  intercept = (_req, reply) => { reply.code(503).send({ code: 'NOTES_STORE_INVALID', error: 'The original notes.json was preserved.' }); };
  const unavailable = await client.callTool({ name: 'notes_list', arguments: {} });
  expect(structured(unavailable)).toEqual({ code: 'NOTES_STORE_INVALID', error: 'The original notes.json was preserved.' });
  intercept = (_req, reply) => { reply.code(500).send({ unexpected: 'HTML server' }); };
  expect(structured(await client.callTool({ name: 'notes_list', arguments: {} })).code).toBe('MC_INVALID_RESPONSE');
});

test('a successful response must acknowledge the requested note or creation request ID', async () => {
  const client = await protocol();
  const saved = await create(client);
  intercept = (req, reply) => { reply.send({ ...saved, note: { ...saved.note, ...(req.method === 'POST' ? { clientRequestId: randomUUID() } : { id: randomUUID() }) } }); };
  for (const [name, args] of [['notes_get', { id: saved.note.id }], ['notes_update', { id: saved.note.id, expectedRevision: 1, body: 'Edit' }], ['notes_create', { body: 'New' }]] as const) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true); expect(structured(result).code).toBe('MC_INVALID_RESPONSE');
    if (name === 'notes_create') expect(structured(result).clientRequestId).toBe(captured.at(-1)!.body.clientRequestId);
  }
});

test.each([
  ['notes_create', { body: 'OK', taskIssue: 0 }],
  ['notes_create', { body: 'OK', taskIssue: 1.5 }], ['notes_create', { body: 'OK', taskIssue: Number.MAX_SAFE_INTEGER + 1 }],
  ['notes_create', { body: 'OK', projectId: 'injected' }],
  ['notes_get', { id: '../tasks' }], ['notes_list', { scope: 'task' }], ['notes_list', { scope: 'general', taskIssue: 42 }],
  ['notes_update', { id: randomUUID(), body: 'OK' }], ['notes_update', { id: randomUUID(), expectedRevision: 1 }],
  ['notes_set_status', { id: randomUUID(), expectedRevision: 0, status: 'settled' }],
  ['notes_set_status', { id: randomUUID(), expectedRevision: 1, status: 'deleted' }],
] as const)('rejects invalid %s arguments before HTTP dispatch, case %#', async (name, args) => {
  const client = await protocol();
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true); expect(captured).toHaveLength(0);
});

test.each(['https://127.0.0.1:4317', 'http://example.com', 'http://127.0.0.1.example.com', 'http://0.0.0.0:4317', 'http://user:secret@localhost:4317', 'http://localhost:4317/base', 'http://localhost:4317?x=y', 'http://localhost:4317/#x'])('rejects non-loopback or ambiguous URL %s', url => {
  expect(() => new NotesApiClient({ projectId, serverUrl: url })).toThrow();
});
test.each(['http://127.0.0.1:4317', 'http://localhost:4317', 'http://[::1]:4317'])('accepts loopback HTTP origin %s', url => {
  expect(() => new NotesApiClient({ projectId, serverUrl: url })).not.toThrow();
});

test('never follows redirects and never reports malformed or wrong-project responses as success', async () => {
  const client = await protocol();
  for (const bad of [
    { redirect: `${serverUrl}/escaped` }, { body: '<html>wrong server</html>' },
    { body: { projectId, serverSessionId: randomUUID(), revision: 0, notes: [{ id: 'bad' }] } },
    { body: { projectId: 'other__repo', serverSessionId: randomUUID(), revision: 0, notes: [] } },
  ]) {
    intercept = (_req, reply) => { if ('redirect' in bad) reply.redirect(bad.redirect!); else reply.send(bad.body); };
    const result = await client.callTool({ name: 'notes_list', arguments: {} });
    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe('body' in bad && typeof bad.body === 'object' && bad.body.projectId === 'other__repo' ? 'NOTES_PROJECT_MISMATCH' : 'MC_INVALID_RESPONSE');
  }
  expect(captured.some(req => req.url.includes('escaped'))).toBe(false);
});

test('HTTP timeout and stopped server return MC_UNAVAILABLE with no file fallback', async () => {
  const client = await protocol('legacy', { timeoutMs: 30 });
  intercept = async (_req, reply) => { await new Promise(resolve => setTimeout(resolve, 100)); reply.send({}); };
  const timed = await client.callTool({ name: 'tasks_list', arguments: {} });
  expect(structured(timed).code).toBe('MC_UNAVAILABLE');
  await app.close();
  const stopped = await client.callTool({ name: 'notes_create', arguments: { body: 'Must not write' } });
  expect(structured(stopped).code).toBe('MC_UNAVAILABLE');
  expect(await readdir(home)).not.toContain('notes.json');
});

test('spawned CLI handles MCP before config loading and emits only protocol JSON on stdout', async () => {
  const child = spawn(process.execPath, cliArgs(), {
    cwd: home, env: { ...process.env, MC_ROOT: home, MC_HOME: join(home, 'missing-config') }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  });
  let stdout = ''; let stderr = ''; const replies: any[] = []; const invalidLines: string[] = [];
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    const lines = stdout.split('\n'); stdout = lines.pop()!;
    for (const line of lines) if (line.trim()) {
      try { replies.push(JSON.parse(line)); } catch { invalidLines.push(line); }
    }
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const reply = async (id: number) => {
    const deadline = Date.now() + 20000;
    while (!replies.some(value => value.id === id) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
    expect(stderr).toBe('');
    expect(invalidLines).toEqual([]);
    const result = replies.find(value => value.id === id); expect(result).toBeDefined(); return result;
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cli-test', version: '1' } } });
  expect((await reply(1)).result.protocolVersion).toBe('2024-11-05');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  expect((await reply(2)).result.tools).toHaveLength(6);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notes_create', arguments: { body: 'Spawned CLI note' } } });
  expect((await reply(3)).result.structuredContent.note.body).toBe('Spawned CLI note');
  child.stdin.end();
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('MCP CLI did not exit on stdin EOF')); }, 5000); child.once('exit', code => { clearTimeout(timer); expect(code).toBe(0); resolve(); }); });
  expect(stdout).toBe('');
  expect(JSON.parse(await readFile(join(home, 'notes.json'), 'utf8')).notes).toHaveLength(1);
}, 30000);
