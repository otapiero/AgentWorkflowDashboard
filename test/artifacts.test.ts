import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execaSync } from 'execa';
import {
  parsePorcelainPaths,
  diffFiles,
  uniqueName,
  shouldCollectPlan,
  resolveArtifactStoredPath,
  writePlanSnapshot,
  collectArtifacts,
  readArtifacts,
} from '../src/orchestrator/artifacts.ts';
import { taskDir, planPath, worktreePath } from '../src/orchestrator/paths.ts';
import type { Config } from '../src/shared/types.ts';

describe('parsePorcelainPaths', () => {
  it('extracts paths and resolves renames to their new name', () => {
    const out = ' M docs/spec.md\n?? docs/new.md\nR  a.md -> b.md\n';
    expect(parsePorcelainPaths(out)).toEqual(['docs/spec.md', 'docs/new.md', 'b.md']);
  });
  it('returns [] for empty output', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });
});

describe('diffFiles', () => {
  it('returns entries present in after but not before', () => {
    expect(diffFiles(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });
});

describe('uniqueName', () => {
  it('keeps the base when free', () => {
    expect(uniqueName([], 'plan.md')).toBe('plan.md');
  });
  it('suffixes before the extension on collision', () => {
    expect(uniqueName(['plan.md'], 'plan.md')).toBe('plan-1.md');
    expect(uniqueName(['plan.md', 'plan-1.md'], 'plan.md')).toBe('plan-2.md');
  });
});

describe('shouldCollectPlan', () => {
  const base = { liveSpawn: null, planMdExists: true, planDoneMarker: false, manifestExists: false };
  it('collects when the plan spawn has ended and produced a plan', () => {
    expect(shouldCollectPlan(base)).toBe(true);
  });
  it('collects on the done marker even if a process still looks live', () => {
    expect(shouldCollectPlan({ ...base, liveSpawn: { pid: 1 }, planDoneMarker: true })).toBe(true);
  });
  it('never collects once a manifest exists', () => {
    expect(shouldCollectPlan({ ...base, manifestExists: true })).toBe(false);
  });
  it('waits while a spawn is live with no done marker', () => {
    expect(shouldCollectPlan({ ...base, liveSpawn: { pid: 1 } })).toBe(false);
  });
});

describe('resolveArtifactStoredPath', () => {
  const refs = [
    { name: 'design.md', storedPath: 'artifacts/design.md', origin: 'repo' as const, originalPath: 'x' },
  ];
  it('resolves a known artifact under the task dir', () => {
    const p = resolveArtifactStoredPath(7, 'design.md', refs);
    expect(p).toMatch(/[\\/]7[\\/]artifacts[\\/]design\.md$/);
  });
  it('returns null for a name not in the manifest (blocks traversal)', () => {
    expect(resolveArtifactStoredPath(7, '../../secret', refs)).toBeNull();
  });
});

describe('snapshot + collectArtifacts', () => {
  let home: string;
  let repo: string;
  const ISSUE = 4242;
  const config = { repo: { path: '' } } as unknown as Config;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mc-home-'));
    process.env.MC_HOME = home;
    // The plan run works in the task's worktree; make it a real git repo with a
    // committed base so only later additions are attributed to the run.
    repo = worktreePath(ISSUE);
    mkdirSync(repo, { recursive: true });
    execaSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), 'base\n');
    execaSync('git', ['add', '.'], { cwd: repo });
    execaSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'],
      { cwd: repo },
    );
    mkdirSync(taskDir(ISSUE), { recursive: true });
  });

  afterEach(() => {
    delete process.env.MC_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('captures task-dir and repo-origin artifacts, tagging origin', async () => {
    writePlanSnapshot(config, ISSUE);
    // Agent writes plan.md (task dir) + a design doc inside the checkout.
    writeFileSync(planPath(ISSUE), '# plan\n');
    writeFileSync(join(taskDir(ISSUE), 'spec.md'), '# spec\n');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'design.md'), '# design\n');

    const refs = await collectArtifacts(config, ISSUE);
    const byName = Object.fromEntries(refs.map((r) => [r.name, r]));

    expect(byName['spec.md']!.origin).toBe('taskdir');
    expect(byName['design.md']!.origin).toBe('repo');
    // plan.md is the primary signal, surfaced elsewhere — not in the list.
    expect(byName['plan.md']).toBeUndefined();
    // Copies live under the task's own folder.
    expect(existsSync(join(taskDir(ISSUE), 'artifacts', 'design.md'))).toBe(true);
    expect(readArtifacts(ISSUE)).toHaveLength(refs.length);
  });

  it('is idempotent and a re-snapshot clears the prior manifest', async () => {
    writePlanSnapshot(config, ISSUE);
    writeFileSync(join(taskDir(ISSUE), 'spec.md'), 'x');
    await collectArtifacts(config, ISSUE);
    await collectArtifacts(config, ISSUE);
    expect(readArtifacts(ISSUE)).toHaveLength(1);

    writePlanSnapshot(config, ISSUE); // a new run
    expect(existsSync(join(taskDir(ISSUE), 'artifacts.json'))).toBe(false);
  });
});
