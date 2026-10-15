import { resolveAgent } from './agents.ts';
import { buildPrompt } from './prompt.ts';
import { pipelineWith } from '../shared/custom-run.ts';
import { STANDING_RULES } from './spawn/build.ts';
import { resolveExecutionTarget, type ExecutionTarget } from './execution-target.ts';
import type {
  AgentProfile,
  ArtifactRef,
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
  target: ExecutionTarget;
  agent: string;
  model: string | null;
  effort: string | null;
  profile: AgentProfile;
  command: string;
  promptText: string;
}

export interface SpawnPlanOptions {
  layerKey?: string;
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
  /** Collected artifacts, rendered into the prompt's {{artifacts}}. */
  artifacts?: readonly ArtifactRef[];
  /**
   * Bypass the command file entirely: this text *is* the prompt body. Set when
   * a custom run is launched with issue context turned off.
   */
  rawPrompt?: string;
}

/**
 * `phaseDefaults` is passed in rather than read via getPhaseDefaults() here, so
 * this stays pure and testable without touching ~/.mission-control. Callers read it.
 */
export function resolveSpawnPlan(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  phaseDefaults: PhaseDefaults,
  options: SpawnPlanOptions = {},
): SpawnPlan {
  const target = resolveExecutionTarget(config, task, options.layerKey, phase.id === 'plan');
  // The phase is spliced into the pipeline for the lookup, so a synthetic
  // phase's actor is reachable. A configured phase is already there, so this
  // is a no-op for every pipeline run.
  const { agent, model, effort } = resolveAgent(
    { ...config, pipeline: pipelineWith(config.pipeline, phase) },
    task,
    phase.id,
    phaseDefaults,
    { agent: options.agent, model: options.model, effort: options.effort },
  );
  if (!agent) {
    throw new Error(
      `Phase '${phase.id}' has no agent to spawn. Pin one on the task or set a phase default.`,
    );
  }
  const profile = config.agents[agent]!;
  // Agents without a system-prompt flag carry the rules in the prompt body.
  const inline = profile.instructionMode === 'inline' ? STANDING_RULES : undefined;

  // A raw prompt is the operator's text and nothing else — no command file is
  // read, so a phase without one is fine here even though it never is below.
  if (options.rawPrompt !== undefined) {
    const body = options.rawPrompt.trim();
    return {
      target,
      agent,
      model,
      effort,
      profile,
      command: 'raw',
      promptText: inline ? `${inline}\n\n${body}` : body,
    };
  }

  if (!phase.command) {
    throw new Error(`Phase '${phase.id}' has no command to render a prompt from.`);
  }

  let promptText = buildPrompt(phase.command, { ...task, branch: target.branch, worktree: target.worktreePath }, {
    customInstructions: options.customInstructions ?? task.overrides?.instructions,
    inlineInstructions: inline,
    artifacts: options.artifacts,
    doneMarkerName: `${phase.id}.done`,
    repo: {
      owner: config.repo.owner,
      name: config.repo.name,
      baseBranch: target.baseBranch,
      path: config.repo.path,
    },
  });

  if (target.prNumber) promptText = `Target PR #${target.prNumber}: ${target.branch} -> ${target.baseBranch}\nCheckout: ${target.worktreePath}\nStack: ${(task.stack?.layers ?? []).map(p => `#${p.number} (${p.headBranch} -> ${p.baseBranch})`).join(', ')}\nWork on this PR only. Preserve its actual base branch.\n\n${promptText}`;
  return { target, agent, model, effort, profile, command: phase.command, promptText };
}
