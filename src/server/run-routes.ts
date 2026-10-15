import type { FastifyInstance } from 'fastify';

import { spawnPhase } from '../orchestrator/spawn/phase.ts';
import { resolveSpawnPlan } from '../orchestrator/spawn-plan.ts';
import { readArtifacts } from '../orchestrator/artifacts.ts';
import { getPhaseDefaults, getTask, upsertTask } from '../orchestrator/state.ts';
import { isCustomRun, resolveRunPhase } from '../shared/custom-run.ts';
import { errorMessage, findTask, type RouteContext } from './route-helpers.ts';
import { cancelPendingLaunch } from '../orchestrator/launch-lock.ts';

/** Launching a phase, and previewing what it would be sent. */
export function registerRunRoutes(
  app: FastifyInstance,
  { config, refresh }: Pick<RouteContext, 'config' | 'refresh'>,
): void {
  app.post<{ Params: { issue: string } }>('/api/tasks/:issue/cancel-launch', async (req, reply) => {
    const task = findTask(req.params.issue, reply);
    if (!task) return reply;
    try { cancelPendingLaunch(task.issue); return { ok: true }; }
    catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });
  /**
   * Phases the operator can launch: everything in the pipeline, plus the
   * synthetic custom run, which is deliberately not in config.yaml.
   */
  const runPhase = (id: string | undefined) =>
    resolveRunPhase(
      { pipeline: config.pipeline, agentNames: Object.keys(config.agents) },
      id,
    );

  app.post<{
    Params: { issue: string };
    Body: {
      layerKey?: string;
      phase?: string;
      customInstructions?: string;
      agent?: string;
      model?: string;
      effort?: string;
      /** Custom runs only: false sends the operator's text with no preamble. */
      includeContext?: boolean;
    };
  }>('/api/tasks/:issue/spawn', async (req, reply) => {
    const task = findTask(req.params.issue, reply);
    if (!task) return reply;

    const phase = runPhase(req.body?.phase);
    if (!phase) return reply.code(400).send({ error: `unknown phase '${req.body?.phase}'` });
    if (!phase.spawnable) {
      return reply.code(400).send({ error: `phase '${phase.id}' is not spawnable` });
    }

    // Context off means the operator's text is the entire prompt, so there has
    // to be some: a raw run of nothing is not a run.
    const raw =
      isCustomRun(phase) && req.body?.includeContext === false
        ? (req.body?.customInstructions ?? '').trim()
        : undefined;
    if (raw === '') {
      return reply
        .code(400)
        .send({ error: 'a custom run with issue context turned off needs a prompt' });
    }

    try {
      const record = await spawnPhase(config, task, phase, {
        layerKey: req.body?.layerKey,
        customInstructions: req.body?.customInstructions,
        agent: req.body?.agent,
        model: req.body?.model,
        effort: req.body?.effort,
        rawPrompt: raw,
      });
      const current = getTask(task.issue);
      if (current) upsertTask({ ...current, spawnHistory: [...current.spawnHistory, record] });
      // The tab needs a moment to write its running marker before we re-derive.
      setTimeout(() => void refresh(), 1500);
      return { spawned: record };
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });

  /**
   * What the agent *would* receive. Read-only: no prompt file, no plan
   * snapshot, no spawn record — this must never have a side effect, because
   * the operator will hit it repeatedly while writing.
   */
  app.post<{
    Params: { issue: string };
    Body: { phase?: string; instructions?: string; includeContext?: boolean; layerKey?: string };
  }>('/api/tasks/:issue/prompt', async (req, reply) => {
    const task = findTask(req.params.issue, reply);
    if (!task) return reply;

    const phase = runPhase(req.body?.phase);
    if (!phase) return reply.code(400).send({ error: `unknown phase '${req.body?.phase}'` });

    try {
      const plan = resolveSpawnPlan(config, task, phase, getPhaseDefaults(), {
        layerKey: req.body?.layerKey,
        customInstructions: req.body?.instructions || undefined,
        artifacts: readArtifacts(task.issue),
        // Unlike the spawn route this does not reject an empty raw prompt: the
        // operator hits this while typing, so it must stay forgiving.
        rawPrompt:
          isCustomRun(phase) && req.body?.includeContext === false
            ? (req.body?.instructions ?? '')
            : undefined,
      });
      return {
        text: plan.promptText,
        command: plan.command,
        words: plan.promptText.trim().split(/\s+/).filter(Boolean).length,
        target: plan.target,
      };
    } catch (err) {
      return reply.code(500).send({ error: errorMessage(err) });
    }
  });
}
