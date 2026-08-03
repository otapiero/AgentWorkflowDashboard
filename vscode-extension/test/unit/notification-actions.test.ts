import { expect, test } from 'vitest';
import { notificationActions } from '../../src/notifications/notification-actions.ts';
import { task } from './fixtures.ts';

test('offers PR and worktree actions independently with dashboard fallback', () => {
  const value = task();
  expect(notificationActions({ kind: 'reviewComments', issue: value.issue, title: '', message: '', fingerprint: '', prUrl: 'https://example.test/pr/1' }, value, undefined)).toEqual(['View PR', 'Open Worktree', 'Open Dashboard']);
});

test('filters actions that cannot succeed', () => {
  const value = task({ worktreeExists: false });
  expect(notificationActions({ kind: 'approvalRequired', issue: value.issue, title: '', message: '', fingerprint: '', prUrl: null }, value, undefined)).toEqual(['Open Dashboard']);
});
