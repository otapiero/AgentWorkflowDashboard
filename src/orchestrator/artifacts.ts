import { join } from 'node:path';

import { taskDir } from './paths.ts';
import type { ArtifactRef } from '../shared/types.ts';

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
 */
export function shouldCollectPlan(i: {
  liveSpawn: unknown;
  planMdExists: boolean;
  planDoneMarker: boolean;
  manifestExists: boolean;
}): boolean {
  if (i.manifestExists) return false;
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
