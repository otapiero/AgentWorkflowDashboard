import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHealthResponse } from '../src/server/health.ts';
import { registerRoutes } from '../src/server/routes.ts';
import { Broadcaster } from '../src/server/sse.ts';
import { getTask, saveState } from '../src/orchestrator/state.ts';
import { worktreePath } from '../src/orchestrator/paths.ts';
import type { CleanupResult } from '../src/orchestrator/cleanup.ts';
import type { Config, TaskRecord } from '../src/shared/types.ts';

const ISSUE = 3259;
const BRANCH = 'alice/3259-ui-bug';

const config = {
  repo: { path: 'C:\\repo', owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice' },
  github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
  agents: {},
  pipeline: [{ id: 'implement', label: 'Implement', actor: 'you', gate: { type: 'manual' } }],
  server: { port: 4317 },
} as unknown as Config;

let home: string;
let calls: Array<{ issue: number; branch: string }>;

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    issue: ISSUE,
    title: 'UI bug',
    slug: 'ui-bug',
    branch: BRANCH,
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    ...over,
  } as TaskRecord;
}

function app(over: Partial<Config> = {}) {
  const instance = Fastify();
  registerRoutes(instance, {
    config: { ...config, ...over },
    broadcaster: new Broadcaster(),
    refresh: async () => [],
    health: createHealthResponse('0.1.0', '2026-08-05T00:00:00.000Z'),
    cleanup: async (_cfg, issue, branch): Promise<CleanupResult> => {
      calls.push({ issue, branch });
      return { issue, rescued: ['notes.md'], branchDeleted: true };
    },
  });
  return instance;
}

/** The route only cleans a worktree that is actually there. */
function seedWorktree(): void {
  mkdirSync(worktreePath(ISSUE), { recursive: true });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-markdone-'));
  process.env.MC_HOME = home;
  calls = [];
  saveState({ tasks: [task()] } as never);
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('POST /api/tasks/:issue/move', () => {
  test('marking a task done retires its worktree', async () => {
    seedWorktree();
    const instance = app();

    const res = await instance.inject({
      method: 'POST',
      url: `/api/tasks/${ISSUE}/move`,
      payload: { phase: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ issue: ISSUE, branch: BRANCH }]);
    await instance.close();
  });

  test('moving a task anywhere else leaves the worktree alone', async () => {
    // Pinning to merge, or to any other lane, is not "I am finished".
    seedWorktree();
    const instance = app();

    await instance.inject({
      method: 'POST',
      url: `/api/tasks/${ISSUE}/move`,
      payload: { phase: 'merged' },
    });

    expect(calls).toEqual([]);
    await instance.close();
  });

  test('clearing the override never cleans up', async () => {
    seedWorktree();
    const instance = app();

    await instance.inject({
      method: 'POST',
      url: `/api/tasks/${ISSUE}/move`,
      payload: { phase: null },
    });

    expect(calls).toEqual([]);
    await instance.close();
  });

  test('done with no worktree left does nothing', async () => {
    const instance = app();

    const res = await instance.inject({
      method: 'POST',
      url: `/api/tasks/${ISSUE}/move`,
      payload: { phase: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([]);
    await instance.close();
  });

  test('cleanup: onDone false leaves the worktree even when marked done', async () => {
    seedWorktree();
    const instance = app({ cleanup: { onDone: false } } as Partial<Config>);

    await instance.inject({
      method: 'POST',
      url: `/api/tasks/${ISSUE}/move`,
      payload: { phase: 'done' },
    });

    expect(calls).toEqual([]);
    await instance.close();
  });

  test('failed cleanup reports the error and leaves completion available to retry', async () => {
    seedWorktree();
    const instance = Fastify();
    registerRoutes(instance, {
      config,
      broadcaster: new Broadcaster(),
      refresh: async () => [],
      health: createHealthResponse('0.1.0', '2026-08-05T00:00:00.000Z'),
      cleanup: async () => {
        throw new Error('worktree is held open');
      },
    });

    const res = await instance.inject({
      method: 'POST',
      url: `/api/tasks/${ISSUE}/move`,
      payload: { phase: 'done' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain('worktree is held open');
    expect(getTask(ISSUE)?.manualPhase).toBeNull();
    await instance.close();
  });
});
