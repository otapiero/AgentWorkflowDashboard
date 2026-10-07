import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { BoardConfig, TaskWithDerived } from '../../../src/shared/types.ts';
import { DeliveryLedger } from '../../src/notifications/delivery-ledger.ts';
import { MissionControlRuntime } from '../../src/runtime.ts';
import { TaskStore } from '../../src/task-store.ts';
import { MissionControlClient } from '../../src/client/mission-control-client.ts';
import { MissionControlTreeProvider } from '../../src/tree-provider.ts';
import { MissionControlStatusBar } from '../../src/status-bar.ts';

function within(name: string, actual: number, limit: number): void {
  if (actual > limit) throw new Error(`${name}: ${actual.toFixed(2)} exceeded ${limit}`);
}

const config: BoardConfig = { repo: { path: 'C:\\repo', owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice/' }, pipeline: [{ id: 'plan', label: 'Plan', actor: 'codex', spawnable: true, gate: { type: 'manual' } }, { id: 'implement', label: 'Implement', actor: 'codex', spawnable: true, gate: { type: 'manual' } }], agents: [{ name: 'codex', models: ['gpt-5.6-sol'], efforts: ['medium'], hasEffort: true }], phaseDefaults: {}, launcher: 'vscode' };

function makeTasks(count: number, revision = 0): TaskWithDerived[] {
  return Array.from({ length: count }, (_, index) => {
    const issue = index + 1;
    return { issue, title: `Mission task ${issue}`, slug: `mission-task-${issue}`, branch: `alice/${issue}`, worktreePath: `C:\\mc\\worktrees\\issue-${issue}`, prNumber: issue, prUrl: `https://github.com/acme/widgets/pull/${issue}`, manualPhase: null, spawnHistory: [], lastReconciledAt: `2026-08-03T10:${String(revision).padStart(2, '0')}:00.000Z`, derived: { issue, derivedPhase: revision && issue <= 100 ? 'plan' : 'implement', displayPhase: revision && issue <= 100 ? 'plan' : 'implement', gates: { inbox: true, plan: false, implement: false, publish: false, ci: false, copilot_review: false, dev_review: false, merge: false, merged: false, done: false }, badges: [], artifacts: [], needsYou: issue % 13 === 0, needsYouReason: issue % 13 === 0 ? 'Review required' : null }, pinned: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' }, integration: { workspacePath: `C:\\mc\\worktrees\\issue-${issue}`, worktreeExists: true, liveSpawn: null, checks: 'none', review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 }, approvalRequired: false } };
  });
}

async function main(): Promise<void> {
  const store = new TaskStore();
  let fingerprintCount = 0;
  store.onDidChange(() => {});
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  store.applyBaseline(config, makeTasks(500));
  globalThis.gc?.();
  const retainedHeapMiB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  within('retained heap MiB', retainedHeapMiB, 25);

  const started = performance.now();
  store.applyTasks(makeTasks(500, 1));
  const applyTasksMs = performance.now() - started;
  within('applyTasks 100 changes ms', applyTasksMs, 100);

  const directory = await mkdtemp(join(tmpdir(), 'mission-control-performance-'));
  try {
    const ledger = new DeliveryLedger(directory, async () => {});
    for (let index = 0; index < 510; index += 1) await ledger.claim({ kind: 'ciFailed', issue: index, title: 'CI failed', message: 'CI failed', fingerprint: `performance-${index}`, prUrl: null });
    const fingerprints = await ledger.entriesForTests();
    if (fingerprints.length !== 500) throw new Error(`notification fingerprints: expected 500, got ${fingerprints.length}`);
    fingerprintCount = fingerprints.length;
  } finally { await rm(directory, { recursive: true, force: true }); }

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const runtimeClient = {
    config: async () => config,
    tasks: async () => makeTasks(1),
    reconcile: async () => makeTasks(1),
    connect: async (handlers: { onOpen(): void | Promise<void> }, signal: AbortSignal) => { await handlers.onOpen(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
  };
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => runtimeClient as never, createServerManager: () => ({ ensureReady: async () => ({ kind: 'ready', health: {} }) }) as never, store: new TaskStore(), notifications: { prime: () => {}, apply: async () => {} } as never, delay: async (ms, signal) => await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timers.add(timer); signal.addEventListener('abort', () => { clearTimeout(timer); timers.delete(timer); reject(new Error('aborted')); }, { once: true }); }), jitter: value => value, presentConnectionFailure: async () => undefined });
  runtime.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  runtime.dispose();
  await new Promise<void>(resolve => setImmediate(resolve));
  if (timers.size !== 0) throw new Error(`connected runtime timer registry: expected 0, got ${timers.size}`);

  const flow = await measureRuntimeFlow();
  within('healthy response to first populated tree dispatch ms', flow.healthyTreeMs, 500);
  within('SSE task receipt to tree and status dispatch ms', flow.sseDispatchMs, 100);

  console.log(`Performance budgets: retained heap ${retainedHeapMiB.toFixed(2)} MiB / 25.00 MiB; applyTasks ${applyTasksMs.toFixed(2)} ms / 100.00 ms; healthy tree ${flow.healthyTreeMs.toFixed(2)} ms / 500.00 ms; SSE tree+status ${flow.sseDispatchMs.toFixed(2)} ms / 100.00 ms; notification fingerprints ${fingerprintCount} / 500; runtime timers ${timers.size} / 0`);
}

async function measureRuntimeFlow(): Promise<{ healthyTreeMs: number; sseDispatchMs: number }> {
  const store = new TaskStore();
  let treeDispatches = 0; let statusDispatches = 0;
  class Emitter<T> { private listeners: ((value: T) => void)[] = []; event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose() {} }; }; fire(value: T) { for (const listener of this.listeners) listener(value); } dispose() {} }
  const workspace = () => ({ scheme: 'file', fsPath: 'C:\\mc\\worktrees\\issue-1' });
  const tree = new MissionControlTreeProvider(store, workspace, { TreeItem: class { constructor(_label: string, _state: number) {} } as never, ThemeIcon: class {} as never, EventEmitter: Emitter as never, Uri: { file: (path: string) => path }, CollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 } as never }, () => { treeDispatches += 1; });
  const status = new MissionControlStatusBar(store, workspace, { StatusBarAlignment: { Left: 1, Right: 2 } as never, createStatusBarItem: () => ({ text: '', show() {}, dispose() {} }) }, () => { statusDispatches += 1; });
  tree.getChildren();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const baselineTasks = makeTasks(500);
  const client = new MissionControlClient('http://127.0.0.1:4317', async (url) => {
    const path = new URL(url instanceof Request ? url.url : url.toString()).pathname;
    if (path === '/api/events') return new Response(stream, { status: 200 });
    const body = path === '/api/config' ? config : baselineTasks;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const ready = deferred<void>(); const connected = deferred<void>(); let healthSuccessAt: number | undefined;
  const runtime = new MissionControlRuntime({ readSettings: () => ({ serverUrl: 'http://127.0.0.1:4317', installationPath: undefined, autoStart: false }), createClient: () => client, createServerManager: () => ({ ensureReady: async () => { healthSuccessAt = performance.now(); return { kind: 'ready', health: {} }; } }) as never, store, notifications: { prime: () => {}, apply: async () => {} } as never, delay: async () => {}, jitter: value => value, presentConnectionFailure: async () => undefined });
  const stop = store.onDidChange(() => { if (store.snapshot().isBaselineReady && treeDispatches > 0) ready.resolve(); if (store.snapshot().connection === 'connected') connected.resolve(); });
  runtime.start(); await ready.promise;
  if (healthSuccessAt === undefined) throw new Error('healthy-response boundary was not set');
  const healthyTreeMs = performance.now() - healthSuccessAt;
  await connected.promise;
  if (store.tasks().length !== 500) throw new Error(`connected baseline: expected 500 tasks, got ${store.tasks().length}`);
  tree.getChildren();
  treeDispatches = 0; statusDispatches = 0;
  const marker = 'sse-causal-marker'; const sseTasks = [...baselineTasks];
  for (let index = 0; index < 100; index += 1) {
    const previous = baselineTasks[index]!;
    sseTasks[index] = { ...previous, title: `${marker}-${index}`, derived: { ...previous.derived, derivedPhase: 'plan', displayPhase: 'plan' } };
  }
  const dispatched = deferred<void>(); let parsedAndApplied = false;
  const observe = store.onDidChange(() => { parsedAndApplied = store.task(1)?.title === `${marker}-0` && store.task(100)?.title === `${marker}-99`; if (parsedAndApplied && treeDispatches > 0 && statusDispatches > 0) dispatched.resolve(); });
  const sseStart = performance.now();
  controller!.enqueue(encoder.encode(`event: tasks\ndata: ${JSON.stringify(sseTasks)}\n\n`));
  await withTimeout(dispatched.promise, 1_000, 'SSE causal marker was not parsed, applied, and dispatched');
  const sseDispatchMs = performance.now() - sseStart;
  if (!parsedAndApplied) throw new Error('SSE causal marker was not delivered');
  if (store.tasks().length !== 500) throw new Error(`SSE snapshot inserted tasks: expected 500 tasks, got ${store.tasks().length}`);
  if (store.task(101)?.title !== baselineTasks[100]?.title || store.task(500)?.title !== baselineTasks[499]?.title) throw new Error('SSE snapshot changed tasks outside the first 100');
  observe(); stop(); runtime.dispose(); tree.dispose(); status.dispose();
  return { healthyTreeMs, sseDispatchMs };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } { let resolve!: (value: T) => void; return { promise: new Promise<T>(value => { resolve = value; }), resolve }; }

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> { return await Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms))]); }

void main();
