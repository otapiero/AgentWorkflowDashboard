import type * as vscode from 'vscode';

import type { StoreChange } from './task-store.ts';
import { TaskStore } from './task-store.ts';
import { buildChildren, buildRootNodes, type TreeNode } from './tree-model.ts';

type VscodeAdapter = {
  TreeItem: new (label: string, state: number) => { id?: string; contextValue?: string; description?: string; iconPath?: unknown; command?: unknown };
  ThemeIcon: new (id: string) => unknown;
  EventEmitter: new <T>() => { event: vscode.Event<T>; fire(value: T): void; dispose(): void };
  Uri: { file(path: string): unknown };
  CollapsibleState: typeof vscode.TreeItemCollapsibleState;
};

export class MissionControlTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter: vscode.EventEmitter<TreeNode | undefined>;
  private readonly cached = new Map<string, TreeNode>();
  private readonly unsubscribe: () => void;
  private filter = '';
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined>;

  constructor(
    private readonly store: TaskStore,
    private readonly currentWorkspaceUri: () => { scheme: string; fsPath: string } | undefined,
    private readonly api: VscodeAdapter,
  ) {
    this.emitter = new this.api.EventEmitter<TreeNode | undefined>();
    this.onDidChangeTreeData = this.emitter.event;
    this.unsubscribe = store.onDidChange((change) => this.applyStoreChange(change));
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    this.cached.set(node.id, node);
    const state = node.kind === 'section'
      ? (node.expanded ? this.api.CollapsibleState.Expanded : this.api.CollapsibleState.Collapsed)
      : node.kind === 'phase' || node.kind === 'task' ? this.api.CollapsibleState.Collapsed : this.api.CollapsibleState.None;
    const item = new this.api.TreeItem(node.label, state);
    item.id = node.id;
    item.contextValue = node.kind;
    if (node.kind === 'task') {
      item.description = node.description;
      item.iconPath = new this.api.ThemeIcon(node.severity === 'bad' ? 'error' : node.severity === 'warn' ? 'warning' : 'circle-outline');
      item.contextValue = `task:${node.severity}`;
    }
    if (node.kind === 'action') item.command = { command: node.command, title: node.label, arguments: [...node.args] };
    return item as vscode.TreeItem;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    const snapshot = this.store.snapshot();
    const children = node
      ? buildChildren(snapshot, this.currentWorkspaceUri(), node.id, this.filter)
      : buildRootNodes(snapshot, this.currentWorkspaceUri());
    for (const child of children) this.cached.set(child.id, child);
    return [...children];
  }

  applyStoreChange(change: StoreChange): void {
    const toRefresh = new Map<string, TreeNode>();
    for (const issue of change.issues) {
      const id = `task:${issue}`;
      const node = this.cached.get(id);
      if (node) toRefresh.set(id, node);
    }
    if (change.issues.size > 0) {
      const current = this.cached.get('section:current');
      if (current) toRefresh.set(current.id, current);
    }
    for (const section of change.sections) {
      const id = section === 'current' || section === 'attention' || section === 'all' ? `section:${section}` : `phase:${section}`;
      const node = this.cached.get(id);
      if (node) toRefresh.set(id, node);
    }
    for (const node of toRefresh.values()) this.emitter.fire(node);
  }

  setFilter(value: string): void {
    const next = value.trim();
    if (this.filter === next) return;
    this.filter = next;
    this.cached.clear();
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.unsubscribe();
    this.cached.clear();
    this.emitter.dispose();
  }
}
