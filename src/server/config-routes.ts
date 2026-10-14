import type { FastifyInstance } from 'fastify';

import { agentCapabilities } from '../orchestrator/agents.ts';
import {
  getPhaseDefaults,
  getSettings,
  setPhaseDefault,
  setSettings,
} from '../orchestrator/state.ts';
import type { LauncherKind } from '../shared/types.ts';
import type { RouteContext } from './route-helpers.ts';

const LAUNCHERS: LauncherKind[] = ['wt', 'vscode', 't3'];

export function isValidLauncher(value: unknown): value is LauncherKind {
  return typeof value === 'string' && (LAUNCHERS as string[]).includes(value);
}

/** Health, and the config and settings the pickers read. */
export function registerConfigRoutes(
  app: FastifyInstance,
  {
    config,
    refresh,
    health,
  }: Pick<RouteContext, 'config' | 'refresh' | 'health'>,
): void {
  app.get('/api/health', async () => health);

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
        defaultModel: profile.model,
        defaultEffort: profile.effort,
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
      return refresh();
    },
  );

  app.post<{ Body: { launcher?: string } }>('/api/settings', async (req, reply) => {
    const launcher = req.body?.launcher;
    if (!isValidLauncher(launcher)) {
      return reply.code(400).send({ error: `launcher must be one of ${LAUNCHERS.join(', ')}` });
    }
    setSettings({ launcher });
    return refresh();
  });
}
