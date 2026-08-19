import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { T3Client } from '../src/orchestrator/t3/client.ts';

let home: string;
let t3home: string;

const descriptor = {
  environmentId: 'env-1',
  serverVersion: '0.0.31',
  capabilities: { serverSelfUpdate: 'desktop-managed' },
};

const tokenReply = {
  access_token: 'tok-1',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'orchestration:read orchestration:operate',
};

const snapshot = {
  snapshotSequence: 3,
  projects: [{ id: 'p1', title: 'widgets', workspaceRoot: 'C:\\repo' }],
  threads: [
    {
      id: 'thread-1',
      projectId: 'p1',
      title: '#3060 plan',
      branch: 'alice/3060-thing',
      worktreePath: 'C:\\Users\\alice\\.mission-control\\projects\\acme__widgets\\worktrees\\issue-3060',
      activities: [{ id: 'e1', tone: 'info' }],
      session: { threadId: 'thread-1', status: 'running', activeTurnId: 'turn-1', lastError: null },
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
    if (u.includes('/api/orchestration/snapshot')) {
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    if (u.includes('/api/orchestration/dispatch')) {
      return new Response(JSON.stringify({ sequence: 9 }), { status: 200 });
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
});

describe('status', () => {
  test('reports the server version when everything is up', async () => {
    const { impl } = fakeServer();
    const status = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).status();
    expect(status).toMatchObject({ ok: true, serverVersion: '0.0.31' });
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
  test('returns the parsed snapshot', async () => {
    const { impl } = fakeServer();
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
    expect(result?.threads[0]?.session?.status).toBe('running');
  });

  test('sends the bearer token', async () => {
    const { impl, calls } = fakeServer();
    await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
    const snapshotCall = calls.find((c) => c.url.includes('/api/orchestration/snapshot'));
    const headers = snapshotCall?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
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
      '/api/orchestration/snapshot': {
        status: 200,
        body: { threads: [{ id: 't1', projectId: 'p1', title: 'x', session: { threadId: 't1', status: 'teleporting' } }] },
      },
    });
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    await expect(client.fetchSnapshot()).resolves.toBeUndefined();
  });

  test('a snapshot that is not JSON at all yields undefined and never throws', async () => {
    const impl = (async (url: string) => {
      if (String(url).includes('/api/orchestration/snapshot')) {
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
      '/api/orchestration/snapshot': { status: 200, body: { threads: 'nope' } },
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
      if (u.includes('/api/orchestration/snapshot')) {
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
      if (u.includes('/api/orchestration/snapshot')) {
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

describe('dispatch', () => {
  test('posts the command and returns the sequence', async () => {
    const { impl, calls } = fakeServer();
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).dispatch({
      type: 'thread.turn.start',
    });
    expect(result).toEqual({ ok: true, sequence: 9 });

    const call = calls.find((c) => c.url.includes('/api/orchestration/dispatch'));
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(String(call?.init?.body)).type).toBe('thread.turn.start');
  });

  test('a rejected dispatch surfaces T3s message verbatim rather than throwing', async () => {
    const { impl } = fakeServer({
      '/api/orchestration/dispatch': {
        status: 422,
        body: { message: "provider instance 'opencode' is not configured" },
      },
    });
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).dispatch({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('opencode');
  });

  test('dispatching while T3 is down fails with a reason instead of throwing', async () => {
    rmSync(join(t3home, 'userdata', 'server-runtime.json'));
    const { impl } = fakeServer();
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).dispatch({});
    expect(result.ok).toBe(false);
  });
});
