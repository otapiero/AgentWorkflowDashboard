import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
} from 'node:fs';
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
 *
 * The move is done entry by entry rather than as one directory rename. On
 * Windows a rename fails if *anything* holds a handle anywhere inside the
 * tree, and a worktree is exactly the kind of directory an editor, a language
 * server or a dev server keeps open — one watcher on one worktree would
 * otherwise block the entire migration with nothing moved and no way to
 * proceed. Per-entry moves let the rest land and name what did not.
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
  /** Worktrees left behind because something held them open. */
  skippedWorktrees: string[];
  /** True when the legacy directory still holds something. */
  legacyRemains: boolean;
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
  /**
   * Injected so a held-open worktree can be simulated. Real locks are a
   * Windows filesystem behaviour and cannot be produced portably in a test.
   */
  renameEntry?: (from: string, to: string) => void;
}

export function migrateLegacyHome(options: MigrateOptions = {}): MigrationResult {
  const repair = options.repairWorktrees ?? repairWorktreesWithGit;
  const move = options.renameEntry ?? renameSync;
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

  mkdirSync(to, { recursive: true });

  // Everything except the worktrees, which are handled one at a time below.
  for (const entry of readdirSync(from)) {
    if (entry === 'worktrees') continue;
    move(join(from, entry), join(to, entry));
  }

  const legacyWorktrees = join(from, 'worktrees');
  const movedWorktrees: string[] = [];
  const skippedWorktrees: string[] = [];

  if (existsSync(legacyWorktrees)) {
    mkdirSync(join(to, 'worktrees'), { recursive: true });
    for (const name of readdirSync(legacyWorktrees)) {
      const target = join(to, 'worktrees', name);
      try {
        move(join(legacyWorktrees, name), target);
        movedWorktrees.push(target);
      } catch {
        // Held open by an editor, language server or dev server. A worktree is
        // reconstructible from its branch, so this is never fatal.
        skippedWorktrees.push(name);
      }
    }
  }

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

  repair(config.repo.path, movedWorktrees);

  // Tidy the source away when it is genuinely empty. Anything left is a
  // worktree that could not be moved, and that is reported rather than forced.
  let legacyRemains = true;
  if (skippedWorktrees.length === 0) {
    try {
      if (existsSync(legacyWorktrees)) rmdirSync(legacyWorktrees);
      rmdirSync(from);
      legacyRemains = false;
    } catch {
      legacyRemains = true;
    }
  }

  setActiveProject(slug);
  return {
    slug,
    from,
    to,
    sharedFiles,
    displaced,
    repairedWorktrees: movedWorktrees,
    skippedWorktrees,
    legacyRemains,
  };
}
