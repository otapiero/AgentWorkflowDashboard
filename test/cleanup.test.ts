import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  parseRescuePaths,
  cleanupDoneTask,
  rescueDir,
  rescueFiles,
} from '../src/orchestrator/cleanup.ts';
import { worktreePath } from '../src/orchestrator/paths.ts';
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

describe('parseRescuePaths', () => {
  test('reads the path out of each porcelain line, whatever the status code', () => {
    const out = ['?? notes.md', ' M src/app.ts', 'A  added.txt', 'MM both.ts'].join('\n');
    expect(parseRescuePaths(out)).toEqual(['notes.md', 'src/app.ts', 'added.txt', 'both.ts']);
  });

  test('unquotes a path git had to quote for spaces or specials', () => {
    // git quotes paths containing spaces or non-ASCII; the leading '?? ' is
    // followed by the quoted name, which must be unwrapped before use.
    const out = '?? "backend/# xAPI and Ministry LRS research.md"';
    expect(parseRescuePaths(out)).toEqual(['backend/# xAPI and Ministry LRS research.md']);
  });

  test('ignores blank lines rather than yielding empty paths', () => {
    expect(parseRescuePaths('?? a.txt\n\n  \n?? b.txt\n')).toEqual(['a.txt', 'b.txt']);
  });

  test('takes the destination of a rename, not the arrow form', () => {
    // A staged rename reads "R  old -> new"; the file on disk is the new one.
    expect(parseRescuePaths('R  old/name.ts -> new/name.ts')).toEqual(['new/name.ts']);
  });
});

describe('rescuing files off a worktree', () => {
  test('manual completion rescues nested untracked files and removes the git worktree', async () => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    const git = (args: string[]) => execa('git', args, { cwd: repo });
    await git(['init']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
    const worktree = worktreePath(3259);
    await git(['worktree', 'add', '-b', 'issue-3259', worktree]);
    mkdirSync(join(worktree, 'notes'));
    writeFileSync(join(worktree, 'notes', 'research.md'), 'keep this research');
    writeFileSync(join(worktree, '.gitignore'), '.env\nnode_modules/\n');
    writeFileSync(join(worktree, '.env'), 'LOCAL_SETTING=keep');
    const cfg = config({ deleteBranch: false });
    cfg.repo.path = repo;

    await cleanupDoneTask(cfg, 3259, 'issue-3259');

    expect(existsSync(worktree)).toBe(false);
    expect((await git(['worktree', 'list', '--porcelain'])).stdout).not.toContain('issue-3259');
    expect(readFileSync(join(rescueDir(3259), 'research.md'), 'utf8')).toBe('keep this research');
    expect(readFileSync(join(rescueDir(3259), '.env'), 'utf8')).toBe('LOCAL_SETTING=keep');
  });

  test('NUL status preserves arrows and whitespace and skips rename source records', () => {
    expect(parseRescuePaths('?? notes -> final.md\0??  spaced.md\0R  renamed.md\0old.md\0'))
      .toEqual(['notes -> final.md', ' spaced.md', 'renamed.md']);
  });

  test('retries removal of a deregistered folder only after a recorded rescue', async () => {
    const worktree = worktreePath(3259);
    mkdirSync(worktree, { recursive: true });
    mkdirSync(rescueDir(3259), { recursive: true });
    writeFileSync(join(rescueDir(3259), 'notes.md'), 'rescued before removal');
    writeFileSync(join(worktree, '.git'), 'gitdir: missing-registration');
    writeFileSync(join(worktree, 'notes.md'), 'saved after failed cleanup');
    writeFileSync(join(worktree, 'scratch.md'), 'new research');
    writeFileSync(join(home, 'tasks', '3259', 'worktree-cleanup.json'), JSON.stringify({
      worktree, branch: 'issue-3259', rescued: ['notes.md'],
    }));
    await cleanupDoneTask(config({ deleteBranch: false }), 3259, 'issue-3259');
    expect(existsSync(worktree)).toBe(false);
    expect(readFileSync(join(rescueDir(3259), 'notes.md'), 'utf8')).toBe('rescued before removal');
    expect(readFileSync(join(rescueDir(3259), 'notes-2.md'), 'utf8')).toBe('saved after failed cleanup');
    expect(readFileSync(join(rescueDir(3259), 'scratch.md'), 'utf8')).toBe('new research');
  });

  test('an unreadable git status keeps the worktree for retry', async () => {
    const worktree = worktreePath(3259);
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'notes.md'), 'keep');
    await expect(cleanupDoneTask(config(), 3259, 'issue-3259')).rejects.toThrow(/inspect/i);
    expect(readFileSync(join(worktree, 'notes.md'), 'utf8')).toBe('keep');
  });

  test('copies each reported file into the task directory, flattened', () => {
    const worktree = join(home, 'wt');
    mkdirSync(join(worktree, 'backend'), { recursive: true });
    writeFileSync(join(worktree, 'backend', 'notes.md'), 'research', 'utf8');
    writeFileSync(join(worktree, 'top.json'), '{}', 'utf8');

    const rescued = rescueFiles(3259, worktree, ['backend/notes.md', 'top.json']);

    expect(rescued).toEqual(['backend/notes.md', 'top.json']);
    expect(readFileSync(join(rescueDir(3259), 'notes.md'), 'utf8')).toBe('research');
    expect(existsSync(join(rescueDir(3259), 'top.json'))).toBe(true);
  });

  test('two files sharing a basename both survive, suffixed', () => {
    const worktree = join(home, 'wt');
    mkdirSync(join(worktree, 'a'), { recursive: true });
    mkdirSync(join(worktree, 'b'), { recursive: true });
    writeFileSync(join(worktree, 'a', 'notes.md'), 'from a', 'utf8');
    writeFileSync(join(worktree, 'b', 'notes.md'), 'from b', 'utf8');

    rescueFiles(3259, worktree, ['a/notes.md', 'b/notes.md']);

    expect(readFileSync(join(rescueDir(3259), 'notes.md'), 'utf8')).toBe('from a');
    expect(readFileSync(join(rescueDir(3259), 'notes-2.md'), 'utf8')).toBe('from b');
  });

  test('a path that has since vanished is skipped rather than throwing', () => {
    const worktree = join(home, 'wt');
    mkdirSync(worktree, { recursive: true });
    expect(rescueFiles(3259, worktree, ['gone.md'])).toEqual([]);
  });

  test('nothing to rescue creates no directory', () => {
    const worktree = join(home, 'wt');
    mkdirSync(worktree, { recursive: true });
    expect(rescueFiles(3259, worktree, [])).toEqual([]);
    expect(existsSync(rescueDir(3259))).toBe(false);
  });
});
