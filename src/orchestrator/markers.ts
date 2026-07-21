import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { markerPath, markersDir } from './paths.ts';
import type { LiveSpawn, Phase } from '../shared/types.ts';

/**
 * Durable phase signals on disk.
 *
 * Markers are written by the spawn script rather than the app, so they survive
 * the app being closed or crashed. The reconciler prefers them but never
 * requires them — raw evidence (an attached plan, a pushed branch, an open PR)
 * is always a valid fallback.
 */
export function writeMarker(issue: number, name: string, body = ''): void {
  mkdirSync(markersDir(issue), { recursive: true });
  writeFileSync(markerPath(issue, name), body, 'utf8');
}

export function hasMarker(issue: number, name: string): boolean {
  return existsSync(markerPath(issue, name));
}

export function listMarkers(issue: number): string[] {
  try {
    return readdirSync(markersDir(issue));
  } catch {
    // No workspace yet is a normal state, not an error.
    return [];
  }
}

export function clearMarker(issue: number, name: string): void {
  rmSync(markerPath(issue, name), { force: true });
}

/**
 * Record that a spawn is running, identified by the PID of the pwsh process
 * hosting it. Storing the PID is what lets a closed or crashed terminal be
 * distinguished from a session that is genuinely still working.
 */
export function writeRunningMarker(
  issue: number,
  phase: Phase,
  pid: number,
): void {
  writeMarker(
    issue,
    `${phase}.running`,
    JSON.stringify({ phase, pid, startedAt: new Date().toISOString() }),
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without signalling.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The live spawn for a task, if any. Running markers whose process is gone are
 * deleted as a side effect so a dead terminal stops showing as live.
 */
export function readLiveSpawn(issue: number): LiveSpawn | null {
  for (const name of listMarkers(issue)) {
    if (!name.endsWith('.running')) continue;

    let parsed: Partial<LiveSpawn> | null = null;
    try {
      parsed = JSON.parse(readFileSync(markerPath(issue, name), 'utf8'));
    } catch {
      // Truncated, empty, or legacy marker: no PID to trust.
      parsed = null;
    }

    if (parsed && typeof parsed.pid === 'number' && isProcessAlive(parsed.pid)) {
      return {
        phase: (parsed.phase ?? name.replace(/\.running$/, '')) as Phase,
        pid: parsed.pid,
        startedAt: parsed.startedAt ?? new Date(0).toISOString(),
      };
    }

    clearMarker(issue, name);
  }
  return null;
}
