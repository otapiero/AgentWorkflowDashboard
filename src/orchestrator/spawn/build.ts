import { agentCapabilities } from '../agents.ts';
import type { AgentProfile } from '../../shared/types.ts';

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

/** A custom run's prompt, flattened and clipped for the history list. */
export function summarisePrompt(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
