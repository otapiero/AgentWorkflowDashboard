import { describe, expect, test, vi } from 'vitest';

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
  const server = { restartOwned: vi.fn().mockResolvedValue(undefined) };
  const launchPicker = { pick: vi.fn() };
  return { current, api, store, client, flow, output, server, commands: new CommandController({ api, store, client, config: () => config, serverUrl: () => 'http://127.0.0.1:4317/', runLaunchFlow: flow, launchPicker, output, server, ...overrides }) };
}

describe('CommandController', () => {
  test('opens the latest task worktree in a new window', async () => {
    const { commands, current, api } = controller();
    await commands.openTask(current);
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
    expect(api.uriParse).toHaveBeenCalledWith('http://127.0.0.1:4317');
    expect(api.openExternal).toHaveBeenCalledWith({ value: 'http://127.0.0.1:4317' });
  });

  test('delegates a launch for the current workspace task', async () => {
    const { commands, current, client, flow } = controller();
    await commands.runCurrentPhase();
    expect(flow).toHaveBeenCalledWith(current, config, expect.objectContaining({ pick: expect.any(Function) }));
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

  test('reveals only a terminal integrated with the current worktree', async () => {
    const { commands, api } = controller();
    const wrong = { shellIntegration: { cwd: { fsPath: 'C:\\other' } }, show: vi.fn() };
    const exact = { shellIntegration: { cwd: { fsPath: 'C:\\mc\\worktrees\\issue-3060' } }, show: vi.fn() };
    api.terminals.push(wrong, exact);
    await commands.viewSession();
    expect(wrong.show).not.toHaveBeenCalled();
    expect(exact.show).toHaveBeenCalledOnce();
  });

  test('shows output and reports restart completion', async () => {
    const { commands, output, api, server } = controller();
    await commands.showLogs();
    await commands.restartServer();
    expect(output.show).toHaveBeenCalledTimes(2);
    expect(server.restartOwned).toHaveBeenCalledOnce();
    expect(api.showInformationMessage).toHaveBeenCalledWith('Mission Control server restart requested.');
  });
});
