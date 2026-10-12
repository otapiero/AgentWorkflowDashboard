import { afterEach, describe, expect, test, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gatherGitFacts = vi.fn();

vi.mock('../src/orchestrator/worktree.ts', () => ({
  gatherGitFacts: (...a: unknown[]) => gatherGitFacts(...a),
  worktreeExists: () => true,
}));

import { gatherFacts } from '../src/orchestrator/facts.ts';
import type {
  BatchedIssuePrs,
  PrFacts,
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
const openPr: PrFacts = {
  pr: { exists: true, number: 42, url: 'u', state: 'OPEN' },
  checks: 'success',
  review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
};
function batch(over: Partial<BatchedIssuePrs> = {}): BatchedIssuePrs {
  return {
    ok: true,
    byIssue: new Map(),
    unavailable: new Set(),
    rateLimit: null,
    ...over,
  };
}

let home: string;

beforeEach(() => {
  // gatherFacts composes marker and worktree paths, so this needs a project
  // home like every other suite that touches paths.ts.
  home = mkdtempSync(join(tmpdir(), 'mc-facts-'));
  process.env.MC_HOME = home;
  gatherGitFacts.mockReset();
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
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

  test('an issue whose own alias errored throws', async () => {
    await expect(
      gatherFacts(
        config,
        task({ prState: 'OPEN', mergedAt: null }),
        new Set(['b']),
        batch({ unavailable: new Set([3130]) }),
      ),
    ).rejects.toThrow();
  });

  test('a healthy issue resolves even when a sibling alias errored', async () => {
    // The bug this guards: one timed-out alias used to mark every active card
    // unavailable, so the whole board froze on a single bad branch.
    const facts = await gatherFacts(
      config,
      task({ prState: 'OPEN', mergedAt: null }),
      new Set(['b']),
      batch({
        byIssue: new Map([[3130, openPr]]),
        unavailable: new Set([3060]),
      }),
    );
    expect(gatherGitFacts).toHaveBeenCalledOnce();
    expect(facts.pr.state).toBe('OPEN');
    expect(facts.checks).toBe('success');
  });
});
