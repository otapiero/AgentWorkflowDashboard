import { expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutionTarget } from '../src/orchestrator/execution-target.ts';
import { newTask } from '../src/orchestrator/state.ts';
import { prKey, type PrLayer } from '../src/shared/pr-stack.ts';
import type { Config } from '../src/shared/types.ts';
import { worktreePath } from '../src/orchestrator/paths.ts';
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mc-target-')); process.env.MC_HOME = home; });
afterEach(() => { delete process.env.MC_HOME; rmSync(home, { recursive: true, force: true }); });
const config = { repo: { owner: 'acme', name: 'widgets', baseBranch: 'main' } } as Config;
const p = { host: 'github.com', repository: 'acme/widgets', number: 11, state: 'OPEN', headRepository: 'acme/widgets', headBranch: 'alice/child', baseBranch: 'alice/parent', headSha: 'a'.repeat(40), available: true, checkedAt: new Date().toISOString() } as PrLayer;
test('resolves the child branch and actual base while leaving the issue branch intact', () => {
  const task = newTask(1, 'Feature', 'alice');
  task.stack = { layers: [p], discoveryComplete: true };
  const target = resolveExecutionTarget(config, task, prKey(p));
  expect(target.branch).toBe('alice/child');
  expect(target.baseBranch).toBe('alice/parent');
  expect(target.worktreePath).toBe(worktreePath(task.issue));
  task.stack.layers.push({ ...p, number: 12, headBranch: 'alice/next' });
  expect(resolveExecutionTarget(config, task, prKey(task.stack.layers[1]!)).worktreePath).toBe(target.worktreePath);
  expect(task.branch).not.toBe(target.branch);
});
test('rejects unknown, unavailable, stale and fork targets when explicitly requested', () => {
  const task = newTask(1, 'Feature', 'alice');
  task.stack = { layers: [p, { ...p, number: 12 }], discoveryComplete: true };
  expect(() => resolveExecutionTarget(config, task, 'unknown')).toThrow('belong');
  for (const change of [{ available: false }, { headRepository: 'alice/widgets' }, { checkedAt: '2000-01-01T00:00:00Z' }]) {
    task.stack.layers = [{ ...p, ...change }];
    expect(() => resolveExecutionTarget(config, task, prKey(p))).toThrow();
  }
});
