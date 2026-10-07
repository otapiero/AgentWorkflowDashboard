import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.MC_PORT ?? '4317';

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
    include: ['test/**/*.test.ts'],
    // Gives every suite a temp install root by default, so forgetting MC_ROOT
    // cannot reach the operator's real ~/.mission-control.
    setupFiles: ['test/setup.ts'],
  },
});
