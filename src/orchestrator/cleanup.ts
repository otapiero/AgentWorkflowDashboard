import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { execa } from 'execa';

import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
import { taskDir, worktreePath } from './paths.ts';
import { removeWorktree } from './worktree.ts';
import type { Config, Phase } from '../shared/types.ts';

/**
 * Retiring a finished task's checkout.
 *
 * A merged PR means the work has landed, so its worktree is dead weight — but
 * "dead weight" is not the same as "safe to delete". A worktree routinely
 * accumulates files that were never committed: scratch notes, exported
 * fixtures, research an agent wrote beside the code. `git worktree remove
 * --force` destroys those without a word.
 *
 * So the order here is rescue, then remove. Anything git still reports as
 * uncommitted is copied into the task's own directory — the same place the doc
 * rail reads from — before the checkout goes. Nothing that was never in git
 * is ever lost to an automatic action.
 */

/** Where rescued files land, alongside the task's other durable artifacts. */
export function rescueDir(issue: number): string {
  return join(taskDir(issue), 'rescued-from-worktree');
}

/**
 * The paths out of `git status --porcelain`.
 *
 * The status code is deliberately ignored: modified, added, untracked and
 * renamed all mean the same thing here — a file on disk that git is not
 * carrying, which the removal would take with it.
 */
export function parseRescuePaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    // Two status columns then a space; everything after is the path.
    let path = line.slice(3).trim();
    if (path === '') continue;
    // A rename reads "old -> new"; the file on disk is the new one.
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    // git quotes paths with spaces or non-ASCII bytes.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    paths.push(path);
  }
  return paths;
}

/**
 * Copy the named files out of the worktree, flattened into one directory.
 *
 * Flattened because the rescue is a keepsake, not a checkout — a nested tree
 * of one file each is worse to read than a flat list. Basename collisions are
 * suffixed rather than overwritten; two files called notes.md are two files.
 */
export function rescueFiles(
  issue: number,
  worktree: string,
  paths: readonly string[],
): string[] {
  const rescued: string[] = [];
  const used = new Set<string>();

  for (const relative of paths) {
    const source = join(worktree, relative);
    // Deleted-but-unstaged files are reported by git and are already gone.
    if (!existsSync(source)) continue;

    const name = basename(relative);
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;

    let target = name;
    for (let n = 2; used.has(target); n += 1) target = `${stem}-${n}${ext}`;
    used.add(target);

    // Created lazily so a clean worktree leaves no empty directory behind.
    mkdirSync(rescueDir(issue), { recursive: true });
    copyFileSync(source, join(rescueDir(issue), target));
    rescued.push(relative);
  }

  return rescued;
}

/**
 * Should this reconcile retire the task's checkout?
 *
 * Absent config counts as on: every config written before this existed has no
 * cleanup block, and those installs should still get the behaviour.
 */
export function shouldCleanupOnDone(
  config: Config,
  derivedPhase: Phase,
  worktreeExists: boolean,
): boolean {
  if (derivedPhase !== 'done') return false;
  if (!worktreeExists) return false;
  return config.cleanup?.onDone ?? true;
}

export interface CleanupResult {
  issue: number;
  rescued: string[];
  branchDeleted: boolean;
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await execa('git', args, {
      cwd,
      reject: true,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return { stdout, ok: true };
  } catch {
    return { stdout: '', ok: false };
  }
}

/**
 * Rescue, remove the worktree, then drop the local branch.
 *
 * The branch is force-deleted because these repositories squash-merge: the
 * branch's own commits never appear in the base branch, so `git branch -d`
 * refuses every merged branch it is ever handed. GitHub reporting the PR as
 * MERGED is the authority that the work landed, and that is what got us here.
 */
export async function cleanupDoneTask(
  config: Config,
  issue: number,
  branch: string,
): Promise<CleanupResult> {
  const worktree = worktreePath(issue);

  const status = await git(['status', '--porcelain'], worktree);
  const rescued = status.ok
    ? rescueFiles(issue, worktree, parseRescuePaths(status.stdout))
    : [];

  await removeWorktree(config, issue);

  let branchDeleted = false;
  if (config.cleanup?.deleteBranch ?? true) {
    const result = await git(['branch', '-D', branch], config.repo.path);
    branchDeleted = result.ok;
  }

  return { issue, rescued, branchDeleted };
}
