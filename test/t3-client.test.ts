import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { T3Client } from '../src/orchestrator/t3/client.ts';
import { toT3Fact } from '../src/orchestrator/t3/facts.ts';
import type { ThreadLaunchInput } from '../src/orchestrator/t3/commands.ts';

let home: string;
let t3home: string;

const descriptor = {
  environmentId: 'env-1',
  serverVersion: '0.1.0',
  capabilities: { serverSelfUpdate: 'desktop-managed' },
};

const tokenReply = {
  access_token: 'tok-1',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'orchestration:read orchestration:operate',
};

const snapshot = {
  schemaVersion: 2,
  snapshotSequence: 3,
  projects: [{ id: 'p1', title: 'widgets', workspaceRoot: 'C:\\src\\widgets' }],
  archivedThreads: [],
  threads: [
    {
      id: 'thread-1',
      projectId: 'p1',
      title: '#3060 plan',
      branch: 'alice/3060-thing',
      worktreePath: 'C:\\Users\\alice\\.mission-control\\projects\\acme__widgets\\worktrees\\issue-3060',
      status: 'running',
      activeRunId: 'run-1',
      activityRunStatus: 'running',
      pendingRuntimeRequest: null,
      lastError: null,
    },
  ],
};

/**
 * A fake T3 server. Routes by path, so a test only states what it cares about.
 */
function fakeServer(overrides: Record<string, { status?: number; body?: unknown }> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(overrides).find((k) => u.includes(k));
    if (key) {
      const o = overrides[key]!;
      return new Response(JSON.stringify(o.body ?? {}), { status: o.status ?? 200 });
    }
    if (u.includes('/.well-known/t3/environment')) {
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }
    if (u.includes('/oauth/token')) return new Response(JSON.stringify(tokenReply), { status: 200 });
    if (u.includes('/api/orchestration/shell')) {
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    if (u.includes('/api/projects/mutate')) {
      return new Response(JSON.stringify({ id: 'p2' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function writeRuntime(): void {
  mkdirSync(join(t3home, 'userdata'), { recursive: true });
  writeFileSync(
    join(t3home, 'userdata', 'server-runtime.json'),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: 3773,
      origin: 'http://127.0.0.1:3773',
    }),
    'utf8',
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-'));
  t3home = mkdtempSync(join(tmpdir(), 't3-'));
  process.env.MC_HOME = home;
  process.env.MC_ROOT = home;
  process.env.T3_HOME = t3home;
  writeRuntime();
});

afterEach(() => {
  delete process.env.MC_HOME;
  delete process.env.MC_ROOT;
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(t3home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('status', () => {
  test('reports the server version when everything is up', async () => {
    const { impl } = fakeServer();
    const status = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).status();
    expect(status).toMatchObject({ ok: true, serverVersion: '0.1.0' });
  });

  test('reports T3 as down when there is no runtime file', async () => {
    rmSync(join(t3home, 'userdata', 'server-runtime.json'));
    const { impl } = fakeServer();
    const status = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).status();
    expect(status).toMatchObject({ ok: false, reason: 'no-runtime-file' });
  });

  test('a running server with no credential is distinguished from a down server', async () => {
    const { impl } = fakeServer();
    const status = await new T3Client({ fetchImpl: impl, credential: null }).status();
    expect(status).toMatchObject({ ok: false, reason: 'no-credential' });
  });

  test('a rejected credential is distinguished from a missing one', async () => {
    const { impl } = fakeServer({ '/oauth/token': { status: 401, body: {} } });
    const status = await new T3Client({ fetchImpl: impl, credential: 'revoked' }).status();
    expect(status).toMatchObject({ ok: false, reason: 'credential-rejected' });
  });
});

describe('fetchSnapshot', () => {
  test('sends the bearer token', async () => {
    const { impl, calls } = fakeServer();
    await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
    const snapshotCall = calls.find((c) => c.url.includes('/api/orchestration/shell'));
    const headers = snapshotCall?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(headers['x-t3-orchestration-protocol']).toBe('2');
    expect(toT3Fact(await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot(), 'thread-1')).toMatchObject({ sessionStatus: 'running', activeTurnId: 'run-1' });
  });

  test('T3 not running yields undefined, not a throw', async () => {
    rmSync(join(t3home, 'userdata', 'server-runtime.json'));
    const { impl } = fakeServer();
    expect(
      await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot(),
    ).toBeUndefined();
  });

  test('no credential yields undefined, not a throw', async () => {
    const { impl } = fakeServer();
    expect(await new T3Client({ fetchImpl: impl, credential: null }).fetchSnapshot()).toBeUndefined();
  });

  /**
   * THE DEGRADATION TEST. Do not delete this.
   *
   * It is the mechanism that turns an upstream breaking change into lost
   * liveness rather than a broken board. If T3 renames a field this code
   * depends on, fetchSnapshot must return undefined and nothing may throw.
   */
  test('a malformed snapshot yields undefined and never throws', async () => {
    const { impl } = fakeServer({
      '/api/orchestration/shell': {
        status: 200,
        body: { ...snapshot, threads: [{ ...snapshot.threads[0], status: 'teleporting' }] },
      },
    });
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    await expect(client.fetchSnapshot()).resolves.toBeUndefined();
  });

  test('a snapshot that is not JSON at all yields undefined and never throws', async () => {
    const impl = (async (url: string) => {
      if (String(url).includes('/api/orchestration/shell')) {
        return new Response('<html>gateway error</html>', { status: 200 });
      }
      if (String(url).includes('/oauth/token')) return new Response(JSON.stringify(tokenReply), { status: 200 });
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    await expect(client.fetchSnapshot()).resolves.toBeUndefined();
  });

  test('logs a validation failure at most once per client, not once per task', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeServer({
      '/api/orchestration/shell': { status: 200, body: { threads: 'nope' } },
    });
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    await client.fetchSnapshot();
    await client.fetchSnapshot();
    await client.fetchSnapshot();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a 401 triggers exactly one token re-exchange and one retry', async () => {
    let snapshotHits = 0;
    let tokenHits = 0;
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        tokenHits += 1;
        return new Response(JSON.stringify(tokenReply), { status: 200 });
      }
      if (u.includes('/api/orchestration/shell')) {
        snapshotHits += 1;
        // First call 401s (token went stale); the retry succeeds.
        return snapshotHits === 1
          ? new Response('{}', { status: 401 })
          : new Response(JSON.stringify(snapshot), { status: 200 });
      }
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
    expect(result?.threads).toHaveLength(1);
    expect(snapshotHits).toBe(2);
    expect(tokenHits).toBe(2);
  });

  test('a second 401 gives up rather than looping', async () => {
    let snapshotHits = 0;
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth/token')) return new Response(JSON.stringify(tokenReply), { status: 200 });
      if (u.includes('/api/orchestration/shell')) {
        snapshotHits += 1;
        return new Response('{}', { status: 401 });
      }
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;

    expect(
      await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot(),
    ).toBeUndefined();
    expect(snapshotHits).toBe(2);
  });
});

describe('project creation', () => {
  test('uses project mutations and refuses a successful HTML fallback', async () => {
    const { impl, calls } = fakeServer();
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    const command = { type: 'project.create', commandId: 'cmd-1', projectId: 'p2', title: 'widgets', workspaceRoot: 'C:\\src\\widgets' };
    await expect(client.createProject(command)).resolves.toEqual({ ok: true });
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/api/projects/mutate'))?.init?.body))).toEqual(command);
    const htmlFetch = (async (url, init) => String(url).endsWith('/api/projects/mutate')
      ? new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } })
      : impl(url, init)) as typeof fetch;
    const result = await new T3Client({ fetchImpl: htmlFetch, credential: 'pair-abc' }).createProject(command);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('JSON') });
  });

  test('preserves upstream mutation rejection details', async () => {
    const { impl } = fakeServer({ '/api/projects/mutate': { status: 422, body: { message: 'Workspace root is already registered' } } });
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).createProject({ type: 'project.create' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Workspace root is already registered') });
  });
});

test.each([
  ['preparing', 'starting'], ['queued', 'starting'], ['starting', 'starting'],
  ['running', 'running'], ['waiting', 'running'], ['completed', 'stopped'],
  ['interrupted', 'interrupted'], ['failed', 'error'], ['cancelled', 'stopped'],
  ['rolled_back', 'stopped'], ['idle', 'idle'],
])('maps V2 %s to %s without losing active-run liveness', async (status, sessionStatus) => {
  const { impl } = fakeServer({ '/api/orchestration/shell': { body: { ...snapshot,
    threads: [{ ...snapshot.threads[0], status, activeRunId: null, activityRunStatus: null }],
  } } });
  const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
  expect(toT3Fact(result, 'thread-1')?.sessionStatus).toBe(sessionStatus);
});

test('includes archived runs and maps pending requests and background activity', async () => {
  const { impl } = fakeServer({ '/api/orchestration/shell': { body: { ...snapshot,
    threads: [], archivedThreads: [{ ...snapshot.threads[0], status: 'completed', activeRunId: null,
      activityRunStatus: 'waiting', pendingRuntimeRequest: { id: 'request-1', kind: 'approval' },
      archivedAt: '2026-10-18T10:00:00Z' }],
  } } });
  const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
  expect(toT3Fact(result, 'thread-1')).toMatchObject({ sessionStatus: 'running', awaitingApproval: true, settled: true });
});

test('status and launch diagnostics explain HTML and schema failures instead of asking to reconnect', async () => {
  const base = fakeServer();
  const impl = (async (url, init) => String(url).endsWith('/api/orchestration/shell')
    ? new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } })
    : base.impl(url, init)) as typeof fetch;
  const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
  await expect(client.status()).resolves.toMatchObject({ ok: false, reason: 'snapshot-unavailable', detail: expect.stringContaining('JSON') });
  await expect(client.requireSnapshot()).rejects.toThrow(/JSON/);
});

test('a failed HTTP error body loses liveness without throwing out of the poller', async () => {
  const base = fakeServer();
  const impl = (async (url, init) => String(url).endsWith('/api/orchestration/shell')
    ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } }), { status: 503 })
    : base.impl(url, init)) as typeof fetch;
  const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
  await expect(client.fetchSnapshot()).resolves.toBeUndefined();
  await expect(client.requireSnapshot()).rejects.toThrow(/503/);
});

describe('protocol 2 thread launch', () => {
  const input: ThreadLaunchInput = {
    commandId: 'cmd-1', threadId: 'thread-2', projectId: 'p1', title: 'Plan',
    modelSelection: { instanceId: 'codex', model: 'gpt-5.6-sol' },
    runtimeMode: 'approval-required' as const, interactionMode: 'plan' as const,
    workspaceStrategy: { type: 'existing_worktree' as const, worktreePath: 'C:\\src\\widgets', branch: 'alice/feature' },
    initialMessage: { messageId: 'msg-1', text: 'Plan the feature.', attachments: [] },
  };
  function socketServer(reply: (request: any) => unknown) {
    const sockets: Array<{ url: string; closed: boolean; sent: any[] }> = [];
    class Socket extends EventTarget {
      closed = false;
      sent: any[] = [];
      constructor(readonly url: string) {
        super(); sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      send(data: string) {
        const request = JSON.parse(data); this.sent.push(request);
        if (request._tag !== 'Request') return;
        const result = reply(request);
        if (result !== undefined) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(result) })));
      }
      close() { this.closed = true; }
    }
    vi.stubGlobal('WebSocket', Socket);
    const { impl, calls } = fakeServer({ '/api/auth/websocket-ticket': { body: { ticket: 'ticket-1', expiresAt: '2026-10-18T12:00:00Z' } } });
    return { sockets, impl, calls };
  }

  test('launches over a ticket-authenticated RPC socket and closes it after a correlated reply', async () => {
    const { sockets, impl, calls } = socketServer(request => ({ _tag: 'Exit', requestId: request.id,
      exit: { _tag: 'Success', value: request.tag === 'orchestration.launchThread' ? { threadId: 'thread-2' } : {} } }));
    await expect(new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).launchThread(input)).resolves.toBe('thread-2');
    const ticketCall = calls.find(c => c.url.endsWith('/api/auth/websocket-ticket'));
    expect(ticketCall?.init?.method).toBe('POST');
    expect(new Headers(ticketCall?.init?.headers).get('authorization')).toBe('Bearer tok-1');
    const socket = sockets[0]!;
    const url = new URL(socket.url);
    expect(url.pathname).toBe('/ws');
    expect(url.searchParams.get('wsTicket')).toBe('ticket-1');
    expect(url.searchParams.get('orchestrationProtocol')).toBe('2');
    expect(socket.sent[0].payload).toEqual(input);
    expect(socket.closed).toBe(true);
  });

  test('surfaces RPC failures and never retries a potentially accepted launch', async () => {
    const { sockets, impl } = socketServer(request => ({ _tag: 'Exit', requestId: request.id,
      exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'LaunchError', message: 'Failed to launch thread', cause: { stage: 'resolve-worktree', cause: 'Worktree is not registered' } } }] } }));
    await expect(new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).launchThread(input)).rejects.toThrow(/Worktree is not registered/);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(true);
  });

  test('times out an uncorrelated reply and closes the socket', async () => {
    vi.useFakeTimers();
    const { sockets, impl } = socketServer(() => ({ _tag: 'Exit', requestId: 'someone-else', exit: { _tag: 'Success', value: { threadId: 'wrong' } } }));
    const launch = new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).launchThread(input);
    const assertion = expect(launch).rejects.toMatchObject({ message: expect.stringContaining('timed out'), threadId: 'thread-2' });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(sockets[0]?.closed).toBe(true);
    vi.useRealTimers();
  });
});
