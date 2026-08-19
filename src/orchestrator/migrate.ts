import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from './config.ts';
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
}

export function legacyHomePath(): string {
  return process.env.MC_LEGACY_HOME ?? join(homedir(), '.mc');
}

export function migrateLegacyHome(): MigrationResult {
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
  for (const entry of SHARED_ENTRIES) {
    const source = join(to, entry);
    if (!existsSync(source)) continue;
    const destination = join(mcRoot(), entry);
    if (existsSync(destination)) {
      rmSync(source, { recursive: true, force: true });
    } else {
      renameSync(source, destination);
    }
    sharedFiles.push(entry);
  }

  setActiveProject(slug);
  return { slug, from, to, sharedFiles };
}
