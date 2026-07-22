import type {
  AgentProfile,
  Config,
  PhaseDefaults,
  TaskRecord,
} from '../shared/types.ts';

export interface ResolvedAgent {
  agent: string | null;
  model: string | null;
  effort: string | null;
}

export interface OneTime {
  agent?: string;
  model?: string;
  effort?: string;
}

/**
 * Built-in capabilities for the agents we ship, used when config.yaml does not
 * spell them out. Verified against the CLIs on 2026-07-22:
 *   claude 2.1.x  — model aliases; --effort low|medium|high|xhigh|max
 *   copilot 1.0.x — --model (auto|names); --effort none|minimal|low|…|max
 * config.yaml may override any of these per agent.
 */
const BUILT_IN: Record<
  string,
  { models: string[]; efforts: string[]; effortFlag?: string }
> = {
  claude: {
    models: ['default', 'opus', 'sonnet', 'haiku'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortFlag: '--effort',
  },
  copilot: {
    models: ['auto', 'gpt-5.6', 'sol-5.6', 'luna-5.6', 'terra-5.6'],
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    effortFlag: '--effort',
  },
};

export interface Capabilities {
  models: string[];
  efforts: string[];
  effortFlag: string | null;
  modelFlag: string | null;
  hasEffort: boolean;
}

/** Merge a profile's declared capabilities with the built-in fallback. */
export function agentCapabilities(name: string, profile: AgentProfile): Capabilities {
  const builtIn = BUILT_IN[name];
  const models = profile.models ?? builtIn?.models ?? [];
  const efforts = profile.efforts ?? builtIn?.efforts ?? [];
  const effortFlag = profile.effortFlag ?? builtIn?.effortFlag ?? null;
  const modelFlag = profile.modelFlag ?? '--model';
  return {
    models,
    efforts,
    effortFlag,
    modelFlag,
    hasEffort: effortFlag !== null && efforts.length > 0,
  };
}

/** First candidate that names a real configured agent, else null. */
function pickAgent(
  config: Config,
  candidates: Array<string | undefined>,
): string | null {
  return candidates.find((a) => a && config.agents[a]) ?? null;
}

/**
 * Decide the agent, model and effort a spawn should use.
 *
 * Precedence, strongest first: a one-time choice for this run, the task's own
 * pin, the phase default, then the phase's configured actor (agent only). A
 * candidate agent is accepted only if it names a real configured agent, so
 * stale state can never select one that no longer exists.
 */
export function resolveAgent(
  config: Config,
  task: TaskRecord,
  phaseId: string,
  phaseDefaults: PhaseDefaults,
  oneTime: OneTime = {},
): ResolvedAgent {
  const phase = config.pipeline.find((p) => p.id === phaseId);
  const pd = phaseDefaults[phaseId];

  const agent = pickAgent(config, [
    oneTime.agent,
    task.overrides?.agent,
    pd?.agent,
    phase?.actor,
  ]);
  if (!agent) return { agent: null, model: null, effort: null };

  const profile = config.agents[agent]!;
  const rawModel =
    oneTime.model ?? task.overrides?.model ?? pd?.model ?? profile.model;
  const model = !rawModel || rawModel === 'default' ? null : rawModel;

  const rawEffort =
    oneTime.effort ?? task.overrides?.effort ?? pd?.effort ?? profile.effort;
  const effort = rawEffort || null;

  return { agent, model, effort };
}
