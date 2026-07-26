import { existsSync } from 'node:fs';

import { planPath } from './paths.ts';
import { listMarkers, readLiveSpawn } from './markers.ts';
import type { BatchedBranchPrs } from './github.ts';
import { gatherGitFacts, worktreeExists } from './worktree.ts';
import type { Config, Facts, TaskRecord } from '../shared/types.ts';

/**
 * Gather every durable fact about a task, fresh.
 *
 * This is the only place that performs I/O for reconciliation; the reconciler
 * itself stays pure. Nothing here is remembered between calls — that is what
 * makes closing or crashing the app harmless.
 *
 * `branches` is the repo's branch list, gathered once per reconcile and passed
 * in so the board does not run `git branch -a` once per task.
 */
export async function gatherFacts(
  config: Config,
  task: TaskRecord,
  branches: Set<string>,
  batch: BatchedBranchPrs,
): Promise<Facts> {
  const markers = listMarkers(task.issue);
  const liveSpawn = readLiveSpawn(task.issue);
  const hasWorktree = worktreeExists(task.issue);

  const facts: Facts = {
    issue: task.issue,
    worktreeExists: hasWorktree,
    branchExists: false,
    markers,
    planMdExists: existsSync(planPath(task.issue)),
    artifacts: [],
    hasPushedCommits: false,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn,
    pr: { exists: false, number: null, url: null, state: null },
    checks: 'none',
    review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
  };

  // A merged PR is terminal: freeze the mission from the cached record and spend
  // no git or GraphQL calls re-learning a fact that can never change.
  if (task.prState === 'MERGED') {
    facts.branchExists = branches.has(task.branch);
    facts.pr = {
      exists: true,
      number: task.prNumber,
      url: task.prUrl,
      state: 'MERGED',
    };
    return facts;
  }

  const hasBranch = branches.has(task.branch);
  facts.branchExists = hasBranch;

  // An issue that was never started has nothing to query; don't spend calls
  // on it, and don't let network latency scale with board size.
  if (!hasBranch && !hasWorktree) return facts;

  // Active task, but the batched PR request failed this cycle: throw so the
  // poller's per-task catch holds this card at its last good place instead of
  // showing it as PR-less.
  if (!batch.ok) throw new Error(`branch PR batch unavailable for #${task.issue}`);

  const git = await gatherGitFacts(config, task.issue, task.branch);
  facts.dirtyFileCount = git.dirtyFileCount;
  facts.unpushedCommits = git.unpushedCommits;
  facts.hasPushedCommits = git.hasPushedCommits;

  // The PR, its checks, decision and threads come from the one batched call the
  // poller already made this cycle. A branch with no PR simply is not in the map.
  const branchPr = batch.byBranch.get(task.branch);
  if (branchPr) {
    facts.pr = branchPr.pr;
    facts.checks = branchPr.checks;
    facts.review = branchPr.review;
  }
  return facts;
}
