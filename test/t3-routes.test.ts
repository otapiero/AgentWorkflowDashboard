import { describe, expect, test } from 'vitest';

import { isValidLauncher } from '../src/server/config-routes.ts';

describe('launcher validation', () => {
  test('accepts every launcher the board offers', () => {
    expect(isValidLauncher('wt')).toBe(true);
    expect(isValidLauncher('vscode')).toBe(true);
    expect(isValidLauncher('t3')).toBe(true);
  });

  test('rejects anything else', () => {
    expect(isValidLauncher('emacs')).toBe(false);
    expect(isValidLauncher('')).toBe(false);
    expect(isValidLauncher(undefined)).toBe(false);
  });
});
