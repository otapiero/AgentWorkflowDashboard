import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import type { Config, TaskRecord } from '../shared/types.ts';
import type { ExecutionTarget } from './execution-target.ts';
import { taskDir, worktreesDir } from './paths.ts';
import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
import { rescueAndRemoveWorktree } from './cleanup.ts';
import { removeLayerWorktree } from './worktree.ts';

interface OwnedLayer { path: string; branch: string; number: number }
const manifest = (issue: number) => join(taskDir(issue), 'layer-worktrees.json');
export function ownedLayerWorktrees(issue: number): OwnedLayer[] {
  if (!existsSync(manifest(issue))) return [];
  const entries: OwnedLayer[] = JSON.parse(readFileSync(manifest(issue), 'utf8'));
  if (!Array.isArray(entries) || entries.some(p => !Number.isSafeInteger(p.number) || p.number <= 0 ||
    resolve(p.path) !== resolve(join(worktreesDir(), `${issue}-pr-${p.number}`)) || typeof p.branch !== 'string')) throw new Error('Invalid layer worktree ownership manifest');
  return entries;
}

export async function ensureLayerWorktree(config: Config, task: TaskRecord, target: ExecutionTarget): Promise<void> {
  const git = async (args: string[], cwd = config.repo.path) => (await execa('git', args, { cwd, timeout: SUBPROCESS_TIMEOUT_MS })).stdout.trim();
  await git(['check-ref-format', '--branch', target.branch]);
  if (existsSync(target.worktreePath)) {
    const actual = await git(['symbolic-ref', '--short', 'HEAD'], target.worktreePath);
    if (actual !== target.branch) throw new Error(`Checkout branch is ${actual}, expected ${target.branch}. No files changed`);
    const top = await git(['rev-parse', '--show-toplevel'], target.worktreePath);
    if (relative(realpathSync.native(top), realpathSync.native(target.worktreePath)) !== '') throw new Error('The selected directory is not a registered worktree');
    const expected = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const actualRepo = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], target.worktreePath);
    if (relative(realpathSync.native(expected), realpathSync.native(actualRepo)) !== '') throw new Error('The checkout belongs to a different repository');
    if (target.prNumber && target.worktreePath.endsWith(`${task.issue}-pr-${target.prNumber}`) && !ownedLayerWorktrees(task.issue).some(p => resolve(p.path) === resolve(target.worktreePath) && p.branch === target.branch)) throw new Error('Refusing to adopt a layer checkout without an ownership manifest');
    if (target.headSha) {
      try { await git(['merge-base', '--is-ancestor', target.headSha, 'HEAD'], target.worktreePath); }
      catch { throw new Error('The checkout does not include the last observed PR head. Sync this branch before launching'); }
    }
    return;
  }
  // Fetch the PR branch, never create it from the repository base by accident.
  await git(['fetch', 'origin', `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`]);
  const remote = await git(['rev-parse', `refs/remotes/origin/${target.branch}`]);
  if (target.headSha && remote !== target.headSha) throw new Error('PR head changed since the last poll. Refresh before launching');
  let local = false;
  try { await git(['show-ref', '--verify', `refs/heads/${target.branch}`]); local = true; } catch { /* Create from fetched head below. */ }
  if (local && target.headSha) {
    try { await git(['merge-base', '--is-ancestor', target.headSha, `refs/heads/${target.branch}`]); }
    catch { throw new Error('The local branch does not include the PR head. Sync this branch before launching'); }
  }
  const entries = ownedLayerWorktrees(task.issue);
  const isLayerPath = dirname(resolve(target.worktreePath)) === resolve(worktreesDir()) && target.worktreePath.endsWith(`${task.issue}-pr-${target.prNumber}`);
  if (isLayerPath && !entries.some(p => p.path === target.worktreePath)) {
    entries.push({ path: target.worktreePath, branch: target.branch, number: target.prNumber! });
    mkdirSync(taskDir(task.issue), { recursive: true });
    writeFileSync(manifest(task.issue), JSON.stringify(entries), 'utf8');
  }
  mkdirSync(dirname(target.worktreePath), { recursive: true });
  await git(local ? ['worktree', 'add', target.worktreePath, target.branch]
    : ['worktree', 'add', '-b', target.branch, target.worktreePath, `refs/remotes/origin/${target.branch}`]);
}

export async function cleanupLayerWorktrees(config: Config, issue: number): Promise<void> {
  for (const entry of ownedLayerWorktrees(issue)) {
    if (!existsSync(entry.path)) continue;
    await rescueAndRemoveWorktree(entry.path, join(taskDir(issue), `pr-${entry.number}`), entry.branch,
      () => removeLayerWorktree(config, issue, entry.number));
  }
}
