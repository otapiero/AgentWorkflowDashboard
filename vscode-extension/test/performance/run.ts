import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { BoardConfig, TaskWithDerived } from '../../../src/shared/types.ts';
import { DeliveryLedger } from '../../src/notifications/delivery-ledger.ts';
import { MissionControlRuntime } from '../../src/runtime.ts';
import { TaskStore } from '../../src/task-store.ts';

function within(name: string, actual: number, limit: number): void {
  if (actual > limit) throw new Error(`${name}: ${actual.toFixed(2)} exceeded ${limit}`);
}

const config: BoardConfig = { repo: { path: 'C:\\repo', owner: 'otapiero', name: 'acme', baseBranch: 'main', branchPrefix: 'ouriel/' }, pipeline: [{ id: 'plan', label: 'Plan', actor: 'codex', spawnable: true, gate: { type: 'manual' } }, { id: 'implement', label: 'Implement', actor: 'codex', spawnable: true, gate: { type: 'manual' } }], agents: [{ name: 'codex', models: ['gpt-5.6-sol'], efforts: ['medium'], hasEffort: true }], phaseDefaults: {}, launcher: 'vscode' };

function makeTasks(count: number, revision = 0): TaskWithDerived[] {
  return Array.from({ length: count }, (_, index) => {
    const issue = index + 1;
    return { issue, title: `Mission task ${issue}`, slug: `mission-task-${issue}`, branch: `ouriel/${issue}`, worktreePath: `C:\\mc\\worktrees\\issue-${issue}`, prNumber: issue, prUrl: `https://github.com/otapiero/acme/pull/${issue}`, manualPhase: null, spawnHistory: [], lastReconciledAt: `2026-08-03T10:${String(revision).padStart(2, '0')}:00.000Z`, derived: { issue, derivedPhase: revision && issue <= 100 ? 'plan' : 'implement', displayPhase: revision && issue <= 100 ? 'plan' : 'implement', gates: { inbox: true, plan: false, implement: false, publish: false, ci: false, copilot_review: false, dev_review: false, merge: false, done: false }, badges: [], artifacts: [], needsYou: issue % 13 === 0, needsYouReason: issue % 13 === 0 ? 'Review required' : null }, pinned: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' }, integration: { workspacePath: `C:\\mc\\worktrees\\issue-${issue}`, worktreeExists: true, liveSpawn: null, checks: 'none', review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 }, approvalRequired: false } };
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

  console.log(`Performance budgets: retained heap ${retainedHeapMiB.toFixed(2)} MiB / 25.00 MiB; applyTasks ${applyTasksMs.toFixed(2)} ms / 100.00 ms; notification fingerprints ${fingerprintCount} / 500; runtime timers ${timers.size} / 0`);
}

void main();
