import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as paths from '../src/orchestrator/paths.ts';
import {
  hasMarker,
  listMarkers,
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

describe('markers', () => {
  test('markers for an issue with no workspace list as empty, not an error', () => {
    expect(listMarkers(9999)).toEqual([]);
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

  test('a corrupt running marker is treated as dead rather than crashing', () => {
    // A terminal killed mid-write could leave a truncated file.
    mkdirSync(paths.markersDir(3060), { recursive: true });
    writeFileSync(join(paths.markersDir(3060), 'plan.running'), '{ not json');
    expect(readLiveSpawn(3060)).toBeNull();
  });
});
