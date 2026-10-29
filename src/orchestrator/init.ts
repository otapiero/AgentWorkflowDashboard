import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
import { runGit } from './git.ts';
import { render } from './prompt.ts';
import { projectHome, projectSlug, setActiveProject } from './paths.ts';

/**
 * First-run setup.
 *
 * Everything here is derived rather than asked. A repository already knows its
 * own owner, name and default branch, and `gh` already knows who you are — a
 * setup wizard that asks for facts the machine can read is a wizard that gets
 * them wrong.
 */

export interface DetectedRepo {
  path: string;
  owner: string;
  name: string;
  baseBranch: string;
  branchPrefix: string;
}

/** The template shipped in this checkout, the source `init` renders from. */
export function exampleConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'assets', 'config.example.yaml');
}

interface RepoView {
  owner: { login: string };
  name: string;
  defaultBranchRef: { name: string } | null;
}

/**
 * Read the repository's identity from git and gh.
 *
 * `git rev-parse` answers with forward slashes even on Windows, so the result
 * is put back through `resolve` — the config is read by humans, and a mixed
 * separator in a path they may later edit invites a typo.
 */
export async function detectRepo(cwd: string): Promise<DetectedRepo> {
  let path: string;
  try {
    const out = await runGit(['rev-parse', '--show-toplevel'], cwd);
    path = resolve(out.stdout.trim());
  } catch {
    throw new Error(
      `${cwd} is not inside a git repository. Run this from your project's checkout.`,
    );
  }

  let view: RepoView;
  try {
    const out = await execa('gh', ['repo', 'view', '--json', 'owner,name,defaultBranchRef'], {
      cwd: path,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    view = JSON.parse(out.stdout) as RepoView;
  } catch {
    throw new Error(
      `Could not read the GitHub repository for ${path}. Check that it has an 'origin' remote on GitHub and that 'gh auth status' is happy.`,
    );
  }

  if (!view.defaultBranchRef) {
    throw new Error(
      `${view.owner.login}/${view.name} reports no default branch. Push at least one branch, then run init again.`,
    );
  }

  // The branch prefix is a personal convention, not an identity — the login is
  // only the least surprising starting point.
  let branchPrefix = view.owner.login;
  try {
    const out = await execa('gh', ['api', 'user', '--jq', '.login'], {
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (out.stdout.trim()) branchPrefix = out.stdout.trim();
  } catch {
    // Falls back to the owner; the operator can edit config.yaml.
  }

  return {
    path,
    owner: view.owner.login,
    name: view.name,
    baseBranch: view.defaultBranchRef.name,
    branchPrefix,
  };
}

export function renderConfigTemplate(template: string, repo: DetectedRepo): string {
  return render(template, {
    repoPath: repo.path,
    owner: repo.owner,
    repoName: repo.name,
    baseBranch: repo.baseBranch,
    branchPrefix: repo.branchPrefix,
  });
}

export function initProject(
  repo: DetectedRepo,
  options: { force?: boolean } = {},
): { slug: string; configPath: string } {
  const slug = projectSlug(repo.owner, repo.name);
  const home = projectHome(slug);
  const target = join(home, 'config.yaml');

  if (existsSync(target) && !options.force) {
    throw new Error(
      `${repo.owner}/${repo.name} is already set up at ${target}. Pass --force to replace its config.yaml.`,
    );
  }

  for (const dir of [home, join(home, 'tasks'), join(home, 'worktrees')]) {
    mkdirSync(dir, { recursive: true });
  }

  const template = readFileSync(exampleConfigPath(), 'utf8');
  writeFileSync(target, renderConfigTemplate(template, repo), 'utf8');
  setActiveProject(slug);

  return { slug, configPath: target };
}
