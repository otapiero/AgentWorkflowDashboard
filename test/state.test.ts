import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('opens an empty board while preserving the corrupt state for recovery', () => {
    const corrupt = '{ this is not json';
    writeFileSync(statePath(), corrupt, 'utf8');
    expect(loadState()).toEqual({ version: 1, tasks: [] });
    expect(readFileSync(`${statePath()}.corrupt`, 'utf8')).toBe(corrupt);
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
});

describe('task mutations', () => {
  test('upserting an existing issue replaces it rather than duplicating', () => {
    upsertTask(newTask(3060, 'Original title', 'alice'));
    upsertTask({ ...newTask(3060, 'Renamed title', 'alice'), manualPhase: 'merge' });
    expect(listTasks()).toHaveLength(1);
    expect(getTask(3060)?.title).toBe('Renamed title');
    expect(getTask(3060)?.manualPhase).toBe('merge');
  });

  test('removeTask takes an issue off the board', () => {
    upsertTask(newTask(3060, 'Audio mode', 'alice'));
    upsertTask(newTask(3120, 'Prompt change', 'alice'));
    removeTask(3060);
    expect(listTasks().map((t) => t.issue)).toEqual([3120]);
  });
});

describe('saveState', () => {
  test('a write that fails part-way leaves the previous state intact', () => {
    upsertTask(newTask(3060, 'Original title', 'alice'));
    const before = readFileSync(statePath(), 'utf8');
    // A directory where the temp file goes makes the write fail before the
    // rename. Writing state.json in place would have succeeded instead.
    mkdirSync(`${statePath()}.tmp`);

    expect(() => saveState({ version: 1, tasks: [] })).toThrow();
    expect(readFileSync(statePath(), 'utf8')).toBe(before);
  });
});
