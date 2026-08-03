import * as vscode from 'vscode';
import { performance } from 'node:perf_hooks';

import { MissionControlClient } from './client/mission-control-client.ts';
import { CommandController } from './commands.ts';
import { DeferredActivation } from './deferred-activation.ts';
import { DeliveryLedger } from './notifications/delivery-ledger.ts';
import { NotificationCoordinator } from './notifications/notification-coordinator.ts';
import { MissionControlRuntime, type RuntimeSettings } from './runtime.ts';
import { ServerManager } from './server-manager.ts';
import { MissionControlStatusBar } from './status-bar.ts';
import { TaskStore } from './task-store.ts';
import { MissionControlTreeProvider } from './tree-provider.ts';
import { matchWorkspace } from './workspace-matcher.ts';
import type { TaskWithDerived } from '../../src/shared/types.ts';

let syncActivationMs = 0;
let activeRuntime: MissionControlRuntime | undefined;
export interface MissionControlTestApi { activationMetricsForTests(): { syncActivationMs: number }; readyForTests(): Promise<void>; lastOpenFolderArgs(): readonly unknown[] | null; seedTasksForTests(tasks: readonly TaskWithDerived[]): void; }

export function activate(context: vscode.ExtensionContext): MissionControlTestApi | void {
  const started = performance.now();
  const deferred = new DeferredActivation(setImmediate, clearImmediate, () => {
      const runtime = createRuntime(context);
      activeRuntime = runtime;
      context.subscriptions.push(runtime);
      runtime.start();
  });
  void deferred.ready.catch(() => undefined);
  for (const id of ['openTask', 'runCurrentPhase', 'openDashboard', 'restartServer', 'showLogs', 'viewSession', 'refresh', 'filter']) {
    context.subscriptions.push(vscode.commands.registerCommand(`missionControl.${id}`, async (...args) => { await deferred.ready; return await vscode.commands.executeCommand(`missionControl.internal.${id}`, ...args); }));
  }
  context.subscriptions.push({ dispose: () => deferred.dispose() });
  deferred.schedule();
  syncActivationMs = performance.now() - started;
  if (context.extensionMode === vscode.ExtensionMode.Test) return { activationMetricsForTests, readyForTests: async () => await deferred.ready, lastOpenFolderArgs: () => activeRuntime?.lastOpenFolderArgsForTests() ?? null, seedTasksForTests: tasks => activeRuntime?.seedTasksForTests(tasks) };
}
export function activationMetricsForTests(): { syncActivationMs: number } { return { syncActivationMs }; }
export function deactivate(): void { activeRuntime?.dispose(); activeRuntime = undefined; }

function createRuntime(context: vscode.ExtensionContext): MissionControlRuntime {
  const output = vscode.window.createOutputChannel('Mission Control');
  const store = new TaskStore();
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri;
  const tree = new MissionControlTreeProvider(store, folder, { TreeItem: vscode.TreeItem as never, ThemeIcon: vscode.ThemeIcon, EventEmitter: vscode.EventEmitter, Uri: vscode.Uri, CollapsibleState: vscode.TreeItemCollapsibleState });
  const view = vscode.window.createTreeView('missionControl.tasks', { treeDataProvider: tree, showCollapseAll: true });
  const status = new MissionControlStatusBar(store, folder, { StatusBarAlignment: vscode.StatusBarAlignment, createStatusBarItem: (alignment) => vscode.window.createStatusBarItem(alignment) as never });
  const settings = (): RuntimeSettings => {
    const config = vscode.workspace.getConfiguration('missionControl');
    const installation = config.get<string>('installationPath', '').trim();
    return { serverUrl: config.get<string>('serverUrl', 'http://127.0.0.1:4317'), installationPath: installation || undefined, autoStart: config.get<boolean>('autoStart', true) };
  };
  let client = new MissionControlClient(settings().serverUrl);
  let server = makeServer(client, settings(), context.globalStorageUri.fsPath);
  let lastOpenFolderArgs: readonly unknown[] | null = null;
  const commands = new CommandController({ api: {
    executeCommand: (command, ...args) => { if (command === 'vscode.openFolder') lastOpenFolderArgs = args; return vscode.commands.executeCommand(command, ...args); }, uriFile: vscode.Uri.file, uriParse: vscode.Uri.parse, openExternal: vscode.env.openExternal,
    showInformationMessage: vscode.window.showInformationMessage, showWarningMessage: vscode.window.showWarningMessage,
    showQuickPick: vscode.window.showQuickPick as never, terminals: vscode.window.terminals, workspaceUri: folder,
  }, store, client, currentClient: () => client, config: () => store.snapshot().config, serverUrl: () => settings().serverUrl, output, server, currentServer: () => server,
    launchPicker: { pick: vscode.window.showQuickPick as never },
  });
  const notificationOptions = notificationSettings();
  const notifications = new NotificationCoordinator(new DeliveryLedger(context.globalStorageUri.fsPath, async (ms) => await new Promise(resolve => setTimeout(resolve, ms))), async event => {
    const actions = event.prUrl ? ['View PR', 'Open Worktree'] : ['Open Worktree', 'Run Phase'];
    const show = event.kind === 'ciFailed' ? vscode.window.showErrorMessage : event.kind === 'reviewComments' || event.kind === 'approvalRequired' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const choice = await show(`${event.title}: ${event.message}`, ...actions);
    if (choice === 'Open Worktree') await commands.openTask(store.task(event.issue));
    if (choice === 'Run Phase') await commands.runCurrentPhase(store.task(event.issue));
    if (choice === 'View PR' && event.prUrl) await vscode.env.openExternal(vscode.Uri.parse(event.prUrl));
  }, notificationOptions);
  const runtime = new MissionControlRuntime({ readSettings: settings, createClient: (url) => { client = new MissionControlClient(url); return client; }, createServerManager: (nextClient, nextSettings) => { server = makeServer(nextClient as MissionControlClient, nextSettings, context.globalStorageUri.fsPath); return server; }, store, notifications,
    delay: (ms, signal) => abortableDelay(ms, signal), jitter: value => value * (0.8 + Math.random() * 0.4), presentConnectionFailure: async result => presentFailure(result, output), lastOpenFolderArgsForTests: () => lastOpenFolderArgs, seedTasksForTests: tasks => store.applyTasks(tasks) });
  const register = (id: string, callback: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id.replace('missionControl.', 'missionControl.internal.'), callback));
  register('missionControl.openTask', (task) => commands.openTask(task)); register('missionControl.runCurrentPhase', (task) => commands.runCurrentPhase(task));
  register('missionControl.openDashboard', () => commands.openDashboard()); register('missionControl.restartServer', () => commands.restartServer()); register('missionControl.showLogs', () => commands.showLogs()); register('missionControl.viewSession', (task) => commands.viewSession(task));
  register('missionControl.refresh', async () => { const signal = runtime.requestSignal(); if (!signal) return; const tasks = await client.reconcile(signal); if (signal.aborted) return; store.applyTasks(tasks); await notifications.apply(tasks); });
  register('missionControl.filter', async () => tree.setFilter(await vscode.window.showInputBox({ prompt: 'Filter Mission Control tasks' }) ?? ''));
  const updateContexts = () => { const snapshot = store.snapshot(); void vscode.commands.executeCommand('setContext', 'missionControl.connected', snapshot.connection === 'connected'); void vscode.commands.executeCommand('setContext', 'missionControl.configured', Boolean(snapshot.config)); void vscode.commands.executeCommand('setContext', 'missionControl.currentTask', Boolean(matchWorkspace(folder(), snapshot.tasks)?.integration.liveSpawn)); };
  context.subscriptions.push(output, tree, view, status, vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('missionControl.notifications')) Object.assign(notificationOptions, notificationSettings()); runtime.reconfigure(new Set(['missionControl.serverUrl', 'missionControl.installationPath', 'missionControl.autoStart'].filter(key => event.affectsConfiguration(key)))); }), vscode.workspace.onDidChangeWorkspaceFolders(updateContexts));
  context.subscriptions.push({ dispose: store.onDidChange(updateContexts) }); updateContexts();
  return runtime;
}
function notificationSettings() { const c = vscode.workspace.getConfiguration('missionControl.notifications'); const enabled = c.get<boolean>('enabled', true); return { agentFinished: enabled && c.get<boolean>('agentFinished', true), ciFailed: enabled && c.get<boolean>('ci', true), ciPassed: enabled && c.get<boolean>('ci', true), reviewComments: enabled && c.get<boolean>('review', true), approvalRequired: enabled && c.get<boolean>('review', true) }; }
function makeServer(client: MissionControlClient, settings: RuntimeSettings, storagePath: string) { return new ServerManager({ client, storagePath, serverUrl: settings.serverUrl, installationPath: settings.installationPath, autoStart: settings.autoStart, expectedApiVersion: 1, process: { spawn: require('node:child_process').spawn }, kill: process.kill, delay: abortableDelay }); }
function abortableDelay(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true }); }); }
async function presentFailure(result: import('./server-manager.ts').EnsureReadyResult, output: vscode.OutputChannel): Promise<'retry' | 'configure' | 'logs' | undefined> { if (result.kind === 'ready') return undefined; const message = result.kind === 'incompatible' ? `Mission Control API version is incompatible (expected 1, got ${result.health.apiVersion}).` : result.message; const choices = result.kind === 'unavailable' ? ['Retry', 'Configure Installation', 'Show Logs'] : result.kind === 'configuration-error' ? ['Configure Installation', 'Show Logs'] : ['Show Logs']; const picked = await vscode.window.showWarningMessage(message, ...choices); if (picked === 'Configure Installation') { await vscode.commands.executeCommand('workbench.action.openSettings', 'missionControl.installationPath'); return 'configure'; } if (picked === 'Show Logs') { output.show(); return 'logs'; } return picked === 'Retry' ? 'retry' : undefined; }
