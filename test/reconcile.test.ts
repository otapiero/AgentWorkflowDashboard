import { describe, expect, test } from 'vitest';
import { reconcile } from '../src/orchestrator/reconcile.ts';
import type { Facts } from '../src/shared/types.ts';

/** A task that exists as an issue and nothing more. */
function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    issue: 3060,
    worktreeExists: false,
    branchExists: false,
    markers: [],
    planMdExists: false,
    artifacts: [],
    hasPushedCommits: false,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn: null,
    pr: { exists: false, number: null, url: null, state: null },
    checks: 'none',
    review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    ...overrides,
  };
}

/** A task with an open PR, green CI, and no reviews yet. */
function openPr(overrides: Partial<Facts> = {}): Facts {
  return facts({
    worktreeExists: true,
    branchExists: true,
    hasPushedCommits: true,
    markers: ['plan.done', 'implement.done'],
    planMdExists: true,
    pr: {
      exists: true,
      number: 3119,
      url: 'https://github.com/acme/widgets/pull/3119',
      state: 'OPEN',
    },
    checks: 'success',
    ...overrides,
  });
}

describe('derivedPhase — pipeline order, first match wins', () => {
  test('a merged PR is done, regardless of anything else', () => {
    const d = reconcile(
      openPr({
        pr: { exists: true, number: 3119, url: 'u', state: 'MERGED' },
        checks: 'failure',
        review: { decision: 'NONE', unresolvedThreads: 5, copilotUnresolved: 5 },
      }),
    );
    expect(d.derivedPhase).toBe('done');
  });

  test('approved with no unresolved threads is ready to merge', () => {
    const d = reconcile(
      openPr({
        review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 },
      }),
    );
    expect(d.derivedPhase).toBe('merge');
  });

  test('changes requested goes to dev review', () => {
    const d = reconcile(
      openPr({
        review: {
          decision: 'CHANGES_REQUESTED',
          unresolvedThreads: 0,
          copilotUnresolved: 0,
        },
      }),
    );
    expect(d.derivedPhase).toBe('dev_review');
  });

  test('unresolved human threads go to dev review even without a formal decision', () => {
    const d = reconcile(
      openPr({
        review: {
          decision: 'REVIEW_REQUIRED',
          unresolvedThreads: 3,
          copilotUnresolved: 1,
        },
      }),
    );
    // 3 total, 1 from Copilot => 2 human threads outstanding.
    expect(d.derivedPhase).toBe('dev_review');
  });

  test('only Copilot threads outstanding goes to copilot review', () => {
    // This is PR #3119's real state: 2 unresolved threads, both Copilot's.
    const d = reconcile(
      openPr({
        review: {
          decision: 'REVIEW_REQUIRED',
          unresolvedThreads: 2,
          copilotUnresolved: 2,
        },
      }),
    );
    expect(d.derivedPhase).toBe('copilot_review');
  });

  test('human review outranks Copilot review when both are outstanding', () => {
    const d = reconcile(
      openPr({
        review: {
          decision: 'CHANGES_REQUESTED',
          unresolvedThreads: 4,
          copilotUnresolved: 2,
        },
      }),
    );
    expect(d.derivedPhase).toBe('dev_review');
  });

  test('failing checks hold the task at CI', () => {
    const d = reconcile(openPr({ checks: 'failure' }));
    expect(d.derivedPhase).toBe('ci');
  });

  test('pending checks hold the task at CI', () => {
    const d = reconcile(openPr({ checks: 'pending' }));
    expect(d.derivedPhase).toBe('ci');
  });

  test('an open PR with green checks and no review rests at copilot review', () => {
    const d = reconcile(openPr());
    expect(d.derivedPhase).toBe('copilot_review');
  });

  test('pushed commits plus implement.done means ready to publish', () => {
    const d = reconcile(
      facts({
        worktreeExists: true,
        branchExists: true,
        planMdExists: true,
        hasPushedCommits: true,
        markers: ['plan.done', 'implement.done'],
      }),
    );
    expect(d.derivedPhase).toBe('publish');
  });

  test('an attached plan moves the task to implement', () => {
    const d = reconcile(
      facts({ worktreeExists: true, branchExists: true, planMdExists: true }),
    );
    expect(d.derivedPhase).toBe('implement');
  });

  test('a worktree with no plan yet sits at plan', () => {
    const d = reconcile(facts({ worktreeExists: true, branchExists: true }));
    expect(d.derivedPhase).toBe('plan');
  });

  test('an issue with nothing started is in the inbox', () => {
    expect(reconcile(facts()).derivedPhase).toBe('inbox');
  });
});

describe('derivedPhase — fallbacks when markers are missing', () => {
  test('plan.md present without plan.done still counts as plan ready', () => {
    const d = reconcile(
      facts({ worktreeExists: true, branchExists: true, planMdExists: true, markers: [] }),
    );
    expect(d.derivedPhase).toBe('implement');
    expect(d.gates.plan).toBe(true);
  });

  test('plan.done present without plan.md still counts as plan ready', () => {
    const d = reconcile(
      facts({ worktreeExists: true, branchExists: true, markers: ['plan.done'] }),
    );
    expect(d.derivedPhase).toBe('implement');
    expect(d.gates.plan).toBe(true);
  });

  test('a plan.running marker alone is enough to leave the inbox', () => {
    const d = reconcile(facts({ markers: ['plan.running'] }));
    expect(d.derivedPhase).toBe('plan');
  });

  test('pushed commits without implement.done stay in implement, not publish', () => {
    // Real work exists, but only the human declares implementation finished.
    const d = reconcile(
      facts({
        worktreeExists: true,
        branchExists: true,
        planMdExists: true,
        hasPushedCommits: true,
        markers: ['plan.done'],
      }),
    );
    expect(d.derivedPhase).toBe('implement');
  });

  test('an existing branch with no local worktree still leaves the inbox', () => {
    const d = reconcile(facts({ branchExists: true }));
    expect(d.derivedPhase).toBe('plan');
  });
});

describe('gates', () => {
  test('publish gate opens exactly when a PR exists', () => {
    expect(reconcile(facts()).gates.publish).toBe(false);
    expect(reconcile(openPr()).gates.publish).toBe(true);
  });

  test('ci gate opens only on success', () => {
    expect(reconcile(openPr({ checks: 'pending' })).gates.ci).toBe(false);
    expect(reconcile(openPr({ checks: 'failure' })).gates.ci).toBe(false);
    expect(reconcile(openPr({ checks: 'success' })).gates.ci).toBe(true);
  });

  test('copilot gate opens when a PR exists with no unresolved Copilot threads', () => {
    expect(reconcile(openPr()).gates.copilot_review).toBe(true);
    expect(
      reconcile(
        openPr({
          review: { decision: 'NONE', unresolvedThreads: 2, copilotUnresolved: 2 },
        }),
      ).gates.copilot_review,
    ).toBe(false);
  });

  test('dev review gate needs both approval and zero unresolved threads', () => {
    expect(
      reconcile(
        openPr({
          review: { decision: 'APPROVED', unresolvedThreads: 1, copilotUnresolved: 0 },
        }),
      ).gates.dev_review,
    ).toBe(false);
    expect(
      reconcile(
        openPr({
          review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 },
        }),
      ).gates.dev_review,
    ).toBe(true);
  });

  test('implement gate is the implement.done marker alone', () => {
    expect(reconcile(facts({ planMdExists: true })).gates.implement).toBe(false);
    expect(reconcile(facts({ markers: ['implement.done'] })).gates.implement).toBe(true);
  });

  test('merge gate is never satisfied automatically', () => {
    const d = reconcile(
      openPr({
        review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 },
      }),
    );
    expect(d.derivedPhase).toBe('merge');
    expect(d.gates.merge).toBe(false);
  });
});

describe('displayPhase and manual override', () => {
  test('without an override the display phase is the derived phase', () => {
    expect(reconcile(openPr()).displayPhase).toBe('copilot_review');
  });

  test('a manual override wins for placement', () => {
    const d = reconcile(openPr({ checks: 'failure' }), 'merge');
    expect(d.derivedPhase).toBe('ci');
    expect(d.displayPhase).toBe('merge');
  });

  test('badges still reflect real facts under an override', () => {
    // A card parked in Merge must still show its red CI badge.
    const d = reconcile(openPr({ checks: 'failure' }), 'merge');
    expect(d.badges).toContainEqual(
      expect.objectContaining({ kind: 'ci', tone: 'bad' }),
    );
  });
});

describe('badges', () => {
  test('a live spawn is reported as busy', () => {
    const d = reconcile(
      facts({
        worktreeExists: true,
        liveSpawn: { phase: 'plan', pid: 1234, startedAt: '2026-07-21T10:00:00Z' },
      }),
    );
    expect(d.badges).toContainEqual(
      expect.objectContaining({ kind: 'live', tone: 'busy' }),
    );
  });

  test('a running marker whose process is gone is reported as stale, not live', () => {
    const d = reconcile(
      facts({ worktreeExists: true, markers: ['plan.running'], liveSpawn: null }),
    );
    expect(d.badges.map((b) => b.kind)).toContain('stale-spawn');
    expect(d.badges.map((b) => b.kind)).not.toContain('live');
  });

  test('uncommitted and unpushed work are surfaced with counts', () => {
    const d = reconcile(
      facts({
        worktreeExists: true,
        branchExists: true,
        planMdExists: true,
        dirtyFileCount: 4,
        unpushedCommits: 2,
      }),
    );
    expect(d.badges).toContainEqual(
      expect.objectContaining({ kind: 'dirty', label: '4 uncommitted' }),
    );
    expect(d.badges).toContainEqual(
      expect.objectContaining({ kind: 'unpushed', label: '2 unpushed' }),
    );
  });

  test('a clean worktree produces no dirty or unpushed badge', () => {
    const kinds = reconcile(openPr()).badges.map((b) => b.kind);
    expect(kinds).not.toContain('dirty');
    expect(kinds).not.toContain('unpushed');
  });

  test('the PR number is surfaced as a badge', () => {
    expect(reconcile(openPr()).badges).toContainEqual(
      expect.objectContaining({ kind: 'pr', label: '#3119' }),
    );
  });

  test('unresolved Copilot and human threads are counted separately', () => {
    const d = reconcile(
      openPr({
        review: { decision: 'NONE', unresolvedThreads: 5, copilotUnresolved: 2 },
      }),
    );
    expect(d.badges).toContainEqual(
      expect.objectContaining({ kind: 'copilot', label: '2 Copilot' }),
    );
    expect(d.badges).toContainEqual(
      expect.objectContaining({ kind: 'review', label: '3 review' }),
    );
  });
});

describe('needsYou', () => {
  test('a live spawn means the agent is working, not you', () => {
    const d = reconcile(
      openPr({
        checks: 'failure',
        liveSpawn: { phase: 'ci', pid: 42, startedAt: '2026-07-21T10:00:00Z' },
      }),
    );
    expect(d.needsYou).toBe(false);
  });

  test('red CI needs you', () => {
    const d = reconcile(openPr({ checks: 'failure' }));
    expect(d.needsYou).toBe(true);
    expect(d.needsYouReason).toMatch(/CI/i);
  });

  test('pending CI does not need you', () => {
    expect(reconcile(openPr({ checks: 'pending' })).needsYou).toBe(false);
  });

  test('the reason describes the lane the card is in, not a lower gate', () => {
    // Failing CI plus an unresolved Copilot thread: derivePhase rests the card
    // in copilot_review, so the reason must name the review — otherwise the card
    // sits in one lane while explaining a different one.
    const d = reconcile(
      openPr({
        checks: 'failure',
        review: { decision: 'REVIEW_REQUIRED', unresolvedThreads: 1, copilotUnresolved: 1 },
      }),
    );
    expect(d.derivedPhase).toBe('copilot_review');
    expect(d.needsYouReason).toMatch(/copilot/i);
  });

  test('an attached plan awaiting your review needs you', () => {
    const d = reconcile(
      facts({ worktreeExists: true, branchExists: true, planMdExists: true }),
    );
    expect(d.needsYou).toBe(true);
    expect(d.needsYouReason).toMatch(/plan/i);
  });

  test('unresolved Copilot comments need you', () => {
    const d = reconcile(
      openPr({
        review: { decision: 'NONE', unresolvedThreads: 2, copilotUnresolved: 2 },
      }),
    );
    expect(d.needsYou).toBe(true);
    expect(d.needsYouReason).toMatch(/copilot/i);
  });

  test('an approved PR needs you, because only you merge', () => {
    const d = reconcile(
      openPr({
        review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 },
      }),
    );
    expect(d.needsYou).toBe(true);
    expect(d.needsYouReason).toMatch(/merge/i);
  });

  test('a merged task never needs you', () => {
    const d = reconcile(
      openPr({ pr: { exists: true, number: 3119, url: 'u', state: 'MERGED' } }),
    );
    expect(d.needsYou).toBe(false);
    expect(d.needsYouReason).toBeNull();
  });

  test('an untouched inbox issue does not need you', () => {
    expect(reconcile(facts()).needsYou).toBe(false);
  });

  test('implementation marked done and ready to publish needs you', () => {
    const d = reconcile(
      facts({
        worktreeExists: true,
        branchExists: true,
        planMdExists: true,
        hasPushedCommits: true,
        markers: ['plan.done', 'implement.done'],
      }),
    );
    expect(d.needsYou).toBe(true);
    expect(d.needsYouReason).toMatch(/publish/i);
  });
});

describe('purity', () => {
  test('reconcile does not mutate the facts it is given', () => {
    const input = openPr({ checks: 'failure' });
    const snapshot = structuredClone(input);
    reconcile(input, 'merge');
    expect(input).toEqual(snapshot);
  });

  test('the same facts always produce the same result', () => {
    const input = openPr({
      review: { decision: 'NONE', unresolvedThreads: 2, copilotUnresolved: 2 },
    });
    expect(reconcile(input)).toEqual(reconcile(input));
  });
});
