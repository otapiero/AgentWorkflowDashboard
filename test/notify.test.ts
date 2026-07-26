import { describe, expect, test } from 'vitest';

import { needsYouIssues, newlyNeedsYou } from '../src/web/notify.ts';
import type { DerivedState, Phase, TaskWithDerived } from '../src/shared/types.ts';

function task(
  issue: number,
  needsYou: boolean,
  reason: string | null = null,
): TaskWithDerived {
  const derived: DerivedState = {
    issue,
    derivedPhase: 'ci' as Phase,
    displayPhase: 'ci' as Phase,
    gates: {} as DerivedState['gates'],
    badges: [],
    artifacts: [],
    needsYou,
    needsYouReason: reason,
  };
  return {
    issue,
    title: `Task ${issue}`,
    slug: `task-${issue}`,
    branch: `ouriel/${issue}`,
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    lastReconciledAt: null,
    derived,
    pinned: { agent: null, model: null, effort: null },
  };
}

describe('newlyNeedsYou', () => {
  test('a task that just flipped into needs-you is reported', () => {
    const fired = newlyNeedsYou(new Set(), [task(3140, true, 'CI is failing')]);
    expect(fired).toEqual([{ issue: 3140, title: 'Task 3140', reason: 'CI is failing' }]);
  });

  test('a task that already needed you is not reported again', () => {
    // Otherwise every 30s poll would re-notify for the same card.
    const fired = newlyNeedsYou(new Set([3140]), [task(3140, true, 'CI is failing')]);
    expect(fired).toEqual([]);
  });

  test('a task that does not need you is never reported', () => {
    expect(newlyNeedsYou(new Set(), [task(3140, false)])).toEqual([]);
  });

  test('the reason falls back to a generic phrase when absent', () => {
    const fired = newlyNeedsYou(new Set(), [task(3140, true, null)]);
    expect(fired[0]!.reason).toBe('needs you');
  });
});

describe('needsYouIssues', () => {
  test('collects exactly the issues that need you', () => {
    const set = needsYouIssues([task(1, true), task(2, false), task(3, true)]);
    expect([...set].sort()).toEqual([1, 3]);
  });
});
