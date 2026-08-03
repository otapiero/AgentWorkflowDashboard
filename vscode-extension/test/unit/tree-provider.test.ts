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
  test('refreshes only cached changed task and named sections', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.getChildren();
    provider.getChildren({ kind: 'section', id: 'section:attention', label: 'Needs Attention', expanded: true });
    provider.getTreeItem({ kind: 'task', id: 'task:3060', issue: 3060, label: '#3060 Task', description: 'Implement', severity: 'normal' });
    provider.applyStoreChange({ issues: new Set([3060]), sections: new Set(['attention']) });
    expect(vscode.fires.map((node: any) => node?.id)).toEqual(['task:3060', 'section:attention']);
  });

  test('uses a full refresh only when the filter is replaced', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]);
    const vscode = fakeVscode();
    const provider = new MissionControlTreeProvider(store, () => undefined, vscode);
    provider.setFilter('3060');
    expect(vscode.fires).toEqual([undefined]);
  });
});
