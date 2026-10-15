import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerStackRoutes } from '../src/server/stack-routes.ts';
import { getTask, newTask, saveState } from '../src/orchestrator/state.ts';
import { prKey, type PrLayer } from '../src/shared/pr-stack.ts';
import type { Config } from '../src/shared/types.ts';
const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa }));
const config = { repo: { owner: 'acme', name: 'widgets' } } as Config;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mc-stack-routes-')); process.env.MC_HOME = home; execa.mockClear(); });
afterEach(() => { delete process.env.MC_HOME; rmSync(home, { recursive: true, force: true }); });

test('selection and detach persist intent without git or GitHub requests', async () => {
  const task = newTask(1, 'Feature', 'alice');
  const layer = { host: 'github.com', repository: 'acme/widgets', number: 10 } as PrLayer;
  task.stack = { layers: [layer], discoveryComplete: true };
  saveState({ version: 1, tasks: [task] });
  const app = Fastify(); registerStackRoutes(app, { config });
  try {
    const selected = await app.inject({ method: 'POST', url: '/api/tasks/1/stack', payload: { action: 'select', key: prKey(layer) } });
    expect(selected.statusCode).toBe(200);
    expect(getTask(1)?.stack?.selectedKey).toBe(prKey(layer));
    await app.inject({ method: 'POST', url: '/api/tasks/1/stack', payload: { action: 'detach', key: prKey(layer) } });
    expect(getTask(1)?.stack).toMatchObject({ layers: [], selectedKey: null, excludedKeys: [prKey(layer)], discoveryComplete: false });
    expect(execa).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

test('validates attachment scope and keeps companion links outside stack membership', async () => {
  saveState({ version: 1, tasks: [newTask(1, 'Feature', 'alice')] });
  const app = Fastify(); registerStackRoutes(app, { config });
  const post = (action: string, url: string) => app.inject({ method: 'POST', url: '/api/tasks/1/stack', payload: { action, url } });
  try {
    expect((await post('attach', 'https://github.com/other/package/pull/2')).statusCode).toBe(400);
    expect((await post('attach', 'http://github.com/acme/widgets/pull/2')).statusCode).toBe(400);
    expect((await post('attach', 'https://github.com/acme/widgets/pull/2')).statusCode).toBe(200);
    expect((await post('add-companion', 'https://github.com/other/package/pull/3')).statusCode).toBe(200);
    expect(getTask(1)?.stack).toMatchObject({ layers: [], manualNumbers: [2], companionUrls: ['https://github.com/other/package/pull/3'] });
    const removed = await app.inject({ method: 'POST', url: '/api/tasks/1/stack', payload: { action: 'detach', key: 'github.com/acme/widgets/2' } });
    expect(removed.statusCode).toBe(200);
    expect(getTask(1)?.stack?.manualNumbers).toEqual([]);
    expect(execa).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
