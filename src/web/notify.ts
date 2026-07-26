import type { TaskWithDerived } from '../shared/types.ts';

/**
 * Pure diffing for needs-you notifications. Kept free of the DOM and the
 * Notification API so it can be unit-tested; App wires the actual toast to it.
 */

/** The set of issues currently asking for the operator. */
export function needsYouIssues(tasks: TaskWithDerived[]): Set<number> {
  return new Set(tasks.filter((t) => t.derived.needsYou).map((t) => t.issue));
}

/**
 * Tasks that need you now but did not in the previous board — the moments worth
 * a notification. Re-reporting an already-flagged card every poll would be noise.
 */
export function newlyNeedsYou(
  previous: Set<number>,
  tasks: TaskWithDerived[],
): Array<{ issue: number; title: string; reason: string }> {
  return tasks
    .filter((t) => t.derived.needsYou && !previous.has(t.issue))
    .map((t) => ({
      issue: t.issue,
      title: t.title,
      reason: t.derived.needsYouReason ?? 'needs you',
    }));
}
