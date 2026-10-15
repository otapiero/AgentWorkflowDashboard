import { existsSync, readFileSync, rmSync } from 'node:fs';

import { mcHome, runPhaseScript, runSnapshotPath, taskDir } from '../paths.ts';
import { writePromptFile } from '../prompt.ts';
import { readArtifacts, writeRunSnapshot } from '../artifacts.ts';
import { isCustomRun } from '../../shared/custom-run.ts';
import { resolveSpawnPlan } from '../spawn-plan.ts';
import { getPhaseDefaults, getSettings } from '../state.ts';
import { ensureWorktree } from '../worktree.ts';
import { validateT3Prompt } from '../t3/commands.ts';
import { PROMPT_TOKEN, STANDING_RULES, buildAgentArgs, summarisePrompt } from './build.ts';
import { launchVscode, launchWt } from './launchers.ts';
import { writeSpec, type SpawnSpec } from './spec.ts';
import { launchT3, resolveT3Launch } from './t3.ts';
import type { Config, PhaseConfig, SpawnRecord, TaskRecord } from '../../shared/types.ts';
import { ensureLayerWorktree } from '../layer-worktrees.ts';
import { assertLaunchReservation, withIssueLaunch } from '../launch-lock.ts';

/**
 * Launching an agent crash-safely.
 *
 * The app must never be the parent of an agent run — a child process dies with
 * its parent, and the whole design depends on a run surviving the app being
 * closed. So the app launches a detached Windows Terminal tab, records that it
 * did so, and then forgets: the outcome is learned only by reconciling durable
 * facts later.
 */

export interface SpawnOptions {
  layerKey?: string;
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
  /** Bypass the command file: this text is the whole prompt body. */
  rawPrompt?: string;
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
  return withIssueLaunch(task, token => launchPhase(config, task, phase, options, token));
}

async function launchPhase(config: Config, task: TaskRecord, phase: PhaseConfig, options: SpawnOptions, launchToken: string): Promise<SpawnRecord> {
  const { target, agent, model, effort, profile, promptText } = resolveSpawnPlan(
    config,
    task,
    phase,
    getPhaseDefaults(),
    {
      layerKey: options.layerKey,
      customInstructions: options.customInstructions,
      agent: options.agent,
      model: options.model,
      effort: options.effort,
      rawPrompt: options.rawPrompt,
      // What earlier runs produced, so this one can build on it.
      artifacts: readArtifacts(task.issue),
    },
  );

  const launcher = getSettings().launcher ?? config.launcher ?? 'wt';
  if (launcher !== 't3') {
    let script = '';
    try { script = readFileSync(runPhaseScript(), 'utf8'); } catch { /* Explain the installation step below. */ }
    if (!script.includes('# mc-launch-protocol: 2')) throw new Error('Installed phase scripts need updating. Run powershell -File scripts/install.ps1 before launching');
  }
  const t3Plan = launcher === 't3'
    ? resolveT3Launch({ agent, profile, phase, model, effort })
    : undefined;
  if (t3Plan && !t3Plan.ok) throw new Error(t3Plan.error);
  if (launcher === 't3') validateT3Prompt(promptText);
  // Never snapshot a checkout while git is still populating it.
  if (target.layerKey || (task.stack?.layers.length && existsSync(target.worktreePath))) await ensureLayerWorktree(config, task, target);
  else if (task.stack?.layers.length || launcher === 't3' || launcher === 'vscode') {
    await ensureWorktree(config, task.issue, task.branch);
  }
  assertLaunchReservation(task.issue, launchToken);
  const promptFile = writePromptFile(task.issue, promptText, launchToken);

  // Snapshot the "before" picture for the runs whose output we capture. A
  // custom run counts: research and specs are exactly what should reach the
  // doc rail. Implement and the review fixers are not — their output is code.
  if (phase.id === 'plan' || isCustomRun(phase)) {
    writeRunSnapshot(config, task.issue, phase.id, target.worktreePath);
  }

  const spec: SpawnSpec = {
    launchToken,
    issue: task.issue,
    phase: phase.id,
    branch: target.branch,
    worktree: target.worktreePath,
    baseBranch: target.baseBranch,
    repoPath: config.repo.path,
    mcHome: mcHome(),
    promptFile,
    exe: profile.launch,
    args: buildAgentArgs(agent, profile, {
      instructions: STANDING_RULES,
      model: model ?? undefined,
      effort: effort ?? undefined,
      variables: {
        taskDir: taskDir(task.issue),
        worktree: target.worktreePath,
      },
    }),
    promptToken: PROMPT_TOKEN,
  };
  const specFile = writeSpec(spec);

  let command: string;
  let threadId: string | undefined;

  if (launcher === 't3') {
    if (!t3Plan?.ok) throw new Error('T3 launch was not resolved.');
    let launched;
    try {
      launched = await launchT3(config, task, phase, { ...t3Plan, prompt: promptText, target });
    } catch (error) {
      rmSync(runSnapshotPath(task.issue, phase.id), { force: true });
      throw error;
    }
    command = launched.command;
    threadId = launched.threadId;
  } else if (launcher === 'vscode') {
    command = await launchVscode(config, task, phase, specFile, target, launchToken);
  } else {
    command = launchWt(task, phase, config, specFile);
  }

  const summary = isCustomRun(phase)
    ? summarisePrompt(options.rawPrompt ?? options.customInstructions ?? '')
    : '';

  return {
    ...(target.layerKey ? { layerKey: target.layerKey, workspacePath: target.worktreePath } : {}),
    phase: phase.id,
    agent: describeAgent(agent, model, effort),
    startedAt: new Date().toISOString(),
    command,
    ...(threadId ? { threadId } : {}),
    ...(summary ? { promptSummary: summary } : {}),
  };
}
