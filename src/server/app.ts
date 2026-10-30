import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

import { registerRequestGuard } from './request-guard.ts';
import { registerRoutes } from './routes.ts';
import type { Broadcaster } from './sse.ts';
import { projectSlug } from '../orchestrator/paths.ts';
import { loadState } from '../orchestrator/state.ts';
import { NotesService } from '../orchestrator/notes.ts';
import type { Config, HealthResponse, TaskWithDerived } from '../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const distWeb = join(here, '..', '..', 'dist', 'web');

export interface AppOptions {
  config: Config;
  broadcaster: Broadcaster;
  /** Re-derive the board. The real server reconciles; the e2e server reads fixtures. */
  refresh: () => Promise<TaskWithDerived[]>;
  health: HealthResponse;
}

/**
 * The HTTP app: notes, the API and the built UI, but not the poller or the
 * listening socket. Split out of index.ts so the Playwright suite serves the
 * very same app over a throwaway project instead of a copy of this wiring.
 */
export async function createApp({ config, broadcaster, refresh, health }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRequestGuard(app);
  const notes = new NotesService({
    home: process.env.MC_HOME!,
    projectId: projectSlug(config.repo.owner, config.repo.name),
    tasks: () => loadState().tasks.map(({ issue, title }) => ({ issue, title })),
    onSnapshot: snapshot => broadcaster.send('notes', snapshot),
    onStatus: status => broadcaster.send('notes-status', status),
  });
  await notes.start();
  app.addHook('onClose', async () => notes.close());

  registerRoutes(app, { config, broadcaster, refresh, health, notes });

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
  return app;
}
