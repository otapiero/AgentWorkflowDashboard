import type { Config, TaskRecord } from '../shared/types.ts';

/** Per-phase default agent/model, layered over config without editing it. */
export type PhaseDefaults = Record<string, { agent?: string; model?: string }>;

export interface ResolvedAgent {
  agent: string | null;
  model: string | null;
}

export interface OneTime {
  agent?: string;
  model?: string;
}

/**
 * Decide which agent and model a spawn should use.
 *
 * Precedence, strongest first: a one-time choice for this run, the task's own
 * pin, the phase default, then the phase's configured actor. A candidate is
 * only accepted if it names a real configured agent, so stale state can never
 * select an agent that no longer exists.
 */
export function resolveAgentModel(
  config: Config,
  task: TaskRecord,
  phaseId: string,
  phaseDefaults: PhaseDefaults,
  oneTime: OneTime = {},
): ResolvedAgent {
  const phase = config.pipeline.find((p) => p.id === phaseId);

  const agentCandidates = [
    oneTime.agent,
    task.overrides?.agent,
    phaseDefaults[phaseId]?.agent,
    phase?.actor,
  ];
  const agent = agentCandidates.find((a) => a && config.agents[a]) ?? null;
  if (!agent) return { agent: null, model: null };

  const rawModel =
    oneTime.model ??
    task.overrides?.model ??
    phaseDefaults[phaseId]?.model ??
    config.agents[agent]?.model;

  const model = !rawModel || rawModel === 'default' ? null : rawModel;
  return { agent, model };
}
