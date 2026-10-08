import { describe, expect, test } from 'vitest';
import {
  parseChecksRollup,
  normalizeReviewDecision,
  parseReviewThreads,
  parseBranchPrsResponse,
  parseRateLimit,
  unavailableBranches,
} from '../src/orchestrator/github.ts';

const COPILOT = 'copilot-pull-request-reviewer';

describe('parseChecksRollup', () => {
  test('an empty rollup means no checks have reported', () => {
    // Real shape from PR #3119, which had no checks at all.
    expect(parseChecksRollup([])).toBe('none');
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

  test('resolved threads are not counted', () => {
    // PR #3122's real state: two Copilot threads, both resolved.
    expect(
      parseReviewThreads([thread(true, COPILOT), thread(true, COPILOT)], COPILOT),
    ).toEqual({ unresolvedThreads: 0, copilotUnresolved: 0 });
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

describe('folding a branch PR connection', () => {
  /** Fold one branch's PR connection through the batched parser. */
  const fold = (nodes: unknown[]) =>
    parseBranchPrsResponse(
      { data: { repository: { b0: { nodes } } } },
      ['feat'],
      COPILOT,
    ).get('feat')!;

  /** One pull-request node in the combined-query shape. */
  const prNode = (opts: {
    number?: number;
    state?: 'OPEN' | 'MERGED' | 'CLOSED';
    reviewDecision?: string | null;
    threads?: unknown[];
    checks?: unknown[] | null;
  }) => ({
    number: opts.number ?? 3119,
    url: `https://github.com/o/r/pull/${opts.number ?? 3119}`,
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
    expect(fold([])).toEqual({
      pr: { exists: false, number: null, url: null, state: null },
      checks: 'none',
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    });
  });

  test('an open PR reports checks, decision and thread counts together', () => {
    // The whole point of the combined query: one call yields every live gate.
    const result = fold([
      prNode({
        state: 'OPEN',
        reviewDecision: 'REVIEW_REQUIRED',
        checks: [
          { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
        threads: [
          { isResolved: false, comments: { nodes: [{ author: { login: COPILOT } }] } },
          { isResolved: false, comments: { nodes: [{ author: { login: 'alice' } }] } },
        ],
      }),
    ]);
    expect(result.checks).toBe('success');
    expect(result.review).toEqual({
      decision: 'REVIEW_REQUIRED',
      unresolvedThreads: 2,
      copilotUnresolved: 1,
    });
  });

  test('a closed or merged PR reports no live checks or review', () => {
    // A PR that is not OPEN has no gates to poll.
    const result = fold([
      prNode({
        state: 'MERGED',
        reviewDecision: 'APPROVED',
        checks: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
        threads: [
          { isResolved: false, comments: { nodes: [{ author: { login: 'alice' } }] } },
        ],
      }),
    ]);
    expect(result.pr.state).toBe('MERGED');
    expect(result.checks).toBe('none');
    expect(result.review).toEqual({
      decision: 'NONE',
      unresolvedThreads: 0,
      copilotUnresolved: 0,
    });
  });

  test('an open PR is preferred over a more recent closed one', () => {
    // Several PRs can share a head branch; the open one is the live one.
    const result = fold([
      prNode({ number: 20, state: 'CLOSED' }),
      prNode({ number: 19, state: 'OPEN' }),
    ]);
    expect(result.pr.number).toBe(19);
    expect(result.pr.state).toBe('OPEN');
  });
});

describe('parseBranchPrsResponse', () => {
  // The batched envelope: one aliased connection per branch, keyed b0, b1, ...
  const prNode = (state: 'OPEN' | 'CLOSED' | 'MERGED', number: number) => ({
    number,
    url: `https://x/pull/${number}`,
    state,
    reviewDecision: '',
    reviewThreads: { nodes: [] },
    commits: {
      nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }],
    },
  });

  test('maps each aliased connection back to its branch', () => {
    const raw = {
      data: {
        repository: {
          b0: { nodes: [prNode('OPEN', 11)] },
          b1: { nodes: [] },
        },
      },
    };
    const map = parseBranchPrsResponse(raw, ['feat-a', 'feat-b'], COPILOT);
    expect(map.get('feat-a')?.pr).toEqual({
      exists: true, number: 11, url: 'https://x/pull/11', state: 'OPEN',
    });
    expect(map.get('feat-b')?.pr).toEqual({
      exists: false, number: null, url: null, state: null,
    });
  });

  test('a branch missing from the response folds to no PR', () => {
    const map = parseBranchPrsResponse({ data: { repository: {} } }, ['x'], COPILOT);
    expect(map.get('x')?.pr.exists).toBe(false);
  });

  test('healthy aliases still fold when a sibling alias errored', () => {
    // GitHub fills in every alias it could answer and nulls the one it could
    // not; the good branches must survive their neighbour's failure.
    const raw = {
      data: { repository: { b0: { nodes: [prNode('OPEN', 11)] }, b1: null } },
      errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['repository', 'b1'] }],
    };
    const map = parseBranchPrsResponse(raw, ['feat-a', 'feat-b'], COPILOT);
    expect(map.get('feat-a')?.pr.number).toBe(11);
  });
});

describe('unavailableBranches', () => {
  test('a clean response leaves every branch trusted', () => {
    expect(unavailableBranches({ data: {} }, ['a', 'b'])).toEqual(new Set());
    expect(unavailableBranches({ data: {}, errors: [] }, ['a'])).toEqual(new Set());
  });

  test('an aliased error distrusts only the branch it names', () => {
    // Real shape: gh exits non-zero for this, but four of five branches are
    // perfectly good and must not be held back with the fifth.
    const raw = {
      errors: [
        {
          type: 'SERVICE_UNAVAILABLE',
          path: ['repository', 'b2'],
          message: 'timedout',
        },
      ],
    };
    expect(unavailableBranches(raw, ['a', 'b', 'c', 'd'])).toEqual(new Set(['c']));
  });

  test('several aliased errors distrust exactly their own branches', () => {
    const raw = {
      errors: [{ path: ['repository', 'b0'] }, { path: ['repository', 'b3'] }],
    };
    expect(unavailableBranches(raw, ['a', 'b', 'c', 'd'])).toEqual(
      new Set(['a', 'd']),
    );
  });

  test('an error naming no alias poisons the whole batch', () => {
    // RATE_LIMITED and MAX_NODE_LIMIT_EXCEEDED arrive without a path: nothing
    // in the payload can be trusted, so null says "hold every card".
    expect(unavailableBranches({ errors: [{ type: 'RATE_LIMITED' }] }, ['a'])).toBeNull();
  });

  test('an alias outside the queried range poisons the batch', () => {
    expect(unavailableBranches({ errors: [{ path: ['repository', 'b9'] }] }, ['a'])).toBeNull();
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
