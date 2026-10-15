import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const openWorktree = vi.hoisted(() => vi.fn());
vi.mock('../src/orchestrator/spawn/launchers.ts', () => ({ openWorktreeInVscode: openWorktree, openArtifactInEditor: vi.fn() }));
import { registerDocumentRoutes } from '../src/server/document-routes.ts';
import { newTask, saveState } from '../src/orchestrator/state.ts';
import type { PrLayer } from '../src/shared/pr-stack.ts';
const home = mkdtempSync(join(tmpdir(), 'mc-open-'));
afterEach(() => { delete process.env.MC_HOME; rmSync(home, { recursive: true, force: true }); });

test('opens the issue folder even when the stack has no selected layer or fresh metadata', async () => {
  process.env.MC_HOME = home;
  const task = newTask(1, 'Feature', 'alice');
  task.stack = { layers: [{ number: 10 }, { number: 11 }] as PrLayer[], discoveryComplete: false };
  saveState({ version: 1, tasks: [task] });
  const app = Fastify();
  registerDocumentRoutes(app);
  try {
    const result = await app.inject({ method: 'POST', url: '/api/tasks/1/open-code', payload: {} });
    expect(result.statusCode).toBe(200);
    expect(openWorktree).toHaveBeenCalledWith(1);
  } finally { await app.close(); }
});
