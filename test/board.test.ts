import { describe, expect, test } from 'vitest';

import { applyLastGood, boardSignature } from '../src/orchestrator/board.ts';
import type { DerivedState, Phase, TaskWithDerived } from '../src/shared/types.ts';

function derived(overrides: Partial<DerivedState> = {}): DerivedState {
  return {
    issue: 1,
    derivedPhase: 'plan' as Phase,
    displayPhase: 'plan' as Phase,
    gates: {} as DerivedState['gates'],
    badges: [],
    needsYou: false,
    needsYouReason: null,
    ...overrides,
  };
}

function task(overrides: Partial<TaskWithDerived> = {}): TaskWithDerived {
  return {
    issue: 1,
    title: 'A task',
    slug: 'a-task',
    branch: 'ouriel/1-a-task',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    lastReconciledAt: '2026-07-26T10:00:00Z',
    derived: derived(),
    pinned: { agent: null, model: null, effort: null },
    ...overrides,
  };
}

describe('boardSignature', () => {
  test('two boards that differ only in lastReconciledAt have the same signature', () => {
    // The heartbeat carries freshness; the tasks payload must not re-fire for it.
    const a = [task({ lastReconciledAt: '2026-07-26T10:00:00Z' })];
    const b = [task({ lastReconciledAt: '2026-07-26T10:05:30Z' })];
    expect(boardSignature(a)).toBe(boardSignature(b));
  });

  test('a change in needsYou changes the signature', () => {
    const a = [task({ derived: derived({ needsYou: false }) })];
    const b = [task({ derived: derived({ needsYou: true, needsYouReason: 'CI is failing' }) })];
    expect(boardSignature(a)).not.toBe(boardSignature(b));
  });

  test('a task becoming unreachable changes the signature', () => {
    const a = [task({ unreachable: false })];
    const b = [task({ unreachable: true })];
    expect(boardSignature(a)).not.toBe(boardSignature(b));
  });

  test('a change in display phase changes the signature', () => {
    const a = [task({ derived: derived({ displayPhase: 'plan' }) })];
    const b = [task({ derived: derived({ displayPhase: 'implement' }) })];
    expect(boardSignature(a)).not.toBe(boardSignature(b));
  });
});

describe('applyLastGood', () => {
  test('a good result passes through and is remembered', () => {
    const good = task({ issue: 1, derived: derived({ displayPhase: 'ci' }) });
    const { results, lastGood } = applyLastGood([good], new Map());
    expect(results[0]!.unreachable).toBeFalsy();
    expect(results[0]!.derived.displayPhase).toBe('ci');
    expect(lastGood.get(1)?.derived.displayPhase).toBe('ci');
  });

  test('an unreachable result keeps its last good lane and is flagged', () => {
    const good = task({ issue: 1, derived: derived({ displayPhase: 'ci' }) });
    const cache = applyLastGood([good], new Map()).lastGood;

    const blip = task({
      issue: 1,
      unreachable: true,
      derived: derived({ displayPhase: 'inbox' }),
    });
    const { results } = applyLastGood([blip], cache);
    // Held in its real lane, not blanked to inbox, but marked stale.
    expect(results[0]!.derived.displayPhase).toBe('ci');
    expect(results[0]!.unreachable).toBe(true);
  });

  test('an unreachable result with no history stays as its fallback', () => {
    const blip = task({ issue: 9, unreachable: true, derived: derived({ displayPhase: 'inbox' }) });
    const { results } = applyLastGood([blip], new Map());
    expect(results[0]!.derived.displayPhase).toBe('inbox');
    expect(results[0]!.unreachable).toBe(true);
  });

  test('a task no longer on the board is dropped from the cache', () => {
    const cache = applyLastGood([task({ issue: 1 }), task({ issue: 2 })], new Map()).lastGood;
    const { lastGood } = applyLastGood([task({ issue: 1 })], cache);
    expect(lastGood.has(1)).toBe(true);
    expect(lastGood.has(2)).toBe(false);
  });
});
