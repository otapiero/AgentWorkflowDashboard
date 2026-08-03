import { describe, expect, test } from 'vitest';

import { buildChildren, buildRootNodes, severityFor } from '../../src/tree-model.ts';
import { config, task, taskWithPath } from './fixtures.ts';
import type { TaskStoreSnapshot } from '../../src/task-store.ts';

function snapshot(tasks = [task()]): TaskStoreSnapshot {
  return { config, tasks, poll: null, connection: 'connected', isBaselineReady: true };
}

describe('tree model', () => {
  test('keeps the root sections in worktree-first order', () => {
    expect(buildRootNodes(snapshot(), { scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }).map((node) => node.id)).toEqual([
      'section:current', 'section:attention', 'section:all',
    ]);
  });

  test('shows the exact current worktree task, resolved agent, and permitted native actions', () => {
    const live = taskWithPath('C:\\mc\\worktrees\\issue-3060');
    live.integration.liveSpawn = { phase: 'implement', pid: 42, startedAt: '2026-08-03T10:00:00.000Z' };
    const current = buildChildren(snapshot([live]), { scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }, 'section:current');
    expect(current).toEqual([
      { kind: 'task', id: 'task:3060', issue: 3060, label: '#3060 Task 3060', description: 'Implement', severity: 'normal' },
      { kind: 'message', id: 'message:agent:3060', label: 'Agent: codex · gpt-5.6-sol · medium' },
      { kind: 'message', id: 'message:session:3060', label: 'Session: Implement running' },
      { kind: 'action', id: 'action:view-session:3060', label: 'View Session', command: 'missionControl.viewSession', args: [3060] },
      { kind: 'action', id: 'action:open:3060', label: 'Open Worktree', command: 'missionControl.openTask', args: [3060] },
      { kind: 'action', id: 'action:dashboard:3060', label: 'Open Dashboard', command: 'missionControl.openDashboard', args: [] },
    ]);
  });

  test('shows Run Current Phase only for a connected spawnable phase without a live session', () => {
    const current = buildChildren(snapshot([taskWithPath('C:\\mc\\worktrees\\issue-3060')]), { scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }, 'section:current');
    expect(current.map((node) => node.id)).toEqual(['task:3060', 'message:agent:3060', 'action:run:3060', 'action:open:3060', 'action:dashboard:3060']);
    const disconnected = { ...snapshot(), connection: 'disconnected' as const };
    expect(buildChildren(disconnected, { scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }, 'section:current').map((node) => node.id)).toEqual(['task:3060', 'message:agent:3060', 'action:open:3060', 'action:dashboard:3060']);
  });

  test('shows a clear unrelated-workspace message', () => {
    const unrelated = buildChildren(snapshot(), { scheme: 'file', fsPath: 'C:\\elsewhere' }, 'section:current');
    expect(unrelated).toEqual([{ kind: 'message', id: 'message:current:unrelated', label: 'This workspace is not a Mission Control worktree.' }]);
  });

  test('sorts attention by structured severity, transition time, then issue', () => {
    const bad = task({ issue: 7, needsYou: true, checks: 'failure', lastReconciledAt: '2026-08-03T12:00:00.000Z' });
    const warnLater = task({ issue: 9, needsYou: true, lastReconciledAt: '2026-08-03T12:00:00.000Z' });
    const warnEarlier = task({ issue: 8, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' });
    expect(buildChildren(snapshot([warnLater, bad, warnEarlier]), undefined, 'section:attention').map((node) => node.id)).toEqual(['task:7', 'task:9', 'task:8']);
  });

  test('uses structured attention signals for severity', () => {
    expect(severityFor(task({ checks: 'failure' }))).toBe('bad');
    const requested = task(); requested.integration.review.decision = 'CHANGES_REQUESTED';
    expect(severityFor(requested)).toBe('bad');
    const unresolved = task(); unresolved.integration.review.unresolvedThreads = 1;
    expect(severityFor(unresolved)).toBe('warn');
  });

  test('groups all tasks by configured pipeline order and filters issue title and phase', () => {
    const tasks = [task({ issue: 2, phase: 'ci' }), task({ issue: 1, phase: 'plan' })];
    expect(buildChildren(snapshot(tasks), undefined, 'section:all').map((node) => node.id)).toEqual(['phase:plan', 'phase:ci']);
    expect(buildChildren(snapshot(tasks), undefined, 'phase:plan', 'task 1').map((node) => node.id)).toEqual(['task:1']);
    expect(buildChildren(snapshot(tasks), undefined, 'phase:ci', 'ci').map((node) => node.id)).toEqual(['task:2']);
  });
});
