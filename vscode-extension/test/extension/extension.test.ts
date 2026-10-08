import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { abortableDelay, type MissionControlTestApi } from '../../src/extension.ts';
import { task } from '../unit/fixtures.ts';

suite('Mission Control extension', () => {
  test('rejects an already-aborted lifecycle delay immediately', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(abortableDelay(60_000, controller.signal), /aborted/);
  });
  test('activates within the synchronous budget and registers commands', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control');
    assert.ok(extension);
    const api = await extension.activate() as MissionControlTestApi;
    assert.ok(api.activationMetricsForTests().syncActivationMs <= 50, `synchronous activation ${api.activationMetricsForTests().syncActivationMs.toFixed(2)}ms exceeded 50ms`);
    const queued = task({ workspacePath: 'C:\\mc\\worktrees\\queued-task' });
    const opened = vscode.commands.executeCommand('missionControl.openTask', queued);
    await api.readyForTests();
    await opened;
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('missionControl.openTask'));
    assert.ok(commands.includes('missionControl.runCurrentPhase'));
    assert.ok(commands.includes('missionControl.connectionActions'));
  });

  test('opens a seeded task worktree in a new window', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control'); assert.ok(extension);
    const api = await extension.activate() as MissionControlTestApi;
    await api.readyForTests();
    const seeded = task({ workspacePath: 'C:\\mc\\worktrees\\host-task' }); api.seedTasksForTests([seeded]);
    await vscode.commands.executeCommand('missionControl.openTask', seeded);
    const args = api.lastOpenFolderArgs(); assert.ok(args);
    assert.equal((args[0] as vscode.Uri).fsPath.toLowerCase(), seeded.integration.workspacePath.toLowerCase());
    assert.deepEqual(args[1], { forceNewWindow: true });
  });
});
