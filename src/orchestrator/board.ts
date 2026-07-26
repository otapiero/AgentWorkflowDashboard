import type { TaskWithDerived } from '../shared/types.ts';

/**
 * Pure helpers for turning a freshly reconciled board into what the clients see.
 * Kept apart from the poller so they can be tested without any I/O.
 */

/**
 * A stable fingerprint of everything the board renders — but not `lastReconciledAt`,
 * which ticks every poll. Comparing signatures is what lets the poller skip
 * re-pushing an unchanged board while the heartbeat still reports freshness.
 */
export function boardSignature(tasks: TaskWithDerived[]): string {
  return JSON.stringify(tasks, (key, value) =>
    key === 'lastReconciledAt' ? undefined : value,
  );
}

/**
 * Hold an unreachable task in its last good place instead of blanking it.
 *
 * A task that failed its reconcile arrives with `unreachable: true` and a bare
 * fallback phase. If we have a good result from a previous poll we reuse it —
 * same lane, same badges — and only add the stale flag, so a transient network
 * blip does not send cards flying to the inbox. Good results refresh the cache;
 * tasks that left the board leave it.
 */
export function applyLastGood(
  results: TaskWithDerived[],
  lastGood: Map<number, TaskWithDerived>,
): { results: TaskWithDerived[]; lastGood: Map<number, TaskWithDerived> } {
  const next = new Map(lastGood);

  const out = results.map((result) => {
    if (!result.unreachable) {
      next.set(result.issue, result);
      return result;
    }
    const good = next.get(result.issue);
    return good ? { ...good, unreachable: true } : result;
  });

  const live = new Set(results.map((r) => r.issue));
  for (const issue of next.keys()) {
    if (!live.has(issue)) next.delete(issue);
  }

  return { results: out, lastGood: next };
}

/** Poll cadence tiers. FAST comes from config; these two are fixed. */
export const REST_MS = 120_000;
export const DORMANT_MS = 600_000;

/**
 * Whether any card is doing something worth watching at the fast cadence: an
 * agent spawn running, CI still pending, or an open PR with unresolved review
 * threads. Read from the derived badges the board already carries.
 */
export function anyInFlight(tasks: TaskWithDerived[]): boolean {
  return tasks.some((t) =>
    t.derived.badges.some(
      (b) =>
        b.kind === 'live' ||
        (b.kind === 'ci' && b.tone === 'busy') ||
        b.kind === 'copilot' ||
        b.kind === 'review',
    ),
  );
}

/**
 * How long to wait before the next poll. No open tab: dormant (very slow). A
 * tab is open: fast while work is in flight, otherwise rest.
 */
export function nextDelayMs(
  tasks: TaskWithDerived[],
  hasClients: boolean,
  fastMs: number,
): number {
  if (!hasClients) return DORMANT_MS;
  return anyInFlight(tasks) ? fastMs : REST_MS;
}
