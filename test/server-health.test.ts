import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';

import { createHealthResponse } from '../src/server/health.ts';
import { registerRoutes } from '../src/server/routes.ts';
import { Broadcaster } from '../src/server/sse.ts';
import type { Config } from '../src/shared/types.ts';

const config = {
  repo: { path: 'C:\\repo', owner: 'o', name: 'r', baseBranch: 'main', branchPrefix: 'alice/' },
  github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
  agents: {},
  pipeline: [],
  server: { port: 4317 },
} satisfies Config;

describe('GET /api/health', () => {
  test('returns a stable process identity and API version', async () => {
    const app = Fastify();
    const health = createHealthResponse('0.1.0', '2026-08-03T10:00:00.000Z');
    registerRoutes(app, { config, broadcaster: new Broadcaster(), refresh: async () => [], health });
    const first = await app.inject({ method: 'GET', url: '/api/health' });
    const second = await app.inject({ method: 'GET', url: '/api/health' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
    expect(first.json()).toMatchObject({ status: 'ok', apiVersion: 1, serverVersion: '0.1.0' });
    await app.close();
  });
});
