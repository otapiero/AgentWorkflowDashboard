import { expect, test } from 'vitest';

import { MissionControlRuntime } from '../../src/runtime.ts';
import { NotificationCoordinator } from '../../src/notifications/notification-coordinator.ts';
import { TaskStore } from '../../src/task-store.ts';
import { config, task } from './fixtures.ts';

test('keeps the REST baseline visible until SSE opens and reconciliation finishes', async () => {
  const baseline = task({ checks: 'success' });
  const reconciled = task({ checks: 'failure', lastReconciledAt: '2026-08-03T10:01:00.000Z' });
  let openStream!: () => void;
  const streamPending = new Promise<void>((resolve) => { openStream = resolve; });
  let finishReconciliation!: (tasks: Array<typeof reconciled>) => void;
  const reconciliationPending = new Promise<Array<typeof reconciled>>((resolve) => { finishReconciliation = resolve; });
  let reconciling = false;
  const notifications: string[] = [];
  const client = {
    config: async () => config,
    tasks: async () => [baseline],
    reconcile: () => { reconciling = true; return reconciliationPending; },
    async connect(handlers: { onOpen(): Promise<void> }, signal: AbortSignal) {
      const closed = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await streamPending;
      await handlers.onOpen();
      await closed;
    },
  };
  const store = new TaskStore();
  const runtime = new MissionControlRuntime({
    readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }),
    createClient: () => client as never,
    createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never,
    store,
    notifications: new NotificationCoordinator({ claim: async () => true } as never, (event) => { notifications.push(event.kind); }, { ciFailed: true, ciPassed: true, agentFinished: true, reviewComments: true, approvalRequired: true }),
    delay: async () => {}, jitter: (value) => value, presentConnectionFailure: async () => undefined,
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.snapshot()).toMatchObject({ tasks: [baseline], connection: 'starting' });
  expect(reconciling).toBe(false);
  openStream();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.snapshot()).toMatchObject({ tasks: [baseline], connection: 'starting' });
  expect(reconciling).toBe(true);

  finishReconciliation([reconciled]);
  await runtime.whenConnected();

  expect(store.snapshot()).toMatchObject({ tasks: [reconciled], connection: 'connected' });
  expect(notifications).toEqual([]);
  runtime.dispose();
});

test('retains tasks while disconnected and cancels the pending reconnect on disposal', async () => {
  let attempts = 0;
  let reconnectSignal: AbortSignal | undefined;
  const client = {
    config: async () => config, tasks: async () => [task()], reconcile: async () => [task()],
    connect: async (handlers: { onOpen(): Promise<void>; onClosed(error: Error | null): void }) => {
      await handlers.onOpen();
      attempts += 1;
      handlers.onClosed(new Error('lost'));
    },
  };
  const store = new TaskStore();
  const runtime = new MissionControlRuntime({
    readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }),
    createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never,
    store, notifications: { prime: () => {}, apply: async () => {} } as never,
    delay: async (_ms, signal) => { reconnectSignal = signal; await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); }, jitter: (value) => value, presentConnectionFailure: async () => undefined,
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.snapshot()).toMatchObject({ tasks: [task()], connection: 'disconnected' });
  expect(reconnectSignal?.aborted).toBe(false);
  runtime.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reconnectSignal?.aborted).toBe(true);
  expect(attempts).toBe(1);
});

test('restarts only when connection settings change', async () => {
  const streams: AbortSignal[] = [];
  let serverUrl = 'http://127.0.0.1:4317';
  const origins: string[] = [];
  const client = {
    config: async () => config, tasks: async () => [task()], reconcile: async () => [task()],
    async connect(handlers: { onOpen(): Promise<void> }, signal: AbortSignal) {
      streams.push(signal);
      const closed = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await handlers.onOpen();
      await closed;
    },
  };
  const runtime = new MissionControlRuntime({
    readSettings: () => ({ serverUrl, installationPath: undefined, autoStart: false }),
    createClient: (url) => { origins.push(url); return client as never; }, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never,
    store: new TaskStore(), notifications: { prime: () => {}, apply: async () => {} } as never,
    delay: async () => {}, jitter: value => value, presentConnectionFailure: async () => undefined,
  });
  runtime.start();
  await runtime.whenConnected();
  runtime.reconfigure(new Set(['missionControl.notifications.ci']));
  expect(origins).toEqual(['http://127.0.0.1:4317']);
  expect(streams[0]?.aborted).toBe(false);
  serverUrl = 'http://127.0.0.1:4318';
  runtime.reconfigure(new Set(['missionControl.serverUrl']));
  await runtime.whenConnected();
  expect(origins).toEqual(['http://127.0.0.1:4317', 'http://127.0.0.1:4318']);
  expect(streams.map((signal) => signal.aborted)).toEqual([true, false]);
  runtime.dispose();
});

test('applies SSE tasks to the store before notifying', async () => {
  const store = new TaskStore(); const order: string[] = [];
  const next = task({ issue: 2 });
  const client = { config: async () => config, tasks: async () => [task()], reconcile: async () => [task()], connect: async (handlers: { onOpen(): Promise<void>; onTasks(tasks: typeof next[]): Promise<void> }, signal: AbortSignal) => { await handlers.onOpen(); await handlers.onTasks([next]); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } };
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never, store, notifications: { prime: () => {}, apply: async (tasks: typeof next[]) => { order.push(store.task(tasks[0]!.issue) ? 'store' : 'missing'); } } as never, delay: async () => {}, jitter: value => value, presentConnectionFailure: async () => undefined });
  runtime.start(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(order).toContain('store'); runtime.dispose();
});

test('caps failed reconnect backoff and applies injected jitter', async () => {
  const delays: number[] = [];
  const client = { config: async () => config, tasks: async () => [task()], reconcile: async () => [task()], connect: async () => { throw new Error('transport down'); } };
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never, store: new TaskStore(), notifications: { prime: () => {}, apply: async () => {} } as never, delay: async (ms) => { delays.push(ms); if (delays.length === 7) throw new Error('stop'); }, jitter: value => value * 2, presentConnectionFailure: async () => undefined });
  runtime.start(); await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]); runtime.dispose();
});

test('disposal aborts an active stream without scheduling a reconnect', async () => {
  let streamAborted = false; let reconnectScheduled = false;
  const client = { config: async () => config, tasks: async () => [task()], reconcile: async () => [task()], connect: async (handlers: { onOpen(): Promise<void> }, signal: AbortSignal) => { await handlers.onOpen(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { streamAborted = true; reject(new Error('aborted')); }, { once: true })); } };
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never, store: new TaskStore(), notifications: { prime: () => {}, apply: async () => {} } as never, delay: async () => { reconnectScheduled = true; }, jitter: value => value, presentConnectionFailure: async () => undefined });
  runtime.start(); await new Promise(resolve => setTimeout(resolve, 0)); runtime.dispose(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(streamAborted).toBe(true); expect(reconnectScheduled).toBe(false);
});

test('releases a command gate once the connection settles without connecting', async () => {
  const client = { config: async () => config, tasks: async () => [task()], reconcile: async () => [task()], connect: async () => {} };
  const store = new TaskStore();
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'unavailable', message: 'down' }) }) as never, store, notifications: { prime: () => {}, apply: async () => {} } as never, delay: async () => {}, jitter: value => value, presentConnectionFailure: async () => undefined });
  runtime.start(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.snapshot().connection).toBe('disconnected');
  // A gate that outlived the verdict would hang the command for the whole backoff.
  await expect(Promise.race([runtime.whenConnected(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('whenConnected hung')), 100))])).resolves.toBeUndefined();
  runtime.dispose();
});

test('holds a command issued during startup until the connection settles', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const client = { config: async () => config, tasks: async () => [task()], reconcile: async () => [task()], connect: async (handlers: { onOpen(): Promise<void> }, signal: AbortSignal) => { await handlers.onOpen(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } };
  const store = new TaskStore();
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => { await pending; return { kind: 'ready', health: {} }; } }) as never, store, notifications: { prime: () => {}, apply: async () => {} } as never, delay: async () => {}, jitter: value => value, presentConnectionFailure: async () => undefined });
  runtime.start();
  let settled = false;
  const gated = runtime.whenConnected().then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(store.snapshot().connection).toBe('starting');
  release(); await gated;
  expect(store.snapshot().connection).toBe('connected');
  runtime.dispose();
});

test('delivers an offline actionable transition once after authoritative reconnect', async () => {
  const baseline = task({ checks: 'success' }); const offline = task({ checks: 'failure' });
  let connection = 0; const presented: string[] = [];
  const client = { config: async () => config, tasks: async () => connection === 0 ? [baseline] : [offline], reconcile: async () => connection === 0 ? [baseline] : [offline], connect: async (handlers: { onOpen(): Promise<void>; onClosed(error: Error | null): void }, signal: AbortSignal) => { await handlers.onOpen(); if (connection++ === 0) { handlers.onClosed(new Error('lost')); return; } await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } };
  const notifications = new NotificationCoordinator({ claim: async () => true } as never, event => { presented.push(event.kind); }, { agentFinished: true, ciFailed: true, ciPassed: true, reviewComments: true, approvalRequired: true });
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never, store: new TaskStore(), notifications, delay: async () => {}, jitter: value => value, presentConnectionFailure: async () => undefined });
  runtime.start(); await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0));
  expect(presented).toEqual(['ciFailed']); runtime.dispose();
});
