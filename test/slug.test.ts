import { describe, expect, test } from 'vitest';
import { slugify, branchName } from '../src/orchestrator/slug.ts';

describe('slugify', () => {
  test('lowercases and joins words with single dashes', () => {
    expect(slugify('Add audio playback mode')).toBe(
      'add-audio-playback-mode',
    );
  });

  test('drops apostrophes rather than turning them into separators', () => {
    // "doesn't" must become "doesnt", not "doesn-t".
    expect(slugify("Refresh token doesn't work in background")).toBe(
      'refresh-token-doesnt-work-in-background',
    );
  });

  test('collapses runs of punctuation and whitespace into one dash', () => {
    expect(slugify('Error handeling in AiEngine  -  Draft')).toBe(
      'error-handeling-in-aiengine-draft',
    );
  });

  test('trims leading and trailing separators', () => {
    expect(slugify('  --Fix first admin user--  ')).toBe('fix-first-admin-user');
  });

  test('truncates long titles at a word boundary, not mid-word', () => {
    const slug = slugify(
      'Add AI assisted questions at the beginning and end of the lesson to assess emotional state',
    );
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith('-')).toBe(false);
    // "-end" ends exactly at the 50-char cap, so it is a whole word and is kept.
    expect(slug).toBe('add-ai-assisted-questions-at-the-beginning-and-end');
  });

  test('drops the trailing partial word when the cap lands mid-word', () => {
    // "...emotional" would be cut mid-word at the cap, so it must be dropped.
    const slug = slugify('Persist intervention messages inside chat historical record');
    expect(slug).toBe('persist-intervention-messages-inside-chat');
  });

  test('strips non-ascii characters', () => {
    expect(slugify('Add KT for עברית support')).toBe('add-kt-for-support');
  });

  test('falls back to "task" when a title has no usable characters', () => {
    expect(slugify('***')).toBe('task');
  });
});

describe('branchName', () => {
  test('composes prefix, issue number and slug', () => {
    expect(
      branchName('alice', 3060, 'Add audio playback mode'),
    ).toBe('alice/3060-add-audio-playback-mode');
  });

  test('produces a branch that publish-pr can parse the issue number from', () => {
    // /publish-pr takes the numeric portion after the first "/".
    const branch = branchName('alice', 3120, 'change audio mode prompt');
    const parsed = Number(branch.split('/')[1]?.split('-')[0]);
    expect(parsed).toBe(3120);
  });
});
