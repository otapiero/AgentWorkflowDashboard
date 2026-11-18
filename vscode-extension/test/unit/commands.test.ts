import { describe, expect, test, vi } from 'vitest';

import type { SpawnRequest } from '../../src/client/mission-control-client.ts';
import { CommandController } from '../../src/commands.ts';
import { config, task } from './fixtures.ts';

function controller(overrides: Partial<ConstructorParameters<typeof CommandController>[0]> = {}) {
  const current = task();
  const api = {
    executeCommand: vi.fn(),
    uriFile: vi.fn((value: string) => ({ fsPath: value })),
    uriParse: vi.fn((value: string) => ({ value })),
    openExternal: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showQuickPick: vi.fn(),
    terminals: [] as Array<{ shellIntegration?: { cwd?: { fsPath: string } }; show: ReturnType<typeof vi.fn> }>,
    workspaceUri: () => ({ scheme: 'file', fsPath: current.integration.workspacePath }),
  };
  const store = { task: vi.fn((issue: number) => issue === current.issue ? current : undefined), tasks: vi.fn(() => [current]) };
  const client = { spawn: vi.fn().mockResolvedValue({ spawned: {} }) };
  const flow = vi.fn().mockResolvedValue({ phase: 'implement', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  const output = { show: vi.fn() };
  const server = { restartOwned: vi.fn().mockResolvedValue(true) };
  const launchPicker = { pick: vi.fn() };
  return { current, api, store, client, flow, output, server, commands: new CommandController({ api, store, client, config: () => config, serverUrl: () => 'http://127.0.0.1:4317/', runLaunchFlow: flow, launchPicker, output, server, ...overrides }) };
}

describe('CommandController', () => {
  test('opens the latest task worktree in a new window', async () => {
    const { commands, current, api } = controller();
    const stale = task({ workspacePath: 'C:\\src\\widgets\\old-worktree' });
    await commands.openTask(stale);
    expect(api.executeCommand).toHaveBeenCalledWith('vscode.openFolder', { fsPath: current.integration.workspacePath }, { forceNewWindow: true });
  });

  test('refuses to open a missing worktree', async () => {
    const { commands, current, api } = controller();
    current.integration.worktreeExists = false;
    await commands.openTask(current);
    expect(api.executeCommand).not.toHaveBeenCalled();
    expect(api.showWarningMessage).toHaveBeenCalledWith('This task does not have an available worktree.');
  });

  test('opens the configured dashboard origin', async () => {
    const { commands, api } = controller();
    await commands.openDashboard();
    expect(api.openExternal).toHaveBeenCalledWith({ value: 'http://127.0.0.1:4317' });
  });

  test('spawns the requested selection for the current workspace task', async () => {
    const { commands, current, client } = controller();
    await commands.runCurrentPhase();
    expect(client.spawn).toHaveBeenCalledWith(current.issue, { phase: 'implement', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }, expect.any(AbortSignal));
  });

  test('shows a rejected spawn message and opens logs when requested', async () => {
    const { commands, api, client, output } = controller();
    client.spawn.mockRejectedValueOnce(new Error('The selected agent is unavailable.'));
    api.showWarningMessage.mockResolvedValueOnce('Show Logs');
    await commands.runCurrentPhase();
    expect(api.showWarningMessage).toHaveBeenCalledWith('The selected agent is unavailable.', 'Show Logs');
    expect(output.show).toHaveBeenCalledOnce();
  });

  test('shows an unrelated workspace message without spawning', async () => {
    const { commands, api, client } = controller();
    api.workspaceUri = () => ({ scheme: 'file', fsPath: 'C:\\other' });
    await commands.runCurrentPhase();
    expect(client.spawn).not.toHaveBeenCalled();
    expect(api.showWarningMessage).toHaveBeenCalledWith('This workspace is not a Mission Control worktree.');
  });

  test('refuses a session from a different task than the current workspace', async () => {
    const { commands, current, api, store } = controller();
    const other = task({ issue: 9, workspacePath: 'C:\\mc\\worktrees\\issue-9' });
    other.integration.liveSpawn = { phase: 'implement', pid: 9, startedAt: '2026-08-03T10:00:00.000Z', source: 'marker' };
    store.task.mockImplementation((issue: number) => issue === current.issue ? current : issue === other.issue ? other : undefined);
    store.tasks.mockReturnValue([current, other]);
    await commands.viewSession(other.issue);
    expect(api.showInformationMessage).toHaveBeenCalledWith('View Session is only available for the current workspace task.');
  });

  test('refuses the current task when it has no live session', async () => {
    const { commands, current, api } = controller();
    await commands.viewSession(current.issue);
    expect(api.showInformationMessage).toHaveBeenCalledWith('This task has no live Mission Control session.');
  });

  test('reveals only a terminal integrated with the exact current live worktree', async () => {
    const { commands, current, api } = controller();
    current.integration.liveSpawn = { phase: 'implement', pid: 42, startedAt: '2026-08-03T10:00:00.000Z', source: 'marker' };
    const wrong = { shellIntegration: { cwd: { fsPath: 'C:\\other' } }, show: vi.fn() };
    const exact = { shellIntegration: { cwd: { fsPath: 'C:\\mc\\worktrees\\issue-3060' } }, show: vi.fn() };
    api.terminals.push(wrong, exact);
    await commands.viewSession();
    expect(wrong.show).not.toHaveBeenCalled();
    expect(exact.show).toHaveBeenCalledOnce();
  });

  test('restarts the current server and reports completion', async () => {
    const replacement = { restartOwned: vi.fn().mockResolvedValue(true) };
    const { commands, output, api, server } = controller({ currentServer: () => replacement });
    await commands.restartServer();
    expect(output.show).toHaveBeenCalledOnce();
    expect(replacement.restartOwned).toHaveBeenCalledOnce();
    expect(server.restartOwned).not.toHaveBeenCalled();
    expect(api.showInformationMessage).toHaveBeenCalledWith('Mission Control server stopped; reconnecting.');
  });

  test('does not spawn when the runtime is reconnecting after the launch picks', async () => {
    let finishPick!: (value: SpawnRequest) => void;
    const flow = () => new Promise<SpawnRequest>(resolve => { finishPick = resolve; });
    const { commands, current, client, api } = controller({ runLaunchFlow: flow, mutationTarget: () => null });
    const pending = commands.runCurrentPhase(current);
    await Promise.resolve();
    finishPick({ phase: 'implement' });
    await pending;
    expect(client.spawn).not.toHaveBeenCalled();
    expect(api.showWarningMessage).toHaveBeenCalledWith('Mission Control is reconnecting. Try again when connected.');
  });

  test('passes the active runtime generation signal to spawn and observes abort', async () => {
    const lifecycle = new AbortController();
    const targetClient = { spawn: vi.fn((_issue, _request, signal: AbortSignal) => new Promise<{ spawned: unknown }>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))) };
    const { commands, current, api } = controller({ mutationTarget: () => ({ client: targetClient, signal: lifecycle.signal, generation: 7 }) });
    const pending = commands.runCurrentPhase(current); await Promise.resolve(); lifecycle.abort(); await pending;
    expect(targetClient.spawn).toHaveBeenCalledWith(current.issue, expect.any(Object), lifecycle.signal);
    expect(api.showWarningMessage).toHaveBeenCalledWith('aborted', 'Show Logs');
  });
});
