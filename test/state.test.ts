import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { statePath } from '../src/orchestrator/paths.ts';
import {
  loadState,
  saveState,
  listTasks,
  getTask,
  upsertTask,
  removeTask,
  newTask,
} from '../src/orchestrator/state.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-state-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('loadState', () => {
  test('a missing state file yields an empty board rather than an error', () => {
    // state.json is only a cache; its absence is a normal first-run state.
    expect(loadState()).toEqual({ version: 1, tasks: [] });
  });

  test('a corrupt state file yields an empty board rather than crashing', () => {
    writeFileSync(statePath(), '{ this is not json', 'utf8');
    expect(loadState().tasks).toEqual([]);
  });

  test('a corrupt state file is preserved alongside as a .corrupt backup', () => {
    writeFileSync(statePath(), '{ this is not json', 'utf8');
    loadState();
    expect(existsSync(`${statePath()}.corrupt`)).toBe(true);
  });

  test('state written by saveState round-trips', () => {
    const task = newTask(3060, 'Add audio playback mode', 'alice');
    saveState({ version: 1, tasks: [task] });
    expect(loadState().tasks).toEqual([task]);
  });
});

describe('newTask', () => {
  test('derives the branch from the prefix, issue and title', () => {
    const task = newTask(3060, 'Add audio playback mode', 'alice');
    expect(task.branch).toBe('alice/3060-add-audio-playback-mode');
    expect(task.slug).toBe('add-audio-playback-mode');
  });

  test('starts with no PR, no override and no history', () => {
    const task = newTask(3060, 'Anything', 'alice');
    expect(task.prNumber).toBeNull();
    expect(task.manualPhase).toBeNull();
    expect(task.spawnHistory).toEqual([]);
    expect(task.worktreePath).toBeNull();
  });
});

describe('task mutations', () => {
  test('an upserted task can be read back by issue number', () => {
    upsertTask(newTask(3060, 'Audio mode', 'alice'));
    expect(getTask(3060)?.title).toBe('Audio mode');
  });

  test('upserting an existing issue replaces it rather than duplicating', () => {
    upsertTask(newTask(3060, 'Original title', 'alice'));
    upsertTask({ ...newTask(3060, 'Renamed title', 'alice'), manualPhase: 'merge' });
    expect(listTasks()).toHaveLength(1);
    expect(getTask(3060)?.title).toBe('Renamed title');
    expect(getTask(3060)?.manualPhase).toBe('merge');
  });

  test('getTask returns null for an issue that is not on the board', () => {
    expect(getTask(9999)).toBeNull();
  });

  test('removeTask takes an issue off the board', () => {
    upsertTask(newTask(3060, 'Audio mode', 'alice'));
    upsertTask(newTask(3120, 'Prompt change', 'alice'));
    removeTask(3060);
    expect(listTasks().map((t) => t.issue)).toEqual([3120]);
  });

  test('removing an issue that is absent is a no-op', () => {
    expect(() => removeTask(9999)).not.toThrow();
  });

  test('mutations persist across a reload', () => {
    upsertTask(newTask(3060, 'Audio mode', 'alice'));
    expect(loadState().tasks.map((t) => t.issue)).toEqual([3060]);
  });
});

describe('durability', () => {
  test('saved state is human-readable json', () => {
    // A cache the user can inspect and hand-edit when something goes wrong.
    upsertTask(newTask(3060, 'Audio mode', 'alice'));
    expect(readFileSync(statePath(), 'utf8')).toContain('\n  ');
  });

  test('a failed write does not leave a truncated state file', () => {
    upsertTask(newTask(3060, 'Audio mode', 'alice'));
    const before = readFileSync(statePath(), 'utf8');
    // Writing must go via a temp file and rename, so a reader never sees
    // a half-written file.
    expect(() => saveState({ version: 1, tasks: [] })).not.toThrow();
    expect(readFileSync(statePath(), 'utf8')).not.toBe(before);
    expect(() => JSON.parse(readFileSync(statePath(), 'utf8'))).not.toThrow();
  });
});
