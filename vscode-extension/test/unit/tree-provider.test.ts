import { describe, expect, test } from 'vitest';

import { MissionControlTreeProvider } from '../../src/tree-provider.ts';
import { TaskStore } from '../../src/task-store.ts';
import type { TreeNode } from '../../src/tree-model.ts';
import { config, task } from './fixtures.ts';

function fakeVscode() {
  const fires: Array<TreeNode | undefined> = [];
  return {
    fires,
    TreeItem: class { id?: string; contextValue?: string; description?: string; iconPath?: unknown; command?: unknown; constructor(readonly label: string, readonly collapsibleState: number) {} },
    ThemeIcon: class { constructor(readonly id: string) {} },
    EventEmitter: class<T> { event = () => ({ dispose() {} }); fire(value: T) { fires.push(value as TreeNode | undefined); } dispose() {} },
    Uri: { file: (path: string) => ({ scheme: 'file', fsPath: path }) },
    CollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
}

describe('MissionControlTreeProvider', () => {
  test('refreshes the tree and hides nonmatching tasks when the filter changes', () => {
    const store = new TaskStore();
    store.applyBaseline(config, [task({ issue: 1 }), task({ issue: 2 })]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    const all = provider.getChildren().find((node) => node.id === 'section:all');
    const [phase] = provider.getChildren(all);
    expect(provider.getChildren(phase).map((node) => node.label)).toEqual(['#1 Task 1', '#2 Task 2']);

    provider.setFilter(' TASK 2 ');
    provider.setFilter('TASK 2');

    expect(vscode.fires).toEqual([undefined]);
    expect(provider.getChildren(phase).map((node) => node.label)).toEqual(['#2 Task 2']);
  });

  test('refreshes the tree when an empty baseline first loads or pipeline labels change', () => {
    const store = new TaskStore();
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    const all = provider.getChildren().find((node) => node.id === 'section:all');
    expect(provider.getChildren(all).map((node) => node.label)).toEqual(['Waiting for Mission Control data…']);

    store.applyBaseline(config, []);

    expect(vscode.fires).toEqual([undefined]);
    expect(provider.getChildren(all)).toEqual([]);

    const tasks = [task()];
    store.applyTasks(tasks);
    vscode.fires.length = 0;
    const changed = { ...config, pipeline: config.pipeline.map((phase) => phase.id === 'implement' ? { ...phase, label: 'Build' } : phase) };
    store.applyBaseline(changed, tasks);
    store.applyBaseline(changed, tasks);

    expect(vscode.fires).toEqual([undefined]);
    expect(provider.getChildren(all).map((node) => node.label)).toEqual(['Build']);
  });

  test('marks task items with their server-provided worktree availability', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task({ worktreeExists: true }), task({ issue: 2, worktreeExists: false })]);
    const provider = new MissionControlTreeProvider(store, () => undefined, fakeVscode());
    expect(provider.getTreeItem({ kind: 'task', id: 'task:all:implement:3060', scope: 'all:implement', issue: 3060, label: 'one', description: '', severity: 'normal' })).toMatchObject({ contextValue: 'task:normal:other:worktree', command: { command: 'missionControl.openTask', arguments: [3060] } });
    expect(provider.getTreeItem({ kind: 'task', id: 'task:all:implement:2', scope: 'all:implement', issue: 2, label: 'two', description: '', severity: 'normal' })).toMatchObject({ contextValue: 'task:normal:other:missing-worktree', command: undefined });
  });

  test('marks only the exact current live task as session eligible', () => {
    const current = task(); current.integration.liveSpawn = { phase: 'implement', pid: 42, startedAt: '2026-08-03T10:00:00.000Z', source: 'marker' };
    const other = task({ issue: 2 }); other.integration.liveSpawn = { phase: 'implement', pid: 43, startedAt: '2026-08-03T10:00:00.000Z', source: 'marker' };
    const store = new TaskStore(); store.applyBaseline(config, [current, other]);
    const provider = new MissionControlTreeProvider(store, () => ({ scheme: 'file', fsPath: current.integration.workspacePath }), fakeVscode());
    expect(provider.getTreeItem({ kind: 'task', id: 'task:current:3060', scope: 'current', issue: 3060, label: 'current', description: '', severity: 'normal' }).contextValue).toContain(':current-live:');
    expect(provider.getTreeItem({ kind: 'task', id: 'task:all:implement:2', scope: 'all:implement', issue: 2, label: 'other', description: '', severity: 'normal' }).contextValue).not.toContain(':current-live:');
  });

  test('does not fire a removed cached task object', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.getChildren();
    const phases = provider.getChildren({ kind: 'section', id: 'section:all', label: 'All Tasks', expanded: false });
    provider.getChildren(phases[0]);

    store.applyTasks([]);

    expect(vscode.fires.map((node) => node?.id).sort()).toEqual(['section:all', 'section:current']);
  });

  test('does not refresh Current Worktree before that section is cached', () => {
    const initial = task();
    const store = new TaskStore(); store.applyBaseline(config, [initial]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    store.applyTasks([{ ...initial, title: 'Updated' }]);
    expect(vscode.fires).toEqual([]);
    provider.dispose();
  });

  test('refreshes every displayed placement and affected section for a changed task', () => {
    const initial = task({ needsYou: true });
    const sibling = task({ issue: 2 });
    const store = new TaskStore(); store.applyBaseline(config, [initial, sibling]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => ({ scheme: 'file', fsPath: initial.integration.workspacePath }), vscode);
    const roots = provider.getChildren();
    provider.getChildren(roots[0]);
    provider.getChildren(roots[1]);
    const phases = provider.getChildren(roots[2]);
    provider.getChildren(phases[0]);
    const changed = { ...task({ needsYou: true, checks: 'failure', worktreeExists: false }), title: 'Updated' };

    store.applyTasks([changed, sibling]);

    expect(vscode.fires.map((node) => node?.id).sort()).toEqual([
      'section:attention', 'section:current', 'task:all:implement:3060', 'task:attention:3060', 'task:current:3060',
    ]);
    for (const node of vscode.fires) {
      if (node?.kind === 'task') {
        expect(provider.getTreeItem(node)).toMatchObject({ label: '#3060 Updated', iconPath: { id: 'error' }, command: undefined });
      }
    }
  });

  test('does not fire an old placement after a task changes phase', () => {
    const build = task({ issue: 1 });
    const checks = task({ issue: 2, phase: 'ci' });
    const store = new TaskStore(); store.applyBaseline(config, [task(), build, checks]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    const all = provider.getChildren({ kind: 'section', id: 'section:all', label: 'All Tasks', expanded: false });
    for (const phase of all) provider.getChildren(phase);

    store.applyTasks([task({ phase: 'ci' }), build, checks]);

    expect(vscode.fires.map((node) => node?.id).sort()).toEqual(['phase:ci', 'phase:implement']);
    expect(provider.getChildren(all[0]).map((node) => node.label)).toEqual(['#1 Task 1']);
    expect(provider.getChildren(all[1]).map((node) => node.label)).toEqual(['#2 Task 2', '#3060 Task 3060']);
  });
});
