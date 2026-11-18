import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, test, vi } from 'vitest';

import { registerConfigRoutes } from '../src/server/config-routes.ts';
import type { Config, HealthResponse } from '../src/shared/types.ts';

test('persists launcher changes and rejects unsupported launchers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-t3-routes-'));
  vi.stubEnv('MC_HOME', home);
  const app = Fastify();
  const refresh = vi.fn(async () => []);
  registerConfigRoutes(app, {
    config: { agents: {}, launcher: 'wt' } as Config,
    health: {} as HealthResponse,
    refresh,
  });

  try {
    for (const launcher of ['vscode', 'wt', 't3']) {
      const response = await app.inject({ method: 'POST', url: '/api/settings', payload: { launcher } });
      expect(response.statusCode).toBe(200);
      expect((await app.inject('/api/config')).json()).toMatchObject({ launcher });
    }

    refresh.mockClear();
    const invalid = await app.inject({ method: 'POST', url: '/api/settings', payload: { launcher: 'unknown' } });
    expect(invalid.statusCode).toBe(400);
    expect(refresh).not.toHaveBeenCalled();
    expect((await app.inject('/api/config')).json()).toMatchObject({ launcher: 't3' });
  } finally {
    await app.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
