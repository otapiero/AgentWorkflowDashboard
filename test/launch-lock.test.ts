import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLaunchReservation, cancelPendingLaunch, withIssueLaunch } from '../src/orchestrator/launch-lock.ts';
import { newTask } from '../src/orchestrator/state.ts';
import { writeMarker } from '../src/orchestrator/markers.ts';
import { T3Client, UnconfirmedT3LaunchError } from '../src/orchestrator/t3/client.ts';
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mc-launch-lock-')); process.env.MC_HOME = home; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.MC_HOME; rmSync(home, { recursive: true, force: true }); });
test('a second launch cannot enter while the first awaits its launcher', async () => {
  const task = newTask(1, 'Feature', 'alice');
  let finish!: () => void;
  const first = withIssueLaunch(task, () => new Promise<void>(resolve => { finish = resolve; }));
  let entered = false;
  await expect(withIssueLaunch(task, async () => { entered = true; })).rejects.toThrow('already starting');
  expect(entered).toBe(false);
  finish(); await first;
});
test('failed launch releases its reservation but a live PID blocks new runs', async () => {
  const task = newTask(1, 'Feature', 'alice');
  await expect(withIssueLaunch(task, async () => { throw new Error('Launch failed'); })).rejects.toThrow('Launch failed');
  writeMarker(1, 'implement.running', JSON.stringify({ pid: process.pid, phase: 'implement' }));
  await expect(withIssueLaunch(task, async () => 'unexpected')).rejects.toThrow('already active');
});
test('slow preparation renews its lease and a delayed terminal must be cancelled explicitly', async () => {
  vi.useFakeTimers();
  const task = newTask(1, 'Feature', 'alice');
  let finish!: () => void; let token = '';
  const first = withIssueLaunch(task, reservation => { token = reservation; return new Promise<void>(resolve => { finish = resolve; }); });
  try {
    vi.advanceTimersByTime(120_000);
    await expect(withIssueLaunch(task, async () => undefined)).rejects.toThrow('already starting');
  } finally { finish(); await first; }
  vi.advanceTimersByTime(120_000);
  await expect(withIssueLaunch(task, async () => undefined)).rejects.toThrow('Cancel pending launch');
  cancelPendingLaunch(1);
  expect(() => assertLaunchReservation(1, token)).toThrow();
  await withIssueLaunch(task, async next => expect(next).not.toBe(token));
});

test.each(['starting', 'running', 'idle'] as const)('blocks a duplicate T3 launch while %s or carrying an active run', async status => {
  const task = newTask(1, 'Feature', 'alice');
  task.spawnHistory.push({ phase: 'plan', agent: 'codex', startedAt: '2026-10-18T10:00:00Z', command: 't3', threadId: 'thread-1' });
  vi.spyOn(T3Client.prototype, 'fetchSnapshot').mockResolvedValue({ projects: [], threads: [{
    id: 'thread-1', projectId: 'p1', title: 'Plan', activities: [],
    session: { threadId: 'thread-1', status, activeTurnId: status === 'idle' ? 'run-1' : null, lastError: null },
  }] });
  let entered = false;
  await expect(withIssueLaunch(task, async () => { entered = true; })).rejects.toThrow('already active in T3');
  expect(entered).toBe(false);
});

test('an unavailable snapshot blocks the launch and releases the preparation reservation', async () => {
  const task = newTask(1, 'Feature', 'alice');
  task.spawnHistory.push({ phase: 'plan', agent: 'codex', startedAt: '2026-10-18T10:00:00Z', command: 't3', threadId: 'thread-1' });
  const snapshot = vi.spyOn(T3Client.prototype, 'fetchSnapshot').mockResolvedValue(undefined);
  let entered = false;
  await expect(withIssueLaunch(task, async () => { entered = true; })).rejects.toThrow('Cannot check the existing T3 run');
  expect(entered).toBe(false);
  snapshot.mockResolvedValue({ projects: [], threads: [] });
  await withIssueLaunch(task, async () => { entered = true; });
  expect(entered).toBe(true);
});

test('a lost launch reply retains its thread id and blocks retry until T3 confirms it is inactive', async () => {
  const task = newTask(1, 'Feature', 'alice');
  await expect(withIssueLaunch(task, async () => {
    throw new UnconfirmedT3LaunchError('thread-1', new Error('Connection lost'));
  })).rejects.toThrow('Connection lost');
  const snapshot = vi.spyOn(T3Client.prototype, 'fetchSnapshot').mockResolvedValue({ projects: [], threads: [{
    id: 'thread-1', projectId: 'p1', title: 'Plan', activities: [],
    session: { threadId: 'thread-1', status: 'running', activeTurnId: 'run-1', lastError: null },
  }] });
  let entered = false;
  await expect(withIssueLaunch(task, async () => { entered = true; })).rejects.toThrow('already active in T3');
  snapshot.mockResolvedValue(undefined);
  await expect(withIssueLaunch(task, async () => { entered = true; })).rejects.toThrow('Cannot check the existing T3 run');
  expect(entered).toBe(false);
  snapshot.mockResolvedValue({ projects: [], threads: [] });
  await withIssueLaunch(task, async () => { entered = true; });
  expect(entered).toBe(true);
});
