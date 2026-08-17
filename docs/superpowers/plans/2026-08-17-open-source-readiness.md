# Open-Source Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Mission Control from a one-machine, one-repository personal tool into a Windows application any developer can clone, point at their own GitHub repository, and run — with one install able to drive several repositories.

**Architecture:** Three moves. (1) The prompt renderer learns repository identity, so the `mc-*.md` command files stop naming a specific repo. (2) `~/.mc` splits into an install-wide root `~/.mission-control` (shared scripts, T3 credential) and per-repository project homes under `projects/<owner>__<name>/`; `mcHome()` stays the single choke point, so nothing downstream changes. (3) A new `mc init` derives a working `config.yaml` from `git` and `gh` with no questions asked, and `mc migrate` moves the existing personal install into the new layout.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers, run via `tsx`), Node 22+, Fastify 5, React 19, Vitest 3, Zod 4, execa 9, PowerShell 7 (`pwsh`), `gh` CLI.

**Spec:** Inline — see **Requirements** below. Derived from the open-source readiness audit of 2026-08-17; there is no separate design document for this work.

## Global Constraints

- **Windows-only is accepted and intentional.** `wt`, `pwsh`, and `.ps1` phase scripts stay. Do not add POSIX shell scripts or non-Windows launchers.
- **Published name is `mission-control`.** npm package `mission-control`; install root `~/.mission-control`; VS Code extension id `otapiero.mission-control`; user-facing product name "Mission Control".
- **No new runtime dependencies.** Everything here is buildable from what `package.json` already has.
- **Zero footprint in the user's project repo.** No config, state, worktree, marker, or workspace file is ever written inside `config.repo.path` or a worktree. This is the project's founding principle and every task must preserve it.
- **`MC_HOME` keeps its current meaning** — an explicit override of the *project* home. This is what lets all 46 existing test files keep working unchanged. `MC_ROOT` is the new, separate override for the install-wide root.
- **Tests are Vitest**, live in `test/*.test.ts`, and isolate by pointing `process.env.MC_HOME` (and now `MC_ROOT`) at a `mkdtempSync` directory in `beforeEach`, deleted in `afterEach`. Follow the shape of `test/markers.test.ts`.
- **Full suite must stay green.** Baseline at plan time: `npm test` → 46 files, 596 tests, ~23s. `npm run typecheck` → clean.
- **License is MIT**, copyright holder "Ouriel Tapiero".
- Commit after every task. Conventional-commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).

## Out of Scope

- **Configurable pipeline.** Phase ids are a closed union in `src/shared/types.ts:11-22` and appear 48 times across 18 files, 15 of them inside `reconcile.ts` — the pure reconciler that is the project's main verification surface. Making it data-driven is a separate, riskier project. Task 8 documents the pipeline as opinionated instead.
- **Cross-platform support.** Explicitly declined by the user.
- **Live project switching in the browser.** `server/index.ts:20-42` loads config once at boot and hands it to the poller and every route. Switching projects is a CLI action plus a server restart. The top bar already renders the active `owner/name` (`src/web/App.tsx:141-143`), so no UI work is needed.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/orchestrator/init.ts` | Detect repository identity from `git`/`gh`; render `config.yaml` from the example template; create a project home. |
| `src/orchestrator/migrate.ts` | One-time move of a legacy `~/.mc` install into the new root/project layout. |
| `test/project-paths.test.ts` | Root/project resolution, slugging, active-project precedence. |
| `test/init.test.ts` | Config template rendering and project creation. |
| `test/migrate.test.ts` | Legacy install migration. |
| `LICENSE` | MIT. |
| `.github/workflows/ci.yml` | `npm ci`, typecheck, unit tests on push and PR. |
| `CONTRIBUTING.md` | How to run, test, and lay out a change. |

**Modified**

| Path | Change |
|---|---|
| `src/orchestrator/paths.ts` | Split `mcRoot()` (install-wide) from `mcHome()` (per project); add project slug/list/active helpers; move `scriptsDir()` to the root. |
| `src/orchestrator/prompt.ts` | New `repo` option feeding `{{owner}} {{repo}} {{baseBranch}} {{repoPath}}`. |
| `src/orchestrator/spawn-plan.ts` | Pass `config.repo` into `buildPrompt`. |
| `src/orchestrator/spawn.ts` | `SpawnSpec` carries `mcHome`; T3 project title defaults to the repo name. |
| `src/orchestrator/cli.ts` | `init`, `migrate`, `project` commands that run *before* `loadConfig()`. |
| `src/orchestrator/t3/auth.ts` | Credential and token cache move to the install root. |
| `src/orchestrator/t3/doctor.ts`, `t3/client.ts` | Path strings in operator messages. |
| `src/web/components/Settings.tsx` | Credential path string. |
| `assets/claude/commands/*.md` | Repo-specific text replaced with template variables. |
| `assets/config.example.yaml` | Becomes a placeholder template. |
| `assets/scripts/common.ps1`, `run-phase.ps1` | Take `-McHome` from the spec instead of recomputing it. |
| `scripts/install.ps1` | Seeds the root, then delegates config creation to `mc init` / `mc migrate`. |
| `package.json`, `vscode-extension/package.json`, `vscode-extension/src/server-manager.ts` | Rename and publishable metadata. |
| `start-mission-control.bat` | Self-locating. |
| `README.md` | Rewritten for a general audience. |
| `test/t3-auth.test.ts`, `test/prompt.test.ts`, `test/config.test.ts`, `test/spawn.test.ts` | Follow the above; de-personalise fixtures. |

---

## Requirements

Numbered so tasks can cite them.

- **R1** No command file may name a specific GitHub repository or base branch.
- **R2** The prompt renderer must expose the active repository's owner, name, base branch, and local path.
- **R3** One install must be able to hold several repositories' state without collision.
- **R4** The T3 pairing credential must be shared across projects — it pairs a machine to a local T3 server, and the pairing link is single-use with a ~3-minute expiry, so re-pairing per project is unacceptable.
- **R5** A new user must reach a valid `config.yaml` without hand-editing YAML.
- **R6** The existing `~/.mc` install must survive the change, with its tasks, plans, artifacts, worktrees, and T3 token intact.
- **R7** The published artifact must carry a license, repository metadata, an engine floor, and CI that runs the test suite.
- **R8** Nothing user-facing may refer to Acme, widgets, acme, or a personal branch prefix.

---

## Task 1: Repository variables in prompts

Implements **R1**, **R2**. Independent of every other task — do it first; it is the change that stops a stranger's agents from being aimed at your repository.

**Files:**
- Modify: `src/orchestrator/prompt.ts:76-118`
- Modify: `src/orchestrator/spawn-plan.ts:92-97`
- Modify: `assets/claude/commands/mc-fix-ci.md`, `mc-fix-review.md`, `mc-publish.md`, `mc-planner.md`, `mc-implementer.md`, `mc-custom.md`
- Test: `test/prompt.test.ts`, `test/spawn-plan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PromptOptions.repo?: { owner: string; name: string; baseBranch: string; path: string }` — Task 3 does not use it; nothing else depends on it.

- [ ] **Step 1: Write the failing tests**

Append to `test/prompt.test.ts`, inside the existing `describe('buildPrompt', ...)` block (after the `defaults {{donePath}} to plan.done` test at line 173):

```ts
  test('renders repository identity into the repo placeholders', () => {
    writeCommand('mc-x', 'Repo {{owner}}/{{repo}} base {{baseBranch}} at {{repoPath}}.');
    const text = buildPrompt('mc-x', task, {
      repo: { owner: 'acme', name: 'widgets', baseBranch: 'main', path: 'C:\\src\\widgets' },
    });
    expect(text).toBe('Repo acme/widgets base main at C:\\src\\widgets.');
  });

  test('leaves the repo placeholders visible when no repo is supplied', () => {
    // Same reasoning as every other unknown placeholder: a visibly broken
    // prompt beats a silently blanked one.
    writeCommand('mc-x', 'Repo {{owner}}/{{repo}}.');
    expect(buildPrompt('mc-x', task, {})).toBe('Repo {{owner}}/{{repo}}.');
  });
```

Append to `test/spawn-plan.test.ts`, inside its existing `describe('resolveSpawnPlan', ...)` block. Note that `config()` and `task()` in that file are factory *functions*, and its `beforeEach` already writes an `mc-implementer.md` into `commands` — this overwrites it:

```ts
  test('the prompt is rendered with the configured repository, not a baked-in one', () => {
    // Stand in for what an installed mc-fix-ci.md looks like after Task 1.
    writeFileSync(
      join(commands, 'mc-implementer.md'),
      'gh pr checks --repo {{owner}}/{{repo}} --base {{baseBranch}} in {{repoPath}}',
      'utf8',
    );
    const cfg = config();
    const plan = resolveSpawnPlan(cfg, task(), implementPhase(), {}, {});
    expect(plan.promptText).toBe(
      `gh pr checks --repo ${cfg.repo.owner}/${cfg.repo.name} --base ${cfg.repo.baseBranch} in ${cfg.repo.path}`,
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/prompt.test.ts test/spawn-plan.test.ts`
Expected: FAIL — the repo placeholders come back unsubstituted (`Repo {{owner}}/{{repo}} ...`).

- [ ] **Step 3: Add the repo option to the renderer**

In `src/orchestrator/prompt.ts`, add to `PromptOptions` (after `doneMarkerName`, line 87):

```ts
  /**
   * The repository this task belongs to, rendered into {{owner}}, {{repo}},
   * {{baseBranch}} and {{repoPath}}. Optional so the pure prompt tests can
   * omit it; every real spawn passes it from config.
   */
  repo?: { owner: string; name: string; baseBranch: string; path: string };
```

Replace the `render(...)` call in `buildPrompt` (lines 102-113) with:

```ts
  const vars: Record<string, string> = {
    ARGUMENTS: String(task.issue),
    issue: String(task.issue),
    title: task.title,
    branch: task.branch,
    planPath: planPath(task.issue),
    donePath: markerPath(task.issue, options.doneMarkerName ?? 'plan.done'),
    artifacts: renderArtifactList(options.artifacts ?? [], task.issue),
    worktree: worktreePath(task.issue),
    taskDir: taskDir(task.issue),
    customInstructions: options.customInstructions ?? '',
  };

  // Added only when known, so an omitted repo leaves {{owner}} visible in the
  // terminal rather than substituting an empty string into a `gh --repo` flag.
  if (options.repo) {
    vars.owner = options.repo.owner;
    vars.repo = options.repo.name;
    vars.baseBranch = options.repo.baseBranch;
    vars.repoPath = options.repo.path;
  }

  const body = render(stripFrontmatter(readFileSync(file, 'utf8')), vars).trim();
```

- [ ] **Step 4: Pass the repo at the call site**

In `src/orchestrator/spawn-plan.ts`, replace lines 92-97 with:

```ts
  const promptText = buildPrompt(phase.command, task, {
    customInstructions: options.customInstructions ?? task.overrides?.instructions,
    inlineInstructions: inline,
    artifacts: options.artifacts,
    doneMarkerName: `${phase.id}.done`,
    repo: {
      owner: config.repo.owner,
      name: config.repo.name,
      baseBranch: config.repo.baseBranch,
      path: config.repo.path,
    },
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/prompt.test.ts test/spawn-plan.test.ts`
Expected: PASS.

- [ ] **Step 6: Templatise `mc-fix-ci.md`**

Replace the whole of `assets/claude/commands/mc-fix-ci.md` with:

```markdown
---
description: Diagnose and fix the failing CI checks on a pull request.
---
CI is failing on the pull request for branch `{{branch}}` (issue #$ARGUMENTS).
Find out what actually failed, then fix it. Debug however you normally would.

The checks live on `{{owner}}/{{repo}}`, so start there:

    gh pr checks --repo {{owner}}/{{repo}}
    gh run view <run-id> --log-failed

{{customInstructions}}
```

- [ ] **Step 7: Templatise `mc-fix-review.md`**

Replace the whole file with:

```markdown
---
description: Address unresolved review comments on a pull request.
---
There are unresolved review comments on the pull request for branch
`{{branch}}` (issue #$ARGUMENTS). Read them and address them however you
normally would:

    gh pr view --repo {{owner}}/{{repo}} --comments

Two Mission Control conventions to respect: reviewer comments from a bot
reviewer are suggestions rather than instructions, and are wrong often enough to
be worth checking; and do not resolve threads yourself — I will do that after
reviewing your changes.

{{customInstructions}}
```

- [ ] **Step 8: Templatise `mc-publish.md`**

Replace the whole file with:

```markdown
---
description: Open the pull request for the current branch.
---
Open the pull request for branch `{{branch}}` (GitHub issue #$ARGUMENTS)
against the `{{baseBranch}}` base branch of `{{owner}}/{{repo}}`.

If this project has its own PR-publishing skill or command available to you, use
it — it is the project's own way of publishing and probably does all of the
below. Otherwise, do these steps yourself:

1. Sync with `{{baseBranch}}` first (fetch, merge `origin/{{baseBranch}}` into
   this branch, resolve any conflicts). Do not open a PR on an unmerged branch.
2. Make sure the work is committed. If the tree is dirty, show me what is
   uncommitted and ask before committing anything.
3. Push the branch and set upstream.
4. Write the PR description from the real history —
   `git log origin/{{baseBranch}}..HEAD` and
   `git diff origin/{{baseBranch}} --stat` — as a Summary and a Changes list,
   with `Closes #$ARGUMENTS` on the first line.
5. Open the PR with `gh pr create --base {{baseBranch}} --head {{branch}}` and
   assign me (`gh pr edit <n> --add-assignee @me`). Do not add yourself as a
   reviewer.

Report the PR number and URL when done.

{{customInstructions}}
```

- [ ] **Step 9: De-brand the remaining three command descriptions**

In `assets/claude/commands/mc-planner.md`, `mc-implementer.md`, and `mc-custom.md`, change only the frontmatter `description:` line:

- `mc-planner.md`: `description: Produce an implementation plan for a GitHub issue.`
- `mc-implementer.md`: `description: Implement a GitHub issue by following its Mission Control plan.`
- `mc-custom.md`: `description: Run a free-form instruction against a GitHub issue.`

Leave the bodies of these three alone — they are already repo-neutral.

- [ ] **Step 10: Verify nothing repo-specific is left in the command files**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS, typecheck clean.

Run: `git grep -n "acme\|widgets" -- assets/`
Expected: **no output**. If `config.example.yaml` still matches, that is Task 4's job — but nothing under `assets/claude/commands/` may match.

- [ ] **Step 11: Commit**

```bash
git add src/orchestrator/prompt.ts src/orchestrator/spawn-plan.ts assets/claude/commands test/prompt.test.ts test/spawn-plan.test.ts
git commit -m "feat: render repository identity into agent prompts"
```

---

## Task 2: Split the install root from the project home

Implements **R3**, **R4**. Everything downstream of `mcHome()` is untouched — that is the point of the design.

> **Your own install stops working between this task and Task 4.** After this task `mcHome()` resolves through `~/.mission-control/projects/`, where you have nothing yet, so `npm start` will exit with "No project is set up yet" and `runPhaseScript()` will point at a script that is not there. That is expected. `mc migrate` in Task 4 fixes it. Do not run Tasks 2, 3 and 4 across a break where you need the board working.

**Files:**
- Modify: `src/orchestrator/paths.ts` (whole file)
- Modify: `src/orchestrator/t3/auth.ts:48-57`
- Modify: `src/orchestrator/spawn.ts:255-266, 403-422`
- Modify: `assets/scripts/common.ps1`, `assets/scripts/run-phase.ps1`
- Modify: `test/t3-auth.test.ts:18-28`
- Test: `test/project-paths.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces, all from `src/orchestrator/paths.ts`:
  - `mcRoot(): string`
  - `projectsDir(): string`
  - `projectSlug(owner: string, name: string): string`
  - `activeProjectPath(): string`
  - `listProjects(): string[]`
  - `setActiveProject(slug: string): void`
  - `activeProjectSlug(): string` — throws when unresolvable
  - `mcHome(): string` — unchanged signature, new derivation
  - `projectHome(slug: string): string`
  - `SpawnSpec` gains `mcHome: string` (`src/orchestrator/spawn.ts`)

- [ ] **Step 1: Write the failing tests**

Create `test/project-paths.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activeProjectSlug,
  configPath,
  listProjects,
  mcHome,
  mcRoot,
  projectHome,
  projectSlug,
  projectsDir,
  scriptsDir,
  setActiveProject,
} from '../src/orchestrator/paths.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-root-'));
  process.env.MC_ROOT = root;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;
});

afterEach(() => {
  delete process.env.MC_ROOT;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;
  rmSync(root, { recursive: true, force: true });
});

function makeProject(slug: string): void {
  mkdirSync(join(root, 'projects', slug), { recursive: true });
}

describe('projectSlug', () => {
  test('joins owner and name with a double underscore, lowercased', () => {
    expect(projectSlug('acme', 'widgets')).toBe('acme__widgets');
  });

  test('replaces characters that are not directory-safe', () => {
    expect(projectSlug('my org', 'repo.js+')).toBe('my-org__repo.js');
  });

  test('two repos with the same name under different owners do not collide', () => {
    expect(projectSlug('alice', 'app')).not.toBe(projectSlug('bob', 'app'));
  });
});

describe('active project resolution', () => {
  test('MC_PROJECT wins over everything', () => {
    makeProject('a__one');
    makeProject('b__two');
    setActiveProject('a__one');
    process.env.MC_PROJECT = 'b__two';
    expect(activeProjectSlug()).toBe('b__two');
  });

  test('falls back to the recorded active project', () => {
    makeProject('a__one');
    makeProject('b__two');
    setActiveProject('b__two');
    expect(activeProjectSlug()).toBe('b__two');
  });

  test('a sole project needs no recorded choice', () => {
    makeProject('a__one');
    expect(activeProjectSlug()).toBe('a__one');
  });

  test('no project at all names the command that fixes it', () => {
    expect(() => activeProjectSlug()).toThrow(/mc -- init/);
  });

  test('several projects and no choice names the command that fixes it', () => {
    makeProject('a__one');
    makeProject('b__two');
    expect(() => activeProjectSlug()).toThrow(/project use/);
  });

  test('listProjects returns the directory names, sorted', () => {
    makeProject('b__two');
    makeProject('a__one');
    expect(listProjects()).toEqual(['a__one', 'b__two']);
  });

  test('listProjects on a fresh root is empty, not a throw', () => {
    expect(listProjects()).toEqual([]);
  });
});

describe('the root/project split', () => {
  test('project state lives under projects/<slug>', () => {
    makeProject('a__one');
    expect(mcHome()).toBe(join(projectsDir(), 'a__one'));
    expect(configPath()).toBe(join(root, 'projects', 'a__one', 'config.yaml'));
  });

  test('MC_HOME still overrides the project home outright', () => {
    // This is what keeps every existing test file working unchanged.
    const explicit = join(root, 'somewhere-else');
    process.env.MC_HOME = explicit;
    expect(mcHome()).toBe(explicit);
  });

  test('scripts are shared by the whole install, not per project', () => {
    makeProject('a__one');
    expect(scriptsDir()).toBe(join(root, 'scripts'));
    expect(scriptsDir().startsWith(projectsDir())).toBe(false);
  });

  test('scripts stay at the root even when MC_HOME is overridden', () => {
    process.env.MC_HOME = join(root, 'somewhere-else');
    expect(scriptsDir()).toBe(join(root, 'scripts'));
  });

  test('projectHome addresses a project without making it active', () => {
    expect(projectHome('x__y')).toBe(join(root, 'projects', 'x__y'));
  });

  test('mcRoot defaults under the home folder when MC_ROOT is unset', () => {
    delete process.env.MC_ROOT;
    expect(mcRoot().endsWith('.mission-control')).toBe(true);
  });
});
```

Add to `test/t3-auth.test.ts` — modify the existing `beforeEach`/`afterEach` (lines 20-28) to also control the root, and add one test after the existing `the credential lives under MC_HOME...` test at line 56:

```ts
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.MC_HOME = home;
  process.env.MC_ROOT = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  delete process.env.MC_ROOT;
  rmSync(home, { recursive: true, force: true });
});
```

```ts
  test('the credential lives at the install root, so projects share one pairing', () => {
    // A T3 pairing link is single-use and expires in about three minutes.
    // Re-pairing per project would be unusable, so this is deliberate.
    expect(t3CredentialPath()).toBe(join(mcRoot(), 't3-credential'));
    expect(t3TokenCachePath()).toBe(join(mcRoot(), 't3-token.json'));
  });
```

Import `mcRoot` alongside `mcHome` at the top of `test/t3-auth.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/project-paths.test.ts test/t3-auth.test.ts`
Expected: FAIL — `projectSlug`, `mcRoot`, `projectHome`, `listProjects`, `setActiveProject`, `activeProjectSlug` are not exported from `paths.ts`.

- [ ] **Step 3: Rewrite `src/orchestrator/paths.ts`**

Replace lines 1-32 (the imports through `runPhaseScript`) with the following. Everything from `tasksDir()` down stays exactly as it is.

```ts
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
      `No project is set up yet. Run 'npm run mc -- init' from inside the repository you want to drive.`,
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
```

- [ ] **Step 4: Move the T3 credential to the install root**

In `src/orchestrator/t3/auth.ts`, change the `mcHome` import on line 1-ish to `mcRoot` (check the exact import line and keep any other imported symbols), then replace the two path functions at lines 48-57:

```ts
/**
 * The pairing URL, saved by hand at the install root.
 *
 * Root rather than project: a pairing link is single-use and expires within
 * about three minutes, so making every project mint its own would be unusable.
 * One pairing serves the machine.
 */
export function t3CredentialPath(): string {
  return join(mcRoot(), 't3-credential');
}

export function t3TokenCachePath(): string {
  return join(mcRoot(), 't3-token.json');
}
```

Keep the surrounding doc comments that explain *why* the token is cached; only the directory changes.

- [ ] **Step 5: Run the path tests to verify they pass**

Run: `npx vitest run test/project-paths.test.ts test/t3-auth.test.ts`
Expected: PASS.

- [ ] **Step 6: Carry the project home into the spawn spec**

The phase scripts run in a separate PowerShell process that has no idea which project is active. Rather than duplicate the resolution rules in PowerShell, the spec carries the answer.

In `src/orchestrator/spawn.ts`, add to the `SpawnSpec` interface (after `repoPath`, line 261):

```ts
  /**
   * The project home the phase script writes markers into. Passed rather than
   * recomputed: the script is a separate process with no notion of an active
   * project, and a second implementation of that lookup would eventually
   * disagree with this one.
   */
  mcHome: string;
```

Import `mcHome` in the existing import block from `./paths.ts` (line 6-12), and add it to the spec literal built at lines 403-422, immediately after `repoPath: config.repo.path,`:

```ts
    mcHome: mcHome(),
```

- [ ] **Step 7: Take the project home as a parameter in PowerShell**

In `assets/scripts/common.ps1`, delete the `Get-McHome` function entirely and rewrite the four helpers below it to take `-McHome`:

```powershell
function Get-TaskDir {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue
    )
    return (Join-Path (Join-Path $McHome 'tasks') $Issue)
}

function Get-MarkersDir {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue
    )
    return (Join-Path (Get-TaskDir -McHome $McHome -Issue $Issue) 'markers')
}

function Write-Marker {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue,
        [Parameter(Mandatory)][string]$Name,
        [string]$Body = ''
    )
    $dir = Get-MarkersDir -McHome $McHome -Issue $Issue
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Set-Content -Path (Join-Path $dir $Name) -Value $Body -NoNewline -Encoding utf8
}

function Clear-Marker {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue,
        [Parameter(Mandatory)][string]$Name
    )
    $path = Join-Path (Get-MarkersDir -McHome $McHome -Issue $Issue) $Name
    if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
}

function Write-RunningMarker {
    param(
        [Parameter(Mandatory)][string]$McHome,
        [Parameter(Mandatory)][int]$Issue,
        [Parameter(Mandatory)][string]$Phase
    )
    $payload = @{
        phase     = $Phase
        pid       = $PID
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json -Compress
    Write-Marker -McHome $McHome -Issue $Issue -Name "$Phase.running" -Body $payload
}
```

`Ensure-Worktree` is unchanged — it already takes every path it needs.

Keep the file ASCII-only. Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI, so a UTF-8 em-dash arrives as a byte PowerShell accepts as a string terminator, and the parse error surfaces tens of lines later.

- [ ] **Step 8: Thread it through `run-phase.ps1`**

In `assets/scripts/run-phase.ps1`, after `$phase = [string]$spec.phase` (line ~30) add:

```powershell
$mcHome = [string]$spec.mcHome
if (-not $mcHome) {
    throw "Spawn spec has no mcHome. It was written by an older Mission Control; relaunch the phase from the board."
}
```

Then update the three call sites:

```powershell
Write-RunningMarker -McHome $mcHome -Issue $issue -Phase $phase
```

```powershell
    Clear-Marker -McHome $mcHome -Issue $issue -Name "$phase.running"
```

```powershell
    if (Test-Path (Join-Path (Get-TaskDir -McHome $mcHome -Issue $issue) 'plan.md')) {
```

- [ ] **Step 9: Run the full suite**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, typecheck clean. `test/spawn.test.ts` may need `mcHome` added to any hand-built `SpawnSpec` literal — if it fails, add the field with a literal path such as `'C:\\Users\\o\\.mission-control\\projects\\acme__widgets'`.

- [ ] **Step 10: Commit**

```bash
git add src/orchestrator/paths.ts src/orchestrator/t3/auth.ts src/orchestrator/spawn.ts assets/scripts test/project-paths.test.ts test/t3-auth.test.ts test/spawn.test.ts
git commit -m "feat: split the install root from per-project homes"
```

---

## Task 3: `mc init`

Implements **R5**. A new user runs one command inside their repository and gets a working config.

**Files:**
- Create: `src/orchestrator/init.ts`
- Create: `test/init.test.ts`
- Modify: `assets/config.example.yaml:1-44` (the `repo:` and `t3:` blocks only)
- Modify: `src/orchestrator/cli.ts:115-124`

**Interfaces:**
- Consumes: `projectSlug`, `projectHome`, `setActiveProject`, `mcRoot` from `src/orchestrator/paths.ts` (Task 2); `render` from `src/orchestrator/prompt.ts`; `parseConfig` from `src/orchestrator/config.ts`; `SUBPROCESS_TIMEOUT_MS` from `src/orchestrator/exec.ts`.
- Produces, from `src/orchestrator/init.ts`:
  - `interface DetectedRepo { path: string; owner: string; name: string; baseBranch: string; branchPrefix: string }`
  - `detectRepo(cwd: string): Promise<DetectedRepo>`
  - `renderConfigTemplate(template: string, repo: DetectedRepo): string`
  - `initProject(repo: DetectedRepo, options?: { force?: boolean }): { slug: string; configPath: string }`
  - `exampleConfigPath(): string`

- [ ] **Step 1: Turn the example config into a template**

In `assets/config.example.yaml`, replace lines 1-21 (the header comment through the `github:` block) with:

```yaml
# Mission Control configuration.
#
# Written by `npm run mc -- init`, which fills the repo block in from `git` and
# `gh`. Everything workflow-shaped lives here so it can change without code
# edits. Edit it by hand whenever you like; it is never overwritten.

repo:
  # Absolute path to the local clone. It does not have to be named after the
  # GitHub repository.
  path: '{{repoPath}}'
  owner: '{{owner}}'
  name: '{{repoName}}'
  baseBranch: '{{baseBranch}}'
  # Prefix for the branches Mission Control creates: <prefix>/<issue>-<slug>.
  # `mc init` seeds this from your GitHub login; change it to whatever
  # convention your team uses.
  branchPrefix: '{{branchPrefix}}'

github:
  auth: gh-cli
  pollIntervalSeconds: 30
  # The login that posts automated review comments. Used by the copilot_review
  # gate to tell bot threads from human ones.
  copilotReviewerLogin: 'copilot-pull-request-reviewer'
```

And in the `t3:` block, replace `projectTitle: 'Acme'` with:

```yaml
  projectTitle: '{{repoName}}'
```

Leave the `agents:`, `pipeline:`, `launcher:` and `server:` blocks exactly as they are — they are already generic.

- [ ] **Step 2: Write the failing tests**

Create `test/init.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  exampleConfigPath,
  initProject,
  renderConfigTemplate,
  type DetectedRepo,
} from '../src/orchestrator/init.ts';
import { parseConfig } from '../src/orchestrator/config.ts';
import { activeProjectSlug, projectHome, projectSlug } from '../src/orchestrator/paths.ts';

let root: string;

const REPO: DetectedRepo = {
  path: 'C:\\src\\widgets',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
  branchPrefix: 'alice',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-init-'));
  process.env.MC_ROOT = root;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;
});

afterEach(() => {
  delete process.env.MC_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe('renderConfigTemplate', () => {
  test('produces a config that actually validates', () => {
    // The example is the shipped default, so a template that renders to an
    // invalid config would break every new install and nothing else.
    const template = readFileSync(exampleConfigPath(), 'utf8');
    const cfg = parseConfig(renderConfigTemplate(template, REPO));
    expect(cfg.repo).toEqual(REPO);
  });

  test('leaves no unsubstituted placeholders behind', () => {
    const template = readFileSync(exampleConfigPath(), 'utf8');
    expect(renderConfigTemplate(template, REPO)).not.toMatch(/\{\{/);
  });

  test('titles the T3 project after the repository', () => {
    const template = readFileSync(exampleConfigPath(), 'utf8');
    const cfg = parseConfig(renderConfigTemplate(template, REPO));
    expect(cfg.t3?.projectTitle).toBe('widgets');
  });
});

describe('initProject', () => {
  test('writes the config into the project home and makes it active', () => {
    const result = initProject(REPO);
    expect(result.slug).toBe(projectSlug('acme', 'widgets'));
    expect(existsSync(result.configPath)).toBe(true);
    expect(activeProjectSlug()).toBe(result.slug);
  });

  test('the written config loads back through the real validator', () => {
    const result = initProject(REPO);
    expect(parseConfig(readFileSync(result.configPath, 'utf8')).repo.owner).toBe('acme');
  });

  test('creates the tasks and worktrees directories the runtime expects', () => {
    const result = initProject(REPO);
    expect(existsSync(join(projectHome(result.slug), 'tasks'))).toBe(true);
    expect(existsSync(join(projectHome(result.slug), 'worktrees'))).toBe(true);
  });

  test('refuses to clobber an existing config', () => {
    initProject(REPO);
    expect(() => initProject(REPO)).toThrow(/already/i);
  });

  test('force replaces an existing config', () => {
    initProject(REPO);
    const again = initProject({ ...REPO, branchPrefix: 'bob' }, { force: true });
    expect(parseConfig(readFileSync(again.configPath, 'utf8')).repo.branchPrefix).toBe('bob');
  });

  test('a second repository gets its own project, leaving the first intact', () => {
    const first = initProject(REPO);
    const second = initProject({ ...REPO, name: 'gadgets', path: 'C:\\src\\gadgets' });
    expect(second.slug).not.toBe(first.slug);
    expect(existsSync(first.configPath)).toBe(true);
    expect(activeProjectSlug()).toBe(second.slug);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/init.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator/init.ts`.

- [ ] **Step 4: Write `src/orchestrator/init.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

import { SUBPROCESS_TIMEOUT_MS } from './exec.ts';
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
    const out = await execa('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    path = resolve(out.stdout.trim());
  } catch {
    throw new Error(`${cwd} is not inside a git repository. Run this from your project's checkout.`);
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/init.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire `init` into the CLI ahead of `loadConfig`**

`init` runs when there is no config to load, so it must be handled before line 122's `loadConfig()`. In `src/orchestrator/cli.ts`, add the import:

```ts
import { detectRepo, initProject } from './init.ts';
```

Replace the help line (line 118) with:

```ts
    console.log('commands: init | doctor | issues | import <issue> | forget <issue> | facts <issue> | reconcile <issue> | list | spawn <issue> <phase> | collect <issue>');
```

And insert this block between the help check (line 120) and `const config = loadConfig();` (line 122):

```ts
  // Commands that run *before* a config exists must be handled here — the
  // loadConfig() below is exactly what they are there to make possible.
  if (command === 'init') {
    const repo = await detectRepo(process.cwd());
    const { slug, configPath } = initProject(repo, { force: rest.includes('--force') });
    console.log(`project  ${slug}  (now active)`);
    console.log(`repo     ${repo.owner}/${repo.name}  (base ${repo.baseBranch})`);
    console.log(`path     ${repo.path}`);
    console.log(`branches ${repo.branchPrefix}/<issue>-<slug>`);
    console.log(`config   ${configPath}`);
    console.log('');
    console.log('Review the config, then run: npm start');
    return;
  }

  const config = loadConfig();
```

Then delete the original `const config = loadConfig();` line so it is not declared twice.

- [ ] **Step 7: Verify the command end to end**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, clean.

Run: `$env:MC_ROOT="$env:TEMP\mc-init-probe"; npm run mc -- init; Get-Content "$env:TEMP\mc-init-probe\projects\*\config.yaml" -TotalCount 20`
Expected: a config naming **this** repository (`otapiero/AgentWorkflowDashboard`, base `main`), with no `{{` left in it.

Then clean up: `Remove-Item -Recurse -Force "$env:TEMP\mc-init-probe"; Remove-Item Env:\MC_ROOT`

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/init.ts src/orchestrator/cli.ts assets/config.example.yaml test/init.test.ts
git commit -m "feat: add mc init to derive a config from git and gh"
```

---

## Task 4: `mc migrate` and the installer

Implements **R6**. Moves the existing `~/.mc` install into the new layout without losing a single task directory.

**Files:**
- Create: `src/orchestrator/migrate.ts`
- Create: `test/migrate.test.ts`
- Modify: `src/orchestrator/cli.ts` (the pre-config block from Task 3)
- Modify: `scripts/install.ps1` (whole file)

**Interfaces:**
- Consumes: `mcRoot`, `projectHome`, `projectSlug`, `setActiveProject`, `listProjects` from `paths.ts`; `parseConfig` from `config.ts`.
- Produces, from `src/orchestrator/migrate.ts`:
  - `interface MigrationResult { slug: string; from: string; to: string; sharedFiles: string[] }`
  - `legacyHomePath(): string`
  - `migrateLegacyHome(): MigrationResult`

- [ ] **Step 1: Write the failing tests**

Create `test/migrate.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLegacyHome } from '../src/orchestrator/migrate.ts';
import { activeProjectSlug, mcRoot, projectHome, projectSlug } from '../src/orchestrator/paths.ts';

let root: string;
let legacy: string;

const CONFIG = `
repo:
  path: 'C:\\\\src\\\\widgets'
  owner: 'acme'
  name: 'widgets'
  baseBranch: 'main'
  branchPrefix: 'alice'
github:
  auth: gh-cli
  pollIntervalSeconds: 30
  copilotReviewerLogin: 'copilot-pull-request-reviewer'
agents:
  claude:
    launch: 'claude'
    promptMode: positional
    instructionMode: flag
    instructionFlag: '--append-system-prompt'
pipeline:
  - id: plan
    label: Plan
    actor: claude
    command: mc-planner
    gate: { type: manual }
server:
  port: 4317
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-mig-root-'));
  legacy = mkdtempSync(join(tmpdir(), 'mc-mig-legacy-'));
  process.env.MC_ROOT = root;
  process.env.MC_LEGACY_HOME = legacy;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;

  writeFileSync(join(legacy, 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(join(legacy, 'state.json'), '{"tasks":[]}', 'utf8');
  mkdirSync(join(legacy, 'tasks', '3060', 'markers'), { recursive: true });
  writeFileSync(join(legacy, 'tasks', '3060', 'plan.md'), '# plan', 'utf8');
  mkdirSync(join(legacy, 'scripts'), { recursive: true });
  writeFileSync(join(legacy, 'scripts', 'run-phase.ps1'), '# script', 'utf8');
  writeFileSync(join(legacy, 't3-token.json'), '{"access_token":"x"}', 'utf8');
});

afterEach(() => {
  delete process.env.MC_ROOT;
  delete process.env.MC_LEGACY_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
});

describe('migrateLegacyHome', () => {
  test('moves the install under projects/<slug> and makes it active', () => {
    const result = migrateLegacyHome();
    expect(result.slug).toBe(projectSlug('acme', 'widgets'));
    expect(result.to).toBe(projectHome(result.slug));
    expect(activeProjectSlug()).toBe(result.slug);
  });

  test('carries task artifacts across intact', () => {
    const result = migrateLegacyHome();
    expect(readFileSync(join(result.to, 'tasks', '3060', 'plan.md'), 'utf8')).toBe('# plan');
    expect(existsSync(join(result.to, 'tasks', '3060', 'markers'))).toBe(true);
  });

  test('lifts the shared files to the install root', () => {
    // Scripts and the T3 token belong to the machine, not to one repository.
    const result = migrateLegacyHome();
    expect(existsSync(join(mcRoot(), 'scripts', 'run-phase.ps1'))).toBe(true);
    expect(existsSync(join(mcRoot(), 't3-token.json'))).toBe(true);
    expect(existsSync(join(result.to, 't3-token.json'))).toBe(false);
    expect(result.sharedFiles).toContain('t3-token.json');
  });

  test('the legacy directory is gone afterwards', () => {
    const result = migrateLegacyHome();
    expect(existsSync(result.from)).toBe(false);
  });

  test('refuses when the destination project already exists', () => {
    migrateLegacyHome();
    writeFileSync(join(legacy, 'config.yaml'), CONFIG, 'utf8');
    expect(() => migrateLegacyHome()).toThrow(/already/i);
  });

  test('says so plainly when there is nothing to migrate', () => {
    rmSync(legacy, { recursive: true, force: true });
    expect(() => migrateLegacyHome()).toThrow(/nothing to migrate/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/migrate.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator/migrate.ts`.

- [ ] **Step 3: Write `src/orchestrator/migrate.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the CLI command**

In `src/orchestrator/cli.ts`, add the import:

```ts
import { legacyHomePath, migrateLegacyHome } from './migrate.ts';
```

Add this immediately after the `init` block from Task 3, still above `const config = loadConfig();`:

```ts
  if (command === 'migrate') {
    const result = migrateLegacyHome();
    console.log(`migrated ${result.from}`);
    console.log(`      -> ${result.to}  (project ${result.slug}, now active)`);
    if (result.sharedFiles.length) {
      console.log(`shared   ${result.sharedFiles.join(', ')} moved to ${mcRoot()}`);
    }
    return;
  }
```

Import `mcRoot` alongside the existing `mcHome` import from `./paths.ts` (line 24).

Update the help line to include `migrate`:

```ts
    console.log('commands: init | migrate | doctor | issues | import <issue> | forget <issue> | facts <issue> | reconcile <issue> | list | spawn <issue> <phase> | collect <issue>');
```

Also add a hint about migration to the "no project" error path — in `src/orchestrator/paths.ts`, extend the zero-projects message in `activeProjectSlug()`:

```ts
  if (projects.length === 0) {
    throw new Error(
      `No project is set up yet. Run 'npm run mc -- init' from inside the repository you want to drive` +
        (existsSync(join(homedir(), '.mc'))
          ? `, or 'npm run mc -- migrate' to bring your existing ~/.mc install across.`
          : `.`),
    );
  }
```

- [ ] **Step 6: Rewrite the installer**

Replace `scripts/install.ps1` entirely:

```powershell
# Mission Control installer.
#
# Seeds the install root (%USERPROFILE%\.mission-control) with the phase
# scripts and the mc-* command files, then points you at `mc init` for the
# per-repository part. Nothing is ever written into a project checkout.
#
# Safe to re-run: scripts and commands are refreshed every time; no config is
# touched.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $repoRoot 'assets'

$mcRoot = if ($env:MC_ROOT) { $env:MC_ROOT } else { Join-Path $env:USERPROFILE '.mission-control' }
$claudeCommands = Join-Path $env:USERPROFILE '.claude\commands'
$legacyHome = Join-Path $env:USERPROFILE '.mc'

Write-Host ""
Write-Host "Mission Control installer" -ForegroundColor Green
Write-Host "  root:     $mcRoot"
Write-Host "  commands: $claudeCommands"
Write-Host ""

foreach ($dir in @($mcRoot, (Join-Path $mcRoot 'scripts'), (Join-Path $mcRoot 'projects'), $claudeCommands)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# --- phase scripts -------------------------------------------------------
Get-ChildItem (Join-Path $assets 'scripts') -Filter *.ps1 | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $mcRoot 'scripts') -Force
    Write-Host "  script   $($_.Name)" -ForegroundColor DarkGray
}

# --- user-scoped command files ------------------------------------------
# These stay the single editable source of prompt text. Mission Control reads
# them at spawn time, renders the task context in, and passes the result to the
# agent verbatim.
Get-ChildItem (Join-Path $assets 'claude\commands') -Filter *.md | ForEach-Object {
    Copy-Item $_.FullName $claudeCommands -Force
    Write-Host "  command  /$($_.BaseName)" -ForegroundColor DarkGray
}

# --- sanity checks -------------------------------------------------------
Write-Host ""
$problems = @()

foreach ($tool in @('git', 'gh', 'wt', 'pwsh')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        $problems += "$tool was not found on PATH"
    }
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { $problems += 'gh is not authenticated (run: gh auth login)' }

# T3 Code is optional: the t3 launcher needs it, wt and vscode do not.
$t3Runtime = Join-Path $env:USERPROFILE '.t3\userdata\server-runtime.json'
if (Test-Path $t3Runtime) {
    Write-Host "  ok: T3 Code state found at $t3Runtime"
    $t3Credential = Join-Path $mcRoot 't3-credential'
    $t3Token = Join-Path $mcRoot 't3-token.json'
    if (-not (Test-Path $t3Credential) -and -not (Test-Path $t3Token)) {
        Write-Host "  note: no T3 credential yet. The 't3' launcher needs one."
        Write-Host "        In T3: Settings -> This environment -> Authorized clients -> Create link."
        # Keep this block ASCII-only. Windows PowerShell 5.1 reads a .ps1 with
        # no BOM as ANSI, so a UTF-8 em-dash arrives as bytes ending in 0x94 --
        # a curly close-quote, which PowerShell accepts as a string terminator.
        # The result is a parser error tens of lines further down.
        Write-Host "        Save the 'This machine' URL to $t3Credential straight away:"
        Write-Host "        the link is single-use and expires within about three minutes."
    }
}
else {
    Write-Host "  note: T3 Code not detected. The 'wt' and 'vscode' launchers work without it."
}

if ($problems.Count -eq 0) {
    Write-Host "All checks passed." -ForegroundColor Green
}
else {
    Write-Host "Check the following:" -ForegroundColor Yellow
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}

Write-Host ""
if (Test-Path (Join-Path $legacyHome 'config.yaml')) {
    Write-Host "An older install was found at $legacyHome." -ForegroundColor Yellow
    Write-Host "Bring it across with:  npm run mc -- migrate" -ForegroundColor Yellow
}
elseif (-not (Get-ChildItem (Join-Path $mcRoot 'projects') -Directory -ErrorAction SilentlyContinue)) {
    Write-Host "Next: cd into the repository you want to drive, then run:" -ForegroundColor Green
    Write-Host "  npm run mc -- init" -ForegroundColor Green
}
else {
    Write-Host "Next: npm start" -ForegroundColor Green
}
Write-Host ""
```

- [ ] **Step 7: Run the full suite and the installer**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, clean.

Run: `$env:MC_ROOT="$env:TEMP\mc-install-probe"; powershell -File scripts\install.ps1`
Expected: scripts and commands copied; the closing hint tells you to migrate (you have a real `~/.mc`).

Clean up: `Remove-Item -Recurse -Force "$env:TEMP\mc-install-probe"; Remove-Item Env:\MC_ROOT`

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/migrate.ts src/orchestrator/cli.ts src/orchestrator/paths.ts scripts/install.ps1 test/migrate.test.ts
git commit -m "feat: migrate a legacy install into the project layout"
```

---

## Task 5: `mc project` commands

Implements **R3**'s operator surface. Small, and the last piece of multi-repo support.

**Files:**
- Modify: `src/orchestrator/cli.ts` (the pre-config block)
- Test: `test/project-paths.test.ts` (extend)

**Interfaces:**
- Consumes: `listProjects`, `setActiveProject`, `activeProjectSlug`, `projectHome` from `paths.ts`.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing test**

Append to `test/project-paths.test.ts`:

```ts
describe('switching the active project', () => {
  test('setActiveProject is what a later resolution reads back', () => {
    makeProject('a__one');
    makeProject('b__two');
    setActiveProject('a__one');
    expect(activeProjectSlug()).toBe('a__one');
    setActiveProject('b__two');
    expect(activeProjectSlug()).toBe('b__two');
  });
});
```

- [ ] **Step 2: Run it to verify it passes already**

Run: `npx vitest run test/project-paths.test.ts`
Expected: PASS — `setActiveProject` landed in Task 2. This test exists to pin the round-trip the CLI depends on; the CLI wiring below is verified by hand, since `cli.ts` is a process entry point with no test harness.

- [ ] **Step 3: Add the `project` command**

In `src/orchestrator/cli.ts`, import `activeProjectSlug`, `listProjects`, `projectHome`, `setActiveProject` alongside the existing `paths.ts` imports, and add this after the `migrate` block, still above `const config = loadConfig();`:

```ts
  if (command === 'project') {
    const [action, slug] = rest;

    if (!action || action === 'list') {
      const projects = listProjects();
      if (projects.length === 0) {
        console.log('no projects yet (run: npm run mc -- init)');
        return;
      }
      // Resolution can legitimately fail here (several projects, no choice),
      // and listing them is exactly how you recover from that.
      let active = '';
      try {
        active = activeProjectSlug();
      } catch {
        active = '';
      }
      for (const project of projects) {
        console.log(`${project === active ? '*' : ' '} ${project}  ${projectHome(project)}`);
      }
      return;
    }

    if (action === 'use') {
      if (!slug) die('usage: project use <slug>');
      if (!listProjects().includes(slug)) {
        die(`unknown project '${slug}'. known: ${listProjects().join(', ') || 'none'}`);
      }
      setActiveProject(slug);
      console.log(`active project is now ${slug}`);
      console.log('Restart the server for it to take effect.');
      return;
    }

    die(`usage: project [list] | project use <slug>`);
  }
```

Update the help line:

```ts
    console.log('commands: init | migrate | project [list|use <slug>] | doctor | issues | import <issue> | forget <issue> | facts <issue> | reconcile <issue> | list | spawn <issue> <phase> | collect <issue>');
```

- [ ] **Step 4: Show the active project in `doctor`**

In `src/orchestrator/cli.ts`, add one line at the top of `doctor()` (before the existing `home` line at line 42):

```ts
  console.log(`root        ${mcRoot()}`);
  console.log(`project     ${activeProjectSlug()}`);
```

- [ ] **Step 5: Verify by hand**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, clean.

Run: `npm run mc -- project list`
Expected: your migrated project listed with a `*`. (If you have not run `mc migrate` yet, `no projects yet` is the correct answer.)

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/cli.ts test/project-paths.test.ts
git commit -m "feat: list and switch projects from the CLI"
```

---

## Task 6: Rename to `mission-control`

Implements **R8**. Mechanical and wide; done after the structural work so it does not collide with it.

**Files:**
- Modify: `package.json:2`
- Modify: `vscode-extension/package.json:2,38-39`
- Modify: `vscode-extension/src/server-manager.ts:138`
- Modify: `vscode-extension/test/extension/extension.test.ts` (4 occurrences), `vscode-extension/test/unit/manifest.test.ts` if it asserts the name
- Modify: `src/orchestrator/t3/auth.ts` (`client_label`, doc comment), `src/orchestrator/t3/doctor.ts:42,49`, `src/orchestrator/t3/client.ts:80`, `src/orchestrator/spawn.ts`, `src/orchestrator/paths.ts` comment, `src/orchestrator/spawn-plan.ts:46` comment, `src/web/components/Settings.tsx:105`
- Modify: `test/config.test.ts:20-26,79-80`, `test/spawn-plan.test.ts:51-54`, `test/t3-config.test.ts:10-13`, `test/t3-facts.test.ts:200-239`, `test/branch-match.test.ts`, `test/state.test.ts`, `test/slug.test.ts`, `test/reconcile.test.ts:36`, `test/spawn.test.ts`, `test/board.test.ts`, `test/agents.test.ts`, `test/notify.test.ts`, `test/github-parse.test.ts`, `test/t3-client.test.ts`, `test/t3-commands.test.ts`, `test/t3-schemas.test.ts`, `test/usage.test.ts`

- [ ] **Step 1: Rename the npm package**

In `package.json`, set `"name": "mission-control"` and update `"description"`:

```json
  "name": "mission-control",
  "description": "A local cockpit for driving AI coding agents through a GitHub issue-to-merge pipeline",
```

- [ ] **Step 2: Rename the VS Code extension**

In `vscode-extension/package.json`, set `"name": "mission-control"`, and replace the two hardcoded artifact names in the scripts so a version bump cannot desynchronise them:

```json
    "package": "npm run verify && vsce package --out dist/mission-control.vsix && npm run check:vsix-size",
    "check:vsix-size": "node scripts/check-vsix-size.mjs dist/mission-control.vsix",
```

In `vscode-extension/src/server-manager.ts:138`, change the identity check:

```ts
    if (pkg.name !== 'mission-control' || typeof pkg.scripts?.start !== 'string') {
```

In `vscode-extension/test/extension/extension.test.ts`, replace all four `otapiero.mission-control` with `otapiero.mission-control`.

- [ ] **Step 3: Update the operator-facing strings**

Replace every user-visible `~/.mc` with `~/.mission-control` in:
- `src/orchestrator/t3/doctor.ts:42,49`
- `src/orchestrator/t3/client.ts:80`
- `src/orchestrator/t3/auth.ts` (doc comment at line 32, and the message at line 217)
- `src/web/components/Settings.tsx:105`

In `src/orchestrator/t3/auth.ts:199`, change the pairing label:

```ts
      client_label: 'Mission Control',
```

In `src/orchestrator/spawn.ts:498`, the T3 project title default is now the repository:

```ts
        title: config.t3?.projectTitle ?? config.repo.name,
```

In `src/shared/types.ts:427`, update the doc comment:

```ts
  /** Title of the T3 project Mission Control creates. Defaults to the repo name. */
```

Replace "Acme" with "the project" in the doc comments at `src/orchestrator/paths.ts` (now already rewritten in Task 2 — verify), `src/orchestrator/spawn-plan.ts:46`, and `src/orchestrator/t3/commands.ts:257`.

- [ ] **Step 4: De-personalise the test fixtures**

Across the test files listed above, replace fixture values:
- `'acme'` → `'acme'`
- `'widgets'` → `'widgets'`
- `'ouriel'` (as a branch prefix or login) → `'alice'`
- `'C:\\src\\widgets'` → `'C:\\src\\widgets'`
- `'C:\\Users\\ouriel\\.mc'` → `'C:\\Users\\alice\\.mission-control\\projects\\acme__widgets'`
- `'widgets'` (as a T3 project title) → `'widgets'`
- `'Acme'` (as a T3 project title) → `'widgets'`

These are pure fixture values — the assertions around them change with them. `test/t3-facts.test.ts:200` carries a comment quoting a real observed path; rewrite the comment to use the new fixture rather than deleting the observation.

Do **not** touch `test/branch-match.test.ts:46`'s deliberate mismatch case (`'otapiero/3060-audio-mode'` vs prefix `'ouriel'`) without renaming both sides — the test's whole point is that a different prefix does not match. Use `'bob/3060-audio-mode'` against prefix `'alice'`.

- [ ] **Step 5: Verify the rename is complete**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, clean.

Run: `git grep -ni "acme\|acme\|ouriel\|widgets" -- src test assets scripts vscode-extension/src vscode-extension/test package.json`
Expected: **no output**. (`docs/superpowers/**` and `plan.md`/`spec.md` are historical records and are handled in Task 8.)

- [ ] **Step 6: Rebuild the extension to prove the manifest still loads**

Run: `npm run extension:install-deps && npm run extension:verify`
Expected: typecheck, unit tests, performance check and build all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: rename to mission-control and de-personalise fixtures"
```

---

## Task 7: License, package metadata, and the launcher script

Implements **R7** (metadata half).

**Files:**
- Create: `LICENSE`
- Modify: `package.json`
- Modify: `vscode-extension/package.json`
- Modify: `start-mission-control.bat`
- Modify: `.gitignore`

- [ ] **Step 1: Add the MIT license**

Create `LICENSE`:

```
MIT License

Copyright (c) 2026 Ouriel Tapiero

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Complete the root `package.json` metadata**

Replace the top block (lines 2-6) with:

```json
  "name": "mission-control",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "author": "Ouriel Tapiero",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/otapiero/AgentWorkflowDashboard.git"
  },
  "bugs": {
    "url": "https://github.com/otapiero/AgentWorkflowDashboard/issues"
  },
  "homepage": "https://github.com/otapiero/AgentWorkflowDashboard#readme",
  "keywords": ["ai-agents", "claude-code", "codex", "github", "worktree", "orchestration"],
  "engines": {
    "node": ">=22.0.0"
  },
  "os": ["win32"],
  "type": "module",
  "description": "A local cockpit for driving AI coding agents through a GitHub issue-to-merge pipeline",
```

`private: true` stays — this is cloned and run, not installed from npm, and leaving it set prevents an accidental publish.

- [ ] **Step 3: Complete the extension manifest**

In `vscode-extension/package.json`, add after `"publisher"`:

```json
  "displayName": "Mission Control",
  "description": "Drive Mission Control's agent pipeline from the VS Code sidebar",
  "license": "MIT",
  "icon": "resources/mission-control.svg",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/otapiero/AgentWorkflowDashboard.git"
  },
```

Note: the Marketplace requires a 128×128 PNG icon, not SVG. If `npm run extension:package` rejects the SVG, drop the `icon` field rather than inventing a PNG here — packaging an unlisted `.vsix` works without one, and producing artwork is out of scope for this plan.

- [ ] **Step 4: Make the launcher script self-locating**

Replace line 3 of `start-mission-control.bat`:

```bat
cd /d "%~dp0"
```

- [ ] **Step 5: Ignore the local scratch file**

Add to `.gitignore` (it is already covered by `*.log`, but the entry documents intent):

```
debug.log
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npx vitest run && npm run extension:verify`
Expected: PASS.

Run: `.\start-mission-control.bat` from a different working directory, e.g. `cd C:\ ; & 'C:\Users\ouriel\source\repos\otapiero\AgentWorkflowDashboard\start-mission-control.bat'`
Expected: the server starts and the browser opens on `http://127.0.0.1:4317`. Close the window afterwards.

- [ ] **Step 7: Commit**

```bash
git add LICENSE package.json vscode-extension/package.json start-mission-control.bat .gitignore
git commit -m "chore: add MIT license and publishable package metadata"
```

---

## Task 8: CI, README, and CONTRIBUTING

Implements **R7** (CI half) and closes out **R8**.

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `CONTRIBUTING.md`
- Modify: `README.md` (whole file)

- [ ] **Step 1: Add the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  test:
    # Mission Control is a Windows application: the phase scripts are
    # PowerShell and the default launcher is Windows Terminal. Testing on
    # anything else would verify a configuration nobody runs.
    runs-on: windows-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - run: npm run typecheck

      - run: npm test

      - run: npm run build

  extension:
    runs-on: windows-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: vscode-extension/package-lock.json

      - run: npm run extension:install-deps

      # typecheck + unit tests + performance budget + build. The VS Code
      # integration test needs a real editor download and is left to a manual
      # `npm run extension:test-host`.
      - run: npm run extension:verify
```

- [ ] **Step 2: Verify the workflow's commands actually pass locally**

Run: `npm ci && npm run typecheck && npm test && npm run build`
Expected: all PASS. `npm ci` reinstalls from the lockfile — if it fails where `npm install` worked, the lockfile is stale and must be regenerated and committed as part of this task.

Run: `npm run extension:install-deps && npm run extension:verify`
Expected: PASS.

- [ ] **Step 3: Write `CONTRIBUTING.md`**

```markdown
# Contributing

## Getting set up

```powershell
npm install
npm run build
powershell -File scripts\install.ps1
cd <your repo>
npm run mc -- init
```

## The three principles

Changes are reviewed against these, so it is worth reading them in the README
before opening a pull request.

1. **Deterministic scripts over agents.** Worktrees, branches, markers and `gh`
   reads are done by scripts. Agents are reserved for cognition.
2. **The app is a reconciler over durable facts.** The running app is never the
   source of truth. Closing or crashing it must never lose state.
3. **Zero footprint in the project repo.** Nothing is written into the
   repository Mission Control is driving.

## Working on it

```powershell
npm run dev        # Vite dev server + Fastify, live reload
npm test           # the unit suite
npm run test:watch
npm run typecheck
```

The reconciler (`src/orchestrator/reconcile.ts`) is pure and is the main
verification surface — it is tested exhaustively against hand-built facts and
against real recorded `gh` payloads. New behaviour there needs a test.

Tests isolate by pointing `MC_ROOT` and/or `MC_HOME` at a `mkdtempSync`
directory. Never let a test touch the real `~/.mission-control`.

## Layout

See the Layout section of the README.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
One logical change per commit.
```

- [ ] **Step 4: Rewrite the README**

Rewrite `README.md` making exactly these changes and leaving the rest of the structure intact:

1. Title → `# Mission Control`.
2. Replace the opening paragraph and the "Built for one machine and one repository" line with:

```markdown
A local, single-user cockpit for driving AI coding agents (Claude Code, GitHub
Copilot CLI, Codex CLI) through a GitHub issue-to-merge pipeline. One screen
shows where every task is and which need you; one click moves any task forward
with no retyped prompts.

Windows only. It leans on Windows Terminal, PowerShell 7 and the `gh` CLI, and
there is no plan to port it.
```

3. In "The three principles", change "the Acme checkout" to "your project's checkout" and `%USERPROFILE%\.mc\` to `%USERPROFILE%\.mission-control\`.
4. Replace the "Setup" section body with:

```markdown
```powershell
npm install
npm run build
powershell -File scripts\install.ps1
```

`install.ps1` seeds `%USERPROFILE%\.mission-control\` with the phase scripts and
the `mc-*` command files, and checks that `git`, `gh`, `wt` and `pwsh` are on
PATH and that `gh` is authenticated.

Then point it at a repository — run this from inside the checkout you want to
drive:

```powershell
npm run mc -- init
```

`init` reads the repository's owner, name and default branch from `git` and
`gh`, and your login from `gh api user`, and writes a ready
`config.yaml`. Nothing to fill in by hand, though everything in it is yours to
edit.

### Several repositories

One install can drive several. Each `mc init` creates a project under
`%USERPROFILE%\.mission-control\projects\<owner>__<name>\`, holding that
repository's config, board state, task artifacts and worktrees. The phase
scripts and the T3 pairing credential are shared by the whole install.

```powershell
npm run mc -- project list        # * marks the active one
npm run mc -- project use acme__widgets
```

The active project is read at server start, so switching means restarting the
server. The board's top bar always shows which repository you are looking at.

### Upgrading from a pre-0.2 install

```powershell
npm run mc -- migrate
```

Moves `%USERPROFILE%\.mc\` into the new layout, keeping every task
directory, plan, artifact, worktree and the cached T3 token.
```

5. Everywhere else, replace `~/.mc` / `%USERPROFILE%\.mc\` with the `.mission-control` equivalents, and the T3 credential path with `%USERPROFILE%\.mission-control\t3-credential`.
6. In "How a spawn works", change "fetching the latest `dev` first" to "fetching the latest base branch first".
7. In "Prompt delivery", replace the last sentence with: "If your project has its own PR-publishing skill or command, `mc-publish` will use it by name."
8. Add a new subsection under "Choosing agent, model and effort":

```markdown
### The pipeline is opinionated

`config.yaml` lets you relabel each phase, change which agent runs it, and
change its gate. It does not let you add, remove or reorder phases — the set
(`plan → implement → publish → ci → copilot_review → dev_review → merge`) is
built into the reconciler. If a phase does not apply to your project, set its
actor to `you` and its gate to `manual` and click through it.
```

9. In "Testing", correct the count: `npm test          # 596 unit tests`.
10. In "Layout", change `assets/config.example.yaml` to `assets/config.example.yaml  template rendered by mc init`, and add `src/orchestrator/init.ts` and `migrate.ts` to the orchestrator list.
11. Add a Licence section at the end: `## Licence` / `MIT — see [LICENSE](LICENSE).`

- [ ] **Step 5: Note the historical documents**

Add to the top of `plan.md` and `spec.md`:

```markdown
> Historical. This is the original design record from when Mission Control was
> built for a single repository, kept for the reasoning it captures. It names
> that repository throughout; the shipped tool is repository-agnostic.
```

Do the same in `docs/superpowers/specs/2026-07-21-mission-control-design.md`.

- [ ] **Step 6: Final verification**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: 46+ files, 596+ tests PASS; typecheck clean; build succeeds.

Run: `git grep -ni "acme\|acme\|ouriel" -- README.md CONTRIBUTING.md .github/`
Expected: **no output**.

Run: `npm run mc -- doctor`
Expected: root, project, repo, agents, pipeline, tool checks — all reading from your migrated project.

- [ ] **Step 7: Commit**

```bash
git add .github CONTRIBUTING.md README.md plan.md spec.md docs/superpowers/specs/2026-07-21-mission-control-design.md
git commit -m "docs: rewrite the README for a general audience and add CI"
```

---

## Verification checklist

Run after Task 8, from a clean tree:

- [ ] `npm ci && npm run typecheck && npm test && npm run build` — all green.
- [ ] `npm run extension:verify` — green.
- [ ] `git grep -ni "acme\|acme\|ouriel\|widgets" -- src test assets scripts vscode-extension/src vscode-extension/test package.json README.md CONTRIBUTING.md .github/` — no output.
- [ ] `npm run mc -- doctor` names the active project and your real repository.
- [ ] Import an issue, spawn a `plan` phase, and confirm the terminal tab opens, the running marker appears under `%USERPROFILE%\.mission-control\projects\<slug>\tasks\<issue>\markers\`, and the card goes live on the board.
- [ ] Open the rendered prompt at `...\tasks\<issue>\prompt.txt` and confirm it names **your** repository, with no `{{` left in it.
- [ ] `npm run mc -- init` in a second, unrelated repository, then `npm run mc -- project list` shows both.
