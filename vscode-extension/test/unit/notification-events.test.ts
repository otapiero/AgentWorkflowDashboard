import { expect, test } from 'vitest';

import { classifyTransitions } from '../../src/notifications/notification-events.ts';
import { task } from './fixtures.ts';

const at = (value: string) => task({ lastReconciledAt: value });

test('classifies explicit task transitions', () => {
  const running = at('2026-08-03T10:00:00.000Z');
  running.integration.liveSpawn = { phase: 'implement', pid: 42, startedAt: '2026-08-03T09:00:00.000Z' };
  const stopped = at('2026-08-03T10:01:00.000Z');
  const failure = task({ checks: 'failure', lastReconciledAt: '2026-08-03T10:02:00.000Z' });
  const passed = task({ checks: 'success', lastReconciledAt: '2026-08-03T10:03:00.000Z' });
  const reviews = at('2026-08-03T10:04:00.000Z');
  reviews.integration.review = { decision: 'NONE', unresolvedThreads: 1, copilotUnresolved: 1 };
  const moreReviews = at('2026-08-03T10:05:00.000Z');
  moreReviews.integration.review = { decision: 'NONE', unresolvedThreads: 2, copilotUnresolved: 2 };
  const approval = at('2026-08-03T10:06:00.000Z');
  approval.integration.approvalRequired = true;

  expect(classifyTransitions(running, stopped)).toEqual([expect.objectContaining({ kind: 'agentFinished', issue: 3060 })]);
  expect(classifyTransitions(failure, failure)).toEqual([]);
  expect(classifyTransitions(failure, passed)).toEqual([expect.objectContaining({ kind: 'ciPassed', issue: 3060 })]);
  expect(classifyTransitions(reviews, moreReviews)).toEqual([expect.objectContaining({ kind: 'reviewComments', issue: 3060 })]);
  expect(classifyTransitions(at('2026-08-03T10:07:00.000Z'), approval)).toEqual([expect.objectContaining({ kind: 'approvalRequired', issue: 3060 })]);
  const nextFailure = task({ checks: 'failure', lastReconciledAt: '2026-08-03T10:08:00.000Z' });
  expect(classifyTransitions(passed, nextFailure)).toEqual([expect.objectContaining({ kind: 'ciFailed', fingerprint: expect.stringContaining(nextFailure.lastReconciledAt!) })]);
});

test('does not classify a transition without a current reconciliation timestamp', () => {
  const unreconciled = { ...task({ checks: 'failure' }), lastReconciledAt: null };
  expect(classifyTransitions(task(), unreconciled)).toEqual([]);
});
