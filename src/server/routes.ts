import { existsSync, readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

import { fetchIssueTitle, listOpenIssues } from '../orchestrator/github.ts';
import { planPath } from '../orchestrator/paths.ts';
import { writeMarker, clearMarker } from '../orchestrator/markers.ts';
import { reconcileAll } from '../orchestrator/poller.ts';
import { spawnPhase } from '../orchestrator/spawn.ts';
import {
  getTask,
  newTask,
  removeTask,
  upsertTask,
} from '../orchestrator/state.ts';
import { removeWorktree, resolveBranch } from '../orchestrator/worktree.ts';
import { PHASES } from '../shared/types.ts';
import type { Config, Phase, TaskWithDerived } from '../shared/types.ts';
import type { Broadcaster } from './sse.ts';

interface Deps {
  config: Config;
  broadcaster: Broadcaster;
  refresh: () => Promise<TaskWithDerived[]>;
}

function isPhase(value: unknown): value is Phase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value);
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, broadcaster, refresh } = deps;

  /** Re-derive and push to every connected board. */
  async function refreshAndBroadcast(): Promise<TaskWithDerived[]> {
    const tasks = await refresh();
    broadcaster.send('tasks', tasks);
    return tasks;
  }

  app.get('/api/config', async () => ({
    repo: config.repo,
    pipeline: config.pipeline,
    agents: Object.keys(config.agents),
  }));

  app.get('/api/tasks', async () => refresh());

  app.get('/api/issues', async () => listOpenIssues(config));

  app.post<{ Body: { issue?: number } }>('/api/tasks/import', async (req, reply) => {
    const issue = Number(req.body?.issue);
    if (!Number.isInteger(issue) || issue <= 0) {
      return reply.code(400).send({ error: 'issue must be a positive integer' });
    }
    if (getTask(issue)) {
      return reply.code(409).send({ error: `#${issue} is already on the board` });
    }

    const title = await fetchIssueTitle(config, issue);
    if (!title) {
      return reply
        .code(404)
        .send({ error: `issue #${issue} not found in ${config.repo.owner}/${config.repo.name}` });
    }

    const task = newTask(issue, title, config.repo.branchPrefix);
    // An existing branch for this issue wins over the generated slug.
    upsertTask({ ...task, branch: await resolveBranch(config, issue, task.branch) });
    return refreshAndBroadcast();
  });

  app.post<{
    Params: { issue: string };
    Body: { phase?: string; customInstructions?: string; agent?: string; model?: string };
  }>('/api/tasks/:issue/spawn', async (req, reply) => {
    const task = getTask(Number(req.params.issue));
    if (!task) return reply.code(404).send({ error: 'task not on the board' });

    const phase = config.pipeline.find((p) => p.id === req.body?.phase);
    if (!phase) return reply.code(400).send({ error: `unknown phase '${req.body?.phase}'` });
    if (!phase.spawnable) {
      return reply.code(400).send({ error: `phase '${phase.id}' is not spawnable` });
    }

    try {
      const record = await spawnPhase(config, task, phase, {
        customInstructions: req.body?.customInstructions,
        agent: req.body?.agent,
        model: req.body?.model,
      });
      upsertTask({ ...task, spawnHistory: [...task.spawnHistory, record] });
      // The tab needs a moment to write its running marker before we re-derive.
      setTimeout(() => void refreshAndBroadcast(), 1500);
      return { spawned: record };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { issue: string }; Body: { phase?: string } }>(
    '/api/tasks/:issue/mark-done',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      if (!isPhase(req.body?.phase)) {
        return reply.code(400).send({ error: 'phase is required' });
      }
      writeMarker(issue, `${req.body.phase}.done`);
      return refreshAndBroadcast();
    },
  );

  app.post<{ Params: { issue: string }; Body: { phase?: string } }>(
    '/api/tasks/:issue/unmark-done',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      if (!isPhase(req.body?.phase)) {
        return reply.code(400).send({ error: 'phase is required' });
      }
      clearMarker(issue, `${req.body.phase}.done`);
      return refreshAndBroadcast();
    },
  );

  app.post<{ Params: { issue: string }; Body: { phase?: string | null } }>(
    '/api/tasks/:issue/move',
    async (req, reply) => {
      const task = getTask(Number(req.params.issue));
      if (!task) return reply.code(404).send({ error: 'task not on the board' });

      const phase = req.body?.phase;
      // null clears the override and lets derivation take over again.
      if (phase !== null && !isPhase(phase)) {
        return reply.code(400).send({ error: 'phase must be a valid phase or null' });
      }
      upsertTask({ ...task, manualPhase: phase ?? null });
      return refreshAndBroadcast();
    },
  );

  app.post<{
    Params: { issue: string };
    Body: { agent?: string; model?: string; instructions?: string };
  }>('/api/tasks/:issue/overrides', async (req, reply) => {
    const task = getTask(Number(req.params.issue));
    if (!task) return reply.code(404).send({ error: 'task not on the board' });

    const agent = req.body?.agent;
    if (agent && !config.agents[agent]) {
      return reply.code(400).send({ error: `unknown agent '${agent}'` });
    }
    upsertTask({
      ...task,
      overrides: {
        agent: agent || undefined,
        model: req.body?.model || undefined,
        instructions: req.body?.instructions || undefined,
      },
    });
    return refreshAndBroadcast();
  });

  app.get<{ Params: { issue: string } }>('/api/tasks/:issue/plan', async (req, reply) => {
    const issue = Number(req.params.issue);
    const file = planPath(issue);
    if (!existsSync(file)) return reply.code(404).send({ error: 'no plan attached yet' });
    return { content: readFileSync(file, 'utf8') };
  });

  app.post('/api/reconcile', async () => refreshAndBroadcast());

  app.post<{ Params: { issue: string } }>(
    '/api/tasks/:issue/cleanup',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      // Only removes Mission Control's own worktree; the repo is untouched.
      await removeWorktree(config, issue);
      return refreshAndBroadcast();
    },
  );

  app.delete<{ Params: { issue: string } }>('/api/tasks/:issue', async (req) => {
    removeTask(Number(req.params.issue));
    return refreshAndBroadcast();
  });

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    broadcaster.add(reply);
    // Send current state immediately so a new tab is never blank.
    void refresh().then((tasks) => broadcaster.send('tasks', tasks));
  });
}
