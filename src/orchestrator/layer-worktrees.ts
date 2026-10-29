import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { runGit } from './git.ts';
import type { Config, TaskRecord } from '../shared/types.ts';
import type { ExecutionTarget } from './execution-target.ts';
import { taskDir, worktreePath, worktreesDir } from './paths.ts';
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
  const git = async (args: string[], cwd = config.repo.path) => (await runGit(args, cwd)).stdout.trim();
  if (resolve(target.worktreePath) !== resolve(worktreePath(task.issue))) throw new Error('Stack layers must use the issue worktree');
  await git(['check-ref-format', '--branch', target.branch]);
  const exists = existsSync(target.worktreePath);
  let switching = false;
  if (exists) {
    const actual = await git(['symbolic-ref', '--short', 'HEAD'], target.worktreePath);
    const top = await git(['rev-parse', '--show-toplevel'], target.worktreePath);
    if (relative(realpathSync.native(top), realpathSync.native(target.worktreePath)) !== '') throw new Error('The selected directory is not a registered worktree');
    const expected = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const actualRepo = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], target.worktreePath);
    if (relative(realpathSync.native(expected), realpathSync.native(actualRepo)) !== '') throw new Error('The checkout belongs to a different repository');
    switching = actual !== target.branch;
    if (switching && await git(['status', '--porcelain', '--untracked-files=all'], target.worktreePath)) throw new Error('The issue worktree has uncommitted changes. Commit or stash them before switching PR layers');
    if (!switching && target.headSha) {
      try { await git(['merge-base', '--is-ancestor', target.headSha, 'HEAD'], target.worktreePath); }
      catch { throw new Error('The checkout does not include the last observed PR head. Sync this branch before launching'); }
    }
    if (!switching) return;
  }
  let local = false;
  try { await git(['show-ref', '--verify', `refs/heads/${target.branch}`]); local = true; } catch { /* Create from fetched head below. */ }
  // Existing local branches can be switched without any network request.
  if (!exists || !local) {
    await git(['fetch', 'origin', `+refs/heads/${target.branch}:refs/remotes/origin/${target.branch}`]);
    const remote = await git(['rev-parse', `refs/remotes/origin/${target.branch}`]);
    if (target.headSha && remote !== target.headSha) throw new Error('PR head changed since the last poll. Refresh before launching');
  }
  if (local && target.headSha) {
    try { await git(['merge-base', '--is-ancestor', target.headSha, `refs/heads/${target.branch}`]); }
    catch { throw new Error('The local branch does not include the PR head. Sync this branch before launching'); }
  }
  // Older installations created one checkout per PR. Release only our own clean
  // checkout's branch, keeping the directory and every file intact for the user.
  for (const entry of ownedLayerWorktrees(task.issue)) {
    if (entry.branch !== target.branch || !existsSync(entry.path)) continue;
    const actual = await git(['branch', '--show-current'], entry.path);
    if (actual !== target.branch) continue;
    const top = await git(['rev-parse', '--show-toplevel'], entry.path);
    const expected = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], entry.path);
    if (relative(realpathSync.native(top), realpathSync.native(entry.path)) !== '' || relative(realpathSync.native(expected), realpathSync.native(common)) !== '') throw new Error('Legacy checkout belongs to a different repository');
    if (await git(['status', '--porcelain', '--untracked-files=all'], entry.path)) throw new Error('The legacy PR worktree has uncommitted changes. Commit or stash them before using the shared issue checkout');
    await git(['switch', '--detach'], entry.path);
  }
  if (exists) {
    await git(local ? ['switch', '--no-overwrite-ignore', target.branch] : ['switch', '--no-overwrite-ignore', '-c', target.branch, `refs/remotes/origin/${target.branch}`], target.worktreePath);
    return;
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
