import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execa, execaSync } from 'execa';

import {
  artifactsDir,
  artifactsManifestPath,
  markerPath,
  planSnapshotPath,
  taskDir,
  worktreePath,
} from './paths.ts';
import { worktreeExists } from './worktree.ts';
import { writeMarker } from './markers.ts';
import type { ArtifactRef, Config, PlanSnapshot } from '../shared/types.ts';

/**
 * Plan artifact capture.
 *
 * Capture is a filesystem diff, never a parse of any planning tool's output, so
 * it is agnostic to superpowers / spec-kit / freehand. This file holds the pure
 * core (parsing, diffing, naming, decision) plus, below, the fs routines that
 * snapshot and collect. Nothing here is remembered — artifacts are recomputed
 * from disk, matching the reconciler's crash-safe philosophy.
 */

/** Paths from `git status --porcelain`; a rename resolves to its new name. */
export function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const rest = line.slice(3); // strip the two status chars + separator
      const arrow = rest.indexOf(' -> ');
      return (arrow === -1 ? rest : rest.slice(arrow + 4)).trim();
    });
}

/** Entries present in `after` but not `before`. */
export function diffFiles(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((p) => !seen.has(p));
}

/** A name not already in `existing`, suffixed `-1`, `-2`, … before the ext. */
export function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? '' : base.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * Whether the poller should collect a plan run's artifacts now. Collect once a
 * run is finished (or the agent signalled done), and never twice — a manifest
 * already on disk is the "already collected" sentinel.
 *
 * A snapshot must exist: it is the baseline written at plan spawn, and only a
 * real plan run has one. Without it, auto-collection would diff against nothing
 * and sweep an entire dirty worktree into the manifest — so a task that predates
 * this feature, or is deep in implementation, is correctly left alone. (The
 * explicit `collect` CLI bypasses this guard and degrades gracefully instead.)
 */
export function shouldCollectPlan(i: {
  liveSpawn: unknown;
  planMdExists: boolean;
  planDoneMarker: boolean;
  manifestExists: boolean;
  snapshotExists: boolean;
}): boolean {
  if (i.manifestExists || !i.snapshotExists) return false;
  return i.planDoneMarker || (!i.liveSpawn && i.planMdExists);
}

/** The absolute stored copy for an artifact named `name`, or null if unknown. */
export function resolveArtifactStoredPath(
  issue: number,
  name: string,
  refs: ArtifactRef[],
): string | null {
  const ref = refs.find((r) => r.name === name);
  return ref ? join(taskDir(issue), ref.storedPath) : null;
}

// --- filesystem routines -------------------------------------------------

// Task-dir entries that are MC's own bookkeeping, never artifacts. plan.md is
// excluded too: it is the primary signal with its own drawer surface.
const RESERVED = new Set([
  'markers',
  'prompt.txt',
  'plan.md',
  'plan.snapshot.json',
  'artifacts',
  'artifacts.json',
  'spawn.json',
]);

function isReserved(name: string): boolean {
  return RESERVED.has(name) || name.endsWith('.code-workspace');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !isReserved(n));
  } catch {
    return [];
  }
}

// `--untracked-files=all` is essential: without it git collapses an untracked
// directory to `docs/`, hiding the individual `docs/design.md` we must capture.
const STATUS_ARGS = ['status', '--porcelain', '--untracked-files=all'];

/** `git status` paths in a worktree; [] if git fails or is absent. */
function gitStatusPathsSync(cwd: string): string[] {
  try {
    const { stdout } = execaSync('git', STATUS_ARGS, { cwd });
    return parsePorcelainPaths(stdout);
  } catch {
    return [];
  }
}

async function gitStatusPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa('git', STATUS_ARGS, { cwd });
    return parsePorcelainPaths(stdout);
  } catch {
    return [];
  }
}

/**
 * Capture the "before" picture, and clear any prior run's collected state so a
 * re-spawn re-collects. Fully synchronous: a fresh worktree has no status yet
 * (empty is the correct "before"), and doing the git read inline keeps the
 * snapshot deterministic rather than racing a background write.
 */
export function writePlanSnapshot(config: Config, issue: number): void {
  rmSync(artifactsManifestPath(issue), { force: true });
  rmSync(artifactsDir(issue), { recursive: true, force: true });
  rmSync(markerPath(issue, 'plan.done'), { force: true });

  const snapshot: PlanSnapshot = {
    takenAt: new Date().toISOString(),
    taskDirFiles: listDir(taskDir(issue)),
    repoStatus: worktreeExists(issue) ? gitStatusPathsSync(worktreePath(issue)) : [],
    extraRoots: {},
  };
  for (const root of config.repo.artifactRoots ?? []) {
    snapshot.extraRoots[root] = listDir(root);
  }
  mkdirSync(taskDir(issue), { recursive: true });
  writeFileSync(planSnapshotPath(issue), JSON.stringify(snapshot, null, 2), 'utf8');
}

function readSnapshot(issue: number): PlanSnapshot {
  try {
    return JSON.parse(readFileSync(planSnapshotPath(issue), 'utf8')) as PlanSnapshot;
  } catch {
    return { takenAt: '', taskDirFiles: [], repoStatus: [], extraRoots: {} };
  }
}

/** Diff the roots against the snapshot, copy new files in, write the manifest. */
export async function collectArtifacts(
  config: Config,
  issue: number,
  trigger: 'command' | 'auto' = 'auto',
): Promise<ArtifactRef[]> {
  const snap = readSnapshot(issue);
  const dir = taskDir(issue);
  const store = artifactsDir(issue);
  mkdirSync(store, { recursive: true });

  const found: Array<{ origin: 'taskdir' | 'repo'; abs: string; base: string }> = [];

  for (const name of diffFiles(snap.taskDirFiles, listDir(dir))) {
    found.push({ origin: 'taskdir', abs: join(dir, name), base: name });
  }
  if (worktreeExists(issue)) {
    const wt = worktreePath(issue);
    for (const rel of diffFiles(snap.repoStatus, await gitStatusPaths(wt))) {
      found.push({ origin: 'repo', abs: join(wt, rel), base: rel.split('/').pop()! });
    }
  }
  for (const root of config.repo.artifactRoots ?? []) {
    for (const name of diffFiles(snap.extraRoots[root] ?? [], listDir(root))) {
      found.push({ origin: 'repo', abs: join(root, name), base: name });
    }
  }

  const refs: ArtifactRef[] = [];
  const taken: string[] = [];
  for (const f of found) {
    if (!existsSync(f.abs)) continue; // vanished between snapshot and now
    const name = uniqueName(taken, f.base);
    taken.push(name);
    try {
      copyFileSync(f.abs, join(store, name));
    } catch {
      continue; // locked/failed copy: record the rest
    }
    refs.push({ name, storedPath: `artifacts/${name}`, origin: f.origin, originalPath: f.abs });
  }

  writeFileSync(
    artifactsManifestPath(issue),
    JSON.stringify({ collectedAt: new Date().toISOString(), trigger, artifacts: refs }, null, 2),
    'utf8',
  );
  writeMarker(issue, 'plan.done'); // mkdirs the markers dir as needed
  return refs;
}

/** The manifest's artifacts, or [] when none has been written. */
export function readArtifacts(issue: number): ArtifactRef[] {
  try {
    const m = JSON.parse(readFileSync(artifactsManifestPath(issue), 'utf8')) as {
      artifacts?: ArtifactRef[];
    };
    return m.artifacts ?? [];
  } catch {
    return [];
  }
}
