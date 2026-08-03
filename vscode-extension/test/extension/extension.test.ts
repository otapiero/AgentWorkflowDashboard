import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { MissionControlTestApi } from '../../src/extension.ts';
import { task } from '../unit/fixtures.ts';

suite('Mission Control extension', () => {
  test('activates within the synchronous budget and registers commands', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control');
    assert.ok(extension);
    const api = await extension.activate() as MissionControlTestApi;
    assert.ok(api.activationMetricsForTests().syncActivationMs <= 50, `synchronous activation ${api.activationMetricsForTests().syncActivationMs.toFixed(2)}ms exceeded 50ms`);
    await api.readyForTests();
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

  test('retains at most 25 MiB after seeding 500 Extension Host tasks', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control'); assert.ok(extension);
    const api = await extension.activate() as MissionControlTestApi;
    await api.readyForTests();
    const collect = global.gc;
    assert.equal(typeof collect, 'function', 'Extension Host must launch with --expose-gc');
    if (!collect) throw new Error('Extension Host must launch with --expose-gc');
    for (let index = 0; index < 3; index += 1) collect();
    const before = process.memoryUsage().heapUsed;
    api.seedTasksForTests(Array.from({ length: 500 }, (_, index) => task({ issue: 10_000 + index })));
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let index = 0; index < 3; index += 1) { await new Promise<void>(resolve => setImmediate(resolve)); collect(); }
    const retainedMiB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    assert.ok(retainedMiB <= 25, `Extension Host retained ${retainedMiB.toFixed(2)} MiB, exceeding 25 MiB`);
  });
});
