import type { BoardConfig, TaskWithDerived } from '../../src/shared/types.ts';
import type { MissionControlClient, SpawnRequest } from './client/mission-control-client.ts';
import { runLaunchFlow, type LaunchPicker } from './launch-flow.ts';
import type { ServerManager } from './server-manager.ts';
import type { TaskStore } from './task-store.ts';
import { matchWorkspace, normalizeWorkspacePath } from './workspace-matcher.ts';

type Uri = { scheme?: string; fsPath?: string };
type TaskChoice = { label: string; description: string; task: TaskWithDerived };

export interface CommandsApi {
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown> | Promise<unknown>;
  uriFile(path: string): unknown;
  uriParse(value: string): unknown;
  openExternal(uri: unknown): Thenable<boolean> | Promise<boolean>;
  showInformationMessage(message: string): Thenable<unknown> | Promise<unknown>;
  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined> | Promise<string | undefined>;
  showQuickPick(items: readonly TaskChoice[], options: { placeHolder: string }): Thenable<TaskChoice | undefined> | Promise<TaskChoice | undefined>;
  terminals: readonly { shellIntegration?: { cwd?: { fsPath: string } }; show(): void }[];
  workspaceUri(): Uri | undefined;
}

export interface CommandDependencies {
  api: CommandsApi;
  store: Pick<TaskStore, 'task' | 'tasks'>;
  client: Pick<MissionControlClient, 'spawn'>;
  currentClient?: () => Pick<MissionControlClient, 'spawn'>;
  config: () => BoardConfig | null;
  serverUrl: () => string;
  runLaunchFlow?: (task: TaskWithDerived, config: BoardConfig, picker: LaunchPicker) => Promise<SpawnRequest | null>;
  launchPicker?: LaunchPicker;
  output: { show(): void };
  server: Pick<ServerManager, 'restartOwned'>;
  currentServer?: () => Pick<ServerManager, 'restartOwned'>;
}

export class CommandController {
  private readonly launch: NonNullable<CommandDependencies['runLaunchFlow']>;

  constructor(private readonly deps: CommandDependencies) {
    this.launch = deps.runLaunchFlow ?? runLaunchFlow;
  }

  async openTask(candidate?: TaskWithDerived): Promise<void> {
    const task = candidate ? this.latest(candidate) : await this.pickTask();
    if (!task) return;
    if (!task.integration.worktreeExists) {
      await this.deps.api.showWarningMessage('This task does not have an available worktree.');
      return;
    }
    await this.deps.api.executeCommand('vscode.openFolder', this.deps.api.uriFile(task.integration.workspacePath), { forceNewWindow: true });
  }

  async runCurrentPhase(candidate?: TaskWithDerived): Promise<void> {
    const task = candidate ? this.latest(candidate) : matchWorkspace(this.deps.api.workspaceUri() as { scheme: string; fsPath: string } | undefined, this.deps.store.tasks());
    if (!task) {
      await this.deps.api.showWarningMessage('This workspace is not a Mission Control worktree.');
      return;
    }
    const config = this.deps.config();
    if (!config) {
      await this.deps.api.showWarningMessage('Mission Control configuration is not available.');
      return;
    }
    const picker = this.deps.launchPicker;
    if (!picker) throw new Error('Mission Control launch picker is not configured.');
    const request = await this.launch(task, config, picker);
    if (!request) return;
    try {
      await (this.deps.currentClient?.() ?? this.deps.client).spawn(task.issue, request, new AbortController().signal);
    } catch (error) {
      const choice = await this.deps.api.showWarningMessage(error instanceof Error ? error.message : String(error), 'Show Logs');
      if (choice === 'Show Logs') await this.showLogs();
    }
  }

  async openDashboard(): Promise<void> {
    const origin = new URL(this.deps.serverUrl()).origin;
    await this.deps.api.openExternal(this.deps.api.uriParse(origin));
  }

  async viewSession(candidate?: TaskWithDerived): Promise<void> {
    const task = candidate ? this.latest(candidate) : matchWorkspace(this.deps.api.workspaceUri() as { scheme: string; fsPath: string } | undefined, this.deps.store.tasks());
    if (!task) return;
    const expected = normalizeWorkspacePath(task.integration.workspacePath);
    const terminal = this.deps.api.terminals.find((candidateTerminal) => {
      const cwd = candidateTerminal.shellIntegration?.cwd?.fsPath;
      return cwd !== undefined && normalizeWorkspacePath(cwd) === expected;
    });
    if (terminal) terminal.show();
    else await this.deps.api.showInformationMessage('No integrated terminal is running for this worktree.');
  }

  async restartServer(): Promise<void> {
    this.deps.output.show();
    await (this.deps.currentServer?.() ?? this.deps.server).restartOwned();
    await this.deps.api.showInformationMessage('Mission Control server restart requested.');
  }

  async showLogs(): Promise<void> { this.deps.output.show(); }

  private latest(candidate: TaskWithDerived): TaskWithDerived | undefined {
    return this.deps.store.task(candidate.issue);
  }

  private async pickTask(): Promise<TaskWithDerived | undefined> {
    const tasks = [...this.deps.store.tasks()].sort((left, right) => Number(right.derived.needsYou) - Number(left.derived.needsYou) || left.issue - right.issue);
    const selected = await this.deps.api.showQuickPick(tasks.map((task) => ({ label: `#${task.issue} ${task.title}`, description: task.derived.needsYou ? 'Needs Attention' : '', task })), { placeHolder: 'Open Mission Control worktree' });
    return selected ? this.latest(selected.task) : undefined;
  }
}
