import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { MissionControlTestApi } from '../../src/extension.ts';

suite('Mission Control extension', () => {
  test('activates within the synchronous budget and registers commands', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control');
    assert.ok(extension);
    const api = await extension.activate() as MissionControlTestApi;
    assert.ok(api.activationMetricsForTests().syncActivationMs <= 50);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('missionControl.openTask'));
    assert.ok(commands.includes('missionControl.runCurrentPhase'));
  });
});
