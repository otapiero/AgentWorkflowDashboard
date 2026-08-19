import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Absolute paths for everything Mission Control owns at runtime.
 *
 * Two levels, and the split is the whole design:
 *
 *   mcRoot()   the install. Shared phase scripts and the T3 pairing
 *              credential — things that belong to this machine, not to any
 *              one repository.
 *   mcHome()   one project. config.yaml, state.json, tasks/, worktrees/ —
 *              everything that is about a single repository.
 *
 * None of it is ever inside a project checkout; that separation is the
 * zero-footprint guarantee, so it is expressed here once rather than
 * reconstructed at each call site.
 *
 * Three env overrides, each with a distinct job:
 *   MC_ROOT     relocates the install (tests, and anyone with an unusual home).
 *   MC_PROJECT  selects the active project for one process.
 *   MC_HOME     replaces the project home outright, bypassing the project
 *               lookup entirely. This is what lets a test point at a temp
 *               directory without inventing a project first.
 */
export function mcRoot(): string {
  return process.env.MC_ROOT ?? join(homedir(), '.mission-control');
}

export function projectsDir(): string {
  return join(mcRoot(), 'projects');
}

/**
 * Directory-safe identity for one repository.
 *
 * Owner is included because repository names are only unique within an owner —
 * two `app` repos under different orgs must not share a state file. The double
 * underscore is a separator no GitHub name can contain, so the slug can be read
 * back apart unambiguously.
 */
export function projectSlug(owner: string, name: string): string {
  const clean = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
  return `${clean(owner)}__${clean(name)}`;
}

export function projectHome(slug: string): string {
  return join(projectsDir(), slug);
}

/** Records which project the next process should drive. */
export function activeProjectPath(): string {
  return join(mcRoot(), 'active');
}

export function listProjects(): string[] {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function setActiveProject(slug: string): void {
  mkdirSync(mcRoot(), { recursive: true });
  writeFileSync(activeProjectPath(), slug, 'utf8');
}

/**
 * Which project this process drives.
 *
 * Both failure modes throw with the command that fixes them, because this is
 * reached at startup and a bare "ENOENT config.yaml" tells a new user nothing.
 */
export function activeProjectSlug(): string {
  const fromEnv = process.env.MC_PROJECT?.trim();
  if (fromEnv) return fromEnv;

  const recorded = existsSync(activeProjectPath())
    ? readFileSync(activeProjectPath(), 'utf8').trim()
    : '';
  if (recorded) return recorded;

  const projects = listProjects();
  if (projects.length === 1) return projects[0]!;
  if (projects.length === 0) {
    throw new Error(
      `No project is set up yet. Run 'npm run mc -- init' from inside the repository you want to drive` +
        (existsSync(join(homedir(), '.mc'))
          ? `, or 'npm run mc -- migrate' to bring your existing ~/.mc install across.`
          : `.`),
    );
  }
  throw new Error(
    `Several projects exist (${projects.join(', ')}) and none is active. Run 'npm run mc -- project use <slug>'.`,
  );
}

export function mcHome(): string {
  return process.env.MC_HOME ?? projectHome(activeProjectSlug());
}

export function configPath(): string {
  return join(mcHome(), 'config.yaml');
}

export function statePath(): string {
  return join(mcHome(), 'state.json');
}

/**
 * Phase scripts belong to the install, not to a project: they are identical for
 * every repository and are refreshed wholesale by the installer.
 */
export function scriptsDir(): string {
  return join(mcRoot(), 'scripts');
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

/**
 * The "before" picture captured when a run starts, used to attribute the files
 * it produces. Also the collection sentinel: while it exists, that run's output
 * has not been gathered yet.
 */
export function runSnapshotPath(issue: number, kind: string): string {
  return join(taskDir(issue), `${kind}.snapshot.json`);
}

/** The manifest of artifacts a plan run produced. */
export function artifactsManifestPath(issue: number): string {
  return join(taskDir(issue), 'artifacts.json');
}

/** Where collected copies of a run's artifacts are stored, MC-owned. */
export function artifactsDir(issue: number): string {
  return join(taskDir(issue), 'artifacts');
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

/** Where Claude Code writes per-session transcripts. */
export function claudeProjectsDir(): string {
  return process.env.MC_CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects');
}

/** Where Codex CLI writes its date-partitioned rollout transcripts. */
export function codexSessionsDir(): string {
  return process.env.MC_CODEX_SESSIONS ?? join(homedir(), '.codex', 'sessions');
}

export function claudeCommandPath(command: string): string {
  return join(claudeCommandsDir(), `${command}.md`);
}
