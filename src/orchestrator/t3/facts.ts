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

/**
 * Windows paths differ in case and separator without differing in meaning, and
 * T3 compares the normalised form — its refusal quoted the root lowercased
 * while the API returns it cased.
 */
function normalizeWorkspaceRoot(path: string): string {
  return path.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * The id of the T3 project already rooted at this workspace, if there is one.
 *
 * T3 allows exactly one active project per workspace root and refuses a second
 * with a 500, not a validation error:
 *
 *   OrchestrationCommandInvariantError, commandType 'project.create',
 *   "Active project '…' already exists for workspace root '…'."
 *
 * So a repo the operator already added to T3 by hand — the normal case, since
 * that is how anyone tries T3 out — would make every single spawn fail. Adopt
 * it instead, which is the discipline pickBranchForIssue already applies to a
 * branch that exists before Mission Control would have generated one.
 *
 * Soft-deleted projects are skipped: they do not hold the invariant, so
 * adopting one would bind threads to a project T3 considers gone.
 */
export function findProjectForWorkspace(
  snapshot: T3Snapshot | undefined,
  workspaceRoot: string,
): string | null {
  if (!snapshot) return null;
  const wanted = normalizeWorkspaceRoot(workspaceRoot);
  const match = snapshot.projects.find(
    (p) => !p.deletedAt && normalizeWorkspaceRoot(p.workspaceRoot) === wanted,
  );
  return match?.id ?? null;
}

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
