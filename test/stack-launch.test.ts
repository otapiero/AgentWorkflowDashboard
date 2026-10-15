import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const boundary = vi.hoisted(() => ({ commands: [] as Record<string, unknown>[], terminals: [] as { exe: string; args: string[] }[] }));
vi.mock('execa', () => ({ execa: (exe: string, args: string[]) => {
  boundary.terminals.push({ exe, args }); return { unref() {}, catch() {} };
}, execaSync: vi.fn() }));
vi.mock('../src/orchestrator/layer-worktrees.ts', () => ({ ensureLayerWorktree: vi.fn(async () => undefined) }));
vi.mock('../src/orchestrator/worktree.ts', () => ({ ensureWorktree: vi.fn(async () => undefined) }));
vi.mock('../src/orchestrator/t3/instances.ts', () => ({ readInstanceReadiness: () => ({ instanceId: 'codex', ready: true, models: ['gpt-test'], reason: null }) }));
vi.mock('../src/orchestrator/t3/client.ts', () => ({ T3Client: class {
  async fetchSnapshot() { return { projects: [{ id: 'project', workspaceRoot: 'C:\\src\\widgets' }], threads: [] }; }
  async dispatch(command: Record<string, unknown>) { boundary.commands.push(command); return { ok: true }; }
} }));
import { spawnPhase } from '../src/orchestrator/spawn/phase.ts';
import { newTask } from '../src/orchestrator/state.ts';
import { runPhaseScript, taskDir } from '../src/orchestrator/paths.ts';
import { resolveSpawnPlan } from '../src/orchestrator/spawn-plan.ts';
import type { Config, PhaseConfig, LauncherKind } from '../src/shared/types.ts';
import type { PrLayer } from '../src/shared/pr-stack.ts';
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-stack-launch-')); process.env.MC_HOME = home;
  process.env.MC_CLAUDE_COMMANDS = join(home, 'commands'); mkdirSync(process.env.MC_CLAUDE_COMMANDS);
  writeFileSync(join(process.env.MC_CLAUDE_COMMANDS, 'implement.md'), '{{branch}} -> {{baseBranch}} in {{worktree}}');
  mkdirSync(dirname(runPhaseScript()), { recursive: true });
  writeFileSync(runPhaseScript(), readFileSync(resolve('assets/scripts/run-phase.ps1'), 'utf8'));
  boundary.commands.length = 0; boundary.terminals.length = 0;
});
afterEach(() => { delete process.env.MC_HOME; delete process.env.MC_CLAUDE_COMMANDS; rmSync(home, { recursive: true, force: true }); });

test('an outdated installed script is rejected before starting a terminal', async () => {
  writeFileSync(runPhaseScript(), '# older phase script');
  const config = { repo: { baseBranch: 'main' }, launcher: 'wt', agents: { codex: { launch: 'codex', promptMode: 'positional', instructionMode: 'inline' } }, pipeline: [] } as unknown as Config;
  const phase = { id: 'implement', actor: 'codex', label: 'Implement', gate: { type: 'manual' } } as PhaseConfig;
  await expect(spawnPhase(config, newTask(1, 'Feature', 'alice'), phase, { rawPrompt: 'Inspect this' })).rejects.toThrow('Installed phase scripts need updating');
  expect(boundary.terminals).toHaveLength(0);
});

test.each<LauncherKind>(['wt', 'vscode', 't3'])('%s launches the same selected layer that preview resolved', async launcher => {
  const config: Config = {
    repo: { path: 'C:\\src\\widgets', owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice' },
    github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
    pipeline: [], server: { port: 4317 }, launcher,
    agents: { codex: { launch: 'codex', promptMode: 'positional', instructionMode: 'inline', model: 'gpt-test', t3Instance: 'codex' } },
  };
  const phase: PhaseConfig = { id: 'implement', actor: 'codex', command: 'implement', label: 'Implement', gate: { type: 'manual' }, spawnable: true };
  const task = newTask(1, 'Feature', 'alice');
  const p = { host: 'github.com', repository: 'acme/widgets', number: 11, state: 'OPEN', headRepository: 'acme/widgets', headBranch: 'alice/child', baseBranch: 'alice/parent', headSha: 'a'.repeat(40), available: true, checkedAt: new Date().toISOString() } as PrLayer;
  task.stack = { layers: [p], discoveryComplete: true };
  const preview = resolveSpawnPlan(config, task, phase, {});
  const record = await spawnPhase(config, task, phase);
  const runDir = join(taskDir(1), 'runs', readdirSync(join(taskDir(1), 'runs'))[0]!);
  const spec = JSON.parse(readFileSync(join(runDir, 'spawn.json'), 'utf8'));
  expect(spec).toMatchObject({ branch: preview.target.branch, baseBranch: preview.target.baseBranch, worktree: preview.target.worktreePath });
  expect(readFileSync(spec.promptFile, 'utf8')).toBe(preview.promptText);
  expect(record.workspacePath).toBe(preview.target.worktreePath);
  if (launcher === 't3') {
    expect(boundary.commands.find(c => c.type === 'thread.create')).toMatchObject({ branch: 'alice/child', worktreePath: preview.target.worktreePath });
  } else if (launcher === 'vscode') {
    const workspace = JSON.parse(readFileSync(join(runDir, 'workspace.code-workspace'), 'utf8'));
    expect(workspace.folders).toEqual([{ path: preview.target.worktreePath }]);
    expect(workspace.tasks.tasks[0].args).toContain(join(runDir, 'spawn.json'));
  } else expect(boundary.terminals.find(t => t.exe === 'wt')?.args).toContain(join(runDir, 'spawn.json'));
});
