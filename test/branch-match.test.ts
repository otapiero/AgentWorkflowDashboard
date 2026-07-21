import { describe, expect, test } from 'vitest';
import { parseRefs, pickBranchForIssue } from '../src/orchestrator/worktree.ts';

const GENERATED = 'ouriel/3060-add-audio-playback-mode';

describe('parseRefs', () => {
  test('reads one ref per line', () => {
    expect(parseRefs('dev\nouriel/3060-x\n')).toEqual(['dev', 'ouriel/3060-x']);
  });

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
  test('uses the generated name when no branch exists yet', () => {
    expect(pickBranchForIssue([], 'ouriel', 3060, GENERATED)).toBe(GENERATED);
  });

  test('prefers a real branch whose casing differs from the generated slug', () => {
    // The actual branch on this machine is "3060-Add..."; the slug
    // produces "3060-learning...". Windows git refs are case-insensitive so
    // the mismatch is invisible locally, but GitHub's --head lookup is
    // case-sensitive and silently finds no PR.
    const real = 'ouriel/3060-Add-audio-playback-mode';
    expect(pickBranchForIssue([real, 'dev'], 'ouriel', 3060, GENERATED)).toBe(real);
  });

  test('matches a branch that uses the slash form instead of a dash', () => {
    const real = 'ouriel/3060/audio-mode';
    expect(pickBranchForIssue([real], 'ouriel', 3060, GENERATED)).toBe(real);
  });

  test('ignores another author branch for the same issue', () => {
    // Someone else's branch must never become this task's branch.
    expect(
      pickBranchForIssue(['otapiero/3060-audio-mode'], 'ouriel', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('does not match an issue number that merely starts with the same digits', () => {
    // 30601 must not be mistaken for 3060.
    expect(
      pickBranchForIssue(['ouriel/30601-something'], 'ouriel', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('does not match when the issue number is a suffix of another', () => {
    expect(
      pickBranchForIssue(['ouriel/13060-something'], 'ouriel', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('returns the generated name when only unrelated branches exist', () => {
    expect(
      pickBranchForIssue(['dev', 'ouriel/1145-other'], 'ouriel', 3060, GENERATED),
    ).toBe(GENERATED);
  });

  test('is deterministic when several branches match the same issue', () => {
    const refs = ['ouriel/3060-b-variant', 'ouriel/3060-a-variant'];
    const first = pickBranchForIssue(refs, 'ouriel', 3060, GENERATED);
    const second = pickBranchForIssue([...refs].reverse(), 'ouriel', 3060, GENERATED);
    expect(first).toBe(second);
  });

  test('deduplicates a branch that exists both locally and on origin', () => {
    const real = 'ouriel/3060-Add-audio-playback-mode';
    expect(pickBranchForIssue([real, real], 'ouriel', 3060, GENERATED)).toBe(real);
  });
});
