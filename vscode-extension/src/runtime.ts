import type * as vscode from 'vscode';

import type { TaskWithDerived } from '../../src/shared/types.ts';
import type { MissionControlClient } from './client/mission-control-client.ts';
import type { NotificationCoordinator } from './notifications/notification-coordinator.ts';
import type { EnsureReadyResult, ServerManager } from './server-manager.ts';
import type { TaskStore } from './task-store.ts';

export interface RuntimeSettings { serverUrl: string; installationPath: string | undefined; autoStart: boolean; }
type Client = Pick<MissionControlClient, 'config' | 'tasks' | 'reconcile' | 'connect'>;
type Manager = Pick<ServerManager, 'ensureReady'> & Partial<Pick<ServerManager, 'dispose'>>;

export interface RuntimeDependencies {
  readSettings(): RuntimeSettings;
  createClient(serverUrl: string): Client;
  createServerManager(client: Client, settings: RuntimeSettings): Manager;
  store: TaskStore;
  notifications: Pick<NotificationCoordinator, 'prime' | 'apply'>;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  jitter(delayMs: number): number;
  presentConnectionFailure(result: EnsureReadyResult): Promise<'retry' | 'configure' | 'logs' | undefined>;
}

const reconnectDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/** Owns the single REST/SSE session for one VS Code window. */
export class MissionControlRuntime implements vscode.Disposable {
  private controller: AbortController | undefined;
  private server: Manager | undefined;
  private client: Client | undefined;
  private started = false;
  private generation = 0;

  constructor(private readonly deps: RuntimeDependencies) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.begin();
  }

  reconfigure(changedKeys: ReadonlySet<string>): void {
    if (![...changedKeys].some((key) => key === 'missionControl.serverUrl' || key === 'missionControl.installationPath' || key === 'missionControl.autoStart')) return;
    this.abort();
    if (this.started) this.begin();
  }

  lastOpenFolderArgsForTests(): readonly unknown[] | null { return null; }

  dispose(): void { this.started = false; this.abort(); }

  private begin(): void {
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const settings = this.deps.readSettings();
    const client = this.deps.createClient(settings.serverUrl);
    const server = this.deps.createServerManager(client, settings);
    this.client = client;
    this.server = server;
    void this.connectLoop(generation, controller.signal, client, server);
  }

  private async connectLoop(generation: number, signal: AbortSignal, client: Client, server: Manager): Promise<void> {
    let attempts = 0;
    let reconnect = false;
    while (!signal.aborted && generation === this.generation) {
      if (reconnect) {
        try { await this.deps.delay(this.deps.jitter(reconnectDelays[Math.min(Math.max(attempts - 1, 0), reconnectDelays.length - 1)]!), signal); } catch { return; }
        if (signal.aborted) return;
      }
      const ready = await server.ensureReady();
      if (signal.aborted) return;
      if (ready.kind !== 'ready') {
        this.deps.store.setConnection(ready.kind === 'incompatible' ? 'incompatible' : 'disconnected');
        const action = await this.deps.presentConnectionFailure(ready);
        if (action === 'retry') { reconnect = true; attempts += 1; continue; }
        return;
      }
      try {
        const [configuration, tasks] = await Promise.all([client.config(signal), client.tasks(signal)]);
        if (signal.aborted) return;
        this.deps.store.applyBaseline(configuration, tasks);
        if (reconnect) await this.deps.notifications.apply(tasks); else this.deps.notifications.prime(tasks);
        let opened = false;
        let closed: Error | null = null;
        await client.connect({
          onOpen: async () => {
            if (signal.aborted || opened) return;
            opened = true;
            const reconciled = await client.reconcile(signal);
            if (signal.aborted) return;
            this.deps.store.applyTasks(reconciled);
            if (reconnect) await this.deps.notifications.apply(reconciled); else this.deps.notifications.prime(reconciled);
            this.deps.store.setConnection('connected');
            attempts = 0;
          },
          onTasks: async (next: TaskWithDerived[]) => { this.deps.store.applyTasks(next); await this.deps.notifications.apply(next); },
          onPoll: (poll) => this.deps.store.applyPoll(poll),
          onClosed: (error) => { closed = error; },
        }, signal);
        if (signal.aborted) return;
        if (closed || opened) {
          this.deps.store.setConnection('disconnected');
          reconnect = true;
          attempts += 1;
          continue;
        }
      } catch {
        if (signal.aborted) return;
        this.deps.store.setConnection('disconnected');
        reconnect = true;
        attempts += 1;
      }
    }
  }

  private abort(): void {
    this.controller?.abort();
    this.server?.dispose?.();
    this.controller = undefined;
    this.server = undefined;
    this.client = undefined;
  }
}
