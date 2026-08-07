import type { Facts, TaskRecord } from '../../shared/types.ts';
import type { T3Snapshot } from './schemas.ts';

/**
 * Turning T3's snapshot into the one optional fact the reconciler consumes.
 *
 * The load-bearing distinction throughout: `undefined` means "no information",
 * never "not running". Only that reading makes the fallback to PID liveness
 * correct — inventing a 'stopped' status when T3 is unreachable would show a
 * working agent as dead.
 */

/** The thread id of the most recent T3-launched spawn, if any. */
export function latestThreadId(task: TaskRecord): string | null {
  for (let i = task.spawnHistory.length - 1; i >= 0; i -= 1) {
    const threadId = task.spawnHistory[i]?.threadId;
    if (threadId) return threadId;
  }
  return null;
}

export function toT3Fact(
  snapshot: T3Snapshot | undefined,
  threadId: string | null,
): Facts['t3'] {
  if (!snapshot || !threadId) return undefined;

  const thread = snapshot.threads.find((t) => t.id === threadId);
  // Deleted inside T3, or belonging to another environment. Markers still hold
  // the history; only liveness is lost.
  if (!thread) return undefined;

  // Only the latest activity matters: an approval that has been answered is
  // followed by further activity, so a historical one must not keep the card
  // in the attention rail forever.
  const latest = thread.activities.at(-1);

  return {
    threadId,
    sessionStatus: thread.session?.status ?? 'idle',
    activeTurnId: thread.session?.activeTurnId ?? null,
    awaitingApproval: latest?.tone === 'approval',
    lastError: thread.session?.lastError ?? null,
  };
}
