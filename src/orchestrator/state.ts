import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mcHome, statePath } from './paths.ts';
import { branchName, slugify } from './slug.ts';
import type { StateFile, TaskRecord } from '../shared/types.ts';

/**
 * The persisted board.
 *
 * This is a cache, not truth — phases are always recomputed by the reconciler
 * from disk and GitHub. What only lives here is what nothing else can tell us:
 * which issues the user put on the board, manual phase overrides, per-task
 * overrides, and spawn history. Losing this file loses the board's membership
 * and nothing about the actual work.
 */

const EMPTY: StateFile = { version: 1, tasks: [] };

export function loadState(): StateFile {
  const file = statePath();
  if (!existsSync(file)) return structuredClone(EMPTY);

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StateFile;
    if (!Array.isArray(parsed?.tasks)) throw new Error('missing tasks array');
    return parsed;
  } catch {
    // Keep the unreadable file for inspection rather than silently destroying
    // it, then carry on with an empty board.
    try {
      renameSync(file, `${file}.corrupt`);
    } catch {
      // If even that fails, an empty board is still the right outcome.
    }
    return structuredClone(EMPTY);
  }
}

export function saveState(state: StateFile): void {
  mkdirSync(dirname(statePath()), { recursive: true });
  mkdirSync(mcHome(), { recursive: true });
  const tmp = `${statePath()}.tmp`;
  // Write-then-rename so a reader never observes a half-written file.
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, statePath());
}

export function listTasks(): TaskRecord[] {
  return loadState().tasks;
}

export function getTask(issue: number): TaskRecord | null {
  return loadState().tasks.find((t) => t.issue === issue) ?? null;
}

export function upsertTask(task: TaskRecord): void {
  const state = loadState();
  const index = state.tasks.findIndex((t) => t.issue === task.issue);
  if (index === -1) state.tasks.push(task);
  else state.tasks[index] = task;
  saveState(state);
}

export function removeTask(issue: number): void {
  const state = loadState();
  saveState({ ...state, tasks: state.tasks.filter((t) => t.issue !== issue) });
}

export function newTask(
  issue: number,
  title: string,
  branchPrefix: string,
): TaskRecord {
  return {
    issue,
    title,
    slug: slugify(title),
    branch: branchName(branchPrefix, issue, title),
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    lastReconciledAt: null,
  };
}
