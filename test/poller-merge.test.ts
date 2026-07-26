import { describe, expect, test } from 'vitest';
import { mergedFields } from '../src/orchestrator/poller.ts';
import type { TaskRecord } from '../src/shared/types.ts';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    issue: 3130, title: 't', slug: 's', branch: 'b', worktreePath: null,
    prNumber: 1, prUrl: 'u', manualPhase: null, spawnHistory: [],
    lastReconciledAt: null, prState: null, mergedAt: null, ...overrides,
  };
}

describe('mergedFields', () => {
  test('records the observed state', () => {
    const r = mergedFields(task(), 'OPEN', '2026-07-26T00:00:00Z');
    expect(r.prState).toBe('OPEN');
    expect(r.mergedAt).toBeNull();
  });

  test('stamps mergedAt the first time MERGED is seen', () => {
    const r = mergedFields(task(), 'MERGED', '2026-07-26T00:00:00Z');
    expect(r.prState).toBe('MERGED');
    expect(r.mergedAt).toBe('2026-07-26T00:00:00Z');
  });

  test('does not overwrite an existing mergedAt', () => {
    const r = mergedFields(
      task({ prState: 'MERGED', mergedAt: '2026-07-01T00:00:00Z' }),
      'MERGED', '2026-07-26T00:00:00Z',
    );
    expect(r.mergedAt).toBe('2026-07-01T00:00:00Z');
  });
});
