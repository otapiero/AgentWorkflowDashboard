import { describe, expect, test } from 'vitest';
import {
  parseChecksRollup,
  normalizeReviewDecision,
  parseReviewThreads,
} from '../src/orchestrator/github.ts';

const COPILOT = 'copilot-pull-request-reviewer';

describe('parseChecksRollup', () => {
  test('an empty rollup means no checks have reported', () => {
    // Real shape from PR #3119, which had no checks at all.
    expect(parseChecksRollup([])).toBe('none');
  });

  test('all successful check runs are success', () => {
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
    ).toBe('success');
  });

  test('skipped checks do not count as failures', () => {
    // Real shape from PR #2830: conditional jobs report SKIPPED on a green PR.
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ]),
    ).toBe('success');
  });

  test('any failed check makes the whole rollup a failure', () => {
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failure');
  });

  test('timed out and action required count as failures', () => {
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      ]),
    ).toBe('failure');
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      ]),
    ).toBe('failure');
  });

  test('a run still in progress makes the rollup pending', () => {
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
      ]),
    ).toBe('pending');
  });

  test('a queued run makes the rollup pending', () => {
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'QUEUED', conclusion: null },
      ]),
    ).toBe('pending');
  });

  test('failure outranks pending, so a red run surfaces immediately', () => {
    // Waiting for the rest of a run to finish would hide an actionable failure.
    expect(
      parseChecksRollup([
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failure');
  });

  test('legacy StatusContext entries are read via their state field', () => {
    expect(
      parseChecksRollup([{ __typename: 'StatusContext', state: 'SUCCESS' }]),
    ).toBe('success');
    expect(
      parseChecksRollup([{ __typename: 'StatusContext', state: 'FAILURE' }]),
    ).toBe('failure');
    expect(
      parseChecksRollup([{ __typename: 'StatusContext', state: 'PENDING' }]),
    ).toBe('pending');
  });

  test('a missing rollup is treated as no checks', () => {
    expect(parseChecksRollup(null)).toBe('none');
    expect(parseChecksRollup(undefined)).toBe('none');
  });
});

describe('normalizeReviewDecision', () => {
  test('an empty string means no review, not an invalid value', () => {
    // gh returns "" rather than null when nothing has been reviewed.
    // Verified against PR #3119.
    expect(normalizeReviewDecision('')).toBe('NONE');
  });

  test('null means no review', () => {
    expect(normalizeReviewDecision(null)).toBe('NONE');
  });

  test('known decisions pass through unchanged', () => {
    expect(normalizeReviewDecision('APPROVED')).toBe('APPROVED');
    expect(normalizeReviewDecision('CHANGES_REQUESTED')).toBe('CHANGES_REQUESTED');
    expect(normalizeReviewDecision('REVIEW_REQUIRED')).toBe('REVIEW_REQUIRED');
  });

  test('an unrecognised value degrades to NONE rather than breaking the gate', () => {
    expect(normalizeReviewDecision('SOMETHING_NEW')).toBe('NONE');
  });
});

describe('parseReviewThreads', () => {
  /** The real GraphQL node shape returned for this repo. */
  const thread = (isResolved: boolean, login: string) => ({
    isResolved,
    comments: { nodes: [{ author: { login } }] },
  });

  test('no threads means nothing unresolved', () => {
    expect(parseReviewThreads([], COPILOT)).toEqual({
      unresolvedThreads: 0,
      copilotUnresolved: 0,
    });
  });

  test('resolved threads are not counted', () => {
    // PR #3122's real state: two Copilot threads, both resolved.
    expect(
      parseReviewThreads([thread(true, COPILOT), thread(true, COPILOT)], COPILOT),
    ).toEqual({ unresolvedThreads: 0, copilotUnresolved: 0 });
  });

  test('unresolved Copilot threads are counted in both totals', () => {
    // PR #3119's real state: two unresolved Copilot threads.
    expect(
      parseReviewThreads([thread(false, COPILOT), thread(false, COPILOT)], COPILOT),
    ).toEqual({ unresolvedThreads: 2, copilotUnresolved: 2 });
  });

  test('human threads count toward the total but not the Copilot count', () => {
    expect(
      parseReviewThreads(
        [thread(false, 'Sonya'), thread(false, COPILOT), thread(true, 'avichai')],
        COPILOT,
      ),
    ).toEqual({ unresolvedThreads: 2, copilotUnresolved: 1 });
  });

  test('a thread with no comments is counted as human rather than dropped', () => {
    // Defensive: an unresolved thread we cannot attribute still needs a human.
    expect(
      parseReviewThreads([{ isResolved: false, comments: { nodes: [] } }], COPILOT),
    ).toEqual({ unresolvedThreads: 1, copilotUnresolved: 0 });
  });

  test('a null author is counted as human rather than crashing', () => {
    expect(
      parseReviewThreads(
        [{ isResolved: false, comments: { nodes: [{ author: null }] } }],
        COPILOT,
      ),
    ).toEqual({ unresolvedThreads: 1, copilotUnresolved: 0 });
  });

  test('the Copilot login is matched case-insensitively', () => {
    expect(
      parseReviewThreads([thread(false, 'Copilot-Pull-Request-Reviewer')], COPILOT)
        .copilotUnresolved,
    ).toBe(1);
  });
});
