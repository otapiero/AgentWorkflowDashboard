import type * as vscode from 'vscode';

import type { TaskWithDerived } from '../../src/shared/types.ts';
import { TaskStore } from './task-store.ts';
import { phaseLabel } from './tree-model.ts';
import { matchWorkspace } from './workspace-matcher.ts';

type StatusApi = {
  StatusBarAlignment: typeof vscode.StatusBarAlignment;
  createStatusBarItem(alignment: vscode.StatusBarAlignment): { text: string; command?: string; show(): void; dispose(): void };
};

export function taskStatus(task: TaskWithDerived): string {
  const agent = [task.pinned.agent, task.pinned.model, task.pinned.effort].filter(Boolean).join(' · ');
  return `#${task.issue} · ${phaseLabel(task.derived.displayPhase)}${agent ? ` | ${agent}` : ''}`;
}

export class MissionControlStatusBar implements vscode.Disposable {
  private readonly taskItem: { text: string; command?: string; show(): void; dispose(): void };
  private readonly connectionItem: { text: string; command?: string; show(): void; dispose(): void };
  private readonly unsubscribe: () => void;
  private lastTaskText: string | undefined;
  private lastConnectionText: string | undefined;

  constructor(
    private readonly store: TaskStore,
    private readonly currentWorkspaceUri: () => { scheme: string; fsPath: string } | undefined,
    api: StatusApi,
    private readonly onDispatchForTests?: () => void,
  ) {
    this.taskItem = api.createStatusBarItem(api.StatusBarAlignment.Left);
    this.connectionItem = api.createStatusBarItem(api.StatusBarAlignment.Right);
    this.taskItem.command = 'missionControl.runCurrentPhase';
    this.connectionItem.command = 'missionControl.openDashboard';
    this.unsubscribe = store.onDidChange(() => this.refresh());
    this.refresh();
    this.taskItem.show();
    this.connectionItem.show();
  }

  refresh(): void {
    const snapshot = this.store.snapshot();
    const current = matchWorkspace(this.currentWorkspaceUri(), snapshot.tasks);
    this.updateTask(current ? taskStatus(current) : '');
    this.updateConnection(snapshot.connection === 'connected' ? '$(check) Mission Control' : '$(warning) Mission Control disconnected');
    this.onDispatchForTests?.();
  }

  dispose(): void {
    this.unsubscribe();
    this.taskItem.dispose();
    this.connectionItem.dispose();
  }

  private updateTask(text: string): void {
    if (text === this.lastTaskText) return;
    this.lastTaskText = text;
    this.taskItem.text = text;
  }

  private updateConnection(text: string): void {
    if (text === this.lastConnectionText) return;
    this.lastConnectionText = text;
    this.connectionItem.text = text;
  }
}
