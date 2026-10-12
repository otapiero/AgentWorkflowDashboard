import { randomUUID } from 'node:crypto';

import { worktreePath } from '../paths.ts';
import { getT3ProjectId, setT3ProjectId } from '../state.ts';
import { ensureWorktree } from '../worktree.ts';
import { T3Client } from '../t3/client.ts';
import {
  buildModelSelection,
  buildProjectCreateCommand,
  buildThreadCreateCommand,
  buildTurnStartCommand,
  offeredEfforts,
  resolveInstanceModel,
  type ModelSelection,
} from '../t3/commands.ts';
import { readInstanceReadiness, type InstanceReadiness } from '../t3/instances.ts';
import { findProjectForWorkspace } from '../t3/facts.ts';
import { t3ModesForPhase } from '../../shared/types.ts';
import type {
  AgentProfile,
  Config,
  PhaseConfig,
  T3PhaseModes,
  TaskRecord,
} from '../../shared/types.ts';

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

  const named = buildModelSelection(input.profile, { model: input.model });
  if (!named) {
    return {
      ok: false,
      error: `T3 needs a specific model for '${input.agent}', but the resolved choice was '${input.model ?? 'none'}'. Pick a model in the drawer, or set one on the agent in config.yaml.`,
    };
  }

  // The readiness check above already read the instance's model slugs; using
  // them here is what stops a name from the agent's CLI vocabulary reaching
  // T3 as a dispatch it can only reject.
  const resolved = resolveInstanceModel(named.model, instance.models);
  if (!resolved.ok) {
    return {
      ok: false,
      error: `T3 cannot run '${input.agent}' on provider instance '${input.profile.t3Instance}': ${resolved.error}`,
    };
  }

  // Effort is resolved against the *resolved* slug, because the option ids and
  // the levels on offer belong to the model T3 will actually run, not to the
  // name the agent's config uses for it.
  const descriptors = instance.options?.[resolved.model];
  const modelSelection = buildModelSelection(input.profile, {
    model: resolved.model,
    effort: input.effort,
    descriptors,
  });
  if (!modelSelection) {
    return {
      ok: false,
      error: `T3 needs a specific model for '${input.agent}', but the resolved choice was '${input.model ?? 'none'}'. Pick a model in the drawer, or set one on the agent in config.yaml.`,
    };
  }
  if (input.effort && !modelSelection.options) {
    const offered = offeredEfforts(descriptors);
    return {
      ok: false,
      error: `T3's '${resolved.model}' does not offer effort '${input.effort}'.${
        offered.length ? ` It offers: ${offered.join(', ')}.` : ''
      } Pick a different effort in the drawer, or fix the agent's efforts list in config.yaml.`,
    };
  }

  return {
    ok: true,
    modelSelection,
    modes: t3ModesForPhase(input.phase),
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
export async function launchT3(
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
        title: config.t3?.projectTitle ?? config.repo.name,
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
