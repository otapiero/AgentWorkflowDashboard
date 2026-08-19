import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from './config.ts';
import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
import { mcRoot, projectHome, projectSlug, setActiveProject } from './paths.ts';

/**
 * One-time move from the single-repository layout to the root/project one.
 *
 * Deliberately a separate command rather than something the app does on
 * startup: it moves a directory the operator may have open in an editor, and
 * doing that silently behind a server boot is how a half-moved install
 * happens. MC_LEGACY_HOME overrides the source, which is what lets this be
 * tested without a real ~/.mc.
 */

/** Files and directories that belong to the machine, not to one repository. */
const SHARED_ENTRIES = ['scripts', 't3-credential', 't3-token.json'];

export interface MigrationResult {
  slug: string;
  from: string;
  to: string;
  sharedFiles: string[];
  /** Shared entries already at the root, renamed aside rather than dropped. */
  displaced: string[];
  /** Worktrees whose git registration was re-pointed at the new location. */
  repairedWorktrees: string[];
}

export function legacyHomePath(): string {
  return process.env.MC_LEGACY_HOME ?? join(homedir(), '.mc');
}

/**
 * Re-point git at the worktrees this move relocated.
 *
 * A worktree is registered by absolute path in two places: the main repo's
 * .git/worktrees/<name>/gitdir, and the worktree's own .git file pointing
 * back. Moving the directory breaks both, and git then reports the worktree as
 * prunable — one `git worktree prune` away from losing unmerged work.
 * `git worktree repair` rewrites both links from the paths it is handed.
 */
function repairWorktreesWithGit(repoPath: string, worktrees: string[]): void {
  if (worktrees.length === 0) return;
  execFileSync('git', ['-C', repoPath, 'worktree', 'repair', ...worktrees], {
    timeout: SUBPROCESS_TIMEOUT_MS,
    stdio: 'pipe',
  });
}

export interface MigrateOptions {
  /** Injected so the move can be tested without a real git repository. */
  repairWorktrees?: (repoPath: string, worktrees: string[]) => void;
}

export function migrateLegacyHome(options: MigrateOptions = {}): MigrationResult {
  const repair = options.repairWorktrees ?? repairWorktreesWithGit;
  const from = legacyHomePath();
  const legacyConfig = join(from, 'config.yaml');

  if (!existsSync(legacyConfig)) {
    throw new Error(`Nothing to migrate: no config.yaml at ${from}.`);
  }

  const config = parseConfig(readFileSync(legacyConfig, 'utf8'));
  const slug = projectSlug(config.repo.owner, config.repo.name);
  const to = projectHome(slug);

  if (existsSync(to)) {
    throw new Error(
      `${slug} already exists at ${to}. Move or delete it first if you really mean to migrate over it.`,
    );
  }

  mkdirSync(join(mcRoot(), 'projects'), { recursive: true });
  renameSync(from, to);

  // Lift the machine-wide files out of what is now a project directory. The
  // T3 pairing especially: it is single-use and short-lived, so a second
  // project must inherit it rather than mint its own.
  const sharedFiles: string[] = [];
  const displaced: string[] = [];
  for (const entry of SHARED_ENTRIES) {
    const source = join(to, entry);
    if (!existsSync(source)) continue;
    const destination = join(mcRoot(), entry);

    // The install being migrated is the authoritative one, so it wins. Anything
    // already sitting at the root is renamed aside rather than deleted: it may
    // be the only copy of a credential, and a migration that silently destroys
    // one is worse than a migration that leaves a file to tidy up.
    if (existsSync(destination)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      renameSync(destination, `${destination}.replaced-${stamp}`);
      displaced.push(entry);
    }
    renameSync(source, destination);
    sharedFiles.push(entry);
  }

  // Worktrees moved with the project directory, so their git registration now
  // points at a path that no longer exists.
  const worktreesDir = join(to, 'worktrees');
  const repairedWorktrees = existsSync(worktreesDir)
    ? readdirSync(worktreesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(worktreesDir, entry.name))
    : [];
  repair(config.repo.path, repairedWorktrees);

  setActiveProject(slug);
  return { slug, from, to, sharedFiles, displaced, repairedWorktrees };
}
