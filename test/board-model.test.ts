import { describe, expect, test } from 'vitest';

import { attentionTasks, laneLayout, reuseBoardTasks } from '../src/web/board-model.ts';
import type { DerivedState, Phase, TaskWithDerived } from '../src/shared/types.ts';

function task(issue: number, needsYou: boolean): TaskWithDerived {
  return {
    issue,
    title: `task ${issue}`,
    integration: {
      workspacePath: 'C:\\mc\\worktrees\\issue-1',
      worktreeExists: false,
      liveSpawn: null,
      checks: 'none',
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
      approvalRequired: false,
    },
    derived: { needsYou, needsYouReason: needsYou ? 'changes requested' : null } as DerivedState,
  } as TaskWithDerived;
}

describe('laneLayout', () => {
  test('an empty lane collapses and takes no share of the width', () => {
    const [inbox, plan] = laneLayout([
      { id: 'inbox' as Phase, count: 0 },
      { id: 'plan' as Phase, count: 2 },
    ]);
    expect(inbox?.collapsed).toBe(true);
    expect(inbox?.grow).toBe(0);
    expect(plan?.collapsed).toBe(false);
    expect(plan?.grow).toBeGreaterThan(0);
  });

  test('a busier lane gets a larger share', () => {
    const [one, four] = laneLayout([
      { id: 'plan' as Phase, count: 1 },
      { id: 'implement' as Phase, count: 4 },
    ]);
    expect(four!.grow).toBeGreaterThan(one!.grow);
  });

  test('the weighting saturates so one lane cannot starve the others', () => {
    const [four, twenty] = laneLayout([
      { id: 'plan' as Phase, count: 4 },
      { id: 'implement' as Phase, count: 20 },
    ]);
    expect(twenty!.grow).toBe(four!.grow);
  });

  test('order is preserved exactly', () => {
    const layout = laneLayout([
      { id: 'inbox' as Phase, count: 0 },
      { id: 'plan' as Phase, count: 3 },
      { id: 'done' as Phase, count: 0 },
    ]);
    expect(layout.map((l) => l.id)).toEqual(['inbox', 'plan', 'done']);
  });
});

describe('attentionTasks', () => {
  test('keeps only the tasks that need you, in board order', () => {
    const result = attentionTasks([task(1, false), task(2, true), task(3, true)]);
    expect(result.map((t) => t.issue)).toEqual([2, 3]);
  });
});

test('reuses unchanged render data across observations, but keeps changed and reordered tasks', () => {
  const previous = [task(1, false), task(2, true)];
  const observed = previous.map(t => ({ ...structuredClone(t), lastReconciledAt: '2026-10-29T00:00:00Z' }));
  expect(reuseBoardTasks(previous, observed)).toBe(previous);
  const changed = { ...observed[1]!, title: 'Updated widget' };
  const next = reuseBoardTasks(previous, [changed, observed[0]!]);
  expect(next[0]).toMatchObject({ issue: 2, title: 'Updated widget' });
  expect(next[0]).not.toHaveProperty('integration');
  expect(next[1]).toBe(previous[0]);
  expect(reuseBoardTasks(next, [])).toEqual([]);
});
