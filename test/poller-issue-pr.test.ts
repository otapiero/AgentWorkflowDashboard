import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa }));

import { taskDir, planPath, statePath } from '../src/orchestrator/paths.ts';
import { reconcileAll } from '../src/orchestrator/poller.ts';
import { loadState, newTask, saveState } from '../src/orchestrator/state.ts';
import type { Config } from '../src/shared/types.ts';
import type { PrLayer } from '../src/shared/pr-stack.ts';

const config: Config = {
  repo: { path: 'C:\\src\\widgets', owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice' },
  github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
  agents: {}, pipeline: [], server: { port: 4317 },
};
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-linked-pr-'));
  process.env.MC_HOME = home;
  execa.mockReset();
});
afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('finds and persists the issue-attached PR without a matching branch or local worktree', async () => {
  saveState({ version: 1, tasks: [newTask(3060, 'Audio mode', 'alice')] });
  execa.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'git') return { stdout: '' };
    if (command === 'gh' && args.some(arg => arg.includes('issue(number:3060)') && arg.includes('closedByPullRequestsReferences'))) {
      return { stdout: JSON.stringify({ data: { repository: {
        openPrs: { nodes: [], pageInfo: { hasNextPage: false } },
        i0: { closedByPullRequestsReferences: { nodes: [{
          number: 42, url: 'https://github.com/acme/widgets/pull/42', state: 'OPEN',
          createdAt: '2026-07-01T00:00:00Z', headRefName: 'unrelated-branch-name',
          reviewDecision: 'NONE', reviewThreads: { nodes: [] },
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
            { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
          ] } } } }] },
        }] } },
      } } }) };
    }
    throw new Error('Unexpected GitHub query');
  });
  const { results } = await reconcileAll(config);
  expect(results[0]).toMatchObject({
    prNumber: 42, prState: 'OPEN', prUrl: 'https://github.com/acme/widgets/pull/42',
    derived: { displayPhase: 'ci', gates: { publish: true } },
  });
  expect(loadState().tasks[0]).toMatchObject({ prNumber: 42, prState: 'OPEN' });
});

test('a previous implementation run suppresses plan review after its markers are gone', async () => {
  const task = newTask(3060, 'Audio mode', 'alice');
  task.manualPhase = 'plan';
  task.spawnHistory = [{ phase: 'implement', agent: 'codex', startedAt: '2026-07-01T00:00:00Z', command: 'codex' }];
  saveState({ version: 1, tasks: [task] });
  mkdirSync(taskDir(3060), { recursive: true });
  writeFileSync(planPath(3060), '# Audio mode plan\n');
  execa.mockImplementation(async (command: string) => command === 'git' ? { stdout: '' } : {
    stdout: JSON.stringify({ data: { repository: { openPrs: { nodes: [], pageInfo: { hasNextPage: false } }, i0: { closedByPullRequestsReferences: { nodes: [] } } } } }),
  });
  const { results } = await reconcileAll(config);
  expect(results[0]!.derived.displayPhase).toBe('plan');
  expect(results[0]!.derived.badges.map(badge => badge.kind)).not.toContain('plan-ready');
  expect(results[0]!.derived.needsYou).toBe(false);
});

test('timestamp-only stack observations do not write state, but changed checks do', async () => {
  saveState({ version: 1, tasks: [newTask(42, 'Add widget', 'alice')] });
  execa.mockResolvedValue({ stdout: '' });
  const layer: PrLayer = {
    host: 'github.com', repository: 'acme/widgets', number: 7,
    title: 'Add widget', url: 'https://github.com/acme/widgets/pull/7', state: 'OPEN',
    headRepository: 'acme/widgets', baseRepository: 'acme/widgets',
    headBranch: 'alice/widget', baseBranch: 'main', headSha: 'a'.repeat(40),
    checks: 'pending', review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    available: true, source: 'attached', checkedAt: '2026-10-01T00:00:00Z',
  };
  const collector = {
    invalidate() {},
    async collect() {
      return { ok: true, rateLimit: null, unavailable: new Set<number>(),
        stacks: new Map([[42, { layers: [{ ...layer }], discoveryComplete: true }]]),
        byIssue: new Map([[42, { pr: { exists: true, number: 7, url: layer.url, state: layer.state }, checks: layer.checks, review: layer.review }]]),
      };
    },
  };
  await reconcileAll(config, collector);
  const original = readFileSync(statePath(), 'utf8');
  const oldTime = new Date('2020-01-01T00:00:00Z');
  utimesSync(statePath(), oldTime, oldTime);
  layer.checkedAt = '2026-10-01T00:01:00Z';
  const { results } = await reconcileAll(config, collector);
  expect(results[0]!.stack!.layers[0]!.checkedAt).toBe('2026-10-01T00:01:00Z');
  expect(readFileSync(statePath(), 'utf8')).toBe(original);
  expect(statSync(statePath()).mtimeMs).toBe(oldTime.getTime());

  layer.checks = 'failure';
  await reconcileAll(config, collector);
  expect(loadState().tasks[0]!.stack!.layers[0]!.checks).toBe('failure');
});
