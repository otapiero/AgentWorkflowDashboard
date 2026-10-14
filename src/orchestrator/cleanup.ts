import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  if (stdout.includes('\0')) {
    const records = stdout.split('\0');
    const paths: string[] = [];
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]!;
      if (!record) continue;
      paths.push(record.slice(3));
      if (/^[RC]|^.[RC]/.test(record)) i += 1;
    }
    return paths;
  }
  const paths: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    // Two status columns then a space; everything after is the path.
    let path = line.slice(3).trim();
    if (path === '') continue;
    // A rename reads "old -> new"; the file on disk is the new one.
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1 && /^[RC]|^.[RC]/.test(line)) path = path.slice(arrow + 4);
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
  return rescueFilesTo(rescueDir(issue), worktree, paths);
}

function rescueFilesTo(destination: string, worktree: string, paths: readonly string[]): string[] {
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
    for (let n = 2; used.has(target) || existsSync(join(destination, target)); n += 1) target = `${stem}-${n}${ext}`;
    used.add(target);

    // Created lazily so a clean worktree leaves no empty directory behind.
    mkdirSync(destination, { recursive: true });
    copyFileSync(source, join(destination, target));
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

/** A deregistered checkout cannot answer git status. Save its remaining files. */
function orphanFiles(worktree: string, relative = ''): string[] {
  return readdirSync(join(worktree, relative), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const path = join(relative, entry.name);
    if (entry.isDirectory()) return orphanFiles(worktree, path);
    return entry.isFile() ? [path] : [];
  });
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
  const rescued = await rescueAndRemoveWorktree(
    worktreePath(issue), taskDir(issue), branch, () => removeWorktree(config, issue),
  );

  let branchDeleted = false;
  if (config.cleanup?.deleteBranch ?? true) {
    const result = await git(['branch', '-D', branch], config.repo.path);
    branchDeleted = result.ok;
  }

  return { issue, rescued, branchDeleted };
}

/** Shared rescue and retry receipt for issue and review checkouts. */
export async function rescueAndRemoveWorktree(
  worktree: string,
  directory: string,
  branch: string,
  remove: () => Promise<void>,
): Promise<string[]> {
  const destination = join(directory, 'rescued-from-worktree');
  const receiptPath = join(directory, 'worktree-cleanup.json');
  let previous: { worktree: string; branch: string; rescued: string[] } | null = null;
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (receipt.worktree === worktree && receipt.branch === branch &&
        Array.isArray(receipt.rescued) && receipt.rescued.every((p: unknown) => typeof p === 'string')) {
      previous = receipt;
    }
  } catch { /* No completed rescue from an earlier attempt. */ }

  // List individual untracked files, not directory entries that copyFile
  // cannot rescue. Leave the checkout intact if git cannot inspect it.
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], worktree);
  let rescued: string[];
  if (status.ok) {
    const ignored = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], worktree);
    if (!ignored.ok) throw new Error('Could not inspect ignored files; no files were removed');
    // Installed dependencies are disposable. Keep ignored local config and
    // notes, including .env, alongside the normal uncommitted-file rescue.
    const ignoredPaths = ignored.stdout.split('\0').filter((p) => p && !p.split('/').includes('node_modules'));
    rescued = rescueFilesTo(destination, worktree, [...new Set([...parseRescuePaths(status.stdout), ...ignoredPaths])]);
    mkdirSync(directory, { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({ worktree, branch, rescued }), 'utf8');
  } else if (previous) {
    // Windows may have deregistered the checkout before a locked folder
    // prevented deletion. Its saved rescue lets that deletion be retried.
    rescued = [...previous.rescued, ...rescueFilesTo(destination, worktree, orphanFiles(worktree))];
  } else {
    throw new Error('Could not inspect the worktree; no files were removed');
  }

  await remove();
  rmSync(receiptPath, { force: true });

  return rescued;
}
