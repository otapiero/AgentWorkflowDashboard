import { describe, expect, test } from 'vitest';
import { parseRefs, pickBranchForIssue } from '../src/orchestrator/worktree.ts';

const GENERATED = 'alice/42-update-widgets';

describe('parseRefs', () => {
  test('normalizes remote names and ignores symbolic refs and blank lines', () => {
    expect(parseRefs('origin/HEAD -> origin/main\n  origin/Alice/42-Widgets\n\nmain\n'))
      .toEqual(['Alice/42-Widgets', 'main']);
  });
});

describe('pickBranchForIssue', () => {
  test('prefers a real branch whose casing differs from the generated slug', () => {
    const real = 'alice/42-Update-widgets';
    expect(pickBranchForIssue([real, 'dev'], 'alice', 42, GENERATED)).toBe(real);
  });

  test('matches a branch that uses the slash form instead of a dash', () => {
    const real = 'alice/42/widget-settings';
    expect(pickBranchForIssue([real], 'alice', 42, GENERATED)).toBe(real);
  });

  test('ignores another author branch for the same issue', () => {
    // Someone else's branch must never become this task's branch.
    expect(
      pickBranchForIssue(['bob/42-widget-settings'], 'alice', 42, GENERATED),
    ).toBe(GENERATED);
  });

  test('does not match an issue number that merely starts with the same digits', () => {
    // 421 must not be mistaken for 42.
    expect(
      pickBranchForIssue(['alice/421-widget-settings'], 'alice', 42, GENERATED),
    ).toBe(GENERATED);
  });

  test('is deterministic when several branches match the same issue', () => {
    const refs = ['alice/42-b-variant', 'alice/42-a-variant'];
    const first = pickBranchForIssue(refs, 'alice', 42, GENERATED);
    const second = pickBranchForIssue([...refs].reverse(), 'alice', 42, GENERATED);
    expect(refs).toContain(first);
    expect(first).toBe(second);
  });
});
