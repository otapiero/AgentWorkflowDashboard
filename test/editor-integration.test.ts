import { describe, expect, test } from 'vitest';

import { toEditorIntegration } from '../src/orchestrator/editor-integration.ts';
import type { Facts } from '../src/shared/types.ts';

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    issue: 3060,
    worktreeExists: true,
    branchExists: true,
    markers: [],
    planMdExists: true,
    artifacts: [],
    hasPushedCommits: true,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn: { phase: 'implement', pid: 42, startedAt: '2026-08-03T09:00:00.000Z' },
    pr: { exists: true, number: 99, url: 'https://github.test/pr/99', state: 'OPEN' },
    checks: 'success',
    review: { decision: 'REVIEW_REQUIRED', unresolvedThreads: 2, copilotUnresolved: 1 },
    ...overrides,
  };
}

describe('toEditorIntegration', () => {
  test('copies gathered signals and supplies the canonical worktree path', () => {
    const result = toEditorIntegration(facts());
    expect(result.workspacePath).toMatch(/[\\/]issue-3060$/);
    expect(result).toMatchObject({
      worktreeExists: true,
      checks: 'success',
      approvalRequired: true,
      review: { decision: 'REVIEW_REQUIRED', unresolvedThreads: 2, copilotUnresolved: 1 },
    });
  });

  test('does not require approval without an open PR awaiting review', () => {
    expect(toEditorIntegration(facts({
      pr: { exists: false, number: null, url: null, state: null },
    })).approvalRequired).toBe(false);
  });
});
