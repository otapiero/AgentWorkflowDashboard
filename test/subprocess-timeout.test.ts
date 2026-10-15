import { beforeEach, describe, expect, test, vi } from 'vitest';

const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa, execaSync: vi.fn(() => ({ stdout: '' })) }));

import { SUBPROCESS_TIMEOUT_MS } from '../src/orchestrator/exec.ts';
import { queryGithub } from '../src/orchestrator/github.ts';
import { createStackCollector } from '../src/orchestrator/github-stack.ts';
import { newTask } from '../src/orchestrator/state.ts';
import { listBranches } from '../src/orchestrator/worktree.ts';
import type { Config } from '../src/shared/types.ts';

const config = {
  repo: { path: 'C:\\src\\widgets', owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice' },
  github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
  agents: {},
  pipeline: [],
  server: { port: 4317 },
} satisfies Config;

beforeEach(() => {
  execa.mockReset();
  execa.mockResolvedValue({ stdout: '' });
});

/**
 * Every reconcile runs behind one serialized promise, so an external command
 * that never returns wedges the board for good. Each call must be bounded.
 */
describe('external commands are bounded', () => {
  test('gh runs under the shared timeout', async () => {
    execa.mockResolvedValue({ stdout: '{"data":{"repository":{}}}' });
    await queryGithub(config, 'query { rateLimit { remaining } }');
    expect(execa).toHaveBeenCalledWith(
      'gh',
      expect.any(Array),
      expect.objectContaining({ timeout: SUBPROCESS_TIMEOUT_MS }),
    );
  });

  test('git runs under the shared timeout', async () => {
    await listBranches(config);
    expect(execa).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({ timeout: SUBPROCESS_TIMEOUT_MS }),
    );
  });

  test('a timed-out gh degrades to an unavailable board rather than hanging', async () => {
    const timedOut = Object.assign(new Error('Command timed out'), { timedOut: true });
    execa.mockRejectedValue(timedOut);
    await expect(createStackCollector(config).collect([newTask(3060, 'Feature', 'alice')])).resolves.toMatchObject({ unavailable: new Set([3060]) });
  });

  test('a timed-out git degrades to an empty branch list rather than hanging', async () => {
    execa.mockRejectedValue(Object.assign(new Error('Command timed out'), { timedOut: true }));
    await expect(listBranches(config)).resolves.toEqual([]);
  });
});
