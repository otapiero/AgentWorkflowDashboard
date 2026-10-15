import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { ensureLayerWorktree, cleanupLayerWorktrees } from '../src/orchestrator/layer-worktrees.ts';
import { newTask } from '../src/orchestrator/state.ts';
import { taskDir, worktreePath, worktreesDir } from '../src/orchestrator/paths.ts';
import type { Config } from '../src/shared/types.ts';
import type { ExecutionTarget } from '../src/orchestrator/execution-target.ts';
import { cancelPendingLaunch, withIssueLaunch } from '../src/orchestrator/launch-lock.ts';
import { writePromptFile } from '../src/orchestrator/prompt.ts';
import { writeSpec } from '../src/orchestrator/spawn/spec.ts';
import { gatherGitFacts } from '../src/orchestrator/worktree.ts';
let root: string; let repo: string; let config: Config; let target: ExecutionTarget;
const git = async (...args: string[]) => (await execa('git', args, { cwd: repo })).stdout.trim();
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mc-layer-')); repo = join(root, 'widgets');
  mkdirSync(repo); process.env.MC_HOME = join(root, 'project');
  await git('init', '--initial-branch=main');
  await git('config', 'user.email', 'alice@example.com'); await git('config', 'user.name', 'alice');
  writeFileSync(join(repo, 'file.txt'), 'main'); await git('add', '.'); await git('commit', '-m', 'Initial');
  const remote = join(root, 'remote.git'); await git('init', '--bare', remote); await git('remote', 'add', 'origin', remote);
  await git('checkout', '-b', 'alice/child'); writeFileSync(join(repo, 'file.txt'), 'child'); await git('commit', '-am', 'Child');
  await git('push', 'origin', 'alice/child'); const sha = await git('rev-parse', 'HEAD'); await git('checkout', 'main');
  config = { repo: { path: repo, owner: 'acme', name: 'widgets', baseBranch: 'main' } } as Config;
  target = { branch: 'alice/child', baseBranch: 'alice/parent', layerKey: 'github.com/acme/widgets/11', prNumber: 11, headSha: sha, worktreePath: worktreePath(1) };
});
afterEach(async () => { delete process.env.MC_HOME; rmSync(root, { recursive: true, force: true }); });

test('rescues legacy layer checkouts created before shared issue worktrees', async () => {
  const legacy = join(worktreesDir(), '1-pr-11');
  mkdirSync(worktreesDir(), { recursive: true });
  await git('worktree', 'add', legacy, target.branch);
  mkdirSync(taskDir(1), { recursive: true });
  writeFileSync(join(taskDir(1), 'layer-worktrees.json'), JSON.stringify([{ path: legacy, branch: target.branch, number: 11 }]));
  writeFileSync(join(legacy, 'notes.txt'), 'Keep this');
  await cleanupLayerWorktrees(config, 1);
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(join(taskDir(1), 'pr-11', 'rescued-from-worktree', 'notes.txt'), 'utf8')).toBe('Keep this');
});

test.each([false, true])('legacy upgrade preserves files and refuses dirty checkouts: dirty=%s', async dirty => {
  const legacy = join(worktreesDir(), '1-pr-11');
  mkdirSync(worktreesDir(), { recursive: true });
  await git('worktree', 'add', legacy, target.branch);
  mkdirSync(taskDir(1), { recursive: true });
  writeFileSync(join(taskDir(1), 'layer-worktrees.json'), JSON.stringify([{ path: legacy, branch: target.branch, number: 11 }]));
  if (dirty) {
    writeFileSync(join(legacy, 'notes.txt'), 'Keep this');
    await expect(ensureLayerWorktree(config, newTask(1, 'Feature', 'alice'), target)).rejects.toThrow('uncommitted');
    expect((await execa('git', ['branch', '--show-current'], { cwd: legacy })).stdout).toBe(target.branch);
    expect(readFileSync(join(legacy, 'notes.txt'), 'utf8')).toBe('Keep this');
    return;
  }
  await ensureLayerWorktree(config, newTask(1, 'Feature', 'alice'), target);
  expect(readFileSync(join(target.worktreePath, 'file.txt'), 'utf8')).toBe('child');
  expect(readFileSync(join(legacy, 'file.txt'), 'utf8')).toBe('child');
  expect((await execa('git', ['branch', '--show-current'], { cwd: legacy })).stdout).toBe('');
});

test('reports unpushed commits against the branch currently checked out in the shared folder', async () => {
  await ensureLayerWorktree(config, newTask(1, 'Feature', 'alice'), target);
  await execa('git', ['commit', '--allow-empty', '-m', 'Local change'], { cwd: target.worktreePath });
  const facts = await gatherGitFacts(config, 1, 'alice/parent');
  expect(facts.unpushedCommits).toBe(1);
});
test('refuses wrong-branch and occupied-branch checkouts instead of switching them', async () => {
  mkdirSync(worktreesDir(), { recursive: true });
  await git('worktree', 'add', '--detach', target.worktreePath, 'main');
  await expect(ensureLayerWorktree(config, newTask(1, 'Feature', 'alice'), target)).rejects.toThrow();
  await git('worktree', 'remove', target.worktreePath);
  await git('worktree', 'add', join(root, 'other-checkout'), 'alice/child');
  await expect(ensureLayerWorktree(config, newTask(1, 'Feature', 'alice'), target)).rejects.toThrow();
  expect(existsSync(target.worktreePath)).toBe(false);
});

test('an existing local branch behind the PR head is rejected before creating a checkout', async () => {
  const parent = await git('rev-parse', 'main');
  await git('branch', '-f', 'alice/child', parent);
  await expect(ensureLayerWorktree(config, newTask(1, 'Feature', 'alice'), target)).rejects.toThrow('local branch does not include');
  expect(existsSync(target.worktreePath)).toBe(false);
});

test('switches a clean issue checkout between stack branches without creating another worktree', async () => {
  target.worktreePath = worktreePath(1);
  const task = newTask(1, 'Feature', 'alice');
  await ensureLayerWorktree(config, task, target);
  await git('branch', 'alice/parent', 'main');
  const parent = { ...target, branch: 'alice/parent', headSha: await git('rev-parse', 'main'), prNumber: 10 };
  await ensureLayerWorktree(config, task, parent);
  expect(readFileSync(join(target.worktreePath, 'file.txt'), 'utf8')).toBe('main');
  await ensureLayerWorktree(config, task, target);
  expect(readFileSync(join(target.worktreePath, 'file.txt'), 'utf8')).toBe('child');
  expect((await git('worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(2);
});

test('preserves dirty files and the current branch when a different stack layer is requested', async () => {
  target.worktreePath = worktreePath(1);
  const task = newTask(1, 'Feature', 'alice');
  await ensureLayerWorktree(config, task, target);
  writeFileSync(join(target.worktreePath, 'notes.txt'), 'Keep this');
  await git('branch', 'alice/parent', 'main');
  await expect(ensureLayerWorktree(config, task, { ...target, branch: 'alice/parent', headSha: await git('rev-parse', 'main') })).rejects.toThrow('uncommitted');
  expect(readFileSync(join(target.worktreePath, 'notes.txt'), 'utf8')).toBe('Keep this');
  expect((await execa('git', ['branch', '--show-current'], { cwd: target.worktreePath })).stdout).toBe('alice/child');
});

test('a cancelled delayed PowerShell launch cannot consume a newer run', async () => {
  const task = newTask(1, 'Feature', 'alice');
  await ensureLayerWorktree(config, task, target);
  let token = '';
  await withIssueLaunch(task, async value => { token = value; });
  const sentinel = join(root, 'agent-started.txt');
  const spec = { issue: 1, phase: 'implement' as const, launchToken: token, branch: target.branch,
    worktree: target.worktreePath, baseBranch: target.baseBranch, repoPath: repo, mcHome: process.env.MC_HOME!,
    promptFile: writePromptFile(1, 'Inspect this layer', token), exe: 'pwsh', promptToken: '__MC_PROMPT__',
    args: ['-NoProfile', '-Command', `Set-Content -LiteralPath '${sentinel}' -Value started`] };
  const specFile = writeSpec(spec);
  cancelPendingLaunch(1);
  let nextToken = '';
  await withIssueLaunch(task, async value => { nextToken = value; });
  const result = await execa('pwsh', ['-NoProfile', '-File', resolve('assets/scripts/run-phase.ps1'), '-SpecFile', specFile], { reject: false });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('This launch was cancelled');
  expect(existsSync(sentinel)).toBe(false);
  const nextSpec = writeSpec({ ...spec, launchToken: nextToken, promptFile: writePromptFile(1, 'New run', nextToken) });
  const next = await execa('pwsh', ['-NoProfile', '-File', resolve('assets/scripts/run-phase.ps1'), '-SpecFile', nextSpec], { reject: false });
  expect(next.stderr).toBe('');
  expect(next.exitCode).toBe(0);
  expect(existsSync(sentinel)).toBe(true);
});
