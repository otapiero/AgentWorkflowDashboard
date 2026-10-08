import { describe, expect, test } from 'vitest';
import { parseRefs, pickBranchForIssue } from '../src/orchestrator/worktree.ts';

const GENERATED = 'alice/3060-add-audio-playback-mode';

describe('parseRefs', () => {
  test('strips the origin/ prefix so local and remote refs compare equal', () => {
    expect(parseRefs('origin/dev\ndev')).toEqual(['dev', 'dev']);
  });

  test('drops the origin/HEAD pointer, which is not a branch', () => {
    expect(parseRefs('origin/HEAD -> origin/dev\ndev')).toEqual(['dev']);
  });

  test('ignores blank lines and whitespace', () => {
    expect(parseRefs('  dev  \n\n')).toEqual(['dev']);
  });
});

describe('pickBranchForIssue', () => {
  test('prefers a real branch whose casing differs from the generated slug', () => {
    // The actual branch on this machine is "3060-Add..."; the slug
    // produces "3060-learning...". Windows git refs are case-insensitive so
    // the mismatch is invisible locally, but GitHub's --head lookup is
    // case-sensitive and silently finds no PR.
    const real = 'alice/3060-Add-audio-playback-mode';
    expect(pickBranchForIssue([real, 'dev'], 'alice', 3060, GENERATED)).toBe(real);
  });

  test('matches a branch that uses the slash form instead of a dash', () => {
    const real = 'alice/3060/audio-mode';
    expect(pickBranchForIssue([real], 'alice', 3060, GENERATED)).toBe(real);
  });

  test('ignores another author branch for the same issue', () => {
    // Someone else's branch must never become this task's branch.
    expect(
      pickBranchForIssue(['bob/3060-audio-mode'], 'alice', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('does not match an issue number that merely starts with the same digits', () => {
    // 30601 must not be mistaken for 3060.
    expect(
      pickBranchForIssue(['alice/30601-something'], 'alice', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('does not match when the issue number is a suffix of another', () => {
    expect(
      pickBranchForIssue(['alice/13060-something'], 'alice', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('returns the generated name when only unrelated branches exist', () => {
    expect(
      pickBranchForIssue(['dev', 'alice/1145-other'], 'alice', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('is deterministic when several branches match the same issue', () => {
    const refs = ['alice/3060-b-variant', 'alice/3060-a-variant'];
    const first = pickBranchForIssue(refs, 'alice', 3060, GENERATED);
    const second = pickBranchForIssue([...refs].reverse(), 'alice', 3060, GENERATED);
    expect(first).toBe(second);
  });

});
