import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchT3 } from '../src/orchestrator/spawn/t3.ts';
import { getT3ProjectId, newTask } from '../src/orchestrator/state.ts';
import type { T3Client } from '../src/orchestrator/t3/client.ts';
import type { Config, PhaseConfig } from '../src/shared/types.ts';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mc-t3-launch-')); process.env.MC_HOME = home; });
afterEach(() => { delete process.env.MC_HOME; rmSync(home, { recursive: true, force: true }); });
const config = { repo: { path: 'C:\\src\\widgets', name: 'widgets' } } as Config;
const phase = { id: 'plan' } as PhaseConfig;
const plan = {
  modelSelection: { instanceId: 'codex', model: 'gpt-5.6-sol', options: [{ id: 'reasoningEffort', value: 'high' }] },
  modes: { runtimeMode: 'approval-required' as const, interactionMode: 'plan' as const },
  prompt: 'Plan the feature without editing files.',
  target: { layerKey: 'acme/widgets#2', worktreePath: 'C:\\src\\widgets-worktree', branch: 'alice/feature', baseBranch: 'main' },
};

test('adopts the existing project and launches with the selected worktree, prompt, model and permissions', async () => {
  const launchThread = vi.fn(async () => 'thread-1');
  const createProject = vi.fn();
  const client = { requireSnapshot: async () => ({ projects: [{ id: 'p1', title: 'widgets', workspaceRoot: 'c:/src/widgets' }], threads: [] }),
    launchThread, createProject } as unknown as T3Client;
  const result = await launchT3(config, newTask(1, 'Feature', 'alice'), phase, plan, client);
  expect(result.threadId).toBe('thread-1');
  expect(getT3ProjectId()).toBe('p1');
  expect(createProject).not.toHaveBeenCalled();
  expect(launchThread).toHaveBeenCalledWith(expect.objectContaining({
    projectId: 'p1', runtimeMode: 'approval-required', interactionMode: 'plan', modelSelection: plan.modelSelection,
    workspaceStrategy: { type: 'existing_worktree', worktreePath: 'C:\\src\\widgets-worktree', branch: 'alice/feature' },
    initialMessage: { messageId: expect.any(String), text: plan.prompt, attachments: [] },
  }));
});

test('persists a newly created project only after T3 accepts it', async () => {
  const createProject = vi.fn<T3Client['createProject']>(async () => ({ ok: false, error: 'Workspace is unavailable' }));
  const launchThread = vi.fn(async () => 'thread-1');
  const client = { requireSnapshot: async () => ({ projects: [], threads: [] }), createProject, launchThread } as unknown as T3Client;
  await expect(launchT3(config, newTask(1, 'Feature', 'alice'), phase, plan, client)).rejects.toThrow('Workspace is unavailable');
  expect(getT3ProjectId()).toBeNull();
  expect(launchThread).not.toHaveBeenCalled();
  createProject.mockResolvedValue({ ok: true });
  await launchT3(config, newTask(1, 'Feature', 'alice'), phase, plan, client);
  const created = createProject.mock.calls[1]![0] as unknown as { projectId: string };
  expect(getT3ProjectId()).toBe(created.projectId);
  expect(launchThread).toHaveBeenCalledWith(expect.objectContaining({ projectId: created.projectId }));
});
