import { existsSync } from 'node:fs';
import { execa } from 'execa';

import { worktreePath, worktreesDir } from './paths.ts';
import type { Config } from '../shared/types.ts';

/**
 * Deterministic git work: worktrees, branches, and the raw facts the
 * reconciler needs. Nothing here requires judgement, so nothing here is ever
 * asked of an agent.
 */

// --- pure parsers --------------------------------------------------------

export function countPorcelainChanges(stdout: string): number {
  return stdout.split(/\r?\n/).filter((line) => line.trim() !== '').length;
}

export function parseCount(stdout: string): number {
  const value = Number.parseInt(stdout.trim(), 10);
  return Number.isNaN(value) ? 0 : value;
}

/** Branch names from `git branch -a`, with the origin/ prefix normalised away. */
export function parseRefs(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('->'))
    .map((line) => line.replace(/^origin\//, ''));
}

/**
 * Choose the branch a task should actually use.
 *
 * The generated slug is only a proposal. If a branch for this issue already
 * exists it wins, because the real name is what GitHub will match — and
 * GitHub's lookups are case-sensitive while Windows git refs are not, so a
 * casing difference is invisible locally but silently finds no PR.
 */
export function pickBranchForIssue(
  refs: string[],
  prefix: string,
  issue: number,
  generated: string,
): string {
  // The boundary after the number is what stops 3060 matching 30601.
  const pattern = new RegExp(`^${escapeRegex(prefix)}/${issue}[-/]`);
  const matches = [...new Set(refs.filter((ref) => pattern.test(ref)))];
  if (matches.length === 0) return generated;
  // Sorted so several candidates always resolve the same way.
  return matches.sort()[0]!;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- git calls -----------------------------------------------------------

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await execa('git', args, { cwd, reject: true });
    return { stdout, ok: true };
  } catch {
    return { stdout: '', ok: false };
  }
}

export async function listBranches(config: Config): Promise<string[]> {
  const result = await git(
    ['branch', '-a', '--format=%(refname:short)'],
    config.repo.path,
  );
  return parseRefs(result.stdout);
}

/**
 * Whether this exact branch name exists.
 *
 * Compared case-sensitively against the ref list rather than asking
 * `git show-ref`, because on Windows that check is case-insensitive and would
 * report a branch that GitHub will not match.
 */
export async function branchExists(
  config: Config,
  branch: string,
): Promise<boolean> {
  return (await listBranches(config)).includes(branch);
}

/** Resolve the real branch for an issue, falling back to the generated name. */
export async function resolveBranch(
  config: Config,
  issue: number,
  generated: string,
): Promise<string> {
  return pickBranchForIssue(
    await listBranches(config),
    config.repo.branchPrefix,
    issue,
    generated,
  );
}

export function worktreeExists(issue: number): boolean {
  return existsSync(worktreePath(issue));
}

export async function fetchBase(config: Config): Promise<void> {
  // Always cut from the latest dev; a stale base is a merge conflict later.
  await git(['fetch', 'origin', config.repo.baseBranch], config.repo.path);
}

/**
 * Create the task's isolated checkout if it is not already there.
 *
 * Reuses an existing branch when the task is being resumed, and only creates
 * a new one when cutting fresh from the base branch.
 */
export async function ensureWorktree(
  config: Config,
  issue: number,
  branch: string,
): Promise<{ path: string; created: boolean }> {
  const path = worktreePath(issue);
  if (worktreeExists(issue)) return { path, created: false };

  await fetchBase(config);

  const exists = await branchExists(config, branch);
  const args = exists
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, `origin/${config.repo.baseBranch}`];

  const result = await git(args, config.repo.path);
  if (!result.ok) {
    throw new Error(
      `Failed to create worktree for issue ${issue} at ${path}. Run \`git worktree list\` in ${config.repo.path} to inspect.`,
    );
  }
  return { path, created: !exists };
}

export async function removeWorktree(
  config: Config,
  issue: number,
): Promise<void> {
  await git(
    ['worktree', 'remove', worktreePath(issue), '--force'],
    config.repo.path,
  );
  await git(['worktree', 'prune'], config.repo.path);
}

export interface GitFacts {
  dirtyFileCount: number;
  unpushedCommits: number;
  hasPushedCommits: boolean;
}

export async function gatherGitFacts(
  config: Config,
  issue: number,
  branch: string,
): Promise<GitFacts> {
  const empty: GitFacts = {
    dirtyFileCount: 0,
    unpushedCommits: 0,
    hasPushedCommits: false,
  };
  if (!worktreeExists(issue)) {
    // No local checkout, but the branch may still be pushed from elsewhere.
    const pushed = await git(
      [
        'rev-list',
        '--count',
        `origin/${config.repo.baseBranch}..origin/${branch}`,
      ],
      config.repo.path,
    );
    return { ...empty, hasPushedCommits: parseCount(pushed.stdout) > 0 };
  }

  const path = worktreePath(issue);
  const [status, ahead, pushed] = await Promise.all([
    git(['status', '--porcelain'], path),
    git(['rev-list', '--count', `origin/${branch}..HEAD`], path),
    git(
      ['rev-list', '--count', `origin/${config.repo.baseBranch}..origin/${branch}`],
      path,
    ),
  ]);

  return {
    dirtyFileCount: countPorcelainChanges(status.stdout),
    // If origin/<branch> does not exist the range fails; everything local is
    // then unpushed, which the base-branch range reports instead.
    unpushedCommits: ahead.ok
      ? parseCount(ahead.stdout)
      : parseCount(
          (
            await git(
              ['rev-list', '--count', `origin/${config.repo.baseBranch}..HEAD`],
              path,
            )
          ).stdout,
        ),
    hasPushedCommits: pushed.ok && parseCount(pushed.stdout) > 0,
  };
}

export function worktreesRoot(): string {
  return worktreesDir();
}
