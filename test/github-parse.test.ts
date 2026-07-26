import { describe, expect, test } from 'vitest';
import {
  parseChecksRollup,
  normalizeReviewDecision,
  parseReviewThreads,
  parseBranchPrResponse,
  parseRateLimit,
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

describe('parseBranchPrResponse', () => {
  /** Build the GraphQL envelope a single `gh api graphql` call returns. */
  const envelope = (nodes: unknown[]) => ({
    data: { repository: { pullRequests: { nodes } } },
  });

  /** One pull-request node in the combined-query shape. */
  const prNode = (opts: {
    number?: number;
    url?: string;
    state?: 'OPEN' | 'MERGED' | 'CLOSED';
    reviewDecision?: string | null;
    threads?: unknown[];
    checks?: unknown[] | null;
  }) => ({
    number: opts.number ?? 3119,
    url: opts.url ?? 'https://github.com/o/r/pull/3119',
    state: opts.state ?? 'OPEN',
    reviewDecision: opts.reviewDecision ?? '',
    reviewThreads: { nodes: opts.threads ?? [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup:
              opts.checks === null ? null : { contexts: { nodes: opts.checks ?? [] } },
          },
        },
      ],
    },
  });

  test('a branch with no associated PR reports no PR and no live gates', () => {
    expect(parseBranchPrResponse(envelope([]), COPILOT)).toEqual({
      pr: { exists: false, number: null, url: null, state: null },
      checks: 'none',
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    });
  });

  test('an open PR carries its number, url and state', () => {
    const result = parseBranchPrResponse(
      envelope([prNode({ number: 3119, url: 'https://x/pull/3119', state: 'OPEN' })]),
      COPILOT,
    );
    expect(result.pr).toEqual({
      exists: true,
      number: 3119,
      url: 'https://x/pull/3119',
      state: 'OPEN',
    });
  });

  test('an open PR reports checks, decision and thread counts together', () => {
    // The whole point of the combined query: one call yields every live gate.
    const result = parseBranchPrResponse(
      envelope([
        prNode({
          state: 'OPEN',
          reviewDecision: 'REVIEW_REQUIRED',
          checks: [
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
          threads: [
            { isResolved: false, comments: { nodes: [{ author: { login: COPILOT } }] } },
            { isResolved: false, comments: { nodes: [{ author: { login: 'ouriel' } }] } },
          ],
        }),
      ]),
      COPILOT,
    );
    expect(result.checks).toBe('success');
    expect(result.review).toEqual({
      decision: 'REVIEW_REQUIRED',
      unresolvedThreads: 2,
      copilotUnresolved: 1,
    });
  });

  test('a closed or merged PR reports no live checks or review', () => {
    // Matches the old early-return: a PR that is not OPEN has no gates to poll.
    const result = parseBranchPrResponse(
      envelope([
        prNode({
          state: 'MERGED',
          reviewDecision: 'APPROVED',
          checks: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
          threads: [
            { isResolved: false, comments: { nodes: [{ author: { login: 'ouriel' } }] } },
          ],
        }),
      ]),
      COPILOT,
    );
    expect(result.pr.state).toBe('MERGED');
    expect(result.checks).toBe('none');
    expect(result.review).toEqual({
      decision: 'NONE',
      unresolvedThreads: 0,
      copilotUnresolved: 0,
    });
  });

  test('an open PR is preferred over a more recent closed one', () => {
    // gh pr list --state all could return several; the open one is the live one.
    const result = parseBranchPrResponse(
      envelope([
        prNode({ number: 20, state: 'CLOSED' }),
        prNode({ number: 19, state: 'OPEN' }),
      ]),
      COPILOT,
    );
    expect(result.pr.number).toBe(19);
    expect(result.pr.state).toBe('OPEN');
  });

  test('a missing rollup on an open PR is treated as no checks', () => {
    const result = parseBranchPrResponse(
      envelope([prNode({ state: 'OPEN', checks: null })]),
      COPILOT,
    );
    expect(result.checks).toBe('none');
  });
});

describe('parseRateLimit', () => {
  test('reads the graphql rate-limit block', () => {
    expect(
      parseRateLimit({
        data: { rateLimit: { limit: 5000, remaining: 4930, resetAt: '2026-07-26T11:00:00Z' } },
      }),
    ).toEqual({ limit: 5000, remaining: 4930, resetAt: '2026-07-26T11:00:00Z' });
  });

  test('a malformed or missing block yields null rather than throwing', () => {
    expect(parseRateLimit(null)).toBeNull();
    expect(parseRateLimit({})).toBeNull();
    expect(parseRateLimit({ data: { rateLimit: { limit: 5000 } } })).toBeNull();
  });
});
