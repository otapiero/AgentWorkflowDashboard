import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLegacyHome } from '../src/orchestrator/migrate.ts';
import { activeProjectSlug, mcRoot, projectHome, projectSlug } from '../src/orchestrator/paths.ts';

let root: string;
let legacy: string;

const CONFIG = `
repo:
  path: 'C:\\src\\widgets'
  owner: 'acme'
  name: 'widgets'
  baseBranch: 'main'
  branchPrefix: 'alice'
github:
  auth: gh-cli
  pollIntervalSeconds: 30
  copilotReviewerLogin: 'copilot-pull-request-reviewer'
agents:
  claude:
    launch: 'claude'
    promptMode: positional
    instructionMode: flag
    instructionFlag: '--append-system-prompt'
pipeline:
  - id: plan
    label: Plan
    actor: claude
    command: mc-planner
    gate: { type: manual }
server:
  port: 4317
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-mig-root-'));
  legacy = mkdtempSync(join(tmpdir(), 'mc-mig-legacy-'));
  process.env.MC_ROOT = root;
  process.env.MC_LEGACY_HOME = legacy;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;

  writeFileSync(join(legacy, 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(join(legacy, 'state.json'), '{"tasks":[]}', 'utf8');
  mkdirSync(join(legacy, 'tasks', '3060', 'markers'), { recursive: true });
  writeFileSync(join(legacy, 'tasks', '3060', 'plan.md'), '# plan', 'utf8');
  mkdirSync(join(legacy, 'worktrees', 'issue-3060'), { recursive: true });
  mkdirSync(join(legacy, 'scripts'), { recursive: true });
  writeFileSync(join(legacy, 'scripts', 'run-phase.ps1'), '# script', 'utf8');
  writeFileSync(join(legacy, 't3-token.json'), '{"access_token":"x"}', 'utf8');
});

afterEach(() => {
  delete process.env.MC_ROOT;
  delete process.env.MC_LEGACY_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
});

const noop = () => {};

describe('migrateLegacyHome', () => {
  test('moves the install under projects/<slug> and makes it active', () => {
    const result = migrateLegacyHome({ repairWorktrees: noop });
    expect(result.slug).toBe(projectSlug('acme', 'widgets'));
    expect(result.to).toBe(projectHome(result.slug));
    expect(activeProjectSlug()).toBe(result.slug);
  });

  test('carries task artifacts across intact', () => {
    const result = migrateLegacyHome({ repairWorktrees: noop });
    expect(readFileSync(join(result.to, 'tasks', '3060', 'plan.md'), 'utf8')).toBe('# plan');
    expect(existsSync(join(result.to, 'tasks', '3060', 'markers'))).toBe(true);
  });

  test('lifts the shared files to the install root', () => {
    // Scripts and the T3 token belong to the machine, not to one repository.
    const result = migrateLegacyHome({ repairWorktrees: noop });
    expect(existsSync(join(mcRoot(), 'scripts', 'run-phase.ps1'))).toBe(true);
    expect(existsSync(join(mcRoot(), 't3-token.json'))).toBe(true);
    expect(existsSync(join(result.to, 't3-token.json'))).toBe(false);
    expect(result.sharedFiles).toContain('t3-token.json');
  });

  test('the legacy directory is gone afterwards', () => {
    const result = migrateLegacyHome({ repairWorktrees: noop });
    expect(existsSync(result.from)).toBe(false);
  });

  test('refuses when the destination project already exists', () => {
    migrateLegacyHome({ repairWorktrees: noop });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.yaml'), CONFIG, 'utf8');
    expect(() => migrateLegacyHome({ repairWorktrees: noop })).toThrow(/already/i);
  });

  test('says so plainly when there is nothing to migrate', () => {
    rmSync(legacy, { recursive: true, force: true });
    expect(() => migrateLegacyHome({ repairWorktrees: noop })).toThrow(/nothing to migrate/i);
  });

  test('re-points git at the worktrees the move relocated', () => {
    // A worktree is registered by absolute path, in the main repo and in the
    // worktree itself. Moving the directory breaks both, and git then reports
    // the worktree as prunable - one prune away from losing unmerged work.
    const calls: Array<{ repoPath: string; worktrees: string[] }> = [];
    const result = migrateLegacyHome({
      repairWorktrees: (repoPath, worktrees) => calls.push({ repoPath, worktrees }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.repoPath).toBe('C:\\src\\widgets');
    expect(calls[0]!.worktrees).toEqual([join(result.to, 'worktrees', 'issue-3060')]);
    expect(result.repairedWorktrees).toHaveLength(1);
  });

  test('an install with no worktrees still repairs cleanly', () => {
    rmSync(join(legacy, 'worktrees'), { recursive: true, force: true });
    const calls: string[][] = [];
    const result = migrateLegacyHome({
      repairWorktrees: (_repo, worktrees) => calls.push(worktrees),
    });
    expect(calls).toEqual([[]]);
    expect(result.repairedWorktrees).toEqual([]);
  });

  test('a shared file already at the root is renamed aside, never dropped', () => {
    // Regression: the first cut deleted the incoming file when the destination
    // existed, which threw away a real 30-day T3 token in favour of a stale
    // one. The install being migrated is authoritative.
    mkdirSync(mcRoot(), { recursive: true });
    writeFileSync(join(mcRoot(), 't3-token.json'), '{"accessToken":"stale"}', 'utf8');

    const result = migrateLegacyHome({ repairWorktrees: noop });

    expect(JSON.parse(readFileSync(join(mcRoot(), 't3-token.json'), 'utf8')).access_token).toBe('x');
    expect(result.displaced).toContain('t3-token.json');
    const asideNames = readdirSync(mcRoot()).filter((n) => n.includes('.replaced-'));
    expect(asideNames).toHaveLength(1);
    expect(readFileSync(join(mcRoot(), asideNames[0]!), 'utf8')).toContain('stale');
  });

  test('the legacy directory is only removed when it is genuinely empty', () => {
    const result = migrateLegacyHome({ repairWorktrees: noop });
    expect(result.skippedWorktrees).toEqual([]);
    expect(result.legacyRemains).toBe(false);
    expect(existsSync(result.from)).toBe(false);
  });

  test('a worktree that cannot be moved is reported, and the rest still land', () => {
    // On Windows a rename fails if anything holds a handle inside the tree,
    // and a worktree is exactly what an editor or dev server keeps open. One
    // watcher must not block the whole migration.
    mkdirSync(join(legacy, 'worktrees', 'issue-9999'), { recursive: true });
    writeFileSync(join(legacy, 'worktrees', 'issue-9999', 'file.txt'), 'x', 'utf8');

    const result = migrateLegacyHome({
      repairWorktrees: noop,
      renameEntry: (from, to) => {
        if (from.endsWith('issue-9999')) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        renameSync(from, to);
      },
    });

    expect(result.skippedWorktrees).toEqual(['issue-9999']);
    expect(result.legacyRemains).toBe(true);
    // The rest of the install still arrived.
    expect(existsSync(join(result.to, 'config.yaml'))).toBe(true);
    expect(existsSync(join(result.to, 'tasks', '3060', 'plan.md'))).toBe(true);
    expect(existsSync(join(result.to, 'worktrees', 'issue-3060'))).toBe(true);
    // And the stuck one is still where it was, not lost.
    expect(existsSync(join(legacy, 'worktrees', 'issue-9999', 'file.txt'))).toBe(true);
  });

  test('only the worktrees that actually moved are handed to git repair', () => {
    mkdirSync(join(legacy, 'worktrees', 'issue-9999'), { recursive: true });

    const calls: string[][] = [];
    migrateLegacyHome({
      repairWorktrees: (_repo, worktrees) => calls.push(worktrees),
      renameEntry: (from, to) => {
        if (from.endsWith('issue-9999')) throw new Error('EPERM');
        renameSync(from, to);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.some((w) => w.endsWith('issue-9999'))).toBe(false);
    expect(calls[0]!.some((w) => w.endsWith('issue-3060'))).toBe(true);
  });
});
