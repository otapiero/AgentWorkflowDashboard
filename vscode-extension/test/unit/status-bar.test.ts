import { describe, expect, test } from 'vitest';

import { MissionControlStatusBar } from '../../src/status-bar.ts';
import { TaskStore } from '../../src/task-store.ts';
import { config, task } from './fixtures.ts';

function fakeVscode() {
  const items: any[] = [];
  return { items, StatusBarAlignment: { Left: 1, Right: 2 }, createStatusBarItem: (alignment: number) => { const item = { alignment, text: '', command: undefined, show() {}, hide() {}, dispose() {} }; items.push(item); return item; } };
}

describe('status bar', () => {
  test('shows connected current task context and binds its command', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]); store.setConnection('connected');
    const vscode = fakeVscode();
    new MissionControlStatusBar(store, () => ({ scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-3060' }), vscode);
    expect(vscode.items[0]).toMatchObject({ text: '#3060 · Implement | codex · gpt-5.6-sol · medium', command: 'missionControl.runCurrentPhase' });
    expect(vscode.items[1]).toMatchObject({ text: '$(check) Mission Control', command: 'missionControl.openDashboard' });
  });

  test('removes the model and effort from the status bar when the task clears them', () => {
    const current = task();
    const store = new TaskStore(); store.applyBaseline(config, [current]); store.setConnection('connected');
    const vscode = fakeVscode();
    new MissionControlStatusBar(store, () => ({ scheme: 'file', fsPath: current.integration.workspacePath }), vscode);

    store.applyTasks([{ ...current, pinned: { agent: 'codex', model: null, effort: null } }]);

    expect(vscode.items[0].text).toBe('#3060 · Implement | codex');
  });

  test('shows disconnected warning and hides unrelated workspace context', () => {
    const store = new TaskStore(); store.applyBaseline(config, [task()]); store.setConnection('disconnected');
    const vscode = fakeVscode();
    new MissionControlStatusBar(store, () => ({ scheme: 'file', fsPath: 'C:\\elsewhere' }), vscode);
    expect(vscode.items[0].text).toBe('');
    expect(vscode.items[1]).toMatchObject({ text: '$(warning) Mission Control disconnected', command: 'missionControl.connectionActions' });
  });
});
