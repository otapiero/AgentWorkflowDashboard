import { applyLastGood, boardSignature, nextDelayMs } from './board.ts';
import { gatherFacts } from './facts.ts';
import {
  collectArtifacts,
  readArtifacts,
  shouldCollectRun,
  snapshotAgeMs,
} from './artifacts.ts';
import { CUSTOM_RUN_ID } from '../shared/custom-run.ts';
import { fetchBranchPrs } from './github.ts';
import { reconcile } from './reconcile.ts';
import { toEditorIntegration } from './editor-integration.ts';
import { loadState, saveState } from './state.ts';
import { listBranches, worktreeExists } from './worktree.ts';
import { cleanupDoneTask, shouldCleanupOnDone } from './cleanup.ts';
import { resolveAgent } from './agents.ts';
import { T3Client } from './t3/client.ts';
import { latestThreadId } from './t3/facts.ts';
import type {
  Config,
  DerivedState,
  PhaseDefaults,
  PollMeta,
  PrState,
  RateLimit,
  TaskRecord,
  TaskWithDerived,
} from '../shared/types.ts';

/**
 * One client for the process, so the bearer token is exchanged once rather
 * than per cycle. Discovery still runs on every request, which is what lets a
 * T3 restart on a new port be picked up without restarting the board.
 */
const t3 = new T3Client();

/**
 * Only spend a request when some task could actually use the answer. A board
 * that has never launched through T3 must not pay for it on every poll.
 */
export function shouldFetchT3Snapshot(tasks: TaskRecord[]): boolean {
  return tasks.some((task) => latestThreadId(task) !== null);
}

/**
 * The prState/mergedAt to persist given a freshly observed PR state. mergedAt is
 * stamped once, on the first MERGED observation, and never overwritten — merge
 * is terminal, so the first sighting is the truth we freeze on.
 */
export function mergedFields(
  task: TaskRecord,
  observed: PrState | null,
  now: string,
): { prState: PrState | null; mergedAt: string | null } {
  const mergedAt =
    observed === 'MERGED' ? (task.mergedAt ?? now) : (task.mergedAt ?? null);
  return { prState: observed, mergedAt };
}

/**
 * The agent + model + effort to show on a card: what a spawn at the card's
 * current phase would use. Only agent phases carry a chip; resting phases like
 * CI or Merge do not, so the board stays uncluttered.
 */
function pinnedFor(
  config: Config,
  task: TaskRecord,
  derived: DerivedState,
  phaseDefaults: PhaseDefaults,
): { agent: string | null; model: string | null; effort: string | null } {
  const phase = config.pipeline.find((p) => p.id === derived.displayPhase);
  const isAgentPhase = Boolean(phase && config.agents[phase.actor]);
  if (!isAgentPhase) return { agent: null, model: null, effort: null };
  return resolveAgent(config, task, derived.displayPhase, phaseDefaults);
}

/**
 * Recompute the whole board from durable facts.
 *
 * Runs on startup (crash recovery), on the poll interval, and after any action
 * that could change state. Because everything is re-derived rather than
 * remembered, a stale or missing cache repairs itself here.
 */
export async function reconcileAll(
  config: Config,
): Promise<{ results: TaskWithDerived[]; rateLimit: RateLimit | null }> {
  // Load the board once and gather the branch list once, rather than re-reading
  // state and running `git branch -a` per task.
  const state = loadState();
  const phaseDefaults = state.phaseDefaults ?? {};
  const branches = new Set(await listBranches(config));

  // One batched GraphQL call covers every active branch's PR plus the budget.
  // Active = not merged and actually started (has a branch or a worktree).
  const activeBranches = [
    ...new Set(
      state.tasks
        .filter(
          (t) =>
            t.prState !== 'MERGED' &&
            (branches.has(t.branch) || worktreeExists(t.issue)),
        )
        .map((t) => t.branch),
    ),
  ];
  const batch = await fetchBranchPrs(config, activeBranches);

  // One snapshot covers every task, so the cost does not scale with board size.
  const t3Snapshot = shouldFetchT3Snapshot(state.tasks) ? await t3.fetchSnapshot() : undefined;

  let dirty = false;
  const results = await Promise.all(
    state.tasks.map(async (task): Promise<TaskWithDerived> => {
      try {
        let facts = await gatherFacts(config, task, branches, batch, t3Snapshot);
        // Once a run has ended (or the agent signalled done) and its output has
        // not been gathered yet, collect it. This is the crash-safe floor:
        // capture happens even if the agent never signed off.
        //
        // Both a plan run and a custom run can be waiting at once — launching a
        // custom run does not cancel a plan run's pending capture — so each kind
        // is settled on its own. When both fire, the plan's stale baseline also
        // claims the custom run's files; the originalPath merge in
        // collectArtifacts collapses that to one entry either way.
        for (const kind of ['plan', CUSTOM_RUN_ID] as const) {
          if (
            !shouldCollectRun({
              liveSpawn: facts.liveSpawn,
              doneMarker: facts.markers.includes(`${kind}.done`),
              snapshotAgeMs: snapshotAgeMs(task.issue, kind),
            })
          ) {
            continue;
          }
          try {
            await collectArtifacts(config, task.issue, kind, 'auto');
          } catch (e) {
            console.error(`[mc] ${kind} artifact collection failed for #${task.issue}:`, e);
          }
          facts = { ...facts, artifacts: readArtifacts(task.issue) };
        }
        const derived = reconcile(facts, task.manualPhase);

        // A merged PR means the checkout has done its job. Retiring it here
        // rather than on a button keeps the board honest about what is still
        // on disk. Failures are logged and dropped: a worktree that will not
        // go is untidy, never a reason to fail a whole poll cycle.
        if (shouldCleanupOnDone(config, derived.derivedPhase, facts.worktreeExists)) {
          try {
            const result = await cleanupDoneTask(config, task.issue, task.branch);
            const extras = [
              result.rescued.length ? `rescued ${result.rescued.length} file(s)` : null,
              result.branchDeleted ? `deleted ${task.branch}` : null,
            ].filter(Boolean);
            console.log(
              `[mc] #${task.issue} merged - removed its worktree${extras.length ? ` (${extras.join(', ')})` : ''}`,
            );
            facts = { ...facts, worktreeExists: false };
          } catch (e) {
            console.error(`[mc] worktree cleanup failed for #${task.issue}:`, e);
          }
        }

        const now = new Date().toISOString();
        const merged = mergedFields(task, facts.pr.state, now);
        const updated = {
          ...task,
          prNumber: facts.pr.number,
          prUrl: facts.pr.url,
          prState: merged.prState,
          mergedAt: merged.mergedAt,
          lastReconciledAt: now,
        };
        // Mutate the single in-memory board; one atomic save at the end avoids
        // the lost-update race that concurrent per-task writes used to cause.
        if (
          task.prNumber !== updated.prNumber ||
          task.prUrl !== updated.prUrl ||
          task.prState !== updated.prState ||
          task.mergedAt !== updated.mergedAt ||
          task.lastReconciledAt === null
        ) {
          const index = state.tasks.findIndex((t) => t.issue === task.issue);
          if (index !== -1) state.tasks[index] = updated;
          dirty = true;
        }
        return {
          ...updated,
          derived,
          integration: toEditorIntegration(facts),
          pinned: pinnedFor(config, updated, derived, phaseDefaults),
        };
      } catch (err) {
        // One unreachable task must not blank the whole board. The poller holds
        // it in its last good place; this fallback only applies on a first-ever
        // poll that fails, when there is no good state to fall back to.
        console.error(`[mc] reconcile failed for #${task.issue}:`, err);
        const fallbackFacts = {
          issue: task.issue,
          worktreeExists: false,
          branchExists: false,
          markers: [],
          planMdExists: false,
          artifacts: [],
          hasPushedCommits: false,
          dirtyFileCount: 0,
          unpushedCommits: 0,
          liveSpawn: null,
          pr: { exists: false, number: null, url: null, state: null },
          checks: 'none' as const,
          review: {
            decision: 'NONE' as const,
            unresolvedThreads: 0,
            copilotUnresolved: 0,
          },
        };
        return {
          ...task,
          unreachable: true,
          pinned: { agent: null, model: null, effort: null },
          derived: reconcile(fallbackFacts, task.manualPhase),
          integration: toEditorIntegration(fallbackFacts),
        };
      }
    }),
  );

  if (dirty) saveState(state);
  return { results, rateLimit: batch.rateLimit };
}

export interface Poller {
  stop(): void;
  runNow(): Promise<TaskWithDerived[]>;
}

export interface PollHandlers {
  /** The full board. Sent only when it actually changed, or on a forced run. */
  onTasks: (tasks: TaskWithDerived[]) => void;
  /** The heartbeat: freshness and budget, sent on every poll regardless. */
  onPoll: (meta: PollMeta) => void;
  /** Whether at least one browser tab is currently connected. */
  hasClients: () => boolean;
}

export function startPoller(config: Config, handlers: PollHandlers): Poller {
  let timer: NodeJS.Timeout | null = null;
  // Runs are serialized through this handle: two reconciles must never overlap,
  // because they share one state file and one temp path when saving.
  let active: Promise<TaskWithDerived[]> | null = null;
  let lastSignature: string | null = null;
  let lastGood = new Map<number, TaskWithDerived>();

  async function runReconcile(force: boolean): Promise<TaskWithDerived[]> {
    const { results: raw, rateLimit } = await reconcileAll(config);

    const applied = applyLastGood(raw, lastGood);
    lastGood = applied.lastGood;
    const tasks = applied.results;

    // Dedupe the heavy payload; the heartbeat below still reports every poll.
    const signature = boardSignature(tasks);
    if (force || signature !== lastSignature) handlers.onTasks(tasks);
    lastSignature = signature;

    handlers.onPoll({ checkedAt: new Date().toISOString(), rateLimit });
    return tasks;
  }

  function exec(force: boolean): Promise<TaskWithDerived[]> {
    if (active) {
      // A run is in flight. Interval polls ride it rather than stacking up; a
      // forced run (a user action) chains a fresh pass so it reflects the change.
      if (!force) return active;
      active = active.then(
        () => runReconcile(true),
        () => runReconcile(true),
      );
    } else {
      active = runReconcile(force);
    }
    const settled = active;
    void settled.finally(() => {
      if (active === settled) active = null;
    });
    return settled;
  }

  function scheduleNext(tasks: TaskWithDerived[]): void {
    if (timer) clearTimeout(timer);
    const ms = nextDelayMs(
      tasks,
      handlers.hasClients(),
      config.github.pollIntervalSeconds * 1000,
    );
    timer = setTimeout(() => void tick(), ms);
  }

  async function tick(): Promise<void> {
    const tasks = await exec(false);
    scheduleNext(tasks);
  }

  // Reconcile once immediately (crash recovery), then schedule adaptively.
  void tick();

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
    },
    runNow: () => {
      const settled = exec(true);
      // A forced run resets the cadence timer so the next tick is measured from
      // now, and picks up any change in client presence or in-flight work.
      void settled.then(scheduleNext, () => scheduleNext([]));
      return settled;
    },
  };
}
