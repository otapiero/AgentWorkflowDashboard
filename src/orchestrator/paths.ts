import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Absolute paths for everything Mission Control owns at runtime.
 *
 * All of it lives under a personal home folder, never inside the Acme
 * checkout — that separation is the zero-footprint guarantee, so it is
 * expressed here once rather than reconstructed at each call site.
 *
 * MC_HOME overrides the location, which is what lets tests run against a
 * temp directory instead of the real home folder.
 */
export function mcHome(): string {
  return process.env.MC_HOME ?? join(homedir(), '.mc');
}

export function configPath(): string {
  return join(mcHome(), 'config.yaml');
}

export function statePath(): string {
  return join(mcHome(), 'state.json');
}

export function scriptsDir(): string {
  return join(mcHome(), 'scripts');
}

export function runPhaseScript(): string {
  return join(scriptsDir(), 'run-phase.ps1');
}

export function tasksDir(): string {
  return join(mcHome(), 'tasks');
}

export function taskDir(issue: number): string {
  return join(tasksDir(), String(issue));
}

export function markersDir(issue: number): string {
  return join(taskDir(issue), 'markers');
}

export function markerPath(issue: number, name: string): string {
  return join(markersDir(issue), name);
}

/** The durable plan artifact — the fact that makes the plan phase crash-safe. */
export function planPath(issue: number): string {
  return join(taskDir(issue), 'plan.md');
}

/** Rendered prompt for the next spawn; overwritten each time. */
export function promptPath(issue: number): string {
  return join(taskDir(issue), 'prompt.txt');
}

export function worktreesDir(): string {
  return join(mcHome(), 'worktrees');
}

export function worktreePath(issue: number): string {
  return join(worktreesDir(), `issue-${issue}`);
}

/** Where install.ps1 places the user-scoped Claude command files. */
export function claudeCommandsDir(): string {
  return process.env.MC_CLAUDE_COMMANDS ?? join(homedir(), '.claude', 'commands');
}

export function claudeCommandPath(command: string): string {
  return join(claudeCommandsDir(), `${command}.md`);
}
