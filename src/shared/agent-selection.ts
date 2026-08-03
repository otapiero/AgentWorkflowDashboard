import type { AgentInfo } from './types.ts';

export interface AgentSelection {
  agent: string;
  model: string;
  effort: string;
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
