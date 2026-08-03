import { expect, test } from 'vitest';

import { matchWorkspace, normalizeWorkspacePath } from '../../src/workspace-matcher.ts';
import { taskWithPath } from './fixtures.ts';

test('matches Windows paths case-insensitively and trims trailing separators', () => {
  const current = { scheme: 'file', fsPath: 'C:\\MC\\worktrees\\issue-3060\\' };

  expect(matchWorkspace(current, [taskWithPath('c:\\mc\\worktrees\\issue-3060')], 'win32')?.issue).toBe(3060);
});

test('normalizes relative paths while preserving the platform root', () => {
  expect(normalizeWorkspacePath('C:\\MC\\worktrees\\..\\issue-3060\\', 'win32')).toBe('c:\\mc\\issue-3060');
  expect(normalizeWorkspacePath('/', 'linux')).toBe('/');
});

test('does not fuzzy-match a parent, issue number, or non-file URI', () => {
  expect(matchWorkspace({ scheme: 'file', fsPath: 'C:\\repo\\3060' }, [taskWithPath('C:\\mc\\issue-3060')], 'win32')).toBeNull();
  expect(matchWorkspace({ scheme: 'vscode-remote', fsPath: '/mc/issue-3060' }, [taskWithPath('/mc/issue-3060')], 'linux')).toBeNull();
});
