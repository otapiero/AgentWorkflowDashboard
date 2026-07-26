import { describe, expect, test } from 'vitest';
import {
  anyInFlight,
  nextDelayMs,
  REST_MS,
  DORMANT_MS,
} from '../src/orchestrator/board.ts';
import type { Badge, TaskWithDerived } from '../src/shared/types.ts';

/** Minimal board card carrying only the badges the cadence logic reads. */
function card(badges: Badge[]): TaskWithDerived {
  return {
    issue: 1, title: 't', slug: 's', branch: 'b', worktreePath: null,
    prNumber: null, prUrl: null, prState: null, mergedAt: null,
    manualPhase: null, spawnHistory: [], lastReconciledAt: null,
    pinned: { agent: null, model: null, effort: null },
    derived: {
      issue: 1, derivedPhase: 'ci', displayPhase: 'ci',
      gates: {} as never, badges, needsYou: false, needsYouReason: null,
    },
  };
}

const live: Badge = { kind: 'live', label: 'implement running', tone: 'busy' };
const ciBusy: Badge = { kind: 'ci', label: 'CI pending', tone: 'busy' };
const ciGood: Badge = { kind: 'ci', label: 'CI success', tone: 'good' };
const copilot: Badge = { kind: 'copilot', label: '1 Copilot', tone: 'warn' };
const review: Badge = { kind: 'review', label: '1 review', tone: 'warn' };
const approved: Badge = { kind: 'approved', label: 'approved', tone: 'good' };

describe('anyInFlight', () => {
  test('a live spawn is in flight', () => {
    expect(anyInFlight([card([live])])).toBe(true);
  });
  test('pending CI is in flight', () => {
    expect(anyInFlight([card([ciBusy])])).toBe(true);
  });
  test('unresolved Copilot or human review is in flight', () => {
    expect(anyInFlight([card([copilot])])).toBe(true);
    expect(anyInFlight([card([review])])).toBe(true);
  });
  test('a green, approved board at rest is not in flight', () => {
    expect(anyInFlight([card([ciGood, approved])])).toBe(false);
  });
  test('an empty board is not in flight', () => {
    expect(anyInFlight([])).toBe(false);
  });
});

describe('nextDelayMs', () => {
  const fast = 30_000;
  test('no clients means dormant regardless of work', () => {
    expect(nextDelayMs([card([live])], false, fast)).toBe(DORMANT_MS);
    expect(nextDelayMs([], false, fast)).toBe(DORMANT_MS);
  });
  test('clients + in-flight work means fast', () => {
    expect(nextDelayMs([card([ciBusy])], true, fast)).toBe(fast);
  });
  test('clients but nothing in flight means rest', () => {
    expect(nextDelayMs([card([ciGood])], true, fast)).toBe(REST_MS);
  });
});
