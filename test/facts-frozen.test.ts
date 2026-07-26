import { describe, expect, test, vi, beforeEach } from 'vitest';

const gatherGitFacts = vi.fn();

vi.mock('../src/orchestrator/worktree.ts', () => ({
  gatherGitFacts: (...a: unknown[]) => gatherGitFacts(...a),
  worktreeExists: () => true,
}));

import { gatherFacts } from '../src/orchestrator/facts.ts';
import type {
  BatchedBranchPrs,
  BranchPrFacts,
} from '../src/orchestrator/github.ts';
import type { Config, TaskRecord } from '../src/shared/types.ts';

const config = {} as Config;
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    issue: 3130, title: 't', slug: 's', branch: 'b', worktreePath: null,
    prNumber: 42, prUrl: 'https://x/pull/42', manualPhase: null,
    spawnHistory: [], lastReconciledAt: null, prState: 'MERGED',
    mergedAt: '2026-07-01T00:00:00Z', ...overrides,
  };
}
const openPr: BranchPrFacts = {
  pr: { exists: true, number: 42, url: 'u', state: 'OPEN' },
  checks: 'success',
  review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
};
function batch(over: Partial<BatchedBranchPrs> = {}): BatchedBranchPrs {
  return { ok: true, byBranch: new Map(), rateLimit: null, ...over };
}

beforeEach(() => {
  gatherGitFacts.mockReset();
});

describe('gatherFacts — merged freeze', () => {
  test('a merged task makes no git call and freezes its PR', async () => {
    const facts = await gatherFacts(config, task(), new Set(['b']), batch());
    expect(gatherGitFacts).not.toHaveBeenCalled();
    expect(facts.pr).toEqual({
      exists: true, number: 42, url: 'https://x/pull/42', state: 'MERGED',
    });
  });
});

describe('gatherFacts — active task', () => {
  beforeEach(() => {
    gatherGitFacts.mockResolvedValue({
      dirtyFileCount: 0, unpushedCommits: 0, hasPushedCommits: true,
    });
  });

  test('reads PR facts from the batch, not the network', async () => {
    const facts = await gatherFacts(
      config,
      task({ prState: 'OPEN', mergedAt: null }),
      new Set(['b']),
      batch({ byBranch: new Map([['b', openPr]]) }),
    );
    expect(gatherGitFacts).toHaveBeenCalledOnce();
    expect(facts.pr.state).toBe('OPEN');
    expect(facts.checks).toBe('success');
  });

  test('a failed batch throws so the poller can hold last-good', async () => {
    await expect(
      gatherFacts(
        config,
        task({ prState: 'OPEN', mergedAt: null }),
        new Set(['b']),
        batch({ ok: false }),
      ),
    ).rejects.toThrow();
  });
});
