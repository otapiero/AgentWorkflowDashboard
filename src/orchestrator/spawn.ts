import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import { promptPath, runPhaseScript, taskDir, worktreePath } from './paths.ts';
import { buildPrompt, writePromptFile } from './prompt.ts';
import type {
  AgentProfile,
  Config,
  Phase,
  PhaseConfig,
  SpawnRecord,
  TaskRecord,
} from '../shared/types.ts';

/**
 * Launching an agent crash-safely.
 *
 * The app must never be the parent of an agent run — a child process dies with
 * its parent, and the whole design depends on a run surviving the app being
 * closed. So the app launches a detached Windows Terminal tab, records that it
 * did so, and then forgets: the outcome is learned only by reconciling durable
 * facts later.
 */

/** Placeholder the phase script swaps for the prompt file's contents. */
export const PROMPT_TOKEN = '__MC_PROMPT__';

/** Standing rules injected at spawn — never written into the project repo. */
export const STANDING_RULES = [
  'You are running inside a git worktree that Mission Control already prepared for you.',
  'Do NOT create branches or worktrees, and do not run git bookkeeping — that is handled for you.',
  'Work only inside the current directory.',
].join(' ');

export interface AgentArgOptions {
  instructions: string;
  model?: string;
}

/**
 * Build the agent's argument list.
 *
 * The two supported CLIs differ in both dimensions that matter, which is why
 * this is driven by the profile rather than hard-coded: `claude` takes its
 * prompt positionally and accepts --append-system-prompt, while `copilot`
 * takes -i <prompt> and has no system-prompt flag at all (verified against
 * claude 2.1.183 and copilot 1.0.73).
 */
export function buildAgentArgs(
  profile: AgentProfile,
  options: AgentArgOptions,
): string[] {
  const args: string[] = [];

  if (profile.promptMode === 'flag') {
    args.push(profile.promptFlag!, PROMPT_TOKEN);
  } else {
    args.push(PROMPT_TOKEN);
  }

  if (profile.instructionMode === 'flag' && options.instructions) {
    args.push(profile.instructionFlag!, options.instructions);
  }

  const model = options.model ?? profile.model;
  if (model && model !== 'default' && profile.modelFlag) {
    args.push(profile.modelFlag, model);
  }

  if (profile.extraArgs?.length) args.push(...profile.extraArgs);

  return args;
}

export interface WtOptions {
  issue: number;
  phase: string;
  /** Must already exist — the worktree may not, since the script creates it. */
  startDir: string;
  script: string;
  specFile: string;
}

export function buildWtArgs(options: WtOptions): string[] {
  return [
    'new-tab',
    '--title',
    `#${options.issue} ${options.phase}`,
    '-d',
    options.startDir,
    'pwsh',
    '-NoExit',
    '-File',
    options.script,
    '-SpecFile',
    options.specFile,
  ];
}

export interface SpawnSpec {
  issue: number;
  phase: Phase;
  branch: string;
  worktree: string;
  baseBranch: string;
  repoPath: string;
  promptFile: string;
  exe: string;
  args: string[];
  promptToken: string;
}

export function specPath(issue: number): string {
  return join(taskDir(issue), 'spawn.json');
}

export function writeSpec(spec: SpawnSpec): string {
  mkdirSync(taskDir(spec.issue), { recursive: true });
  const file = specPath(spec.issue);
  writeFileSync(file, JSON.stringify(spec, null, 2), 'utf8');
  return file;
}

export interface SpawnOptions {
  customInstructions?: string;
  agent?: string;
  model?: string;
}

/**
 * Prepare and launch a phase. Returns as soon as the tab is handed off; the
 * agent session is deliberately not awaited.
 */
export async function spawnPhase(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  options: SpawnOptions = {},
): Promise<SpawnRecord> {
  const agentName = options.agent ?? task.overrides?.agent ?? phase.actor;
  const profile = config.agents[agentName];
  if (!profile) {
    throw new Error(
      `Phase '${phase.id}' wants agent '${agentName}', which has no profile in config.yaml.`,
    );
  }
  if (!phase.command) {
    throw new Error(`Phase '${phase.id}' has no command to render a prompt from.`);
  }

  const promptText = buildPrompt(phase.command, task, {
    customInstructions:
      options.customInstructions ?? task.overrides?.instructions,
    // Agents without a system-prompt flag carry the rules in the prompt body.
    inlineInstructions:
      profile.instructionMode === 'inline' ? STANDING_RULES : undefined,
  });
  writePromptFile(task.issue, promptText);

  const spec: SpawnSpec = {
    issue: task.issue,
    phase: phase.id,
    branch: task.branch,
    worktree: worktreePath(task.issue),
    baseBranch: config.repo.baseBranch,
    repoPath: config.repo.path,
    promptFile: promptPath(task.issue),
    exe: profile.launch,
    args: buildAgentArgs(profile, {
      instructions: STANDING_RULES,
      model: options.model ?? task.overrides?.model,
    }),
    promptToken: PROMPT_TOKEN,
  };
  const specFile = writeSpec(spec);

  const wtArgs = buildWtArgs({
    issue: task.issue,
    phase: phase.id,
    startDir: config.repo.path,
    script: runPhaseScript(),
    specFile,
  });

  // Detached and fully disowned: this must outlive the app.
  const child = execa('wt', wtArgs, {
    detached: true,
    stdio: 'ignore',
    cleanup: false,
  });
  child.unref();
  child.catch(() => {
    // The tab is fire-and-forget; failures surface through reconciliation.
  });

  return {
    phase: phase.id,
    agent: agentName,
    startedAt: new Date().toISOString(),
    command: `wt ${wtArgs.join(' ')}`,
  };
}
