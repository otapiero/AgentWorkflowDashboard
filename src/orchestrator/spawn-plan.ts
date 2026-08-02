import { resolveAgent } from './agents.ts';
import { buildPrompt } from './prompt.ts';
import { STANDING_RULES } from './spawn.ts';
import type {
  AgentProfile,
  Config,
  PhaseConfig,
  PhaseDefaults,
  TaskRecord,
} from '../shared/types.ts';

/**
 * Everything a spawn would use, resolved but not yet acted on.
 *
 * Preview and launch both go through here. If they resolved separately they
 * would eventually disagree, and a preview that lies about the prompt is worse
 * than showing nothing at all.
 */
export interface SpawnPlan {
  agent: string;
  model: string | null;
  effort: string | null;
  profile: AgentProfile;
  command: string;
  promptText: string;
}

export interface SpawnPlanOptions {
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

/**
 * `phaseDefaults` is passed in rather than read via getPhaseDefaults() here, so
 * this stays pure and testable without touching ~/.mc. Callers read it.
 */
export function resolveSpawnPlan(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  phaseDefaults: PhaseDefaults,
  options: SpawnPlanOptions = {},
): SpawnPlan {
  if (!phase.command) {
    throw new Error(`Phase '${phase.id}' has no command to render a prompt from.`);
  }

  const { agent, model, effort } = resolveAgent(config, task, phase.id, phaseDefaults, {
    agent: options.agent,
    model: options.model,
    effort: options.effort,
  });
  if (!agent) {
    throw new Error(
      `Phase '${phase.id}' has no agent to spawn. Pin one on the task or set a phase default.`,
    );
  }
  const profile = config.agents[agent]!;

  const promptText = buildPrompt(phase.command, task, {
    customInstructions: options.customInstructions ?? task.overrides?.instructions,
    // Agents without a system-prompt flag carry the rules in the prompt body.
    inlineInstructions: profile.instructionMode === 'inline' ? STANDING_RULES : undefined,
  });

  return { agent, model, effort, profile, command: phase.command, promptText };
}
