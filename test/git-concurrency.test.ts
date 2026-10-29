import { expect, test, vi } from 'vitest';
import type { Config } from '../src/shared/types.ts';

const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa }));
import { listBranches } from '../src/orchestrator/worktree.ts';

test('bounds Git processes across callers and releases capacity after a failed command', async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  const release: (() => void)[] = [];
  execa.mockImplementation(async () => {
    const number = started++;
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => release.push(resolve));
    active--;
    if (number === 0) throw new Error('Git failed');
    return { stdout: `alice/branch-${number}\n` };
  });
  const config = { repo: { path: 'C:\\src\\widgets' } } as Config;
  const calls = Array.from({ length: 13 }, () => listBranches(config));
  // A paused command occupies a slot; starting every caller would spike CPU.
  expect(started).toBe(4);
  for (let completed = 0; completed < 13; completed++) {
    await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
    release.shift()!();
  }
  const results = await Promise.all(calls);
  expect(peak).toBeLessThanOrEqual(4);
  expect(results[0]).toEqual([]);
  expect(results[12]).toEqual(['alice/branch-12']);
  expect(active).toBe(0);
});
