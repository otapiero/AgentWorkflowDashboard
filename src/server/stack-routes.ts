import type { FastifyInstance } from 'fastify';
import { prKey, type TaskStack } from '../shared/pr-stack.ts';
import { upsertTask } from '../orchestrator/state.ts';
import { findTask, type RouteContext } from './route-helpers.ts';

export type StackOperation = { action: 'select' | 'detach'; key: string | null }
  | { action: 'attach' | 'add-companion' | 'remove-companion'; url: string };

export function registerStackRoutes(app: FastifyInstance, { config }: Pick<RouteContext, 'config'>): void {
  app.post<{ Params: { issue: string }; Body: StackOperation }>('/api/tasks/:issue/stack', async (req, reply) => {
    const task = findTask(req.params.issue, reply);
    if (!task) return reply;
    const stack: TaskStack = structuredClone(task.stack ?? { layers: [], discoveryComplete: false });
    const op = req.body;
    if (!op || typeof op.action !== 'string') return reply.code(400).send({ error: 'Stack operation required' });
    if (op.action === 'select' || op.action === 'detach') {
      const layer = stack.layers.find(p => prKey(p) === op.key);
      const pendingNumber = stack.manualNumbers?.find(number => prKey({ host: 'github.com', repository: `${config.repo.owner}/${config.repo.name}`, number }) === op.key);
      if (op.key !== null && !layer && !(op.action === 'detach' && pendingNumber)) return reply.code(400).send({ error: 'PR does not belong to this issue' });
      if (op.action === 'select') stack.selectedKey = op.key;
      else if (layer || pendingNumber) {
        stack.layers = stack.layers.filter(p => prKey(p) !== op.key);
        stack.excludedKeys = [...new Set([...(stack.excludedKeys ?? []), op.key!])];
        stack.manualNumbers = stack.manualNumbers?.filter(n => n !== (layer?.number ?? pendingNumber));
        if (stack.selectedKey === op.key) stack.selectedKey = null;
        stack.discoveryComplete = false;
      }
    } else if (op.action === 'attach' || op.action === 'add-companion' || op.action === 'remove-companion') {
      let url: URL;
      try { url = new URL(op.url); } catch { return reply.code(400).send({ error: 'Enter a GitHub PR URL' }); }
      const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || !match || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= 0) return reply.code(400).send({ error: 'Enter an https://github.com/owner/repo/pull/number URL' });
      const canonical = `https://github.com/${match[1]}/${match[2]}/pull/${Number(match[3])}`;
      if (op.action === 'attach') {
        if (`${match[1]}/${match[2]}`.toLowerCase() !== `${config.repo.owner}/${config.repo.name}`.toLowerCase()) return reply.code(400).send({ error: 'Attach a PR from the configured repository, or add it as a companion link' });
        const number = Number(match[3]);
        stack.manualNumbers = [...new Set([...(stack.manualNumbers ?? []), number])];
        stack.excludedKeys = stack.excludedKeys?.filter(key => key !== prKey({ host: 'github.com', repository: `${config.repo.owner}/${config.repo.name}`, number }));
        stack.discoveryComplete = false;
      } else if (op.action === 'add-companion') stack.companionUrls = [...new Set([...(stack.companionUrls ?? []), canonical])];
      else stack.companionUrls = stack.companionUrls?.filter(u => u !== canonical);
    } else return reply.code(400).send({ error: 'Unknown stack operation' });
    const updated = { ...task, stack };
    upsertTask(updated);
    // Local operation only. The normal collector sees membership intent next poll.
    return updated;
  });
}
