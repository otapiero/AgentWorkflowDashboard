import { existsSync } from 'node:fs';

import { planPath } from './paths.ts';
import { readArtifacts } from './artifacts.ts';
import { listMarkers, readLiveSpawn } from './markers.ts';
import type { BatchedIssuePrs } from './github.ts';
import { gatherGitFacts, worktreeExists } from './worktree.ts';
import { latestThreadId, toT3Fact } from './t3/facts.ts';
import type { T3Snapshot } from './t3/schemas.ts';
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
  batch: BatchedIssuePrs,
  /**
   * The orchestration snapshot for this cycle, fetched once by the poller.
   * Absent means T3 is unavailable, which is a normal state.
   */
  t3Snapshot?: T3Snapshot,
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
    implementationStarted: task.spawnHistory.some(run => run.phase !== 'plan' && run.phase !== 'custom' && run.phase !== 'inbox'),
    artifacts: readArtifacts(task.issue),
    hasPushedCommits: false,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn,
    t3: toT3Fact(t3Snapshot, latestThreadId(task)),
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

  // A task whose attached PR facts did not come back this cycle: throw so the poller's
  // per-task catch holds this card at its last good place instead of showing it
  // as PR-less. Issues whose aliases answered are unaffected.
  if (!batch.ok || batch.unavailable.has(task.issue)) {
    throw new Error(`attached PR facts unavailable for #${task.issue}`);
  }

  const issuePr = batch.byIssue.get(task.issue);
  if (issuePr) {
    facts.pr = issuePr.pr;
    facts.checks = issuePr.checks;
    facts.review = issuePr.review;
  }

  if (!hasBranch && !hasWorktree) return facts;

  const git = await gatherGitFacts(config, task.issue, task.branch);
  facts.dirtyFileCount = git.dirtyFileCount;
  facts.unpushedCommits = git.unpushedCommits;
  facts.hasPushedCommits = git.hasPushedCommits;

  return facts;
}
