import type * as vscode from 'vscode';

import type { TaskWithDerived } from '../../src/shared/types.ts';
import type { MissionControlClient } from './client/mission-control-client.ts';
import type { NotificationCoordinator } from './notifications/notification-coordinator.ts';
import type { EnsureReadyResult, ServerManager } from './server-manager.ts';
import type { TaskStore } from './task-store.ts';

export interface RuntimeSettings { serverUrl: string; installationPath: string | undefined; autoStart: boolean; }
type Client = Pick<MissionControlClient, 'config' | 'tasks' | 'reconcile' | 'connect' | 'spawn'>;
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
  log?: (message: string) => void;
  lastOpenFolderArgsForTests?: () => readonly unknown[] | null;
  seedTasksForTests?: (tasks: readonly TaskWithDerived[]) => void;
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
    this.deps.store.setConnection('starting');
    this.deps.log?.('Configuration changed; reconnecting.');
    this.abort();
    if (this.started) this.begin();
  }

  lastOpenFolderArgsForTests(): readonly unknown[] | null { return this.deps.lastOpenFolderArgsForTests?.() ?? null; }
  requestSignal(): AbortSignal | undefined { return this.controller?.signal; }
  mutationTarget(): { client: Pick<MissionControlClient, 'spawn'>; signal: AbortSignal; generation: number } | null {
    if (this.deps.store.snapshot().connection !== 'connected' || !this.client || !this.controller || this.controller.signal.aborted) return null;
    return { client: this.client, signal: this.controller.signal, generation: this.generation };
  }
  /**
   * Waits only while the first connection attempt is still in flight, so a command
   * fired during startup gets a verdict instead of racing it. Settling on
   * 'disconnected' or 'incompatible' resolves too: the command guards own the
   * disconnected message, and waiting past a verdict would hang the command for
   * the whole reconnect backoff.
   */
  async whenConnected(): Promise<void> {
    const settling = () => this.deps.store.snapshot().connection === 'starting';
    if (!settling()) return;
    const signal = this.controller?.signal;
    if (!signal || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let unsubscribe: (() => void) | undefined;
      const onAbort = () => finish();
      const finish = () => { unsubscribe?.(); signal.removeEventListener('abort', onAbort); resolve(); };
      unsubscribe = this.deps.store.onDidChange(() => { if (!settling()) finish(); });
      // Re-check: the state can settle between the guard above and this subscription.
      if (!settling()) { finish(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  retry(): void { this.abort(); if (this.started) { this.deps.store.setConnection('starting'); this.begin(); } }
  seedTasksForTests = (tasks: readonly TaskWithDerived[]): void => { this.deps.seedTasksForTests?.(tasks); };

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
        const retryDelay = this.deps.jitter(reconnectDelays[Math.min(Math.max(attempts - 1, 0), reconnectDelays.length - 1)]!);
        this.deps.log?.(`Reconnecting in ${Math.round(retryDelay)} ms.`);
        try { await this.deps.delay(retryDelay, signal); } catch { return; }
        if (signal.aborted) return;
      }
      const ready = await server.ensureReady();
      if (signal.aborted) return;
      if (ready.kind !== 'ready') {
        this.deps.log?.(`Connection failed: ${ready.kind}.`);
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
          this.deps.log?.(`SSE closed${closed ? `: ${(closed as Error).message}` : '.'}`);
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
