import type { FastifyInstance } from 'fastify';

import { fetchIssueTitle, listOpenIssues } from '../orchestrator/github.ts';
import { readPlan, writePlan } from '../orchestrator/plan.ts';
import { writeMarker, clearMarker } from '../orchestrator/markers.ts';
import { openWorktreeInVscode, spawnPhase } from '../orchestrator/spawn.ts';
import { missionUsage } from '../orchestrator/usage.ts';
import {
  getPhaseDefaults,
  getSettings,
  getTask,
  newTask,
  removeTask,
  setPhaseDefault,
  setSettings,
  upsertTask,
} from '../orchestrator/state.ts';
import { agentCapabilities } from '../orchestrator/agents.ts';
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

  /** Re-derive and push to every connected board. A forced run broadcasts. */
  async function refreshAndBroadcast(): Promise<TaskWithDerived[]> {
    return refresh();
  }

  app.get('/api/config', async () => ({
    repo: config.repo,
    pipeline: config.pipeline,
    // Each agent with the models and efforts to offer in the pickers.
    agents: Object.entries(config.agents).map(([name, profile]) => {
      const caps = agentCapabilities(name, profile);
      return {
        name,
        models: caps.models,
        efforts: caps.efforts,
        hasEffort: caps.hasEffort,
      };
    }),
    phaseDefaults: getPhaseDefaults(),
    launcher: getSettings().launcher ?? config.launcher ?? 'wt',
  }));

  app.post<{ Body: { phase?: string; agent?: string; model?: string; effort?: string } }>(
    '/api/phase-defaults',
    async (req, reply) => {
      const phase = req.body?.phase;
      if (!phase || !config.pipeline.some((p) => p.id === phase)) {
        return reply.code(400).send({ error: `unknown phase '${phase}'` });
      }
      const agent = req.body?.agent;
      if (agent && !config.agents[agent]) {
        return reply.code(400).send({ error: `unknown agent '${agent}'` });
      }
      setPhaseDefault(phase, {
        agent: agent || undefined,
        model: req.body?.model || undefined,
        effort: req.body?.effort || undefined,
      });
      return refreshAndBroadcast();
    },
  );

  app.post<{ Body: { launcher?: string } }>('/api/settings', async (req, reply) => {
    const launcher = req.body?.launcher;
    if (launcher !== 'wt' && launcher !== 'vscode') {
      return reply.code(400).send({ error: "launcher must be 'wt' or 'vscode'" });
    }
    setSettings({ launcher });
    return refreshAndBroadcast();
  });

  app.get('/api/tasks', async () => refresh());

  app.get<{ Querystring: { scope?: string } }>('/api/issues', async (req) =>
    // Default to the current user's issues; that is the common case and keeps
    // the picker short. scope=all lists every open issue.
    listOpenIssues(config, { mine: req.query?.scope !== 'all' }),
  );

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
    Body: {
      phase?: string;
      customInstructions?: string;
      agent?: string;
      model?: string;
      effort?: string;
    };
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
        effort: req.body?.effort,
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
    Body: { agent?: string; model?: string; effort?: string; instructions?: string };
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
        effort: req.body?.effort || undefined,
        instructions: req.body?.instructions || undefined,
      },
    });
    return refreshAndBroadcast();
  });

  app.get<{ Params: { issue: string } }>('/api/tasks/:issue/plan', async (req, reply) => {
    const content = readPlan(Number(req.params.issue));
    if (content === null) return reply.code(404).send({ error: 'no plan attached yet' });
    return { content };
  });

  app.put<{ Params: { issue: string }; Body: { content?: string } }>(
    '/api/tasks/:issue/plan',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      if (typeof req.body?.content !== 'string') {
        return reply.code(400).send({ error: 'content must be a string' });
      }
      writePlan(issue, req.body.content);
      return { ok: true };
    },
  );

  app.get<{ Params: { issue: string } }>('/api/tasks/:issue/usage', async (req, reply) => {
    const issue = Number(req.params.issue);
    if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
    return missionUsage(issue);
  });

  app.post<{ Params: { issue: string } }>(
    '/api/tasks/:issue/open-code',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      try {
        openWorktreeInVscode(issue);
        return { ok: true };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

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
    // add() replays the latest tasks + poll payloads, so the tab paints at once
    // without forcing a fresh reconcile per connection.
    broadcaster.add(reply);
  });
}
