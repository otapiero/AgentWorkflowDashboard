import type { AgentInfo, PhaseDefaults, TaskRecord } from './types.ts';

export interface AgentSelection {
  agent: string;
  model: string;
  effort: string;
}

export interface ResolvedAgentValues {
  agent: string | null;
  model: string | null;
  effort: string | null;
}

export interface AgentResolutionConfig {
  pipeline: readonly { id: string; actor: string }[];
  agents: readonly AgentInfo[];
  phaseDefaults: PhaseDefaults;
}

export interface OneTimeAgentSelection {
  agent?: string;
  model?: string;
  effort?: string;
}

/** Shared server/UI precedence for the agent settings of one selected phase. */
export function resolveAgentValues(
  config: AgentResolutionConfig,
  task: Pick<TaskRecord, 'overrides'>,
  phaseId: string,
  oneTime: OneTimeAgentSelection = {},
): ResolvedAgentValues {
  const phase = config.pipeline.find((candidate) => candidate.id === phaseId);
  const phaseDefault = config.phaseDefaults[phaseId];
  const agent = [oneTime.agent, task.overrides?.agent, phaseDefault?.agent, phase?.actor]
    .find((candidate) => candidate && config.agents.some((configured) => configured.name === candidate)) ?? null;
  if (!agent) return { agent: null, model: null, effort: null };

  const defaults = config.agents.find((candidate) => candidate.name === agent)!;
  const rawModel = oneTime.model ?? task.overrides?.model ?? phaseDefault?.model ?? defaults.defaultModel;
  const rawEffort = oneTime.effort ?? task.overrides?.effort ?? phaseDefault?.effort ?? defaults.defaultEffort;
  return {
    agent,
    model: !rawModel || rawModel === 'default' ? null : rawModel,
    effort: rawEffort || null,
  };
}

/** Resolve then constrain a selected phase to values its picker can actually offer. */
export function selectionForPhase(
  config: AgentResolutionConfig,
  task: Pick<TaskRecord, 'overrides'>,
  phaseId: string,
): AgentSelection {
  const resolved = resolveAgentValues(config, task, phaseId);
  if (!resolved.agent) return { agent: '', model: '', effort: '' };
  const agent = config.agents.find((candidate) => candidate.name === resolved.agent);
  return {
    agent: resolved.agent,
    model: resolved.model && agent?.models.includes(resolved.model) ? resolved.model : '',
    effort: resolved.effort && agent?.hasEffort && agent.efforts.includes(resolved.effort) ? resolved.effort : '',
  };
}

export function selectionForAgent(
  current: AgentSelection,
  agents: readonly AgentInfo[],
  nextAgent: string,
  inheritedAgent?: string | null,
): AgentSelection {
  const effective = nextAgent || inheritedAgent || agents[0]?.name;
  const capabilities = agents.find((agent) => agent.name === effective);
  return {
    agent: nextAgent,
    model: capabilities?.models.includes(current.model) ? current.model : '',
    effort: capabilities?.efforts.includes(current.effort) ? current.effort : '',
  };
}
