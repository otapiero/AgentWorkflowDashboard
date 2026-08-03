import { expect, test } from 'vitest';

import { TaskStore, type StoreChange } from '../../src/task-store.ts';
import { config, task } from './fixtures.ts';

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

  expect(changes).toEqual([{ issues: new Set([1]), sections: new Set(['attention']) }]);
});

test('reports both phase sections when a task moves phases', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [task({ issue: 1, phase: 'plan' })]);
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));

  store.applyTasks([task({ issue: 1, phase: 'implement' })]);

  expect(changes).toEqual([{ issues: new Set([1]), sections: new Set(['plan', 'implement']) }]);
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
    { issues: new Set(), sections: new Set(['current', 'attention', 'all']) },
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
