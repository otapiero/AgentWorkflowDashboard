import type { Phase, TaskWithDerived } from '../shared/types.ts';

export interface LaneCount {
  id: Phase;
  count: number;
}

export interface LaneLayout {
  id: Phase;
  count: number;
  collapsed: boolean;
  /** flex-grow. 0 for a collapsed lane, which takes a fixed rail width. */
  grow: number;
}

/** Past this many cards, extra ones stop buying width. */
const SATURATION = 4;

/**
 * Lanes sized to their contents.
 *
 * Nine equal lanes meant a lane holding four cards truncated its titles while
 * an empty one held open a ninth of the screen. Empty lanes collapse to a
 * rail; the rest divide what is left, weighted by how full they are. The
 * weighting saturates so one busy lane can never starve its neighbours.
 */
export function laneLayout(counts: LaneCount[]): LaneLayout[] {
  return counts.map(({ id, count }) => ({
    id,
    count,
    collapsed: count === 0,
    grow: count === 0 ? 0 : 1 + Math.min(count, SATURATION) * 0.3,
  }));
}

/** The tasks the rail shows. Board order is kept — it is a filter, not a sort. */
export function attentionTasks(tasks: TaskWithDerived[]): TaskWithDerived[] {
  return tasks.filter((t) => t.derived.needsYou);
}
