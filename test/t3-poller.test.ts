import { describe, expect, test } from 'vitest';

import { shouldFetchT3Snapshot } from '../src/orchestrator/poller.ts';
import type { TaskRecord } from '../src/shared/types.ts';

function task(threadId?: string): TaskRecord {
  return {
    issue: 3060,
    title: 't',
    slug: 't',
    branch: 'b',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: threadId
      ? [{ phase: 'plan', agent: 'codex', startedAt: '2026-08-07T09:00:00Z', command: 't3', threadId }]
      : [],
    lastReconciledAt: null,
  };
}

describe('shouldFetchT3Snapshot', () => {
  test('fetches when at least one task has a T3 thread', () => {
    expect(shouldFetchT3Snapshot([task(), task('thread-1')])).toBe(true);
  });

  test('does not spend a request when no task has ever used T3', () => {
    // A board that never touched T3 must not pay for it every poll.
    expect(shouldFetchT3Snapshot([task(), task()])).toBe(false);
  });

  test('an empty board does not fetch', () => {
    expect(shouldFetchT3Snapshot([])).toBe(false);
  });
});
