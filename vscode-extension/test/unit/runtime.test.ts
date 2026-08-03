import { expect, test } from 'vitest';

import { MissionControlRuntime } from '../../src/runtime.ts';
import { TaskStore } from '../../src/task-store.ts';
import { config, task } from './fixtures.ts';

test('uses one baseline, reconciles after SSE opens, then connects', async () => {
  const calls: string[] = [];
  let handlers: { onOpen(): void | Promise<void>; onClosed(error: Error | null): void } | undefined;
  const client = {
    config: async () => { calls.push('config'); return config; },
    tasks: async () => { calls.push('tasks'); return [task()]; },
    reconcile: async () => { calls.push('reconcile'); return [task()]; },
    connect: async (value: typeof handlers, signal: AbortSignal) => { handlers = value; await value!.onOpen(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); },
  };
  const primes: unknown[][] = [];
  const store = new TaskStore();
  const runtime = new MissionControlRuntime({
    readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }),
    createClient: () => client as never,
    createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never,
    store,
    notifications: { prime: (tasks: unknown[]) => primes.push(tasks), apply: async () => {} } as never,
    delay: async (_ms, signal) => await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })), jitter: (value) => value, presentConnectionFailure: async () => undefined,
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(['config', 'tasks', 'reconcile']);
  expect(primes).toHaveLength(2);
  expect(store.snapshot().connection).toBe('connected');
  runtime.dispose();
});

test('marks the retained store disconnected and waits before reconnecting', async () => {
  const delays: number[] = [];
  let opens = 0;
  const client = {
    config: async () => config, tasks: async () => [task()], reconcile: async () => [task()],
    connect: async (handlers: { onOpen(): Promise<void>; onClosed(error: Error | null): void }) => {
      await handlers.onOpen();
      opens += 1;
      handlers.onClosed(new Error('lost'));
    },
  };
  const store = new TaskStore();
  const runtime = new MissionControlRuntime({
    readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }),
    createClient: () => client as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never,
    store, notifications: { prime: () => {}, apply: async () => {} } as never,
    delay: async (ms, signal) => { delays.push(ms); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }, jitter: (value) => value, presentConnectionFailure: async () => undefined,
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opens).toBeGreaterThan(0);
  expect(delays[0]).toBe(1_000);
  expect(store.snapshot().tasks).toHaveLength(1);
  runtime.dispose();
});

test('restarts only when connection settings change', async () => {
  const clients: string[] = [];
  const client = {
    config: async () => config, tasks: async () => [task()], reconcile: async () => [task()],
    connect: async (handlers: { onOpen(): Promise<void> }, signal: AbortSignal) => { await handlers.onOpen(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); },
  };
  const runtime = new MissionControlRuntime({
    readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }),
    createClient: (url) => { clients.push(url); return client as never; }, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never,
    store: new TaskStore(), notifications: { prime: () => {}, apply: async () => {} } as never,
    delay: async () => {}, jitter: value => value, presentConnectionFailure: async () => undefined,
  });
  runtime.start(); await new Promise(resolve => setTimeout(resolve, 0));
  runtime.reconfigure(new Set(['missionControl.notifications.ci']));
  expect(clients).toHaveLength(1);
  runtime.reconfigure(new Set(['missionControl.serverUrl']));
  expect(clients).toHaveLength(2);
  runtime.dispose();
});
