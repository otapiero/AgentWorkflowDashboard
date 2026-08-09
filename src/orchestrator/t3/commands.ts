import type { AgentProfile, T3PhaseModes } from '../../shared/types.ts';

/**
 * The commands Mission Control sends to T3 Code, as plain data.
 *
 * Pure by design: every payload here was checked against the schemas in T3
 * 0.0.31's shipped bundle, and keeping them free of I/O is what lets that
 * check be a unit test rather than an integration one.
 *
 * All ids are caller-supplied. T3 treats them as opaque non-empty strings, so
 * crypto.randomUUID() is the natural choice and command ids stay idempotency
 * keys the caller controls.
 */

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string }>;
}

/**
 * Render the resolved agent/model/effort as a T3 ModelSelection.
 *
 * The sibling of buildAgentArgs: the same three-tier resolution feeds both,
 * and only the output format differs. Returns null when the choice cannot be
 * expressed — an agent with no t3Instance, or no concrete model — so the
 * caller can say why instead of sending a dispatch that will be rejected.
 */
export function buildModelSelection(
  profile: AgentProfile,
  opts: { model?: string | null; effort?: string | null },
): ModelSelection | null {
  const instanceId = profile.t3Instance;
  if (!instanceId) return null;

  const model = opts.model ?? profile.model ?? null;
  // 'default' is Mission Control's own "let the CLI decide" sentinel. T3
  // requires a real model name, so there is nothing to send.
  if (!model || model === 'default') return null;

  const selection: ModelSelection = { instanceId, model };
  if (opts.effort) selection.options = [{ id: 'effort', value: opts.effort }];
  return selection;
}

export function buildProjectCreateCommand(input: {
  commandId: string;
  projectId: string;
  title: string;
  workspaceRoot: string;
  createdAt: string;
}): unknown {
  return {
    type: 'project.create',
    commandId: input.commandId,
    projectId: input.projectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    createdAt: input.createdAt,
  };
}

export interface ThreadCreateInput {
  commandId: string;
  threadId: string;
  projectId: string;
  title: string;
  worktreePath: string;
  branch: string;
  modelSelection: ModelSelection;
  modes: T3PhaseModes;
  createdAt: string;
}

/**
 * Create the thread the turn will run in.
 *
 * This is a separate dispatch rather than `thread.turn.start`'s
 * `bootstrap.createThread`, because a live T3 0.0.32 refused the one-dispatch
 * form:
 *
 *   OrchestrationCommandInvariantError, commandType 'thread.turn.start',
 *   "Thread 'b21d313d-…' does not exist for command 'thread.turn.start'."
 *
 * The bootstrap field is in T3's schema and every field sent matched it, so
 * this is not a payload error — the dispatch path simply does not act on
 * bootstrap. `thread.create` takes exactly the same fields, so creating first
 * is both what the server asks for and one command per concern.
 *
 * The worktree already exists, because Mission Control created it, and T3 is
 * never asked to prepare one: `prepareWorktree` hard-codes path: null and picks
 * its own directory under ~/.t3/worktrees, which would turn the checkout
 * location into a lookup instead of a derivation from the issue number.
 */
export function buildThreadCreateCommand(input: ThreadCreateInput): unknown {
  return {
    type: 'thread.create',
    commandId: input.commandId,
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.modes.runtimeMode,
    interactionMode: input.modes.interactionMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
    createdAt: input.createdAt,
  };
}

export interface TurnStartInput {
  commandId: string;
  threadId: string;
  messageId: string;
  prompt: string;
  modelSelection: ModelSelection;
  modes: T3PhaseModes;
  createdAt: string;
}

/**
 * Start the turn in a thread that already exists.
 *
 * Both modes are sent explicitly even though the thread already carries them:
 * T3's decoding default for `runtimeMode` is `full-access`, so an omitted field
 * does not mean "inherit", it means "no restrictions".
 */
export function buildTurnStartCommand(input: TurnStartInput): unknown {
  return {
    type: 'thread.turn.start',
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: 'user',
      text: input.prompt,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimeMode: input.modes.runtimeMode,
    interactionMode: input.modes.interactionMode,
    createdAt: input.createdAt,
  };
}

/**
 * The project script that would surface the board inside T3.
 *
 * Currently unused by the spawn path. T3 0.0.31 exposes no preview-URL field
 * on project scripts, so there is no panel to render into — see
 * docs/superpowers/notes/2026-08-07-t3-preview-panel-finding.md. This is kept
 * because it is cheap, because its tests pin the payload shape against a
 * schema read from T3's own bundle, and because the day a release adds a
 * preview panel the only change needed is to call it.
 *
 * Pushed through project.meta.update rather than written as a t3.json into the
 * Acme checkout — that is the zero-footprint principle applied to a file T3
 * would otherwise expect to find in the repo.
 *
 * The command is a health probe, not a launcher, because T3 runs scripts in a
 * worktree-scoped terminal: starting the board there would tie its lifetime to
 * a single thread. It probes /api/health, not /health: the latter is not a
 * route, so it falls through to the SPA not-found handler and returns
 * index.html with a 200, making `curl -sf` succeed while proving nothing.
 */
export function buildMissionControlScript(boardUrl: string): unknown {
  return {
    id: 'mission-control',
    name: 'Mission Control',
    icon: 'configure',
    command: `curl -sf ${boardUrl}/api/health || echo "Mission Control is not running"`,
    runOnWorktreeCreate: false,
    previewUrl: boardUrl,
    autoOpenPreview: true,
  };
}

/**
 * Push project scripts without touching anything else.
 *
 * Every other field on project.meta.update is optional, and T3 applies exactly
 * what it receives — so sending `title` or `workspaceRoot` here would overwrite
 * whatever the operator has since set inside T3.
 */
export function buildProjectScriptsUpdateCommand(input: {
  commandId: string;
  projectId: string;
  scripts: unknown[];
}): unknown {
  return {
    type: 'project.meta.update',
    commandId: input.commandId,
    projectId: input.projectId,
    scripts: input.scripts,
  };
}
