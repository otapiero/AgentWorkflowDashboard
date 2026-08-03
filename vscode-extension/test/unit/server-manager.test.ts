import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

import { afterEach, expect, test, vi } from 'vitest';

import type { HealthResponse } from '../../../src/shared/types.ts';
import { ServerManager } from '../../src/server-manager.ts';

const directories: string[] = [];
const health = (overrides: Partial<HealthResponse> = {}): HealthResponse => ({ status: 'ok', apiVersion: 1, serverVersion: '1.0.0', pid: 42, startedAt: '2026-08-03T10:00:00.000Z', ...overrides });

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
