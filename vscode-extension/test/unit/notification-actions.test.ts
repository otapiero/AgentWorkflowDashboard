import { expect, test } from 'vitest';
import { notificationActions } from '../../src/notifications/notification-actions.ts';
import { task } from './fixtures.ts';

test('never offers Run Phase for non-approval events, even when connected', () => {
  const value = task();
  expect(notificationActions({ kind: 'reviewComments', issue: value.issue, title: '', message: '', fingerprint: '', prUrl: 'https://example.test/pr/1' }, value, undefined, true)).toEqual(['View PR', 'Open Worktree', 'Open Dashboard']);
});

test('filters actions that cannot succeed', () => {
  const value = task({ worktreeExists: false });
  expect(notificationActions({ kind: 'approvalRequired', issue: value.issue, title: '', message: '', fingerprint: '', prUrl: null }, value, undefined)).toEqual(['Open Dashboard']);
});

test('omits Run Phase while disconnected but preserves safe actions', () => {
  const value = task(); const event = { kind: 'approvalRequired' as const, issue: value.issue, title: '', message: '', fingerprint: '', prUrl: 'https://example.test/pr/1' };
  expect(notificationActions(event, value, undefined, false)).toEqual(['View PR', 'Open Worktree', 'Open Dashboard']);
});

test('offers Run Phase for a connected approval with a canonical worktree', () => {
  const value = task(); const event = { kind: 'approvalRequired' as const, issue: value.issue, title: '', message: '', fingerprint: '', prUrl: 'https://example.test/pr/1' };
  expect(notificationActions(event, value, undefined, true)).toEqual(['View PR', 'Open Worktree', 'Run Phase', 'Open Dashboard']);
});
