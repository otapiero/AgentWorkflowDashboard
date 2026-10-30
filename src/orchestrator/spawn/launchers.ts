import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

import { markerPath, runPhaseScript, taskDir, worktreePath } from '../paths.ts';
import { readArtifacts, resolveArtifactStoredPath } from '../artifacts.ts';
import { ensureWorktree } from '../worktree.ts';
import { buildCodeArgs, buildCodeWorkspace, buildWtArgs } from './build.ts';
import type { ExecutionTarget } from '../execution-target.ts';
import type { Config, PhaseConfig, TaskRecord } from '../../shared/types.ts';

function codeWorkspacePath(issue: number): string {
  return join(taskDir(issue), `mc-${issue}.code-workspace`);
}

export function launchWt(
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
export async function launchVscode(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  specFile: string,
  target?: ExecutionTarget,
  launchToken?: string,
): Promise<string> {
  if (!target?.layerKey) await ensureWorktree(config, task.issue, task.branch);

  // This is a deliberate launch, so clear any guard left by a previous run —
  // otherwise the phase script would treat this as a re-open and skip the agent.
  const guardFile = launchToken ? join(taskDir(task.issue), 'runs', launchToken, 'vscode-launched') : markerPath(task.issue, `${phase.id}.vscode-launched`);
  rmSync(guardFile, { force: true });

  const workspace = buildCodeWorkspace({
    issue: task.issue,
    phase: phase.id,
    worktree: target?.worktreePath ?? worktreePath(task.issue),
    script: runPhaseScript(),
    specFile,
    guardFile,
  });
  const wsFile = launchToken ? join(taskDir(task.issue), 'runs', launchToken, 'workspace.code-workspace') : codeWorkspacePath(task.issue);
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
export function openWorktreeInVscode(issue: number, workspace?: string): void {
  const path = workspace ?? worktreePath(issue);
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
  child.nodeChildProcess.unref();
  child.catch(() => {
    // Fire-and-forget; failures surface through reconciliation.
  });
}
