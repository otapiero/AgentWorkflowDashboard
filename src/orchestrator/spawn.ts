import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import {
  markerPath,
  promptPath,
  runPhaseScript,
  taskDir,
  worktreePath,
} from './paths.ts';
import { writePromptFile } from './prompt.ts';
import {
  readArtifacts,
  resolveArtifactStoredPath,
  writePlanSnapshot,
} from './artifacts.ts';
import { agentCapabilities } from './agents.ts';
import { resolveSpawnPlan } from './spawn-plan.ts';
import { getPhaseDefaults, getSettings } from './state.ts';
import { ensureWorktree } from './worktree.ts';
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
  effort?: string;
}

/**
 * Build the agent's argument list.
 *
 * The two supported CLIs differ in the dimensions that matter, which is why
 * this is driven by the profile rather than hard-coded: `claude` takes its
 * prompt positionally and accepts --append-system-prompt, while `copilot`
 * takes -i <prompt> and has no system-prompt flag at all (verified against
 * claude 2.1.183 and copilot 1.0.73). Both accept --model and --effort.
 */
export function buildAgentArgs(
  name: string,
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

  // Resolve the model/effort flags through the same built-in fallback the
  // pickers use, so a config that omits effortFlag still spawns with the flag
  // the CLI expects. Reading profile.effortFlag directly would silently drop
  // the effort the card shows and let the CLI fall back to its own default.
  const caps = agentCapabilities(name, profile);

  const model = options.model ?? profile.model;
  if (model && model !== 'default' && caps.modelFlag) {
    args.push(caps.modelFlag, model);
  }

  const effort = options.effort ?? profile.effort;
  if (effort && caps.effortFlag) {
    args.push(caps.effortFlag, effort);
  }

  if (profile.extraArgs?.length) args.push(...profile.extraArgs);

  return args;
}

export interface CodeWorkspaceOptions {
  issue: number;
  phase: string;
  worktree: string;
  script: string;
  specFile: string;
  /** File the phase run touches once so a re-open of the workspace is a no-op. */
  guardFile: string;
}

interface CodeWorkspace {
  folders: Array<{ path: string }>;
  settings: Record<string, unknown>;
  tasks: {
    version: string;
    tasks: Array<{
      label: string;
      type: string;
      command: string;
      args: string[];
      presentation: Record<string, unknown>;
      runOptions: { runOn: string };
      problemMatcher: string[];
    }>;
  };
}

/**
 * A VS Code workspace that opens the worktree and runs the phase in the
 * integrated terminal on open.
 *
 * The task is defined in the workspace file itself, never in the worktree's
 * .vscode folder, so opening in VS Code leaves no footprint in the checkout.
 * VS Code asks to allow automatic tasks the first time; after that it runs on
 * open.
 *
 * folderOpen fires on *every* open, including VS Code restoring the window on
 * startup, so the task alone would re-run the agent each time. The guard file
 * is how run-phase.ps1 tells a fresh launch apart from a re-open: it runs the
 * agent only when the file is absent, and Mission Control removes the file when
 * it deliberately launches the phase again.
 */
export function buildCodeWorkspace(options: CodeWorkspaceOptions): CodeWorkspace {
  return {
    folders: [{ path: options.worktree }],
    settings: { 'task.allowAutomaticTasks': 'on' },
    tasks: {
      version: '2.0.0',
      tasks: [
        {
          label: `Mission Control #${options.issue} ${options.phase}`,
          type: 'process',
          command: 'pwsh',
          args: [
            '-NoExit',
            '-File',
            options.script,
            '-SpecFile',
            options.specFile,
            '-GuardFile',
            options.guardFile,
          ],
          presentation: { reveal: 'always', panel: 'dedicated', focus: true },
          runOptions: { runOn: 'folderOpen' },
          problemMatcher: [],
        },
      ],
    },
  };
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
  effort?: string;
}

function codeWorkspacePath(issue: number): string {
  return join(taskDir(issue), `mc-${issue}.code-workspace`);
}

/** launch descriptor, so the launcher choice is testable and the record honest. */
function describeAgent(agent: string, model: string | null, effort: string | null): string {
  const extras = [model, effort ? `effort ${effort}` : null].filter(Boolean);
  return extras.length ? `${agent} (${extras.join(', ')})` : agent;
}

/**
 * Prepare and launch a phase. Returns as soon as the terminal is handed off;
 * the agent session is deliberately not awaited.
 */
export async function spawnPhase(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  options: SpawnOptions = {},
): Promise<SpawnRecord> {
  const { agent, model, effort, profile, promptText } = resolveSpawnPlan(
    config,
    task,
    phase,
    getPhaseDefaults(),
    {
      customInstructions: options.customInstructions,
      agent: options.agent,
      model: options.model,
      effort: options.effort,
    },
  );
  writePromptFile(task.issue, promptText);

  // Record the "before" picture so a plan run's artifacts can be attributed to
  // it later. Only the plan phase produces the artifacts we capture.
  if (phase.id === 'plan') writePlanSnapshot(config, task.issue);

  const spec: SpawnSpec = {
    issue: task.issue,
    phase: phase.id,
    branch: task.branch,
    worktree: worktreePath(task.issue),
    baseBranch: config.repo.baseBranch,
    repoPath: config.repo.path,
    promptFile: promptPath(task.issue),
    exe: profile.launch,
    args: buildAgentArgs(agent, profile, {
      instructions: STANDING_RULES,
      model: model ?? undefined,
      effort: effort ?? undefined,
    }),
    promptToken: PROMPT_TOKEN,
  };
  const specFile = writeSpec(spec);

  const launcher = getSettings().launcher ?? config.launcher ?? 'wt';
  const command =
    launcher === 'vscode'
      ? await launchVscode(config, task, phase, specFile)
      : launchWt(task, phase, config, specFile);

  return {
    phase: phase.id,
    agent: describeAgent(agent, model, effort),
    startedAt: new Date().toISOString(),
    command,
  };
}

function launchWt(
  task: TaskRecord,
  phase: PhaseConfig,
  config: Config,
  specFile: string,
): string {
  const wtArgs = buildWtArgs({
    issue: task.issue,
    phase: phase.id,
    startDir: config.repo.path,
    script: runPhaseScript(),
    specFile,
  });
  detach('wt', wtArgs);
  return `wt ${wtArgs.join(' ')}`;
}

/**
 * VS Code path: the worktree must exist before VS Code opens on it (the
 * folder-open task cannot create the folder it opens), so it is created
 * deterministically here rather than by the terminal script.
 */
async function launchVscode(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  specFile: string,
): Promise<string> {
  await ensureWorktree(config, task.issue, task.branch);

  // This is a deliberate launch, so clear any guard left by a previous run —
  // otherwise the phase script would treat this as a re-open and skip the agent.
  const guardFile = markerPath(task.issue, `${phase.id}.vscode-launched`);
  rmSync(guardFile, { force: true });

  const workspace = buildCodeWorkspace({
    issue: task.issue,
    phase: phase.id,
    worktree: worktreePath(task.issue),
    script: runPhaseScript(),
    specFile,
    guardFile,
  });
  const wsFile = codeWorkspacePath(task.issue);
  writeFileSync(wsFile, JSON.stringify(workspace, null, 2), 'utf8');

  detach('code', ['--new-window', wsFile]);
  return `code --new-window ${wsFile}`;
}

/**
 * Open the task's worktree folder in VS Code, without running anything.
 *
 * This is just a shortcut to the checkout, so unlike a spawn it does not create
 * the worktree — there is nothing to open until a phase has run once. Opening a
 * plain folder (not the phase workspace) is deliberate: the operator wants to
 * look at or edit the code, not launch an agent.
 */
export function openWorktreeInVscode(issue: number): void {
  const path = worktreePath(issue);
  if (!existsSync(path)) {
    throw new Error(
      `No worktree yet for issue ${issue}. Run a phase first — that is what creates the checkout.`,
    );
  }
  detach('code', [path]);
}

/**
 * Open a collected artifact's stored copy in the editor. The name must be in
 * the manifest — that lookup is the path-traversal guard, since only names MC
 * itself wrote can resolve.
 */
export function openArtifactInEditor(issue: number, name: string): void {
  const path = resolveArtifactStoredPath(issue, name, readArtifacts(issue));
  if (!path || !existsSync(path)) {
    throw new Error(`No collected artifact named '${name}' for issue ${issue}.`);
  }
  detach('code', [path]);
}

/** Launch detached and fully disowned; the terminal must outlive the app. */
function detach(exe: string, args: string[]): void {
  const child = execa(exe, args, { detached: true, stdio: 'ignore', cleanup: false });
  child.unref();
  child.catch(() => {
    // Fire-and-forget; failures surface through reconciliation.
  });
}
