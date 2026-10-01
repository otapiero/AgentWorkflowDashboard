import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execa, execaSync } from 'execa';

import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
import {
  artifactsDir,
  artifactsManifestPath,
  markerPath,
  planPath,
  runSnapshotPath,
  taskDir,
  worktreePath,
} from './paths.ts';
import { worktreeExists } from './worktree.ts';
import { writeMarker } from './markers.ts';
import type { ArtifactRef, Config, PlanSnapshot, RunKind } from '../shared/types.ts';

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
    .filter((line) => line.trim() !== '' && !line.slice(0, 2).includes('D'))
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
 * How long after a run's snapshot the poller waits before concluding, from the
 * absence of a live process, that the run has finished.
 *
 * A spawn writes its snapshot immediately but its `<kind>.running` marker only
 * once the terminal has started (~1.5s; see the delay in routes.ts). Without
 * this floor the very next poll would find no live spawn, collect nothing,
 * consume the snapshot, and lose everything the run went on to produce.
 * The done marker bypasses it, so a run that signs off is collected at once.
 */
export const COLLECT_GRACE_MS = 90_000;

/**
 * Whether the poller should collect this run's artifacts now.
 *
 * The snapshot is the sentinel in both directions: no snapshot means either
 * nothing is pending or it has already been collected, and collecting consumes
 * it. That single rule replaces the old manifest check, which stopped working
 * once manifests began outliving the run that wrote them.
 *
 * A snapshot must exist for another reason too: it is the baseline, and without
 * one auto-collection would diff against nothing and sweep an entire dirty
 * worktree into the manifest. (The explicit `collect` CLI bypasses this guard
 * and degrades gracefully instead.)
 */
export function shouldCollectRun(i: {
  liveSpawn: unknown;
  doneMarker: boolean;
  snapshotAgeMs: number | null;
}): boolean {
  if (i.snapshotAgeMs === null) return false;
  if (i.doneMarker) return true;
  if (i.liveSpawn) return false;
  return i.snapshotAgeMs > COLLECT_GRACE_MS;
}

/** Age of a run's pending snapshot, or null when there is none. */
export function snapshotAgeMs(issue: number, kind: RunKind): number | null {
  try {
    return Date.now() - statSync(runSnapshotPath(issue, kind)).mtimeMs;
  } catch {
    return null;
  }
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
  'artifacts',
  'artifacts.json',
  'spawn.json',
]);

function isReserved(name: string): boolean {
  // Every run kind has its own snapshot, so match the suffix rather than
  // listing them — a new kind must never be collectable as its own artifact.
  return (
    RESERVED.has(name) ||
    name.endsWith('.snapshot.json') ||
    name.endsWith('.code-workspace')
  );
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
    const { stdout } = execaSync('git', STATUS_ARGS, {
      cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return parsePorcelainPaths(stdout);
  } catch {
    return [];
  }
}

async function gitStatusPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa('git', STATUS_ARGS, {
      cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return parsePorcelainPaths(stdout);
  } catch {
    return [];
  }
}

/**
 * Capture the "before" picture for a run. Fully synchronous: a fresh worktree
 * has no status yet (empty is the correct "before"), and doing the git read
 * inline keeps the snapshot deterministic rather than racing a background write.
 *
 * Note what is *not* here: no artifact is cleared. A run's output has to
 * survive every later run, including a re-plan, so the only thing reset is the
 * run's own sign-off marker — without that, a stale one from the previous run
 * would make the next poll collect before the agent had done anything.
 */
export function writeRunSnapshot(config: Config, issue: number, kind: RunKind): void {
  rmSync(markerPath(issue, `${kind}.done`), { force: true });

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
  writeFileSync(runSnapshotPath(issue, kind), JSON.stringify(snapshot, null, 2), 'utf8');
}

function readSnapshot(issue: number, kind: RunKind): PlanSnapshot {
  try {
    return JSON.parse(readFileSync(runSnapshotPath(issue, kind), 'utf8')) as PlanSnapshot;
  } catch {
    return { takenAt: '', taskDirFiles: [], repoStatus: [], extraRoots: {} };
  }
}

/**
 * Diff the roots against the run's snapshot, copy new files in, merge them into
 * the manifest.
 *
 * Merging is keyed on `originalPath`, not on name: re-planning normally
 * rewrites the same design document, and keying on name would accumulate
 * design-1.md, design-2.md in the doc rail instead of refreshing one entry.
 */
export async function collectArtifacts(
  config: Config,
  issue: number,
  kind: RunKind = 'plan',
  trigger: 'command' | 'auto' = 'auto',
): Promise<ArtifactRef[]> {
  const snap = readSnapshot(issue, kind);
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

  // Seeded with what earlier runs collected, so nothing is ever dropped and a
  // re-collected file keeps the name the doc rail already shows.
  const byOriginal = new Map<string, ArtifactRef>(
    readArtifacts(issue).map((ref) => [ref.originalPath, ref]),
  );
  const taken = [...byOriginal.values()].map((ref) => ref.name);

  for (const f of found) {
    if (!existsSync(f.abs)) continue; // vanished between snapshot and now
    const prior = byOriginal.get(f.abs);
    const name = prior ? prior.name : uniqueName(taken, f.base);
    if (!prior) taken.push(name);
    try {
      copyFileSync(f.abs, join(store, name));
    } catch {
      continue; // locked/failed copy: record the rest
    }
    byOriginal.set(f.abs, {
      name,
      storedPath: `artifacts/${name}`,
      origin: f.origin,
      originalPath: f.abs,
    });
  }

  const refs = [...byOriginal.values()];

  writeFileSync(
    artifactsManifestPath(issue),
    JSON.stringify({ collectedAt: new Date().toISOString(), trigger, artifacts: refs }, null, 2),
    'utf8',
  );
  // Each run signs off with its own marker. Writing 'plan.done' from a custom
  // run would satisfy the Plan gate and move the card to Implement.
  // Capturing leftovers does not prove a failed planning run produced a plan.
  if (kind !== 'plan' || existsSync(planPath(issue))) {
    writeMarker(issue, `${kind}.done`);
  }
  // Consume the sentinel: this run is now collected.
  rmSync(runSnapshotPath(issue, kind), { force: true });
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
