import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as paths from '../src/orchestrator/paths.ts';
import {
  writeMarker,
  hasMarker,
  listMarkers,
  clearMarker,
  writeRunningMarker,
  readLiveSpawn,
} from '../src/orchestrator/markers.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-test-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('paths', () => {
  test('honours MC_HOME so tests never touch the real home folder', () => {
    expect(paths.mcHome()).toBe(home);
  });

  test('task artifacts live outside the worktree, keeping the checkout clean', () => {
    // This is the zero-footprint guarantee expressed as a path assertion.
    expect(paths.planPath(3060).startsWith(paths.taskDir(3060))).toBe(true);
    expect(paths.planPath(3060).startsWith(paths.worktreePath(3060))).toBe(false);
  });

  test('each issue gets its own worktree directory', () => {
    expect(paths.worktreePath(3060)).not.toBe(paths.worktreePath(3120));
    expect(paths.worktreePath(3060).endsWith('issue-3060')).toBe(true);
  });
});

describe('markers', () => {
  test('a written marker is reported as present', () => {
    writeMarker(3060, 'plan.done');
    expect(hasMarker(3060, 'plan.done')).toBe(true);
  });

  test('an unwritten marker is absent', () => {
    expect(hasMarker(3060, 'plan.done')).toBe(false);
  });

  test('markers for an issue with no workspace list as empty, not an error', () => {
    expect(listMarkers(9999)).toEqual([]);
  });

  test('listMarkers returns every marker written', () => {
    writeMarker(3060, 'plan.done');
    writeMarker(3060, 'implement.done');
    expect(listMarkers(3060).sort()).toEqual(['implement.done', 'plan.done']);
  });

  test('clearing a marker removes it', () => {
    writeMarker(3060, 'plan.done');
    clearMarker(3060, 'plan.done');
    expect(hasMarker(3060, 'plan.done')).toBe(false);
  });

  test('clearing an absent marker is a no-op, not an error', () => {
    expect(() => clearMarker(3060, 'nope.done')).not.toThrow();
  });

  test('writing the same marker twice is idempotent', () => {
    writeMarker(3060, 'plan.done');
    writeMarker(3060, 'plan.done');
    expect(listMarkers(3060)).toEqual(['plan.done']);
  });
});

describe('spawn liveness', () => {
  test('a running marker for a live process reports a live spawn', () => {
    writeRunningMarker(3060, 'plan', process.pid);
    const live = readLiveSpawn(3060);
    expect(live).not.toBeNull();
    expect(live?.phase).toBe('plan');
    expect(live?.pid).toBe(process.pid);
  });

  test('a running marker for a dead process reports no live spawn', () => {
    // The whole point of storing the PID: a closed terminal must not leave
    // a card showing "live" forever.
    writeRunningMarker(3060, 'plan', 0x7ffffff);
    expect(readLiveSpawn(3060)).toBeNull();
  });

  test('a dead running marker is cleaned up so it stops being listed', () => {
    writeRunningMarker(3060, 'plan', 0x7ffffff);
    readLiveSpawn(3060);
    expect(hasMarker(3060, 'plan.running')).toBe(false);
  });

  test('a live running marker is left in place', () => {
    writeRunningMarker(3060, 'plan', process.pid);
    readLiveSpawn(3060);
    expect(hasMarker(3060, 'plan.running')).toBe(true);
  });

  test('no running marker means no live spawn', () => {
    expect(readLiveSpawn(3060)).toBeNull();
  });

  test('a corrupt running marker is treated as dead rather than crashing', () => {
    // A terminal killed mid-write could leave a truncated file.
    mkdirSync(paths.markersDir(3060), { recursive: true });
    writeFileSync(join(paths.markersDir(3060), 'plan.running'), '{ not json');
    expect(readLiveSpawn(3060)).toBeNull();
  });

  test('a legacy empty running marker is treated as dead rather than live', () => {
    // Earlier designs wrote a bare empty file with no PID.
    mkdirSync(paths.markersDir(3060), { recursive: true });
    writeFileSync(join(paths.markersDir(3060), 'plan.running'), '');
    expect(readLiveSpawn(3060)).toBeNull();
  });

  test('writing a running marker creates the workspace if absent', () => {
    expect(existsSync(paths.markersDir(3060))).toBe(false);
    writeRunningMarker(3060, 'implement', process.pid);
    expect(existsSync(paths.markersDir(3060))).toBe(true);
  });
});
