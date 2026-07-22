import { gatherFacts } from './facts.ts';
import { reconcile } from './reconcile.ts';
import { getPhaseDefaults, listTasks, upsertTask } from './state.ts';
import { resolveAgent } from './agents.ts';
import type { Config, DerivedState, TaskRecord, TaskWithDerived } from '../shared/types.ts';

/**
 * The agent + model + effort to show on a card: what a spawn at the card's
 * current phase would use. Only agent phases carry a chip; resting phases like
 * CI or Merge do not, so the board stays uncluttered.
 */
function pinnedFor(
  config: Config,
  task: TaskRecord,
  derived: DerivedState,
): { agent: string | null; model: string | null; effort: string | null } {
  const phase = config.pipeline.find((p) => p.id === derived.displayPhase);
  const isAgentPhase = phase?.actor === 'claude' || phase?.actor === 'copilot';
  if (!isAgentPhase) return { agent: null, model: null, effort: null };
  return resolveAgent(config, task, derived.displayPhase, getPhaseDefaults());
}

/**
 * Recompute the whole board from durable facts.
 *
 * Runs on startup (crash recovery), on the poll interval, and after any action
 * that could change state. Because everything is re-derived rather than
 * remembered, a stale or missing cache repairs itself here.
 */
export async function reconcileAll(config: Config): Promise<TaskWithDerived[]> {
  const tasks = listTasks();
  const results = await Promise.all(
    tasks.map(async (task): Promise<TaskWithDerived> => {
      try {
        const facts = await gatherFacts(config, task);
        const derived = reconcile(facts, task.manualPhase);
        const updated = {
          ...task,
          prNumber: facts.pr.number,
          prUrl: facts.pr.url,
          lastReconciledAt: new Date().toISOString(),
        };
        // Only persist when something the cache holds actually changed.
        if (
          task.prNumber !== updated.prNumber ||
          task.prUrl !== updated.prUrl ||
          task.lastReconciledAt === null
        ) {
          upsertTask(updated);
        }
        return { ...updated, derived, pinned: pinnedFor(config, updated, derived) };
      } catch (err) {
        // One unreachable task must not blank the whole board.
        console.error(`[mc] reconcile failed for #${task.issue}:`, err);
        return {
          ...task,
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
  return results;
}

export interface Poller {
  stop(): void;
  runNow(): Promise<TaskWithDerived[]>;
}

export function startPoller(
  config: Config,
  onUpdate: (tasks: TaskWithDerived[]) => void,
): Poller {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (): Promise<TaskWithDerived[]> => {
    // Skip rather than queue: a slow poll must not stack up behind itself.
    if (running) return [];
    running = true;
    try {
      const tasks = await reconcileAll(config);
      onUpdate(tasks);
      return tasks;
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, config.github.pollIntervalSeconds * 1000);

  void tick();

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    runNow: tick,
  };
}
