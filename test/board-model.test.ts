import { describe, expect, test } from 'vitest';

import { attentionTasks, laneLayout } from '../src/web/board-model.ts';
import type { DerivedState, Phase, TaskWithDerived } from '../src/shared/types.ts';

function task(issue: number, needsYou: boolean): TaskWithDerived {
  return {
    issue,
    title: `task ${issue}`,
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

  test('a four-card lane gets roughly twice a one-card lane', () => {
    const [one, four] = laneLayout([
      { id: 'plan' as Phase, count: 1 },
      { id: 'implement' as Phase, count: 4 },
    ]);
    expect(four!.grow / one!.grow).toBeCloseTo(1.69, 2);
  });

  test('order is preserved exactly', () => {
    const layout = laneLayout([
      { id: 'inbox' as Phase, count: 0 },
      { id: 'plan' as Phase, count: 3 },
      { id: 'done' as Phase, count: 0 },
    ]);
    expect(layout.map((l) => l.id)).toEqual(['inbox', 'plan', 'done']);
  });

  test('an all-empty board leaves every lane collapsed', () => {
    const layout = laneLayout([
      { id: 'inbox' as Phase, count: 0 },
      { id: 'plan' as Phase, count: 0 },
    ]);
    expect(layout.every((l) => l.collapsed)).toBe(true);
  });
});

describe('attentionTasks', () => {
  test('keeps only the tasks that need you, in board order', () => {
    const result = attentionTasks([task(1, false), task(2, true), task(3, true)]);
    expect(result.map((t) => t.issue)).toEqual([2, 3]);
  });

  test('is empty when nothing needs you — the rail vanishes', () => {
    expect(attentionTasks([task(1, false)])).toEqual([]);
  });
});
