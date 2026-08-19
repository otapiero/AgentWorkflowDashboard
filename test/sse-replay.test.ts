import { PassThrough } from 'node:stream';

import Fastify from 'fastify';
import { expect, test, vi } from 'vitest';

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

function capturingReply(chunks: string[]): { raw: PassThrough } {
  const raw = new PassThrough();
  raw.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  return { raw };
}

test('Broadcaster can register a client without replaying cached events', () => {
  const broadcaster = new Broadcaster();
  broadcaster.send('tasks', [{ phase: 'old' }]);
  const chunks: string[] = [];

  (broadcaster.add as unknown as (reply: never, options: { replay: boolean }) => void)(
    capturingReply(chunks) as never,
    { replay: false },
  );
  broadcaster.send('tasks', [{ phase: 'new' }]);

  expect(chunks.join('')).not.toContain('old');
  expect(chunks.join('')).toContain('new');
});

test('Broadcaster retains cached replay for legacy clients', () => {
  const broadcaster = new Broadcaster();
  broadcaster.send('tasks', [{ phase: 'cached' }]);
  const chunks: string[] = [];

  broadcaster.add(capturingReply(chunks) as never);

  expect(chunks.join('')).toContain('cached');
});

test('GET /api/events?replay=0 registers without replay or redundant refresh', async () => {
  const app = Fastify();
  const refresh = vi.fn(async () => []);
  let options: { replay?: boolean } | undefined;
  const broadcaster = {
    size: 0,
    add(reply: { raw: { end(): void } }, nextOptions?: { replay?: boolean }) {
      options = nextOptions;
      setImmediate(() => reply.raw.end());
    },
  } as unknown as Broadcaster;
  registerRoutes(app, {
    config,
    broadcaster,
    refresh,
    health: createHealthResponse('0.1.0', '2026-08-03T10:00:00.000Z'),
  });

  const response = await app.inject({ method: 'GET', url: '/api/events?replay=0' });

  expect(response.statusCode).toBe(200);
  expect(options).toEqual({ replay: false });
  expect(refresh).not.toHaveBeenCalled();
  await app.close();
});
