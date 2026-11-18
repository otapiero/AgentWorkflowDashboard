import { describe, expect, test } from 'vitest';

import { buildChildren } from '../../src/tree-model.ts';
import { config, task, taskWithPath } from './fixtures.ts';
import type { TaskStoreSnapshot } from '../../src/task-store.ts';

function snapshot(tasks = [task()]): TaskStoreSnapshot {
  return { config, tasks, attentionTransitions: new Map(tasks.filter((item) => item.derived.needsYou).map((item) => [item.issue, item.lastReconciledAt ?? ''])), poll: null, connection: 'connected' };
}

describe('tree model', () => {
  test('shows the exact current worktree task, resolved agent, and permitted native actions', () => {
    const live = taskWithPath('C:\\mc\\worktrees\\issue-3060');
    live.integration.liveSpawn = { phase: 'implement', pid: 42, startedAt: '2026-08-03T10:00:00.000Z', source: 'marker' };
    const current = buildChildren(snapshot([live]), { scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }, 'section:current');
    expect(current).toEqual([
      { kind: 'task', id: 'task:current:3060', scope: 'current', issue: 3060, label: '#3060 Task 3060', description: 'Implement', severity: 'normal' },
      { kind: 'message', id: 'message:agent:3060', label: 'Agent: codex · gpt-5.6-sol · medium' },
      { kind: 'message', id: 'message:session:3060', label: 'Session: Implement running' },
      { kind: 'action', id: 'action:view-session:3060', label: 'View Session', command: 'missionControl.viewSession', args: [3060] },
      { kind: 'action', id: 'action:open:3060', label: 'Open Worktree', command: 'missionControl.openTask', args: [3060] },
      { kind: 'action', id: 'action:dashboard:3060', label: 'Open Dashboard', command: 'missionControl.openDashboard', args: [] },
    ]);
  });

  test('shows Run Current Phase only for a connected spawnable phase without a live session', () => {
    const current = buildChildren(snapshot([taskWithPath('C:\\mc\\worktrees\\issue-3060')]), { scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }, 'section:current');
    expect(current.map((node) => node.id)).toEqual(['task:current:3060', 'message:agent:3060', 'action:run:3060', 'action:open:3060', 'action:dashboard:3060']);
    const disconnected = { ...snapshot(), connection: 'disconnected' as const };
    expect(buildChildren(disconnected, { scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }, 'section:current').map((node) => node.id)).toEqual(['task:current:3060', 'message:agent:3060', 'action:open:3060', 'action:dashboard:3060']);
  });

  test('shows a clear unrelated-workspace message', () => {
    const unrelated = buildChildren(snapshot(), { scheme: 'file', fsPath: 'C:\\elsewhere' }, 'section:current');
    expect(unrelated).toEqual([{ kind: 'message', id: 'message:current:unrelated', label: 'This workspace is not a Mission Control worktree.' }]);
  });

  test('sorts attention by structured severity, transition time, then issue', () => {
    const bad = task({ issue: 10, needsYou: true, lastReconciledAt: '2026-08-03T10:00:00.000Z' });
    bad.integration.review.decision = 'CHANGES_REQUESTED';
    const warnLater = task({ issue: 9, needsYou: true, lastReconciledAt: '2026-08-03T12:00:00.000Z' });
    const warnEarlier = task({ issue: 8, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' });
    const tied = task({ issue: 7, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' });
    expect(buildChildren(snapshot([warnLater, bad, warnEarlier, tied]), undefined, 'section:attention').map((node) => node.id)).toEqual(['task:attention:10', 'task:attention:9', 'task:attention:7', 'task:attention:8']);
  });

  test('uses structured attention signals for severity', () => {
    const unresolved = task();
    unresolved.integration.review.unresolvedThreads = 1;
    expect(buildChildren(snapshot([unresolved]), undefined, 'phase:implement')).toMatchObject([{ severity: 'warn' }]);
  });

  test('groups tasks by configured pipeline order and filters by issue or phase', () => {
    const tasks = [task({ issue: 2, phase: 'ci' }), task({ issue: 1, phase: 'plan' })];
    const board = { ...snapshot(tasks), config: { ...config, pipeline: [...config.pipeline].reverse() } };
    expect(buildChildren(board, undefined, 'section:all').map((node) => node.id)).toEqual(['phase:ci', 'phase:plan']);
    expect(buildChildren(board, undefined, 'section:all', '1').map((node) => node.id)).toEqual(['phase:plan']);
    expect(buildChildren(board, undefined, 'section:all', 'ci').map((node) => node.id)).toEqual(['phase:ci']);
  });

  test('rests tasks in inbox, merged and done even when the pipeline does not configure them', () => {
    // config.yaml holds only the pipeline; the board brackets it with inbox and done,
    // and a task must be reachable while resting in either.
    const tasks = [task({ issue: 1, phase: 'inbox' }), task({ issue: 2, phase: 'implement' }), task({ issue: 3, phase: 'done' }), task({ issue: 4, phase: 'merged' })];
    expect(buildChildren(snapshot(tasks), undefined, 'section:all').map((node) => node.id)).toEqual(['phase:inbox', 'phase:implement', 'phase:merged', 'phase:done']);
    expect(buildChildren(snapshot(tasks), undefined, 'phase:inbox').map((node) => node.id)).toEqual(['task:all:inbox:1']);
    expect(buildChildren(snapshot(tasks), undefined, 'phase:done').map((node) => node.id)).toEqual(['task:all:done:3']);
    expect(buildChildren(snapshot(tasks), undefined, 'phase:merged').map((node) => node.id)).toEqual(['task:all:merged:4']);
  });
});
