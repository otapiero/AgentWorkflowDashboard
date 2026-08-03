import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist/test/**/*.test.cjs',
  version: 'stable',
  workspaceFolder: 'test/fixtures/workspace',
  mocha: { ui: 'tdd', timeout: 20_000 },
  launchArgs: ['--disable-extensions'],
});
