# Plan Artifact Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every artifact a planning run produces (plan.md plus any spec/design/diagram files, wherever they land), tie them to the task, and surface them in the drawer — without changing how the agent plans.

**Architecture:** Capture is a filesystem **diff**, never a parse of any tool's output, so it is agnostic to superpowers / spec-kit / freehand. MC writes a `plan.snapshot.json` "before" picture into the task folder at spawn; a single `collectArtifacts(issue)` routine later diffs the watch roots (the Acme worktree via `git status`, and the task dir), copies new/changed files into `tasks/<issue>/artifacts/`, and writes an `artifacts.json` manifest. The routine has two triggers: the agent writes a `plan.done` marker as an optional sign-off (belt), and the poller runs it automatically once a plan spawn ends with no manifest yet (suspenders). Artifacts become a recomputed **fact**, never stored state.

**Tech Stack:** TypeScript run via `tsx`; Fastify + SSE server; React + Vite UI; `execa` for git; `vitest` for tests.

## Global Constraints

- All source imports use explicit `.ts`/`.tsx` extensions (e.g. `import { x } from './paths.ts'`).
- Runtime state lives **only** under `MC_HOME` (`%USERPROFILE%\.mc\`, overridable via the `MC_HOME` env var). Never write into the Acme checkout. Reading `git status` in the worktree is the sole in-repo touch.
- Artifacts are **copied, never deleted** from the checkout.
- The reconciler (`reconcile.ts`) stays **pure** — no filesystem, network, or clock. All reads live in `gatherFacts`; the only new side effect (auto-collect) lives in the poller.
- This feature is scoped to the **plan** phase only.
- Tests are `vitest`, co-located as `*.test.ts`, run with `npm test`. Point `process.env.MC_HOME` at a fresh temp dir per test and restore it after.

---

## File Structure

- **Create** `src/orchestrator/artifacts.ts` — the whole capture unit: `ArtifactRef`/`PlanSnapshot` types, pure helpers (`parsePorcelainPaths`, `diffFiles`, `uniqueName`, `resolveArtifactStoredPath`, `shouldCollectPlan`), and the fs routines (`writePlanSnapshot`, `collectArtifacts`, `readArtifacts`).
- **Create** `src/orchestrator/artifacts.test.ts` — unit tests for the above.
- **Modify** `src/orchestrator/paths.ts` — add `planSnapshotPath`, `artifactsManifestPath`, `artifactsDir`.
- **Modify** `src/shared/types.ts` — `Facts.artifacts`, `DerivedState.artifacts`, `BadgeKind` += `'artifacts-in-repo'`, `Config.repo.artifactRoots?`.
- **Modify** `src/orchestrator/facts.ts` — populate `facts.artifacts`.
- **Modify** `src/orchestrator/reconcile.ts` — pass `artifacts` through; add the "in checkout" badge.
- **Modify** `src/orchestrator/reconcile.test.ts` (create if absent) — badge behavior.
- **Modify** `src/orchestrator/spawn.ts` — write the snapshot on a plan spawn; add `openArtifactInEditor`.
- **Modify** `src/orchestrator/poller.ts` — auto-collect trigger; `artifacts: []` in the fallback facts literal.
- **Modify** `src/orchestrator/cli.ts` — `collect <issue>` subcommand.
- **Modify** `src/server/routes.ts` — `POST /api/tasks/:issue/artifacts/:name/open`.
- **Modify** `src/web/api.ts` — `openArtifact(issue, name)`.
- **Modify** `src/web/components/Drawer.tsx` — an "Artifacts" section.
- **Modify** `~/.claude/commands/mc-planner.md` + `src/orchestrator/prompt.ts` — the `{{donePath}}` sign-off line.

---

## Task 1: Paths, types, and the pure capture core

**Files:**
- Modify: `src/orchestrator/paths.ts`
- Modify: `src/shared/types.ts`
- Create: `src/orchestrator/artifacts.ts`
- Create: `src/orchestrator/artifacts.test.ts`

**Interfaces:**
- Consumes: `taskDir(issue)` from `paths.ts`.
- Produces:
  - `planSnapshotPath(issue: number): string`, `artifactsManifestPath(issue: number): string`, `artifactsDir(issue: number): string`
  - `interface ArtifactRef { name: string; storedPath: string; origin: 'taskdir' | 'repo'; originalPath: string }`
  - `interface PlanSnapshot { takenAt: string; taskDirFiles: string[]; repoStatus: string[]; extraRoots: Record<string, string[]> }`
  - `parsePorcelainPaths(stdout: string): string[]`
  - `diffFiles(before: string[], after: string[]): string[]`
  - `uniqueName(existing: string[], base: string): string`
  - `shouldCollectPlan(i: { liveSpawn: unknown; planMdExists: boolean; planDoneMarker: boolean; manifestExists: boolean }): boolean`
  - `resolveArtifactStoredPath(issue: number, name: string, refs: ArtifactRef[]): string | null`
  - `Facts.artifacts: ArtifactRef[]`, `DerivedState.artifacts: ArtifactRef[]`, `BadgeKind` includes `'artifacts-in-repo'`, `Config['repo'].artifactRoots?: string[]`

- [ ] **Step 1: Add path helpers**

In `src/orchestrator/paths.ts`, after `promptPath`:

```ts
/** The "before" picture captured at plan spawn, used to attribute artifacts. */
export function planSnapshotPath(issue: number): string {
  return join(taskDir(issue), 'plan.snapshot.json');
}

/** The manifest of artifacts a plan run produced. */
export function artifactsManifestPath(issue: number): string {
  return join(taskDir(issue), 'artifacts.json');
}

/** Where collected copies of a run's artifacts are stored, MC-owned. */
export function artifactsDir(issue: number): string {
  return join(taskDir(issue), 'artifacts');
}
```

- [ ] **Step 2: Extend the shared types**

In `src/shared/types.ts`:
- Add to `Facts` (after `planMdExists`): `/** Artifacts a plan run produced, from artifacts.json. Empty when none. */ artifacts: ArtifactRef[];`
- Add to `DerivedState` (after `badges`): `artifacts: ArtifactRef[];`
- Add `'artifacts-in-repo'` to the `BadgeKind` union.
- Add to the `Config['repo']` object type: `/** Extra absolute dirs to also diff for artifacts. Ships empty. */ artifactRoots?: string[];`
- Add the exported interface:

```ts
/** One artifact a planning run produced, copied into the task's own folder. */
export interface ArtifactRef {
  name: string;
  /** Path relative to the task dir, e.g. 'artifacts/2026-foo-design.md'. */
  storedPath: string;
  /** 'taskdir' = written beside plan.md; 'repo' = written into the checkout. */
  origin: 'taskdir' | 'repo';
  /** Absolute path the artifact was first found at. */
  originalPath: string;
}
```

- [ ] **Step 3: Write the failing test for the pure helpers**

Create `src/orchestrator/artifacts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parsePorcelainPaths,
  diffFiles,
  uniqueName,
  shouldCollectPlan,
} from './artifacts.ts';

describe('parsePorcelainPaths', () => {
  it('extracts paths and resolves renames to their new name', () => {
    const out = ' M docs/spec.md\n?? docs/new.md\nR  a.md -> b.md\n';
    expect(parsePorcelainPaths(out)).toEqual(['docs/spec.md', 'docs/new.md', 'b.md']);
  });
  it('returns [] for empty output', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });
});

describe('diffFiles', () => {
  it('returns entries present in after but not before', () => {
    expect(diffFiles(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });
});

describe('uniqueName', () => {
  it('keeps the base when free', () => {
    expect(uniqueName([], 'plan.md')).toBe('plan.md');
  });
  it('suffixes before the extension on collision', () => {
    expect(uniqueName(['plan.md'], 'plan.md')).toBe('plan-1.md');
    expect(uniqueName(['plan.md', 'plan-1.md'], 'plan.md')).toBe('plan-2.md');
  });
});

describe('shouldCollectPlan', () => {
  const base = { liveSpawn: null, planMdExists: true, planDoneMarker: false, manifestExists: false };
  it('collects when the plan spawn has ended and produced a plan', () => {
    expect(shouldCollectPlan(base)).toBe(true);
  });
  it('collects on the done marker even if a process still looks live', () => {
    expect(shouldCollectPlan({ ...base, liveSpawn: { pid: 1 }, planDoneMarker: true })).toBe(true);
  });
  it('never collects once a manifest exists', () => {
    expect(shouldCollectPlan({ ...base, manifestExists: true })).toBe(false);
  });
  it('waits while a spawn is live with no done marker', () => {
    expect(shouldCollectPlan({ ...base, liveSpawn: { pid: 1 } })).toBe(false);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -- artifacts`
Expected: FAIL — `artifacts.ts` has no such exports.

- [ ] **Step 5: Implement the pure helpers**

Create `src/orchestrator/artifacts.ts` (fs routines are added in Task 2; this step is the pure core plus type re-exports):

```ts
import { join } from 'node:path';

import { taskDir } from './paths.ts';
import type { ArtifactRef } from '../shared/types.ts';

/** Paths from `git status --porcelain`; a rename resolves to its new name. */
export function parsePorcelainPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const rest = line.slice(3); // strip the two status chars + separator
      const arrow = rest.indexOf(' -> ');
      return (arrow === -1 ? rest : rest.slice(arrow + 4)).trim();
    });
}

/** Entries present in `after` but not `before`. */
export function diffFiles(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((p) => !seen.has(p));
}

/** A name not already in `existing`, suffixed `-1`, `-2`, … before the ext. */
export function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  const dot = base.lastIndexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? '' : base.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * Whether the poller should collect a plan run's artifacts now. Collect once a
 * run is finished (or the agent signalled done), and never twice — a manifest
 * already on disk is the "already collected" sentinel.
 */
export function shouldCollectPlan(i: {
  liveSpawn: unknown;
  planMdExists: boolean;
  planDoneMarker: boolean;
  manifestExists: boolean;
}): boolean {
  if (i.manifestExists) return false;
  return i.planDoneMarker || (!i.liveSpawn && i.planMdExists);
}

/** The absolute stored copy for an artifact named `name`, or null if unknown. */
export function resolveArtifactStoredPath(
  issue: number,
  name: string,
  refs: ArtifactRef[],
): string | null {
  const ref = refs.find((r) => r.name === name);
  return ref ? join(taskDir(issue), ref.storedPath) : null;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- artifacts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors (the new type fields are not yet read anywhere, which is fine).

```bash
git add src/orchestrator/paths.ts src/shared/types.ts src/orchestrator/artifacts.ts src/orchestrator/artifacts.test.ts
git commit -m "feat: artifact-capture types, paths, and pure core"
```

---

## Task 2: Snapshot, collection, and the headless CLI

**Files:**
- Modify: `src/orchestrator/artifacts.ts`
- Modify: `src/orchestrator/artifacts.test.ts`
- Modify: `src/orchestrator/cli.ts`

**Interfaces:**
- Consumes: `planSnapshotPath`, `artifactsManifestPath`, `artifactsDir`, `taskDir` (paths.ts); `worktreePath`, `worktreeExists` (paths.ts / worktree.ts); `writeMarker` (markers.ts); `Config`, `ArtifactRef`, `PlanSnapshot`; the Task 1 helpers.
- Produces:
  - `writePlanSnapshot(config: Config, issue: number): void` — also clears any prior manifest, artifacts dir, and `plan.done` marker so a re-run re-collects.
  - `collectArtifacts(config: Config, issue: number, trigger?: 'command' | 'auto'): Promise<ArtifactRef[]>`
  - `readArtifacts(issue: number): ArtifactRef[]`

- [ ] **Step 1: Write the failing test (snapshot → add files → collect)**

Append to `src/orchestrator/artifacts.test.ts`:

```ts
import { afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePlanSnapshot, collectArtifacts, readArtifacts } from './artifacts.ts';
import { taskDir, planPath, worktreePath } from './paths.ts';
import type { Config } from '../shared/types.ts';

// A worktree that already contains a committed file, so only later additions
// are attributed to the run. `git status --porcelain` needs a real git repo.
import { execaSync } from 'execa';

let home: string;
let repo: string;
const ISSUE = 4242;
const config = { repo: { path: '' } } as unknown as Config;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-home-'));
  process.env.MC_HOME = home;
  // The plan run works in the task's worktree; create it as a git repo.
  repo = worktreePath(ISSUE);
  mkdirSync(repo, { recursive: true });
  execaSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), 'base\n');
  execaSync('git', ['add', '.'], { cwd: repo });
  execaSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: repo });
  mkdirSync(taskDir(ISSUE), { recursive: true });
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('collectArtifacts', () => {
  it('captures task-dir and repo-origin artifacts, tagging origin', () => {
    writePlanSnapshot(config, ISSUE);
    // Agent writes plan.md (task dir) + a design doc inside the checkout.
    writeFileSync(planPath(ISSUE), '# plan\n');
    writeFileSync(join(taskDir(ISSUE), 'spec.md'), '# spec\n');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'design.md'), '# design\n');

    const refs = collectArtifactsSync(config, ISSUE); // see helper note below
    const byName = Object.fromEntries(refs.map((r) => [r.name, r]));

    expect(byName['spec.md'].origin).toBe('taskdir');
    expect(byName['design.md'].origin).toBe('repo');
    // plan.md is the primary signal, surfaced elsewhere — not in the list.
    expect(byName['plan.md']).toBeUndefined();
    // Copies live under the task's own folder.
    expect(existsSync(join(taskDir(ISSUE), 'artifacts', 'design.md'))).toBe(true);
    expect(readArtifacts(ISSUE)).toHaveLength(refs.length);
  });

  it('is idempotent and a re-snapshot clears the prior manifest', () => {
    writePlanSnapshot(config, ISSUE);
    writeFileSync(join(taskDir(ISSUE), 'spec.md'), 'x');
    collectArtifactsSync(config, ISSUE);
    collectArtifactsSync(config, ISSUE);
    expect(readArtifacts(ISSUE)).toHaveLength(1);

    writePlanSnapshot(config, ISSUE); // a new run
    expect(existsSync(join(taskDir(ISSUE), 'artifacts.json'))).toBe(false);
  });
});
```

> Note on `collectArtifactsSync`: `collectArtifacts` is async (it shells out to git). In the test, await it:
> `const refs = await collectArtifacts(config, ISSUE);` — mark the two `it` callbacks `async` and replace the `collectArtifactsSync(...)` calls with `await collectArtifacts(...)`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- artifacts`
Expected: FAIL — `writePlanSnapshot` / `collectArtifacts` / `readArtifacts` not exported.

- [ ] **Step 3: Implement the fs routines**

Append to `src/orchestrator/artifacts.ts`:

```ts
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execa } from 'execa';

import {
  artifactsDir,
  artifactsManifestPath,
  markerPath,
  planSnapshotPath,
} from './paths.ts';
import { worktreePath, worktreeExists } from './worktree.ts';
import type { Config, PlanSnapshot } from '../shared/types.ts';

// Task-dir entries that are MC's own bookkeeping, never artifacts. plan.md is
// excluded too: it is the primary signal with its own drawer surface.
const RESERVED = new Set([
  'markers', 'prompt.txt', 'plan.md', 'plan.snapshot.json',
  'artifacts', 'artifacts.json', 'spawn.json',
]);

function isReserved(name: string): boolean {
  return RESERVED.has(name) || name.endsWith('.code-workspace');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !isReserved(n));
  } catch {
    return [];
  }
}

async function gitStatusPaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execa('git', ['status', '--porcelain'], { cwd });
    return parsePorcelainPaths(stdout);
  } catch {
    return [];
  }
}

/** Capture the "before" picture, and clear any prior run's collected state. */
export function writePlanSnapshot(config: Config, issue: number): void {
  rmSync(artifactsManifestPath(issue), { force: true });
  rmSync(artifactsDir(issue), { recursive: true, force: true });
  rmSync(markerPath(issue, 'plan.done'), { force: true });

  // Repo status can only be read synchronously-enough via a spawned git; a
  // fresh worktree has none yet, so an empty list is the correct "before".
  const snapshot: PlanSnapshot = {
    takenAt: new Date().toISOString(),
    taskDirFiles: listDir(taskDirOf(issue)),
    repoStatus: [], // filled below if a worktree already exists
    extraRoots: {},
  };
  for (const root of config.repo.artifactRoots ?? []) {
    snapshot.extraRoots[root] = listDir(root);
  }
  mkdirSync(taskDirOf(issue), { recursive: true });
  writeFileSync(planSnapshotPath(issue), JSON.stringify(snapshot, null, 2), 'utf8');

  if (worktreeExists(issue)) {
    // Best-effort async fill; the manifest attribution tolerates a missing one.
    void gitStatusPaths(worktreePath(issue)).then((paths) => {
      snapshot.repoStatus = paths;
      writeFileSync(planSnapshotPath(issue), JSON.stringify(snapshot, null, 2), 'utf8');
    });
  }
}

function readSnapshot(issue: number): PlanSnapshot {
  try {
    return JSON.parse(readFileSync(planSnapshotPath(issue), 'utf8')) as PlanSnapshot;
  } catch {
    return { takenAt: '', taskDirFiles: [], repoStatus: [], extraRoots: {} };
  }
}

/** Diff the roots against the snapshot, copy new files in, write the manifest. */
export async function collectArtifacts(
  config: Config,
  issue: number,
  trigger: 'command' | 'auto' = 'auto',
): Promise<ArtifactRef[]> {
  const snap = readSnapshot(issue);
  const dir = taskDirOf(issue);
  const store = artifactsDir(issue);
  mkdirSync(store, { recursive: true });

  const found: Array<{ origin: 'taskdir' | 'repo'; abs: string; base: string }> = [];

  for (const name of diffFiles(snap.taskDirFiles, listDir(dir))) {
    found.push({ origin: 'taskdir', abs: join(dir, name), base: name });
  }
  if (worktreeExists(issue)) {
    const wt = worktreePath(issue);
    for (const rel of diffFiles(snap.repoStatus, await gitStatusPaths(wt))) {
      found.push({ origin: 'repo', abs: join(wt, rel), base: rel.split('/').pop()! });
    }
  }
  for (const root of config.repo.artifactRoots ?? []) {
    for (const name of diffFiles(snap.extraRoots[root] ?? [], listDir(root))) {
      found.push({ origin: 'repo', abs: join(root, name), base: name });
    }
  }

  const refs: ArtifactRef[] = [];
  const taken: string[] = [];
  for (const f of found) {
    if (!existsSync(f.abs)) continue; // vanished between snapshot and now
    const name = uniqueName(taken, f.base);
    taken.push(name);
    try {
      copyFileSync(f.abs, join(store, name));
    } catch {
      continue; // locked/failed copy: record the rest
    }
    refs.push({ name, storedPath: `artifacts/${name}`, origin: f.origin, originalPath: f.abs });
  }

  writeFileSync(
    artifactsManifestPath(issue),
    JSON.stringify({ collectedAt: new Date().toISOString(), trigger, artifacts: refs }, null, 2),
    'utf8',
  );
  writeFileSync(markerPath(issue, 'plan.done'), '', 'utf8');
  return refs;
}

/** The manifest's artifacts, or [] when none has been written. */
export function readArtifacts(issue: number): ArtifactRef[] {
  try {
    const m = JSON.parse(readFileSync(artifactsManifestPath(issue), 'utf8')) as {
      artifacts?: ArtifactRef[];
    };
    return m.artifacts ?? [];
  } catch {
    return [];
  }
}
```

Add the missing import for `taskDir` and alias it to keep the routine readable:

```ts
import { taskDir as taskDirOf } from './paths.ts';
```

(Consolidate the `paths.ts` imports into one statement.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- artifacts`
Expected: PASS. (If the repo-origin case is flaky because the async snapshot fill races, note it is fine here — a fresh worktree's snapshot `repoStatus` is `[]`, so `docs/design.md` is correctly "new".)

- [ ] **Step 5: Add the headless `collect` CLI command**

In `src/orchestrator/cli.ts`: import `collectArtifacts`, add to the help string `| collect <issue>`, and add the case before `default`:

```ts
case 'collect': {
  const task = requireTask(Number(rest[0]));
  const refs = await collectArtifacts(config, task.issue, 'command');
  console.log(`collected ${refs.length} artifact(s) for #${task.issue}`);
  for (const r of refs) console.log(`  ${r.origin.padEnd(7)} ${r.name}`);
  return;
}
```

- [ ] **Step 6: Verify the CLI wiring compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/artifacts.ts src/orchestrator/artifacts.test.ts src/orchestrator/cli.ts
git commit -m "feat: plan snapshot + collectArtifacts routine + collect CLI"
```

---

## Task 3: Wire artifacts into facts and the reconciler

**Files:**
- Modify: `src/orchestrator/facts.ts`
- Modify: `src/orchestrator/reconcile.ts`
- Create: `src/orchestrator/reconcile.test.ts`

**Interfaces:**
- Consumes: `readArtifacts` (artifacts.ts); `Facts.artifacts`, `DerivedState.artifacts` (types.ts).
- Produces: `reconcile` returns `artifacts` on `DerivedState`; a `{ kind: 'artifacts-in-repo', tone: 'warn' }` badge when any artifact has `origin: 'repo'`.

- [ ] **Step 1: Populate facts**

In `src/orchestrator/facts.ts`: import `readArtifacts` from `./artifacts.ts`, and add to the initial `facts` literal (after `planMdExists`):

```ts
    artifacts: readArtifacts(task.issue),
```

- [ ] **Step 2: Write the failing reconciler test**

Create `src/orchestrator/reconcile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile.ts';
import type { ArtifactRef, Facts } from '../shared/types.ts';

function facts(over: Partial<Facts> = {}): Facts {
  return {
    issue: 1,
    worktreeExists: false,
    branchExists: false,
    markers: [],
    planMdExists: false,
    artifacts: [],
    hasPushedCommits: false,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn: null,
    pr: { exists: false, number: null, url: null, state: null },
    checks: 'none',
    review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    ...over,
  };
}

const repoArtifact: ArtifactRef = {
  name: 'design.md', storedPath: 'artifacts/design.md', origin: 'repo', originalPath: 'x',
};
const taskArtifact: ArtifactRef = {
  name: 'spec.md', storedPath: 'artifacts/spec.md', origin: 'taskdir', originalPath: 'y',
};

describe('reconcile artifacts', () => {
  it('passes artifacts through to derived state', () => {
    const d = reconcile(facts({ artifacts: [taskArtifact] }));
    expect(d.artifacts).toEqual([taskArtifact]);
  });
  it('adds an in-checkout badge counting repo-origin artifacts', () => {
    const d = reconcile(facts({ artifacts: [repoArtifact, taskArtifact] }));
    const badge = d.badges.find((b) => b.kind === 'artifacts-in-repo');
    expect(badge).toEqual({ kind: 'artifacts-in-repo', label: '1 in checkout', tone: 'warn' });
  });
  it('adds no badge when every artifact is in the task dir', () => {
    const d = reconcile(facts({ artifacts: [taskArtifact] }));
    expect(d.badges.some((b) => b.kind === 'artifacts-in-repo')).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- reconcile`
Expected: FAIL — `d.artifacts` undefined and no such badge.

- [ ] **Step 4: Implement the passthrough and badge**

In `src/orchestrator/reconcile.ts`:
- In the object returned by `reconcile`, add `artifacts: facts.artifacts,`.
- In `computeBadges`, before `return badges;`, add:

```ts
  const inCheckout = facts.artifacts.filter((a) => a.origin === 'repo').length;
  if (inCheckout > 0) {
    badges.push({
      kind: 'artifacts-in-repo',
      label: `${inCheckout} in checkout`,
      tone: 'warn',
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- reconcile`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: FAIL in `poller.ts` — the fallback facts literal is missing `artifacts`. Fix it now: in `src/orchestrator/poller.ts`, in the catch-block inline facts object (after `planMdExists: false,`), add `artifacts: [],`. Re-run `npx tsc --noEmit`; expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/facts.ts src/orchestrator/reconcile.ts src/orchestrator/reconcile.test.ts src/orchestrator/poller.ts
git commit -m "feat: surface artifacts as a fact + in-checkout badge"
```

---

## Task 4: Trigger collection — spawn snapshot and poller auto-collect

**Files:**
- Modify: `src/orchestrator/spawn.ts`
- Modify: `src/orchestrator/poller.ts`

**Interfaces:**
- Consumes: `writePlanSnapshot`, `collectArtifacts`, `readArtifacts`, `shouldCollectPlan` (artifacts.ts); `artifactsManifestPath` (paths.ts); `existsSync` (node:fs).
- Produces: a snapshot written on every plan spawn; automatic collection during `reconcileAll`.

- [ ] **Step 1: Write the snapshot when a plan spawn is prepared**

In `src/orchestrator/spawn.ts`, import `writePlanSnapshot` from `./artifacts.ts`. In `spawnPhase`, after `writePromptFile(task.issue, promptText);` and before building the `spec`, add:

```ts
  // Record the "before" picture so a plan run's artifacts can be attributed
  // to it later. Only the plan phase produces the artifacts we capture.
  if (phase.id === 'plan') writePlanSnapshot(config, task.issue);
```

- [ ] **Step 2: Auto-collect in the reconcile loop**

In `src/orchestrator/poller.ts`:
- Add imports: `import { collectArtifacts, readArtifacts, shouldCollectPlan } from './artifacts.ts';`, `import { artifactsManifestPath } from './paths.ts';`, and `import { existsSync } from 'node:fs';`.
- In `reconcileAll`, inside the per-task `try`, change the first two lines from:

```ts
        const facts = await gatherFacts(config, task, branches, batch);
        const derived = reconcile(facts, task.manualPhase);
```

to:

```ts
        let facts = await gatherFacts(config, task, branches, batch);
        if (
          shouldCollectPlan({
            liveSpawn: facts.liveSpawn,
            planMdExists: facts.planMdExists,
            planDoneMarker: facts.markers.includes('plan.done'),
            manifestExists: existsSync(artifactsManifestPath(task.issue)),
          })
        ) {
          try {
            await collectArtifacts(config, task.issue, 'auto');
          } catch (e) {
            console.error(`[mc] artifact collection failed for #${task.issue}:`, e);
          }
          facts = { ...facts, artifacts: readArtifacts(task.issue) };
        }
        const derived = reconcile(facts, task.manualPhase);
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual end-to-end verification (headless)**

This path shells out to git and the real board, so verify it by hand rather than a unit test:

```bash
# Pick a task already on the board with a worktree, e.g. 3060.
npm run mc -- spawn 3060 plan     # writes plan.snapshot.json
# (let the agent, or you, drop a plan.md + a docs/ file in the worktree)
npm run mc -- collect 3060        # expect: "collected N artifact(s)"
npm run mc -- facts 3060          # expect: "artifacts": [ … ] populated
```

Expected: `facts` shows the collected artifacts; a doc written under the worktree reports `"origin": "repo"`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/spawn.ts src/orchestrator/poller.ts
git commit -m "feat: snapshot on plan spawn + poller auto-collect"
```

---

## Task 5: Serve artifacts to the UI, and add the agent sign-off line

**Files:**
- Modify: `src/orchestrator/spawn.ts`
- Modify: `src/orchestrator/artifacts.test.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/web/api.ts`
- Modify: `src/orchestrator/prompt.ts`
- Modify: `~/.claude/commands/mc-planner.md`

**Interfaces:**
- Consumes: `readArtifacts`, `resolveArtifactStoredPath` (artifacts.ts); `detach` pattern (spawn.ts); `getTask` (state.ts).
- Produces: `openArtifactInEditor(issue: number, name: string): void`; `POST /api/tasks/:issue/artifacts/:name/open`; `api.openArtifact(issue, name)`; a `{{donePath}}` prompt token.

- [ ] **Step 1: Write the failing path-safety test**

Append to `src/orchestrator/artifacts.test.ts`:

```ts
import { resolveArtifactStoredPath } from './artifacts.ts';

describe('resolveArtifactStoredPath', () => {
  const refs = [{ name: 'design.md', storedPath: 'artifacts/design.md', origin: 'repo' as const, originalPath: 'x' }];
  it('resolves a known artifact under the task dir', () => {
    const p = resolveArtifactStoredPath(7, 'design.md', refs);
    expect(p).toMatch(/[\\/]7[\\/]artifacts[\\/]design\.md$/);
  });
  it('returns null for a name not in the manifest (blocks traversal)', () => {
    expect(resolveArtifactStoredPath(7, '../../secret', refs)).toBeNull();
  });
});
```

(`resolveArtifactStoredPath` already exists from Task 1; this locks its safety contract.)

- [ ] **Step 2: Run it to verify it passes** (it should — this guards existing behavior)

Run: `npm test -- artifacts`
Expected: PASS. If it fails, the Task 1 implementation is wrong — fix there.

- [ ] **Step 3: Add `openArtifactInEditor` in spawn.ts**

In `src/orchestrator/spawn.ts`, import `readArtifacts, resolveArtifactStoredPath` from `./artifacts.ts`, and add near `openWorktreeInVscode`:

```ts
/** Open a collected artifact's stored copy in the editor. Name must be in the
 *  manifest — that lookup is the traversal guard. */
export function openArtifactInEditor(issue: number, name: string): void {
  const path = resolveArtifactStoredPath(issue, name, readArtifacts(issue));
  if (!path || !existsSync(path)) {
    throw new Error(`No collected artifact named '${name}' for issue ${issue}.`);
  }
  detach('code', [path]);
}
```

- [ ] **Step 4: Add the server route**

In `src/server/routes.ts`, import `openArtifactInEditor` alongside `openWorktreeInVscode`, and add near the `open-code` route:

```ts
  app.post<{ Params: { issue: string; name: string } }>(
    '/api/tasks/:issue/artifacts/:name/open',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      try {
        openArtifactInEditor(issue, decodeURIComponent(req.params.name));
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
```

- [ ] **Step 5: Add the api client method**

In `src/web/api.ts`, add to the `api` object after `openCode`:

```ts
  openArtifact: (issue: number, name: string) =>
    post<{ ok: true }>(`/api/tasks/${issue}/artifacts/${encodeURIComponent(name)}/open`),
```

- [ ] **Step 6: Add the `{{donePath}}` token and the sign-off line**

In `src/orchestrator/prompt.ts`, import `markerPath` from `./paths.ts`, and add to the `render` vars object (after `taskDir:`):

```ts
    donePath: markerPath(task.issue, 'plan.done'),
```

In `~/.claude/commands/mc-planner.md`, before the `{{customInstructions}}` line, add:

```markdown
When your plan and any supporting docs (specs, design notes, diagrams) are
complete, write an empty file at this exact absolute path to signal you are
done — Mission Control watches for it to collect your artifacts:

    {{donePath}}
```

- [ ] **Step 7: Verify**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.
Then manually: `npm run mc -- spawn <issue> plan` and confirm the rendered `~/.mc/tasks/<issue>/prompt.txt` contains the real `plan.done` path in place of `{{donePath}}`.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/spawn.ts src/orchestrator/artifacts.test.ts src/server/routes.ts src/web/api.ts src/orchestrator/prompt.ts
git commit -m "feat: serve artifacts to the UI + agent plan.done sign-off"
# The command file lives outside the repo (~/.claude); note it is edited but not committed here.
```

---

## Task 6: Surface artifacts in the drawer

**Files:**
- Modify: `src/web/components/Drawer.tsx`

**Interfaces:**
- Consumes: `task.derived.artifacts` (already in the SSE payload); `api.openArtifact`; the drawer's existing `run(label, action)` helper.
- Produces: an "Artifacts" section listing each artifact with an Open button.

- [ ] **Step 1: Add the Artifacts section**

In `src/web/components/Drawer.tsx`, add a new `<section>` immediately after the Plan section (after its closing `</section>` around line 329):

```tsx
        {task.derived.artifacts.length > 0 && (
          <section className="section">
            <div className="section-label">Artifacts</div>
            <div className="stack">
              {task.derived.artifacts.map((a) => (
                <div key={a.name} className="actions" style={{ justifyContent: 'space-between' }}>
                  <span>
                    {a.name}
                    {a.origin === 'repo' && (
                      <span className="badge tone-warn" style={{ marginLeft: 8 }}>
                        in checkout
                      </span>
                    )}
                  </span>
                  <button
                    className="btn is-sm"
                    disabled={busy !== null}
                    onClick={() => run(`artifact-${a.name}`, () => api.openArtifact(task.issue, a.name))}
                  >
                    {busy === `artifact-${a.name}` ? 'Opening…' : 'Open'}
                  </button>
                </div>
              ))}
            </div>
            <p className="hint">
              Collected from the plan run. Files marked “in checkout” were written into the
              repo; they were copied here, not moved.
            </p>
          </section>
        )}
```

- [ ] **Step 2: Verify the UI builds**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; the Vite build succeeds.

- [ ] **Step 3: Manual visual check**

Run the app (`npm run dev` or the project's start script). Open a task that has collected artifacts (from Task 4's manual run). Confirm: the drawer shows an "Artifacts" section, repo-origin files carry an "in checkout" tag, the card shows the "N in checkout" badge, and clicking Open launches the stored copy in VS Code.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/Drawer.tsx
git commit -m "feat: show collected artifacts in the task drawer"
```

---

## Self-Review Notes

- **Spec coverage:** tool-agnostic diff (Task 2 `collectArtifacts`); two watch roots + `artifactRoots` knob (Task 2); snapshot at spawn (Task 4); belt marker + suspenders auto-collect (Tasks 4–5); copy-only + `artifacts-in-repo` badge (Tasks 2–3); manifest shape (Task 2); pure reconciler with artifacts as a fact (Task 3); degrade-on-missing-snapshot and skip-vanished/locked files (Task 2); UI surfacing (Task 6). All spec sections map to a task.
- **Type consistency:** `ArtifactRef`, `PlanSnapshot`, `shouldCollectPlan`, `collectArtifacts(config, issue, trigger)`, `readArtifacts`, `resolveArtifactStoredPath`, and `writePlanSnapshot` keep one signature across every task that references them.
- **Known nuance:** `writePlanSnapshot` fills `repoStatus` asynchronously for a resumed worktree; for a fresh worktree (the common plan case) the correct "before" is `[]`, so attribution holds regardless of that race.
