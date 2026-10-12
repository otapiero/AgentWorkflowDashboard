import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../orchestrator/config.ts';
import { startPoller, type Poller } from '../orchestrator/poller.ts';
import { createApp } from './app.ts';
import { Broadcaster } from './sse.ts';
import { createHealthResponse } from './health.ts';
import { mcHome } from '../orchestrator/paths.ts';

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

  const broadcaster = new Broadcaster();
  const health = createHealthResponse(packageJson.version);
  // Notes take their lease before the poller starts, so a second server fails
  // here without having reconciled anything.
  let poller: Poller | undefined;
  const app = await createApp({ config, broadcaster, health, refresh: () => poller!.runNow() });

  // Reconciles once immediately, then on the configured interval. The startup
  // pass is what recovers state after the app was closed or crashed. `tasks`
  // fires only when the board changed; `poll` is the every-cycle heartbeat.
  poller = startPoller(config, {
    onTasks: (tasks) => broadcaster.send('tasks', tasks),
    onPoll: (meta) => broadcaster.send('poll', meta),
    hasClients: () => broadcaster.size > 0,
  });

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
    poller?.stop();
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
