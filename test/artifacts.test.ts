import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execaSync } from 'execa';
import {
  parsePorcelainPaths,
  uniqueName,
  shouldCollectRun,
  COLLECT_GRACE_MS,
  resolveArtifactStoredPath,
  writeRunSnapshot,
  snapshotAgeMs,
  collectArtifacts,
  readArtifacts,
} from '../src/orchestrator/artifacts.ts';
import { taskDir, planPath, worktreePath, markerPath } from '../src/orchestrator/paths.ts';
import type { Config } from '../src/shared/types.ts';

describe('parsePorcelainPaths', () => {
  it('ignores deleted files even if a checkout recreates them before collection', () => {
    expect(parsePorcelainPaths(' D src/app.ts\nD  src/old.ts\n?? docs/design.md\n')).toEqual(['docs/design.md']);
  });
  it('extracts paths and resolves renames to their new name', () => {
    const out = ' M docs/spec.md\n?? docs/new.md\nR  a.md -> b.md\n';
    expect(parsePorcelainPaths(out)).toEqual(['docs/spec.md', 'docs/new.md', 'b.md']);
  });
});

describe('uniqueName', () => {
  it('suffixes before the extension on collision', () => {
    expect(uniqueName(['plan.md'], 'plan.md')).toBe('plan-1.md');
    expect(uniqueName(['plan.md', 'plan-1.md'], 'plan.md')).toBe('plan-2.md');
  });
});

describe('shouldCollectRun', () => {
  const base = { liveSpawn: null, doneMarker: false, snapshotAgeMs: COLLECT_GRACE_MS + 1 };

  it('collects once a run has ended and the grace period has passed', () => {
    expect(shouldCollectRun(base)).toBe(true);
  });

  it('collects immediately on the done marker, even while a process looks live', () => {
    expect(
      shouldCollectRun({ ...base, liveSpawn: { pid: 1 }, doneMarker: true, snapshotAgeMs: 0 }),
    ).toBe(true);
  });

  it('waits while a spawn is live with no done marker', () => {
    expect(shouldCollectRun({ ...base, liveSpawn: { pid: 1 } })).toBe(false);
  });

  it('never collects without a snapshot', () => {
    expect(shouldCollectRun({ ...base, snapshotAgeMs: null })).toBe(false);
    expect(shouldCollectRun({ ...base, snapshotAgeMs: null, doneMarker: true })).toBe(false);
  });

  it('waits out the grace period, so a spawn is never collected before its marker lands', () => {
    // The window between writing the snapshot and the terminal writing
    // <kind>.running: nothing is live yet, but the run has not started either.
    expect(shouldCollectRun({ ...base, snapshotAgeMs: 500 })).toBe(false);
  });
});

describe('resolveArtifactStoredPath', () => {
  let storeHome: string;

  beforeEach(() => {
    storeHome = mkdtempSync(join(tmpdir(), 'mc-store-'));
    process.env.MC_HOME = storeHome;
  });

  afterEach(() => {
    delete process.env.MC_HOME;
    rmSync(storeHome, { recursive: true, force: true });
  });

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
    writeRunSnapshot(config, ISSUE, 'plan');
    // Agent writes plan.md (task dir) + a design doc inside the checkout.
    writeFileSync(planPath(ISSUE), '# plan\n');
    writeFileSync(join(taskDir(ISSUE), 'spec.md'), '# spec\n');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'design.md'), '# design\n');

    const refs = await collectArtifacts(config, ISSUE, 'plan');
    const byName = Object.fromEntries(refs.map((r) => [r.name, r]));

    expect(byName['spec.md']!.origin).toBe('taskdir');
    expect(byName['design.md']!.origin).toBe('repo');
    // plan.md is the primary signal, surfaced elsewhere — not in the list.
    expect(byName['plan.md']).toBeUndefined();
    // Copies live under the task's own folder.
    expect(existsSync(join(taskDir(ISSUE), 'artifacts', 'design.md'))).toBe(true);
    expect(readArtifacts(ISSUE)).toHaveLength(refs.length);
  });

  it('keeps earlier artifacts when a later run collects', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'research.md'), '# research\n');
    await collectArtifacts(config, ISSUE, 'custom');

    writeRunSnapshot(config, ISSUE, 'plan');
    writeFileSync(join(taskDir(ISSUE), 'spec.md'), '# spec\n');
    await collectArtifacts(config, ISSUE, 'plan');

    expect(readArtifacts(ISSUE).map((r) => r.name).sort()).toEqual(['research.md', 'spec.md']);
    expect(existsSync(join(taskDir(ISSUE), 'artifacts', 'research.md'))).toBe(true);
  });

  it('starting a plan run no longer clears what earlier runs produced', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'research.md'), '# research\n');
    await collectArtifacts(config, ISSUE, 'custom');

    writeRunSnapshot(config, ISSUE, 'plan');

    expect(readArtifacts(ISSUE)).toHaveLength(1);
    expect(existsSync(join(taskDir(ISSUE), 'artifacts', 'research.md'))).toBe(true);
  });

  it('two runs claiming the same file produce one entry, not a suffixed duplicate', async () => {
    // Exactly the overlap the poller can hit: a custom run launched while a
    // plan run's output was still uncollected leaves both snapshots pending,
    // and both then see the same new file.
    writeRunSnapshot(config, ISSUE, 'plan');
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'design.md'), 'v1\n');

    await collectArtifacts(config, ISSUE, 'plan');
    await collectArtifacts(config, ISSUE, 'custom');

    expect(readArtifacts(ISSUE).map((r) => r.name)).toEqual(['design.md']);
  });

  it('two different originals sharing a basename both land, suffixed', async () => {
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeRunSnapshot(config, ISSUE, 'plan');
    writeFileSync(join(taskDir(ISSUE), 'notes.md'), 'a\n');
    writeFileSync(join(repo, 'docs', 'notes.md'), 'b\n');

    await collectArtifacts(config, ISSUE, 'plan');

    expect(readArtifacts(ISSUE).map((r) => r.name).sort()).toEqual(['notes-1.md', 'notes.md']);
  });

  it('signs off with the run kind, never with plan.done for a custom run', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'research.md'), 'x');
    await collectArtifacts(config, ISSUE, 'custom');

    expect(existsSync(markerPath(ISSUE, 'custom.done'))).toBe(true);
    // Writing plan.done here would satisfy the Plan gate and jump the card to
    // Implement because the operator ran a research prompt.
    expect(existsSync(markerPath(ISSUE, 'plan.done'))).toBe(false);
  });

  it('consumes the snapshot, so a finished run is never collected twice', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    expect(snapshotAgeMs(ISSUE, 'custom')).not.toBeNull();
    writeFileSync(join(taskDir(ISSUE), 'research.md'), 'x');
    await collectArtifacts(config, ISSUE, 'custom');
    expect(snapshotAgeMs(ISSUE, 'custom')).toBeNull();
  });

  it('does not mark an unsuccessful plan complete when collecting its leftovers', async () => {
    writeRunSnapshot(config, ISSUE, 'plan');
    await collectArtifacts(config, ISSUE, 'plan');
    expect(existsSync(markerPath(ISSUE, 'plan.done'))).toBe(false);
  });
});
