import { describe, expect, test } from 'vitest';

import { MissionControlTreeProvider } from '../../src/tree-provider.ts';
import { TaskStore } from '../../src/task-store.ts';
import { config, task } from './fixtures.ts';

function fakeVscode() {
  const fires: unknown[] = [];
  return {
    fires,
    TreeItem: class { id?: string; contextValue?: string; description?: string; iconPath?: unknown; command?: unknown; constructor(readonly label: string, readonly collapsibleState: number) {} },
    ThemeIcon: class { constructor(readonly id: string) {} },
    EventEmitter: class<T> { event = () => ({ dispose() {} }); fire(value: T) { fires.push(value); } dispose() {} },
    Uri: { file: (path: string) => ({ scheme: 'file', fsPath: path }) },
    CollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  };
}

describe('MissionControlTreeProvider', () => {
  test('refreshes only cached changed task, Current Worktree, and named sections', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.getChildren();
    provider.getChildren({ kind: 'section', id: 'section:attention', label: 'Needs Attention', expanded: true });
    provider.getTreeItem({ kind: 'task', id: 'task:3060', issue: 3060, label: '#3060 Task', description: 'Implement', severity: 'normal' });
    provider.applyStoreChange({ kind: 'targeted', issues: new Set([3060]), sections: new Set(['attention']) });
    expect(vscode.fires.map((node: any) => node?.id)).toEqual(['task:3060', 'section:current', 'section:attention']);
  });

  test('uses a full refresh only when the filter is replaced', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.setFilter('3060');
    expect(vscode.fires).toEqual([undefined]);
  });

  test('uses a full refresh for baseline or pipeline configuration replacement', () => {
    const store = new TaskStore(); store.applyBaseline(config, []);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.applyStoreChange({ kind: 'full', reason: 'config' });
    expect(vscode.fires).toEqual([undefined]);
  });

  test('marks task items with their server-provided worktree availability', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task({ worktreeExists: true }), task({ issue: 2, worktreeExists: false })]);
    const provider = new MissionControlTreeProvider(store, () => undefined, fakeVscode());
    expect(provider.getTreeItem({ kind: 'task', id: 'task:3060', issue: 3060, label: 'one', description: '', severity: 'normal' })).toMatchObject({ contextValue: 'task:normal:worktree', command: { command: 'missionControl.openTask', arguments: [3060] } });
    expect(provider.getTreeItem({ kind: 'task', id: 'task:2', issue: 2, label: 'two', description: '', severity: 'normal' })).toMatchObject({ contextValue: 'task:normal:missing-worktree', command: undefined });
  });

  test('rebuilds a changed cached task from current store state', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    const cached = provider.getChildren({ kind: 'section', id: 'section:attention', label: 'Needs Attention', expanded: true });
    provider.getTreeItem({ kind: 'task', id: 'task:3060', issue: 3060, label: '#3060 Old', description: 'Implement', severity: 'normal' });
    const changed = task({ needsYou: true, checks: 'failure', worktreeExists: false }); changed.title = 'New title';

    store.applyTasks([changed]);

    const fired = vscode.fires.find((node: any) => node?.id === 'task:3060') as any;
    expect(fired).toMatchObject({ label: '#3060 New title', severity: 'bad' });
    expect(fired).not.toBe(cached[0]);
    expect(provider.getTreeItem(fired)).toMatchObject({ contextValue: 'task:bad:missing-worktree', command: undefined });
  });

  test('does not fire a removed cached task object', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.getChildren();
    const phases = provider.getChildren({ kind: 'section', id: 'section:all', label: 'All Tasks', expanded: false });
    provider.getChildren(phases[0]);

    store.applyTasks([]);

    expect(vscode.fires.map((node: any) => node?.id)).not.toContain('task:3060');
    expect(vscode.fires.map((node: any) => node?.id)).toEqual(['section:current', 'section:all']);
  });

  test('refreshes cached Current Worktree when a task is added for this workspace', () => {
    const store = new TaskStore(); store.applyBaseline(config, []);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => ({ scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }), vscode);
    provider.getChildren();
    provider.applyStoreChange({ kind: 'targeted', issues: new Set([3060]), sections: new Set() });
    expect(vscode.fires.map((node: any) => node?.id)).toEqual(['section:current']);
  });

  test('does not refresh Current Worktree before that section is cached', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.applyStoreChange({ kind: 'targeted', issues: new Set([3060]), sections: new Set() });
    expect(vscode.fires).toEqual([]);
  });

  test('refreshes cached Current Worktree when its task is removed', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => ({ scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }), vscode);
    provider.getChildren();
    provider.getChildren({ kind: 'section', id: 'section:current', label: 'Current Worktree', expanded: true });
    provider.applyStoreChange({ kind: 'targeted', issues: new Set([3060]), sections: new Set() });
    expect(vscode.fires.map((node: any) => node?.id)).toEqual(['task:3060', 'section:current']);
  });
});
