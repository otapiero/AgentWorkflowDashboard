import { describe, expect, test, vi, beforeEach } from 'vitest';

const fetchBranchPr = vi.fn();
const gatherGitFacts = vi.fn();

vi.mock('../src/orchestrator/github.ts', () => ({
  fetchBranchPr: (...a: unknown[]) => fetchBranchPr(...a),
}));
vi.mock('../src/orchestrator/worktree.ts', () => ({
  gatherGitFacts: (...a: unknown[]) => gatherGitFacts(...a),
  worktreeExists: () => true,
}));

import { gatherFacts } from '../src/orchestrator/facts.ts';
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

beforeEach(() => {
  fetchBranchPr.mockReset();
  gatherGitFacts.mockReset();
});

describe('gatherFacts — merged freeze', () => {
  test('a merged task makes no git or GraphQL calls', async () => {
    const facts = await gatherFacts(config, task(), new Set(['b']));
    expect(fetchBranchPr).not.toHaveBeenCalled();
    expect(gatherGitFacts).not.toHaveBeenCalled();
    expect(facts.pr.state).toBe('MERGED');
    expect(facts.pr.number).toBe(42);
    expect(facts.pr.exists).toBe(true);
  });

  test('a non-merged task still queries', async () => {
    fetchBranchPr.mockResolvedValue({
      pr: { exists: true, number: 42, url: 'u', state: 'OPEN' },
      checks: 'success',
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    });
    gatherGitFacts.mockResolvedValue({
      dirtyFileCount: 0, unpushedCommits: 0, hasPushedCommits: true,
    });
    await gatherFacts(config, task({ prState: 'OPEN', mergedAt: null }), new Set(['b']));
    expect(fetchBranchPr).toHaveBeenCalledOnce();
  });
});
