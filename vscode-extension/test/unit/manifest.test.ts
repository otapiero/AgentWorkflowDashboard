import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('extension manifest', () => {
  test('targets the installed desktop API and activates after startup', () => {
    expect(manifest.engines.vscode).toBe('^1.131.0');
    expect(manifest.extensionKind).toEqual(['ui']);
    expect(manifest.activationEvents).toContain('onStartupFinished');
    expect(manifest.main).toBe('./dist/extension.cjs');
    expect(manifest).not.toHaveProperty('icon');
  });

  test('shows View Session only on a current live task row', () => {
    const item = manifest.contributes.menus['view/item/context'].find((entry: { command: string }) => entry.command === 'missionControl.viewSession');
    expect(item.when).toContain('current-live');
    expect(item.when).not.toContain('missionControl.currentTask');
  });
});
