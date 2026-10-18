import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import { createReviewWorktrees } from '../src/orchestrator/review-worktrees.ts';
import type { Config } from '../src/shared/types.ts';

let root: string;
let home: string;
let repo: string;
let head: string;
let config: Config;
const pr = { number: 42, title: 'Update widgets', url: 'https://github.com/acme/widgets/pull/42', author: 'alice', updatedAt: '2026-10-07T08:00:00Z' };
const git = async (...args: string[]) => (await execa('git', args, { cwd: repo })).stdout;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mc-review-'));
  repo = join(root, 'widgets');
  mkdirSync(repo);
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'alice');
  await git('config', 'user.email', 'alice@example.com');
  writeFileSync(join(repo, 'widgets.txt'), 'base');
  writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n');
  await git('add', '.');
  await git('commit', '-m', 'Base');
  await git('checkout', '-b', 'alice/widgets');
  writeFileSync(join(repo, 'widgets.txt'), 'pull request');
  await git('commit', '-am', 'Update widgets');
  head = await git('rev-parse', 'HEAD');
  await git('update-ref', 'refs/pull/42/head', head);
  await git('checkout', 'main');
  // A local origin with GitHub's pull refs keeps these tests offline.
  await git('remote', 'add', 'origin', repo);
  config = {
    repo: { path: repo, owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice' },
    github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
    agents: {}, pipeline: [], server: { port: 4317 },
  };
});

beforeEach(() => {
  home = mkdtempSync(join(root, 'project-'));
  process.env.MC_HOME = home;
});

afterEach(async () => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
  await git('worktree', 'prune');
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('opens the PR head detached even when its branch is in another worktree, and reuses local changes', async () => {
  const issueTree = join(home, 'issue-checkout');
  await git('worktree', 'add', issueTree, 'alice/widgets');
  let workspace = '';
  const reviews = createReviewWorktrees(config, { open: async path => { workspace = path; } });
  const opened = await reviews.open(pr);
  expect(await execa('git', ['rev-parse', 'HEAD'], { cwd: opened.workspacePath }).then(r => r.stdout)).toBe(head);
  expect(await execa('git', ['branch', '--show-current'], { cwd: opened.workspacePath }).then(r => r.stdout)).toBe('');
  const editor = JSON.parse(readFileSync(workspace, 'utf8'));
  expect(editor.folders).toEqual([{ path: opened.workspacePath }]);
  expect(editor.settings['window.title']).toContain('Review PR #42');
  writeFileSync(join(opened.workspacePath, 'widgets.txt'), 'local review edit');
  // Git canonicalizes Windows drive casing, while the configured home may not.
  process.env.MC_HOME = home.replace(/^[A-Z]:/, drive => drive.toLowerCase());
  await reviews.open(pr);
  // Windows temporary roots may also be aliases for the physical directory.
  const alias = join(root, 'project-alias');
  symlinkSync(home, alias, 'junction');
  process.env.MC_HOME = alias;
  await reviews.open(pr);
  expect(readFileSync(join(opened.workspacePath, 'widgets.txt'), 'utf8')).toBe('local review edit');
  expect(createReviewWorktrees(config).list()).toMatchObject([{ number: 42, worktreeExists: true }]);
  expect(readFileSync(join(issueTree, 'widgets.txt'), 'utf8')).toBe('pull request');
});

test('finish rescues edits, notes and ignored config, removes only the review tree, and retains a recovery bundle for local commits', async () => {
  const reviews = createReviewWorktrees(config, { open: async () => {} });
  const opened = await reviews.open(pr);
  const issueTree = join(home, 'worktrees', 'issue-42');
  mkdirSync(issueTree);
  writeFileSync(join(issueTree, 'keep.txt'), 'issue work');
  writeFileSync(join(opened.workspacePath, 'widgets.txt'), 'committed review edit');
  await execa('git', ['commit', '-am', 'Review edit'], { cwd: opened.workspacePath });
  writeFileSync(join(opened.workspacePath, 'widgets.txt'), 'uncommitted edit');
  writeFileSync(join(opened.workspacePath, 'notes.txt'), 'review notes');
  writeFileSync(join(opened.workspacePath, '.env'), 'local config');
  mkdirSync(join(opened.workspacePath, 'node_modules'));
  writeFileSync(join(opened.workspacePath, 'node_modules', 'disposable.txt'), 'dependency');
  const finished = await reviews.finish(42);
  expect(existsSync(opened.workspacePath)).toBe(false);
  expect(reviews.list()).toEqual([]);
  expect(readFileSync(join(finished.rescuePath, 'widgets.txt'), 'utf8')).toBe('uncommitted edit');
  expect(readFileSync(join(finished.rescuePath, 'notes.txt'), 'utf8')).toBe('review notes');
  expect(readFileSync(join(finished.rescuePath, '.env'), 'utf8')).toBe('local config');
  expect(existsSync(join(finished.rescuePath, 'disposable.txt'))).toBe(false);
  expect(await git('bundle', 'list-heads', join(finished.rescuePath, 'commits.bundle'))).toContain('HEAD');
  expect(readFileSync(join(issueTree, 'keep.txt'), 'utf8')).toBe('issue work');
  expect(await git('worktree', 'list', '--porcelain')).not.toContain(opened.workspacePath.replaceAll('\\', '/'));
});

test('a failed removal keeps the review discoverable across restart and cleanup can be retried', async () => {
  const reviews = createReviewWorktrees(config, { open: async () => {}, remove: async () => { throw new Error('held open'); } });
  const opened = await reviews.open(pr);
  writeFileSync(join(opened.workspacePath, 'notes.txt'), 'keep these notes');
  await expect(reviews.finish(42)).rejects.toThrow('held open');
  const restarted = createReviewWorktrees(config, { open: async () => {} });
  expect(restarted.list()).toMatchObject([{ number: 42, worktreeExists: true }]);
  const finished = await restarted.finish(42);
  expect(readFileSync(join(finished.rescuePath, 'notes.txt'), 'utf8')).toBe('keep these notes');
  expect(restarted.list()).toEqual([]);
});

test('retries a deregistered review using its rescue receipt even when the broken .git file remains', async () => {
  const reviews = createReviewWorktrees(config, {
    open: async () => {},
    remove: async (_config, number) => {
      const path = join(home, 'worktrees', `review-pr-${number}`);
      const marker = readFileSync(join(path, '.git'), 'utf8');
      await git('worktree', 'remove', '--force', path);
      mkdirSync(path);
      writeFileSync(join(path, '.git'), marker);
      writeFileSync(join(path, 'late-notes.txt'), 'notes left in a locked folder');
      throw new Error('held open');
    },
  });
  const opened = await reviews.open(pr);
  writeFileSync(join(opened.workspacePath, 'notes.txt'), 'saved before deregistration');
  await expect(reviews.finish(42)).rejects.toThrow('held open');
  const finished = await createReviewWorktrees(config).finish(42);
  expect(readFileSync(join(finished.rescuePath, 'notes.txt'), 'utf8')).toBe('saved before deregistration');
  expect(readFileSync(join(finished.rescuePath, 'late-notes.txt'), 'utf8')).toBe('notes left in a locked folder');
  expect(existsSync(opened.workspacePath)).toBe(false);
});

test('a later review of the same PR preserves the earlier local commit bundle', async () => {
  // Seed an earlier rescue directly. The full first-review lifecycle is already
  // covered above; this case exercises preserving it during the next finish.
  const rescuePath = join(home, 'reviews', 'pr-42', 'rescued-from-worktree');
  mkdirSync(rescuePath, { recursive: true });
  const bundle = join(rescuePath, 'commits.bundle');
  await git('bundle', 'create', bundle, 'HEAD');
  const firstHead = await git('rev-parse', 'HEAD');
  const reviews = createReviewWorktrees(config, { open: async () => {} });
  const opened = await reviews.open(pr);
  writeFileSync(join(opened.workspacePath, 'widgets.txt'), 'second review commit');
  await execa('git', ['commit', '-am', 'Second review'], { cwd: opened.workspacePath });
  const secondHead = (await execa('git', ['rev-parse', 'HEAD'], { cwd: opened.workspacePath })).stdout;
  await reviews.finish(42);
  expect(await git('bundle', 'list-heads', bundle)).toContain(firstHead);
  expect(await git('bundle', 'list-heads', join(rescuePath, 'commits-2.bundle'))).toContain(secondHead);
});

test('refuses to adopt or remove an unrelated directory and rejects invalid PR numbers', async () => {
  const foreign = join(home, 'worktrees', 'review-pr-42');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, 'keep.txt'), 'unrelated work');
  const reviews = createReviewWorktrees(config, { open: async () => {} });
  await expect(reviews.open(pr)).rejects.toThrow(/unmanaged/i);
  await expect(reviews.finish(42)).rejects.toThrow(/no.*review/i);
  await expect(reviews.open({ ...pr, number: -1 })).rejects.toThrow(/PR number/i);
  await expect(reviews.finish(0)).rejects.toThrow(/PR number/i);
  expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('unrelated work');
});

test('fetch failure creates no checkout and a missing checkout can be recreated from its saved review', async () => {
  const reviews = createReviewWorktrees(config, { open: async () => {} });
  await expect(reviews.open({ ...pr, number: 404 })).rejects.toThrow();
  expect(reviews.list()).toEqual([]);
  const opened = await reviews.open(pr);
  await git('worktree', 'remove', opened.workspacePath);
  expect(reviews.list()).toMatchObject([{ number: 42, worktreeExists: false }]);
  await reviews.open(pr);
  expect(readFileSync(join(opened.workspacePath, 'widgets.txt'), 'utf8')).toBe('pull request');
});

test('simultaneous opens serialize creation and share one checkout', async () => {
  const reviews = createReviewWorktrees(config, { open: async () => {} });
  const [first, second] = await Promise.allSettled([reviews.open(pr), reviews.open(pr)]);
  expect([first.status, second.status]).toEqual(['fulfilled', 'fulfilled']);
  if (first.status !== 'fulfilled' || second.status !== 'fulfilled') return;
  expect(first.value.workspacePath).toBe(second.value.workspacePath);
  expect(reviews.list()).toMatchObject([{ number: 42, worktreeExists: true }]);
  expect(reviews.list()).toHaveLength(1);
});
