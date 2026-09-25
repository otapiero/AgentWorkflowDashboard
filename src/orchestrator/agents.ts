import type {
  AgentProfile,
  Config,
  PhaseDefaults,
  TaskRecord,
} from '../shared/types.ts';
import { resolveAgentValues } from '../shared/agent-selection.ts';
import { discoverModels } from './model-discovery.ts';

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
 * spell them out. The model lists are a fallback only: the live list comes
 * from ./model-discovery.ts whenever T3 has one on disk. Codex uses -c with an effort value template because its CLI
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
    models: [
      'default', 'opus', 'sonnet', 'haiku',
      'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5',
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortFlag: '--effort',
  },
  copilot: {
    models: [
      'auto', 'claude-opus-5.5', 'claude-sonnet-5', 'gpt-6-sol', 'gpt-6-luna',
      'gpt-6-astra', 'gpt-5.3-codex', 'gemini-3.8-flash', 'grok-4.7', 'kimi-k3',
      'mai-code-1.1-flash',
    ],
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    effortFlag: '--effort',
  },
  codex: {
    models: ['default', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
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

/**
 * Merge a profile's declared capabilities with what the agent's account offers
 * right now, then the built-in fallback. A `models` list in config.yaml still
 * wins, for an operator who wants to pin the picker by hand.
 */
export function agentCapabilities(name: string, profile: AgentProfile): Capabilities {
  const builtIn = BUILT_IN[name];
  const models =
    profile.models ?? discoverModels(name, profile.t3Instance) ?? builtIn?.models ?? [];
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
