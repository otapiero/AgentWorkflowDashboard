import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.MC_PORT ?? '4317';

const PROCESS_SUITES = [
  'test/review-worktrees.test.ts',
  'test/artifacts.test.ts',
  'test/cleanup.test.ts',
  'test/notes-lease.test.ts',
  'test/notes-mcp.test.ts',
  'test/notes.test.ts',
  'test/server-notes.test.ts',
];

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 4316,
    proxy: {
      // Trailing slash: a bare '/api' prefix also swallows the /api.ts module.
      '/api/': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    root: '.',
    // Gives every suite a temp install root by default, so forgetting MC_ROOT
    // cannot reach the operator's real ~/.mission-control.
    setupFiles: ['test/setup.ts'],
    // Suites that start real processes (git, tsx, and the PowerShell call the
    // notes lease makes) run as a second group, after everything else. Run
    // alongside the in-process suites they starved them of CPU until a 200 ms
    // Fastify test blew its 5 s timeout. Kept apart, neither needs a raised
    // timeout.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: PROCESS_SUITES,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: PROCESS_SUITES,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
