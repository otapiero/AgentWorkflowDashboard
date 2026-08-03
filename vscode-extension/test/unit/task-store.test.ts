import { expect, test } from 'vitest';

import { TaskStore, type StoreChange } from '../../src/task-store.ts';
import { buildChildren } from '../../src/tree-model.ts';
import { config, task } from './fixtures.ts';

function attentionIssues(store: TaskStore): number[] {
  return buildChildren(store.snapshot(), undefined, 'section:attention').flatMap((node) => node.kind === 'task' ? [node.issue] : []);
}

test('keeps task selectors in stable issue order with one task per issue', () => {
  const store = new TaskStore();
  const replaced = { ...task({ issue: 2, phase: 'ci' }), title: 'Newest issue 2' };

  store.applyBaseline(config, [task({ issue: 3 }), task({ issue: 1 }), task({ issue: 2 }), replaced]);

  expect(store.snapshot().tasks.map(({ issue }) => issue)).toEqual([1, 2, 3]);
  expect(store.tasks().map(({ issue }) => issue)).toEqual([1, 2, 3]);
  expect(store.task(2)?.title).toBe('Newest issue 2');
  expect(store.attentionTasks()).toEqual([]);
  expect(store.phaseTasks('ci').map(({ issue }) => issue)).toEqual([2]);
});

test('reports only the task and sections changed by one update', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [task({ issue: 1, phase: 'ci' }), task({ issue: 2, phase: 'implement' })]);
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));

  store.applyTasks([task({ issue: 1, phase: 'ci', needsYou: true }), task({ issue: 2, phase: 'implement' })]);

  expect(changes).toEqual([{ kind: 'targeted', issues: new Set([1]), sections: new Set(['attention']) }]);
});

test('reports both phase sections when a task moves phases', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [task({ issue: 1, phase: 'plan' })]);
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));

  store.applyTasks([task({ issue: 1, phase: 'implement' })]);

  expect(changes).toEqual([{ kind: 'targeted', issues: new Set([1]), sections: new Set(['plan', 'implement']) }]);
  expect(store.phaseTasks('plan')).toEqual([]);
  expect(store.phaseTasks('implement').map(({ issue }) => issue)).toEqual([1]);
});

test('does not emit when only reconciliation freshness changes', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [task({ issue: 1, lastReconciledAt: '2026-08-03T10:00:00.000Z' })]);
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));

  store.applyTasks([task({ issue: 1, lastReconciledAt: '2026-08-03T10:01:00.000Z' })]);

  expect(changes).toEqual([]);
  expect(store.task(1)?.lastReconciledAt).toBe('2026-08-03T10:01:00.000Z');
});

test('refreshes attention when a task remains actionable but its rank changes', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [
    task({ issue: 1, needsYou: true, lastReconciledAt: '2026-08-03T10:00:00.000Z' }),
    task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' }),
  ]);
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));
  expect(attentionIssues(store)).toEqual([2, 1]);

  store.applyTasks([
    task({ issue: 1, needsYou: true, checks: 'failure', lastReconciledAt: '2026-08-03T12:00:00.000Z' }),
    task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' }),
  ]);

  expect(changes).toEqual([{ kind: 'targeted', issues: new Set([1]), sections: new Set(['attention']) }]);
  expect(attentionIssues(store)).toEqual([1, 2]);
});

test('retains attention order across unrelated global reconciliation timestamps and titles', () => {
  const store = new TaskStore();
  const one = task({ issue: 1, needsYou: true, lastReconciledAt: '2026-08-03T10:00:00.000Z' });
  const two = task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' });
  store.applyBaseline(config, [one, two]);

  const updatedOne = task({ issue: 1, needsYou: true, lastReconciledAt: '2026-08-03T13:00:00.000Z' }); updatedOne.title = 'Renamed';
  store.applyTasks([updatedOne, task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T12:00:00.000Z' })]);

  expect(attentionIssues(store)).toEqual([2, 1]);
});

test('updates attention rank on a structured approval transition', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [
    task({ issue: 1, needsYou: true, lastReconciledAt: '2026-08-03T10:00:00.000Z' }),
    task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' }),
  ]);
  const transitioned = task({ issue: 1, needsYou: true, lastReconciledAt: '2026-08-03T12:00:00.000Z' }); transitioned.integration.approvalRequired = true;

  store.applyTasks([transitioned, task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T12:30:00.000Z' })]);

  expect(attentionIssues(store)).toEqual([1, 2]);
});

test('clears attention rank on removal so re-entry gets its new transition time', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [
    task({ issue: 1, needsYou: true, lastReconciledAt: '2026-08-03T10:00:00.000Z' }),
    task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T11:00:00.000Z' }),
  ]);
  store.applyTasks([task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T12:00:00.000Z' })]);
  store.applyTasks([
    task({ issue: 1, needsYou: true, lastReconciledAt: '2026-08-03T13:00:00.000Z' }),
    task({ issue: 2, needsYou: true, lastReconciledAt: '2026-08-03T13:30:00.000Z' }),
  ]);

  expect(attentionIssues(store)).toEqual([1, 2]);
});

test('reports connection updates and retains poll metadata separately', () => {
  const store = new TaskStore();
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));

  store.setConnection('connected');
  store.applyPoll({ checkedAt: '2026-08-03T10:02:00.000Z', rateLimit: null });

  expect(store.snapshot()).toMatchObject({
    connection: 'connected',
    poll: { checkedAt: '2026-08-03T10:02:00.000Z', rateLimit: null },
    isBaselineReady: false,
  });
  expect(changes).toEqual([
    { kind: 'targeted', issues: new Set(), sections: new Set(['current', 'attention', 'all']) },
  ]);
});

test('snapshots 500 tasks without duplicating issues', () => {
  const store = new TaskStore();
  const tasks = Array.from({ length: 500 }, (_, index) => task({ issue: 500 - index }));

  store.applyBaseline(config, tasks);

  const snapshot = store.snapshot();
  expect(snapshot.isBaselineReady).toBe(true);
  expect(snapshot.tasks).toHaveLength(500);
  expect(snapshot.tasks[0]?.issue).toBe(1);
  expect(snapshot.tasks[499]?.issue).toBe(500);
});

test('emits one full baseline change even when the first task list is empty', () => {
  const store = new TaskStore();
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));

  store.applyBaseline(config, []);

  expect(changes).toEqual([{ kind: 'full', reason: 'baseline' }]);
});

test('emits one full config change when only pipeline presentation changes', () => {
  const store = new TaskStore();
  store.applyBaseline(config, []);
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));
  const changed = { ...config, pipeline: config.pipeline.map((phase) => phase.id === 'implement' ? { ...phase, label: 'Build' } : phase) };

  store.applyBaseline(changed, []);
  store.applyBaseline(changed, []);

  expect(changes).toEqual([{ kind: 'full', reason: 'config' }]);
});
