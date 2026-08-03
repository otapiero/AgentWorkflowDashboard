import type {
  AgentProfile,
  Config,
  PhaseDefaults,
  TaskRecord,
} from '../shared/types.ts';
import { resolveAgentValues } from '../shared/agent-selection.ts';

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
 * spell them out. Codex uses -c with an effort value template because its CLI
 * exposes reasoning effort as a config override rather than a dedicated flag.
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
    models: ['auto', 'claude-sonnet-5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra'],
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    effortFlag: '--effort',
  },
  codex: {
    models: ['default', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    effortFlag: '-c',
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
  return resolveAgentValues({
    pipeline: config.pipeline,
    agents: Object.entries(config.agents).map(([name, profile]) => {
      const capabilities = agentCapabilities(name, profile);
      return { name, models: capabilities.models, efforts: capabilities.efforts, hasEffort: capabilities.hasEffort, defaultModel: profile.model, defaultEffort: profile.effort };
    }),
    phaseDefaults,
  }, task, phaseId, oneTime);
}
