import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t3ServerRuntimePath } from '../src/orchestrator/t3/paths.ts';
import { discoverT3, readServerRuntime } from '../src/orchestrator/t3/discovery.ts';

let home: string;

function writeRuntime(body: unknown): void {
  const file = t3ServerRuntimePath();
  mkdirSync(join(home, 'userdata'), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

/** A live runtime file: our own pid is by definition alive. */
function liveRuntime(origin = 'http://127.0.0.1:3773') {
  return {
    version: 1,
    pid: process.pid,
    host: '127.0.0.1',
    port: 3773,
    origin,
    startedAt: '2026-08-07T09:09:13.504Z',
  };
}

const descriptor = {
  environmentId: 'env-1',
  label: 'DESKTOP-TEST',
  serverVersion: '0.0.31',
  capabilities: { serverSelfUpdate: 'desktop-managed' },
};

function fakeFetch(response: { status?: number; body?: unknown }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response.body ?? descriptor), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.T3_HOME = home;
});

afterEach(() => {
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('readServerRuntime', () => {
  test('reads a well-formed runtime file', () => {
    writeRuntime(liveRuntime());
    expect(readServerRuntime()?.origin).toBe('http://127.0.0.1:3773');
  });

  test('a missing file is undefined, not a throw', () => {
    expect(readServerRuntime()).toBeUndefined();
  });

  test('a truncated file is undefined, not a throw', () => {
    writeRuntime('{ not json');
    expect(readServerRuntime()).toBeUndefined();
  });
});

describe('discoverT3', () => {
  test('reports the origin, version and capabilities when everything is up', async () => {
    writeRuntime(liveRuntime());
    const result = await discoverT3(fakeFetch({}));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.origin).toBe('http://127.0.0.1:3773');
    expect(result.serverVersion).toBe('0.0.31');
    expect(result.capabilities.serverSelfUpdate).toBe('desktop-managed');
  });

  test('no runtime file means T3 is simply not running', async () => {
    const result = await discoverT3(fakeFetch({}));
    expect(result).toMatchObject({ ok: false, reason: 'no-runtime-file' });
  });

  test('a corrupt runtime file is distinguished from an absent one', async () => {
    writeRuntime('{ not json');
    expect(await discoverT3(fakeFetch({}))).toMatchObject({
      ok: false,
      reason: 'unreadable-runtime-file',
    });
  });

  test('a runtime file naming a dead process does not count as running', async () => {
    // T3 crashed without cleaning up. The same liveness discipline the phase
    // markers already use applies here.
    writeRuntime({ ...liveRuntime(), pid: 0x7ffffff });
    expect(await discoverT3(fakeFetch({}))).toMatchObject({ ok: false, reason: 'dead-server' });
  });

  test('a live pid whose server does not answer is unreachable, not running', async () => {
    writeRuntime(liveRuntime());
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await discoverT3(failing)).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  test('a non-200 descriptor is unreachable rather than a crash', async () => {
    writeRuntime(liveRuntime());
    expect(await discoverT3(fakeFetch({ status: 500 }))).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  test('a descriptor that fails validation is unreachable, never a throw', async () => {
    writeRuntime(liveRuntime());
    const result = await discoverT3(fakeFetch({ body: { nope: true } }));
    expect(result.ok).toBe(false);
  });

  test('a trailing slash on the origin does not produce a double slash', async () => {
    writeRuntime(liveRuntime('http://127.0.0.1:3773/'));
    let seen = '';
    const capturing = (async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;
    await discoverT3(capturing);
    expect(seen).toBe('http://127.0.0.1:3773/.well-known/t3/environment');
  });
});
