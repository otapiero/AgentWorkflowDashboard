import { randomUUID } from 'node:crypto';
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
import { getPhaseDefaults, getSettings, getT3ProjectId, setT3ProjectId } from './state.ts';
import { ensureWorktree } from './worktree.ts';
import { T3Client } from './t3/client.ts';
import {
  buildModelSelection,
  buildProjectCreateCommand,
  buildThreadCreateCommand,
  buildTurnStartCommand,
  type ModelSelection,
} from './t3/commands.ts';
import { readInstanceReadiness, type InstanceReadiness } from './t3/instances.ts';
import { findProjectForWorkspace } from './t3/facts.ts';
import { t3ModesForPhase } from '../shared/types.ts';
import type {
  AgentProfile,
  Config,
  Phase,
  PhaseConfig,
  SpawnRecord,
  T3PhaseModes,
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
  variables?: Record<string, string>;
}

function expandArg(value: string, variables: Record<string, string>): string {
  let expanded = value;
  for (const [name, replacement] of Object.entries(variables)) {
    expanded = expanded.split(`{{${name}}}`).join(replacement);
  }
  return expanded;
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
  const promptArgs =
    profile.promptMode === 'flag'
      ? [profile.promptFlag!, PROMPT_TOKEN]
      : [PROMPT_TOKEN];

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
    const value = profile.effortValueTemplate
      ? expandArg(profile.effortValueTemplate, { effort })
      : effort;
    args.push(caps.effortFlag, value);
  }

  if (profile.extraArgs?.length) {
    const variables = options.variables ?? {};
    args.push(...profile.extraArgs.map((arg) => expandArg(arg, variables)));
  }

  return profile.promptPosition === 'last'
    ? [...args, ...promptArgs]
    : [...promptArgs, ...args];
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
 * task.allowAutomaticTasks silences the "allow automatic tasks?" prompt, but as
 * a workspace-level setting it is ignored in Restricted Mode — which is why the
 * launch also has to turn trust off (see buildCodeArgs).
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

/**
 * Args for opening a path in VS Code with workspace trust off for that window.
 *
 * A fresh worktree is a folder VS Code has never seen, so it opens in Restricted
 * Mode and the trust prompt blocks the folderOpen task — the phase would sit
 * there doing nothing until the operator clicked through. MC created that
 * worktree itself from the repo the operator configured, so there is no unknown
 * author for the prompt to protect against.
 *
 * --disable-workspace-trust is a hidden flag (absent from `code --help`, present
 * in code 1.131.0) that turns trust off for the launched window only. It writes
 * nothing to VS Code's global state, so the operator's trust decisions for every
 * other folder stay exactly as they were.
 */
export function buildCodeArgs(
  target: string,
  options: { newWindow?: boolean } = {},
): string[] {
  const args = ['--disable-workspace-trust'];
  if (options.newWindow) args.push('--new-window');
  args.push(target);
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

export type T3LaunchPlan =
  | { ok: true; modelSelection: ModelSelection; modes: T3PhaseModes }
  | { ok: false; error: string };

/**
 * Can this phase run through T3, and with what?
 *
 * Pure, and separate from the launch itself, because every one of these
 * refusals should reach the card as a sentence rather than as a rejected
 * dispatch with a server-side message about an id the operator never typed.
 */
export function resolveT3Launch(input: {
  agent: string;
  profile: AgentProfile;
  phase: PhaseConfig;
  model: string | null;
  effort: string | null;
  readiness?: (instanceId: string) => InstanceReadiness;
}): T3LaunchPlan {
  const readiness = input.readiness ?? readInstanceReadiness;

  if (!input.profile.t3Instance) {
    return {
      ok: false,
      error: `Agent '${input.agent}' has no t3Instance in config.yaml, so it cannot run through T3 Code. Add one (for example t3Instance: 'codex') or pick a different launcher.`,
    };
  }

  const instance = readiness(input.profile.t3Instance);
  if (!instance.ready) {
    return {
      ok: false,
      error: `T3 cannot run '${input.agent}': ${instance.reason}`,
    };
  }

  const modelSelection = buildModelSelection(input.profile, {
    model: input.model,
    effort: input.effort,
  });
  if (!modelSelection) {
    return {
      ok: false,
      error: `T3 needs a specific model for '${input.agent}', but the resolved choice was '${input.model ?? 'none'}'. Pick a model in the drawer, or set one on the agent in config.yaml.`,
    };
  }

  return { ok: true, modelSelection, modes: t3ModesForPhase(input.phase) };
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
      variables: {
        taskDir: taskDir(task.issue),
        worktree: worktreePath(task.issue),
      },
    }),
    promptToken: PROMPT_TOKEN,
  };
  const specFile = writeSpec(spec);

  const launcher = getSettings().launcher ?? config.launcher ?? 'wt';

  let command: string;
  let threadId: string | undefined;

  if (launcher === 't3') {
    const plan = resolveT3Launch({ agent, profile, phase, model, effort });
    if (!plan.ok) throw new Error(plan.error);
    const launched = await launchT3(config, task, phase, { ...plan, prompt: promptText });
    command = launched.command;
    threadId = launched.threadId;
  } else if (launcher === 'vscode') {
    command = await launchVscode(config, task, phase, specFile);
  } else {
    command = launchWt(task, phase, config, specFile);
  }

  return {
    phase: phase.id,
    agent: describeAgent(agent, model, effort),
    startedAt: new Date().toISOString(),
    command,
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * T3 path: the worktree must exist before the thread binds to it, so it is
 * created here exactly as the vscode path does. T3 is never asked to create
 * one — it needs the worktree's path, not its authorship.
 *
 * Unlike wt and vscode this does not detach a terminal, so the dispatch is
 * awaited: an agent that could not start should fail the spawn loudly rather
 * than leaving a card that claims a run began.
 */
async function launchT3(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  plan: { modelSelection: ModelSelection; modes: T3PhaseModes; prompt: string },
  client: T3Client = new T3Client(),
): Promise<{ command: string; threadId: string }> {
  await ensureWorktree(config, task.issue, task.branch);

  const createdAt = new Date().toISOString();

  // The project is resolved once, lazily, and reused so every task's threads
  // group under one entry in T3's sidebar.
  //
  // Three steps in order, because T3 permits exactly one active project per
  // workspace root and answers a second `project.create` with a 500:
  //   1. what we already recorded,
  //   2. what T3 already has for this repo — the normal case, since adding the
  //      repo to T3 by hand is how anyone tries T3 out,
  //   3. only then, create one.
  let projectId = getT3ProjectId();

  if (!projectId) {
    projectId = findProjectForWorkspace(await client.fetchSnapshot(), config.repo.path);
    if (projectId) setT3ProjectId(projectId);
  }

  if (!projectId) {
    projectId = randomUUID();
    const created = await client.dispatch(
      buildProjectCreateCommand({
        commandId: randomUUID(),
        projectId,
        title: config.t3?.projectTitle ?? 'Acme',
        workspaceRoot: config.repo.path,
        createdAt,
      }),
    );
    if (!created.ok) throw new Error(`Could not create the T3 project: ${created.error}`);
    setT3ProjectId(projectId);

    // T3 0.0.31 has no preview panel, so the Mission Control project script is
    // deliberately not pushed here. See
    // docs/superpowers/notes/2026-08-07-t3-preview-panel-finding.md; the block
    // to add if a later release gains one is in Task 12 Step 5 of the plan.
  }

  // Create the thread, then start the turn in it. T3 rejects a turn for a
  // thread it does not already hold, and does not act on thread.turn.start's
  // own `bootstrap.createThread` over this path.
  const threadId = randomUUID();
  const thread = await client.dispatch(
    buildThreadCreateCommand({
      commandId: randomUUID(),
      threadId,
      projectId,
      title: `#${task.issue} ${phase.id}`,
      worktreePath: worktreePath(task.issue),
      branch: task.branch,
      modelSelection: plan.modelSelection,
      modes: plan.modes,
      createdAt,
    }),
  );
  if (!thread.ok) throw new Error(`Could not create the T3 thread: ${thread.error}`);

  const result = await client.dispatch(
    buildTurnStartCommand({
      commandId: randomUUID(),
      threadId,
      messageId: randomUUID(),
      // The same rendered text writePromptFile just persisted. Passing it
      // through rather than re-reading keeps the prompt file exactly what it
      // is for the other launchers: a record, not a channel.
      prompt: plan.prompt,
      modelSelection: plan.modelSelection,
      modes: plan.modes,
      createdAt,
    }),
  );
  if (!result.ok) throw new Error(`T3 did not start the phase: ${result.error}`);

  return {
    command: `t3 dispatch thread.turn.start (thread ${threadId})`,
    threadId,
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

  const codeArgs = buildCodeArgs(wsFile, { newWindow: true });
  detach('code', codeArgs);
  return `code ${codeArgs.join(' ')}`;
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
  detach('code', buildCodeArgs(path));
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
