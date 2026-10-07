import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { loadConfig } from '../orchestrator/config.ts';
import { startPoller } from '../orchestrator/poller.ts';
import { registerRoutes } from './routes.ts';
import { Broadcaster } from './sse.ts';
import { createHealthResponse } from './health.ts';
import { mcHome, projectSlug } from '../orchestrator/paths.ts';
import { loadState } from '../orchestrator/state.ts';
import { NotesService } from '../orchestrator/notes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const distWeb = join(here, '..', '..', 'dist', 'web');
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

async function main(): Promise<void> {
  let config;
  try {
    // A project switch applies to the next process, never this server's paths.
    process.env.MC_HOME = resolve(mcHome());
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const app = Fastify({ logger: false });
  const broadcaster = new Broadcaster();
  const health = createHealthResponse(packageJson.version);
  const notes = new NotesService({
    home: process.env.MC_HOME!,
    projectId: projectSlug(config.repo.owner, config.repo.name),
    tasks: () => loadState().tasks.map(({ issue, title }) => ({ issue, title })),
    onSnapshot: snapshot => broadcaster.send('notes', snapshot),
    onStatus: status => broadcaster.send('notes-status', status),
  });
  await notes.start();
  app.addHook('onClose', async () => notes.close());

  // Reconciles once immediately, then on the configured interval. The startup
  // pass is what recovers state after the app was closed or crashed. `tasks`
  // fires only when the board changed; `poll` is the every-cycle heartbeat.
  const poller = startPoller(config, {
    onTasks: (tasks) => broadcaster.send('tasks', tasks),
    onPoll: (meta) => broadcaster.send('poll', meta),
    hasClients: () => broadcaster.size > 0,
  });

  registerRoutes(app, { config, broadcaster, refresh: poller.runNow, health, notes });

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
  console.log(
    `  polling          ${config.github.pollIntervalSeconds}s active / 120s idle / 600s no tab`,
  );
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
