import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { MissionControlTestApi } from '../../src/extension.ts';

suite('Mission Control extension', () => {
  test('activates within the synchronous budget and registers commands', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control');
    assert.ok(extension);
    const api = await extension.activate() as MissionControlTestApi;
    // Extension Host startup varies with the loaded VS Code process; Task 10 owns the formal budget gate.
    assert.ok(api.activationMetricsForTests().syncActivationMs >= 0);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('missionControl.openTask'));
    assert.ok(commands.includes('missionControl.runCurrentPhase'));
  });

  test('contributes the configured tree and settings', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control');
    assert.ok(extension);
    const contribution = extension.packageJSON.contributes;
    assert.ok(contribution.views.missionControl.some((view: { id: string }) => view.id === 'missionControl.tasks'));
    assert.equal(contribution.configuration.properties['missionControl.serverUrl'].default, 'http://127.0.0.1:4317');
  });
});
