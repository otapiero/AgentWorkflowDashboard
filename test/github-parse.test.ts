import { describe, expect, test } from 'vitest';
import {
  parseChecksRollup,
  normalizeReviewDecision,
  parseReviewThreads,
  parseIssuePrsResponse,
  parseRateLimit,
  unavailableIssues,
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
        [thread(false, 'alice'), thread(false, COPILOT), thread(true, 'bob')],
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

describe('folding issue-attached PRs', () => {
  const fold = (nodes: unknown[]) => parseIssuePrsResponse(
    { data: { repository: { i0: { closedByPullRequestsReferences: { nodes } } } } },
    [3060], COPILOT,
  ).get(3060)!;

  const prNode = (opts: {
    number?: number;
    state?: 'OPEN' | 'MERGED' | 'CLOSED';
    createdAt?: string;
    reviewDecision?: string | null;
    threads?: unknown[];
    checks?: unknown[] | null;
  }) => ({
    number: opts.number ?? 42,
    url: `https://github.com/acme/widgets/pull/${opts.number ?? 42}`,
    state: opts.state ?? 'OPEN',
    createdAt: opts.createdAt ?? '2026-07-01T00:00:00Z',
    reviewDecision: opts.reviewDecision ?? '',
    reviewThreads: { nodes: opts.threads ?? [] },
    commits: { nodes: [{ commit: { statusCheckRollup:
      opts.checks === null ? null : { contexts: { nodes: opts.checks ?? [] } },
    } }] },
  });

  test('an issue with no attached PR reports no PR and no live gates', () => {
    expect(fold([])).toEqual({
      pr: { exists: false, number: null, url: null, state: null },
      checks: 'none',
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    });
  });

  test('an attached open PR reports checks, decision and thread counts together', () => {
    const result = fold([prNode({
      reviewDecision: 'REVIEW_REQUIRED',
      checks: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      threads: [
        { isResolved: false, comments: { nodes: [{ author: { login: COPILOT } }] } },
        { isResolved: false, comments: { nodes: [{ author: { login: 'alice' } }] } },
      ],
    })]);
    expect(result.checks).toBe('success');
    expect(result.review).toEqual({ decision: 'REVIEW_REQUIRED', unresolvedThreads: 2, copilotUnresolved: 1 });
  });

  test('a completed attached PR reports no live checks or review', () => {
    const result = fold([prNode({
      state: 'MERGED', reviewDecision: 'APPROVED',
      checks: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
      threads: [{ isResolved: false, comments: { nodes: [{ author: { login: 'alice' } }] } }],
    })]);
    expect(result.pr.state).toBe('MERGED');
    expect(result.checks).toBe('none');
    expect(result.review).toEqual({ decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 });
  });

  test('an attached open PR wins over a newer closed one', () => {
    const result = fold([
      prNode({ number: 20, state: 'CLOSED', createdAt: '2026-07-02T00:00:00Z' }),
      prNode({ number: 19, state: 'OPEN' }),
    ]);
    expect(result.pr).toMatchObject({ number: 19, state: 'OPEN' });
  });

  test('chooses the newest live PR regardless of relationship order', () => {
    const result = fold([
      prNode({ number: 19 }),
      prNode({ number: 20, createdAt: '2026-07-02T00:00:00Z' }),
    ]);
    expect(result.pr.number).toBe(20);
  });
});

describe('parseIssuePrsResponse', () => {
  const attached = (number: number) => ({ closedByPullRequestsReferences: { nodes: [{
    number, url: `https://github.com/acme/widgets/pull/${number}`, state: 'OPEN',
    createdAt: '2026-07-01T00:00:00Z', reviewDecision: '', reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
  }] } });

  test('maps each issue alias to its attached PR, including an issue without one', () => {
    const raw = { data: { repository: {
      i0: attached(11), i1: { closedByPullRequestsReferences: { nodes: [] } },
    } } };
    const map = parseIssuePrsResponse(raw, [3060, 3061], COPILOT);
    expect(map.get(3060)?.pr).toEqual({ exists: true, number: 11, url: 'https://github.com/acme/widgets/pull/11', state: 'OPEN' });
    expect(map.get(3061)?.pr.exists).toBe(false);
  });

  test('a missing issue response folds to no PR', () => {
    expect(parseIssuePrsResponse({ data: { repository: {} } }, [3060], COPILOT).get(3060)?.pr.exists).toBe(false);
  });

  test('healthy issue aliases still fold when a sibling lookup errored', () => {
    const raw = {
      data: { repository: { i0: attached(11), i1: null } },
      errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['repository', 'i1'] }],
    };
    expect(parseIssuePrsResponse(raw, [3060, 3061], COPILOT).get(3060)?.pr.number).toBe(11);
  });
});

describe('unavailableIssues', () => {
  test('a clean response leaves every issue trusted', () => {
    expect(unavailableIssues({ data: {}, errors: [] }, [3060, 3061])).toEqual(new Set());
  });

  test('an aliased error distrusts only the issue it names', () => {
    const raw = { errors: [{ type: 'SERVICE_UNAVAILABLE', path: ['repository', 'i2'], message: 'timedout' }] };
    expect(unavailableIssues(raw, [3060, 3061, 3062, 3063])).toEqual(new Set([3062]));
  });

  test('several errors distrust exactly their own issues', () => {
    const raw = { errors: [{ path: ['repository', 'i0'] }, { path: ['repository', 'i3'] }] };
    expect(unavailableIssues(raw, [3060, 3061, 3062, 3063])).toEqual(new Set([3060, 3063]));
  });

  test('an error naming no alias poisons the whole batch', () => {
    expect(unavailableIssues({ errors: [{ type: 'RATE_LIMITED' }] }, [3060])).toBeNull();
  });

  test('an alias outside the queried range poisons the batch', () => {
    expect(unavailableIssues({ errors: [{ path: ['repository', 'i9'] }] }, [3060])).toBeNull();
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
