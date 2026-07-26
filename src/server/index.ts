import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { loadConfig } from '../orchestrator/config.ts';
import { startPoller } from '../orchestrator/poller.ts';
import { registerRoutes } from './routes.ts';
import { Broadcaster } from './sse.ts';

const here = dirname(fileURLToPath(import.meta.url));
const distWeb = join(here, '..', '..', 'dist', 'web');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const app = Fastify({ logger: false });
  const broadcaster = new Broadcaster();

  // Reconciles once immediately, then on the configured interval. The startup
  // pass is what recovers state after the app was closed or crashed. `tasks`
  // fires only when the board changed; `poll` is the every-cycle heartbeat.
  const poller = startPoller(config, {
    onTasks: (tasks) => broadcaster.send('tasks', tasks),
    onPoll: (meta) => broadcaster.send('poll', meta),
    hasClients: () => broadcaster.size > 0,
  });

  registerRoutes(app, { config, broadcaster, refresh: poller.runNow });

  if (existsSync(distWeb)) {
    await app.register(fastifyStatic, { root: distWeb });
    // Any non-API path serves the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain')
        .send('UI not built. Run `npm run dev` for the Vite dev server, or `npm run build`.'),
    );
  }

  const port = Number(process.env.MC_PORT ?? config.server.port);
  await app.listen({ port, host: '127.0.0.1' });

  console.log('');
  console.log(`  Mission Control  http://127.0.0.1:${port}`);
  console.log(`  repo             ${config.repo.owner}/${config.repo.name}`);
  console.log(`  polling every    ${config.github.pollIntervalSeconds}s`);
  console.log('');

  const shutdown = async () => {
    poller.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
