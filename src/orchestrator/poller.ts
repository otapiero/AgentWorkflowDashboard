import { applyLastGood, boardSignature, nextDelayMs } from './board.ts';
import { gatherFacts } from './facts.ts';
import { fetchBranchPrs } from './github.ts';
import { reconcile } from './reconcile.ts';
import { loadState, saveState } from './state.ts';
import { listBranches, worktreeExists } from './worktree.ts';
import { resolveAgent } from './agents.ts';
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
  const isAgentPhase = phase?.actor === 'claude' || phase?.actor === 'copilot';
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

  let dirty = false;
  const results = await Promise.all(
    state.tasks.map(async (task): Promise<TaskWithDerived> => {
      try {
        const facts = await gatherFacts(config, task, branches, batch);
        const derived = reconcile(facts, task.manualPhase);
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
          pinned: pinnedFor(config, updated, derived, phaseDefaults),
        };
      } catch (err) {
        // One unreachable task must not blank the whole board. The poller holds
        // it in its last good place; this fallback only applies on a first-ever
        // poll that fails, when there is no good state to fall back to.
        console.error(`[mc] reconcile failed for #${task.issue}:`, err);
        return {
          ...task,
          unreachable: true,
          pinned: { agent: null, model: null, effort: null },
          derived: reconcile(
            {
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
              checks: 'none',
              review: {
                decision: 'NONE',
                unresolvedThreads: 0,
                copilotUnresolved: 0,
              },
            },
            task.manualPhase,
          ),
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
