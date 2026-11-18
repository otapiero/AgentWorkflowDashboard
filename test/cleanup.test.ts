import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  parseRescuePaths,
  cleanupDoneTask,
  rescueAndRemoveWorktree,
} from '../src/orchestrator/cleanup.ts';
import { taskDir, worktreePath } from '../src/orchestrator/paths.ts';
import type { Config } from '../src/shared/types.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-cleanup-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

function config(over: Partial<Config['cleanup']> = {}): Config {
  return {
    repo: {
      path: 'C:\\src\\widgets',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
      branchPrefix: 'alice',
    },
    github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
    agents: {},
    pipeline: [],
    server: { port: 4317 },
    cleanup: { onDone: true, deleteBranch: true, ...over },
  } as unknown as Config;
}

test('NUL status preserves arrows and whitespace and skips rename source records', () => {
  expect(parseRescuePaths('?? notes -> final.md\0??  spaced.md\0R  renamed.md\0old.md\0'))
    .toEqual(['notes -> final.md', ' spaced.md', 'renamed.md']);
});

async function repoWithWorktree(issue: number) {
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (args: string[]) => execa('git', args, { cwd: repo });
  await git(['init']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
  const worktree = worktreePath(issue);
  await git(['worktree', 'add', '-b', `issue-${issue}`, worktree]);
  return { repo, git, worktree };
}

describe('marking a task done', () => {
  test('removes a dirty worktree and its branch without copying anything out', async () => {
    const { repo, git, worktree } = await repoWithWorktree(3259);
    mkdirSync(join(worktree, 'notes'));
    writeFileSync(join(worktree, 'notes', 'research.md'), 'scratch');
    writeFileSync(join(worktree, '.gitignore'), '.env\n');
    writeFileSync(join(worktree, '.env'), 'LOCAL_SETTING=x');
    const cfg = config();
    cfg.repo.path = repo;

    expect(await cleanupDoneTask(cfg, 3259, 'issue-3259')).toEqual({ issue: 3259, branchDeleted: true });

    expect(existsSync(worktree)).toBe(false);
    expect((await git(['worktree', 'list', '--porcelain'])).stdout).not.toContain('issue-3259');
    expect((await git(['branch', '--list', 'issue-3259'])).stdout).toBe('');
    expect(existsSync(join(taskDir(3259), 'rescued-from-worktree'))).toBe(false);
  });
});

describe('rescuing a review checkout', () => {
  test('flattens rescued files and suffixes basename collisions', async () => {
    const { worktree } = await repoWithWorktree(3259);
    mkdirSync(join(worktree, 'a'));
    mkdirSync(join(worktree, 'b'));
    writeFileSync(join(worktree, 'a', 'notes.md'), 'from a');
    writeFileSync(join(worktree, 'b', 'notes.md'), 'from b');
    const directory = join(home, 'review');

    const rescued = await rescueAndRemoveWorktree(worktree, directory, 'issue-3259', async () => {});

    expect(rescued.sort()).toEqual(['a/notes.md', 'b/notes.md']);
    const saved = [readFileSync(join(directory, 'rescued-from-worktree', 'notes.md'), 'utf8'),
      readFileSync(join(directory, 'rescued-from-worktree', 'notes-2.md'), 'utf8')];
    expect(saved.sort()).toEqual(['from a', 'from b']);
  });

  test('an unreadable git status keeps the checkout for retry', async () => {
    const worktree = join(home, 'not-a-checkout');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'notes.md'), 'keep');
    let removed = false;
    await expect(rescueAndRemoveWorktree(worktree, join(home, 'review'), 'x', async () => { removed = true; }))
      .rejects.toThrow(/inspect/i);
    expect(removed).toBe(false);
  });
});
