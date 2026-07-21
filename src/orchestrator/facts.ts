import { existsSync } from 'node:fs';

import { planPath } from './paths.ts';
import { listMarkers, readLiveSpawn } from './markers.ts';
import {
  fetchChecks,
  fetchPrForBranch,
  fetchReviewDecision,
  fetchReviewThreads,
} from './github.ts';
import { branchExists, gatherGitFacts, worktreeExists } from './worktree.ts';
import type { Config, Facts, TaskRecord } from '../shared/types.ts';

/**
 * Gather every durable fact about a task, fresh.
 *
 * This is the only place that performs I/O for reconciliation; the reconciler
 * itself stays pure. Nothing here is remembered between calls — that is what
 * makes closing or crashing the app harmless.
 */
export async function gatherFacts(
  config: Config,
  task: TaskRecord,
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
    hasPushedCommits: false,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn,
    pr: { exists: false, number: null, url: null, state: null },
    checks: 'none',
    review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
  };

  const hasBranch = await branchExists(config, task.branch);
  facts.branchExists = hasBranch;

  // An issue that was never started has nothing to query; don't spend calls
  // on it, and don't let network latency scale with board size.
  if (!hasBranch && !hasWorktree) return facts;

  const git = await gatherGitFacts(config, task.issue, task.branch);
  facts.dirtyFileCount = git.dirtyFileCount;
  facts.unpushedCommits = git.unpushedCommits;
  facts.hasPushedCommits = git.hasPushedCommits;

  const pr = await fetchPrForBranch(config, task.branch);
  if (!pr) return facts;

  facts.pr = { exists: true, number: pr.number, url: pr.url, state: pr.state };

  // A merged or closed PR has no live gates worth polling.
  if (pr.state !== 'OPEN') return facts;

  const [checks, decision, threads] = await Promise.all([
    fetchChecks(config, pr.number),
    fetchReviewDecision(config, pr.number),
    fetchReviewThreads(config, pr.number),
  ]);

  facts.checks = checks;
  facts.review = { decision, ...threads };
  return facts;
}
