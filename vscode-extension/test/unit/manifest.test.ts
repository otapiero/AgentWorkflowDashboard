import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('extension manifest', () => {
  test('targets the installed desktop API and activates after startup', () => {
    expect(manifest.engines.vscode).toBe('^1.131.0');
    expect(manifest.extensionKind).toEqual(['ui']);
    expect(manifest.activationEvents).toContain('onStartupFinished');
    expect(manifest.main).toBe('./dist/extension.cjs');
  });
});
