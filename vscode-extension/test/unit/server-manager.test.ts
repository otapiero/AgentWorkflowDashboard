import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterEach, expect, test, vi } from 'vitest';

import type { HealthResponse } from '../../../src/shared/types.ts';
import { MissionControlClient } from '../../src/client/mission-control-client.ts';
import { ServerManager } from '../../src/server-manager.ts';

const directories: string[] = [];
const health = (overrides: Partial<HealthResponse> = {}): HealthResponse => ({ status: 'ok', apiVersion: 1, serverVersion: '1.0.0', pid: 42, startedAt: '2026-08-03T10:00:00.000Z', instanceId: null, ...overrides });

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'mission-control-manager-'));
  directories.push(value);
  return value;
}

afterEach(async () => { await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

function options(overrides: Partial<ConstructorParameters<typeof ServerManager>[0]> = {}) {
  const spawn = vi.fn(() => ({ pid: 42, unref: vi.fn() }) as unknown as ChildProcess);
  return {
    client: { health: vi.fn().mockResolvedValue(health()) },
    storagePath: 'storage', serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false, expectedApiVersion: 1 as const,
    process: { spawn }, kill: vi.fn(), delay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

test('returns a healthy compatible server without spawning', async () => {
  const dependencies = options();
  const result = await new ServerManager(dependencies).ensureReady();
  expect(result).toEqual({ kind: 'ready', health: health() });
  expect(dependencies.process.spawn).not.toHaveBeenCalled();
});

test('reports an API mismatch without spawning', async () => {
  const dependencies = options({ client: { health: vi.fn().mockResolvedValue(health({ apiVersion: 2 } as never)) } });
  await expect(new ServerManager(dependencies).ensureReady()).resolves.toEqual({ kind: 'incompatible', health: health({ apiVersion: 2 } as never) });
  expect(dependencies.process.spawn).not.toHaveBeenCalled();
});

test('aborting pending initial health preserves cancellation with zero filesystem or process side effects', async () => {
  const storagePath = join(await directory(), 'not-created');
  const dependencies = options({
    storagePath,
    installationPath: await directory(),
    autoStart: true,
    client: { health: vi.fn((signal: AbortSignal) => new Promise<HealthResponse>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))) },
  });
  const manager = new ServerManager(dependencies);
  const readiness = manager.ensureReady();
  await vi.waitFor(() => expect(dependencies.client.health).toHaveBeenCalledOnce());

  manager.dispose();

  await expect(readiness).rejects.toMatchObject({ name: 'AbortError' });
  await expect(stat(storagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(dependencies.process.spawn).not.toHaveBeenCalled();
  expect(dependencies.delay).not.toHaveBeenCalled();
  expect(dependencies.kill).not.toHaveBeenCalled();
});

test('abort immediately after acquiring startup lease still releases it', async () => {
  const released = vi.fn().mockResolvedValue(undefined);
  let manager!: ServerManager;
  const dependencies = options({
    autoStart: true,
    client: { health: vi.fn().mockRejectedValue(new Error('offline')) },
    acquireLease: vi.fn(async () => {
      manager.dispose();
      return { token: 'lease', release: released };
    }),
  });
  manager = new ServerManager(dependencies);

  await expect(manager.ensureReady()).rejects.toMatchObject({ name: 'AbortError' });

  expect(released).toHaveBeenCalledOnce();
  expect(dependencies.process.spawn).not.toHaveBeenCalled();
});

test('reports an API mismatch from a runtime-validated client response', async () => {
  const client = new MissionControlClient('http://127.0.0.1:4317', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    status: 'ok', apiVersion: 2, serverVersion: '2.0.0', pid: 42, startedAt: '2026-08-03T10:00:00.000Z',
  }), { status: 200, headers: { 'content-type': 'application/json' } })));

  await expect(new ServerManager(options({ client })).ensureReady()).resolves.toEqual({
    kind: 'incompatible',
    health: { status: 'ok', apiVersion: 2, serverVersion: '2.0.0', pid: 42, startedAt: '2026-08-03T10:00:00.000Z', instanceId: null },
  });
});

test.each(['https://127.0.0.1:4317', 'http://0.0.0.0:4317', 'not a url', 'http://user@localhost:4317', 'http://localhost:4317/path', 'http://localhost:4317/?query=1', 'http://localhost:4317/#hash'])('rejects unsafe or malformed server URL %s', async (serverUrl) => {
  const dependencies = options({ serverUrl });
  await expect(new ServerManager(dependencies).ensureReady()).resolves.toMatchObject({ kind: 'configuration-error' });
  expect(dependencies.process.spawn).not.toHaveBeenCalled();
});

test.each(['http://localhost', 'http://localhost:4317/', 'http://127.0.0.1:4317'])('accepts credential-free loopback origins %s', async (serverUrl) => {
  await expect(new ServerManager(options({ serverUrl })).ensureReady()).resolves.toMatchObject({ kind: 'ready' });
});

test('a second manager waits for the first manager startup and returns ready without spawning', async () => {
  const installationPath = await directory(); const storagePath = await directory();
  await writeFile(join(installationPath, 'package.json'), JSON.stringify({ name: 'mission-control', scripts: { start: 'node' } }));
  let ready = false;
  let unblockFirst!: () => void;
  const healthClient = { health: vi.fn(async () => ready ? health() : Promise.reject(new Error('offline'))) };
  const spawned = { pid: 42, unref: vi.fn() } as unknown as ChildProcess;
  const processDependency = { spawn: vi.fn(() => spawned) };
  const common = { client: healthClient, installationPath, storagePath, serverUrl: 'http://localhost:4317', autoStart: true, expectedApiVersion: 1 as const, process: processDependency, kill: vi.fn() };
  const firstManager = new ServerManager({ ...common, delay: vi.fn(() => new Promise<void>((resolve) => { unblockFirst = resolve; })) });
  const first = firstManager.ensureReady();
  await vi.waitFor(() => expect(processDependency.spawn).toHaveBeenCalledOnce());
  const secondManager = new ServerManager({ ...common, delay: vi.fn(async () => { ready = true; }) });

  await expect(secondManager.ensureReady()).resolves.toEqual({ kind: 'ready', health: health() });
  expect(processDependency.spawn).toHaveBeenCalledOnce();
  unblockFirst();
  await first;
});

test('does not spawn from an invalid installation package', async () => {
  const installationPath = await directory();
  await writeFile(join(installationPath, 'package.json'), JSON.stringify({ name: 'wrong', scripts: { start: true } }));
  const dependencies = options({ installationPath, autoStart: true, storagePath: await directory(), client: { health: vi.fn().mockRejectedValue(new Error('offline')) } });
  await expect(new ServerManager(dependencies).ensureReady()).resolves.toMatchObject({ kind: 'configuration-error' });
  expect(dependencies.process.spawn).not.toHaveBeenCalled();
});

test('launches detached, hidden and unreferenced then waits on the bounded readiness schedule', async () => {
  const installationPath = await directory();
  const storagePath = await directory();
  await writeFile(join(installationPath, 'package.json'), JSON.stringify({ name: 'mission-control', scripts: { start: 'node src/server.ts' } }));
  const child = { pid: 42, unref: vi.fn() } as unknown as ChildProcess;
  const dependencies = options({ installationPath, storagePath, autoStart: true, process: { spawn: vi.fn(() => child) }, client: { health: vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline')).mockRejectedValueOnce(new Error('still starting')).mockResolvedValue(health()) } });
  const result = await new ServerManager(dependencies).ensureReady();
  expect(result).toEqual({ kind: 'ready', health: health() });
  expect(dependencies.process.spawn).toHaveBeenCalledWith(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], expect.objectContaining({ cwd: installationPath, detached: true, windowsHide: true, stdio: 'ignore', env: expect.objectContaining({ MC_PORT: '4317' }) }));
  expect(child.unref).toHaveBeenCalledOnce();
  expect(dependencies.delay).toHaveBeenCalledWith(0, expect.any(AbortSignal));
  expect(dependencies.delay).toHaveBeenCalledWith(100, expect.any(AbortSignal));
});

test('uses every bounded readiness delay before reporting unavailable', async () => {
  const installationPath = await directory(); const storagePath = await directory();
  await writeFile(join(installationPath, 'package.json'), JSON.stringify({ name: 'mission-control', scripts: { start: 'node' } }));
  const dependencies = options({ installationPath, storagePath, autoStart: true, client: { health: vi.fn().mockRejectedValue(new Error('offline')) } });

  await expect(new ServerManager(dependencies).ensureReady()).resolves.toMatchObject({ kind: 'unavailable' });
  expect(vi.mocked(dependencies.delay).mock.calls.map(([delay]) => delay)).toEqual([0, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000, 1_000]);
});

test('two managers sharing a startup lock create one process', async () => {
  const installationPath = await directory(); const storagePath = await directory();
  await writeFile(join(installationPath, 'package.json'), JSON.stringify({ name: 'mission-control', scripts: { start: 'node' } }));
  const client = { health: vi.fn().mockRejectedValue(new Error('offline')) };
  const process = { spawn: vi.fn(() => ({ pid: 42, unref: vi.fn() }) as unknown as ChildProcess) };
  let completeFirstWait: (() => void) | undefined;
  let delayCalls = 0;
  const common = { client, installationPath, storagePath, serverUrl: 'http://localhost:4317', autoStart: true, expectedApiVersion: 1 as const, process, kill: vi.fn(), delay: vi.fn(() => (++delayCalls === 1 ? new Promise<void>((resolve) => { completeFirstWait = resolve; }) : Promise.resolve())) };
  const first = new ServerManager(common).ensureReady();
  await vi.waitFor(() => expect(process.spawn).toHaveBeenCalledOnce());
  const second = await new ServerManager(common).ensureReady();
  expect(second).toMatchObject({ kind: 'unavailable' });
  expect(process.spawn).toHaveBeenCalledOnce();
  completeFirstWait!();
  await first;
});

test('restart kills only the matching owned health identity and dispose only aborts waits', async () => {
  const storagePath = await directory();
  await writeFile(join(storagePath, 'server-owner.json'), JSON.stringify({ pid: 42, startedAt: health().startedAt }));
  const dependencies = options({ storagePath, client: { health: vi.fn().mockResolvedValue(health()) } });
  const manager = new ServerManager(dependencies);
  await manager.restartOwned();
  expect(dependencies.kill).toHaveBeenCalledWith(42);
  manager.dispose();
  expect(dependencies.kill).toHaveBeenCalledOnce();
});

test.each([
  health({ pid: 99 }),
  health({ startedAt: '2026-08-03T11:00:00.000Z' }),
])('restart does not kill when ownership identity differs', async (currentHealth) => {
  const storagePath = await directory();
  await writeFile(join(storagePath, 'server-owner.json'), JSON.stringify({ pid: 42, startedAt: health().startedAt }));
  const dependencies = options({ storagePath, client: { health: vi.fn().mockResolvedValue(currentHealth) } });

  await new ServerManager(dependencies).restartOwned();
  expect(dependencies.kill).not.toHaveBeenCalled();
});

/**
 * `npm.cmd start` forks cmd -> tsx -> node, so the PID we hold is the npm
 * wrapper's and never the PID the server reports. Ownership therefore has to
 * key off the instance id we injected, and must record the server's own PID so
 * a later restart kills the process actually holding the port.
 */
async function installation(): Promise<string> {
  const path = await directory();
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'mission-control', scripts: { start: 'node' } }));
  return path;
}

function injectedInstanceId(spawn: ReturnType<typeof vi.fn>): string {
  const [, , spawnOptions] = spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
  const id = spawnOptions.env.MC_INSTANCE_ID;
  expect(typeof id).toBe('string');
  return id as string;
}

test('claims ownership of the server it spawned even though the child PID differs, recording the server PID', async () => {
  const installationPath = await installation();
  const storagePath = await directory();
  const spawn = vi.fn(() => ({ pid: 42, unref: vi.fn() }) as unknown as ChildProcess);
  let injected: string | undefined;
  const dependencies = options({
    installationPath, storagePath, autoStart: true,
    process: { spawn },
    // Offline until spawned; then a server whose PID is the tsx grandchild's,
    // carrying back the id we injected.
    client: { health: vi.fn(async () => {
      if (!spawn.mock.calls.length) throw new Error('offline');
      injected ??= injectedInstanceId(spawn);
      return health({ pid: 25808, instanceId: injected });
    }) },
  });

  const result = await new ServerManager(dependencies).ensureReady();

  expect(result).toMatchObject({ kind: 'ready' });
  expect(JSON.parse(await readFile(join(storagePath, 'server-owner.json'), 'utf8'))).toEqual({
    pid: 25808,
    startedAt: health().startedAt,
  });
});

test('a server it spawned can then actually be restarted', async () => {
  const installationPath = await installation();
  const storagePath = await directory();
  const spawn = vi.fn(() => ({ pid: 42, unref: vi.fn() }) as unknown as ChildProcess);
  let injected: string | undefined;
  const client = { health: vi.fn(async () => {
    if (!spawn.mock.calls.length) throw new Error('offline');
    injected ??= injectedInstanceId(spawn);
    return health({ pid: 25808, instanceId: injected });
  }) };
  const dependencies = options({ installationPath, storagePath, autoStart: true, process: { spawn }, client });
  const manager = new ServerManager(dependencies);
  await manager.ensureReady();

  await expect(manager.restartOwned()).resolves.toBe(true);
  expect(dependencies.kill).toHaveBeenCalledWith(25808);
});

test('does not claim a server started outside the extension, even on the same port', async () => {
  const installationPath = await installation();
  const storagePath = await directory();
  const spawn = vi.fn(() => ({ pid: 42, unref: vi.fn() }) as unknown as ChildProcess);
  const dependencies = options({
    installationPath, storagePath, autoStart: true,
    process: { spawn },
    // A manually launched server wins the race: healthy, but unclaimed.
    client: { health: vi.fn(async () => {
      if (!spawn.mock.calls.length) throw new Error('offline');
      return health({ pid: 7777, instanceId: null });
    }) },
  });

  await expect(new ServerManager(dependencies).ensureReady()).resolves.toMatchObject({ kind: 'ready' });
  await expect(stat(join(storagePath, 'server-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('does not claim a server carrying a different instance id', async () => {
  const installationPath = await installation();
  const storagePath = await directory();
  const spawn = vi.fn(() => ({ pid: 42, unref: vi.fn() }) as unknown as ChildProcess);
  const dependencies = options({
    installationPath, storagePath, autoStart: true,
    process: { spawn },
    client: { health: vi.fn(async () => {
      if (!spawn.mock.calls.length) throw new Error('offline');
      return health({ pid: 7777, instanceId: 'some-other-window' });
    }) },
  });

  await expect(new ServerManager(dependencies).ensureReady()).resolves.toMatchObject({ kind: 'ready' });
  await expect(stat(join(storagePath, 'server-owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('injects a distinct instance id per spawn', async () => {
  const installationPath = await installation();
  const first = vi.fn(() => ({ pid: 42, unref: vi.fn() }) as unknown as ChildProcess);
  const second = vi.fn(() => ({ pid: 43, unref: vi.fn() }) as unknown as ChildProcess);
  const offline = { health: vi.fn().mockRejectedValue(new Error('offline')) };
  await new ServerManager(options({ installationPath, storagePath: await directory(), autoStart: true, process: { spawn: first }, client: offline })).ensureReady();
  await new ServerManager(options({ installationPath, storagePath: await directory(), autoStart: true, process: { spawn: second }, client: offline })).ensureReady();

  expect(injectedInstanceId(first)).not.toBe(injectedInstanceId(second));
});
