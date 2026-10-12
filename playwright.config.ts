import { defineConfig, devices } from '@playwright/test';

// Not the app's 4317, so a running Mission Control never answers the tests.
const PORT = 4399;

export default defineConfig({
  testDir: 'e2e',
  // One server, one throwaway project: tests share its notes and task state.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // Serves dist/web, so `npm run test:e2e` builds first.
    command: 'npx tsx e2e/server.ts',
    env: { MC_PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
