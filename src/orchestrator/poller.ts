import { applyLastGood, boardSignature } from './board.ts';
import { gatherFacts } from './facts.ts';
import { fetchRateLimit } from './github.ts';
import { reconcile } from './reconcile.ts';
import { loadState, saveState } from './state.ts';
import { listBranches } from './worktree.ts';
import { resolveAgent } from './agents.ts';
import type {
  Config,
  DerivedState,
  PhaseDefaults,
  PollMeta,
  PrState,
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
export async function reconcileAll(config: Config): Promise<TaskWithDerived[]> {
  // Load the board once and gather the branch list once, rather than re-reading
  // state and running `git branch -a` per task.
  const state = loadState();
  const phaseDefaults = state.phaseDefaults ?? {};
  const branches = new Set(await listBranches(config));

  let dirty = false;
  const results = await Promise.all(
    state.tasks.map(async (task): Promise<TaskWithDerived> => {
      try {
        const facts = await gatherFacts(config, task, branches);
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
  return results;
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
}

export function startPoller(config: Config, handlers: PollHandlers): Poller {
  let timer: NodeJS.Timeout | null = null;
  // Runs are serialized through this handle: two reconciles must never overlap,
  // because they share one state file and one temp path when saving.
  let active: Promise<TaskWithDerived[]> | null = null;
  let lastSignature: string | null = null;
  let lastGood = new Map<number, TaskWithDerived>();

  async function runReconcile(force: boolean): Promise<TaskWithDerived[]> {
    const [raw, rateLimit] = await Promise.all([
      reconcileAll(config),
      fetchRateLimit(config),
    ]);

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

  timer = setInterval(() => {
    void exec(false);
  }, config.github.pollIntervalSeconds * 1000);

  void exec(false);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    runNow: () => exec(true),
  };
}
