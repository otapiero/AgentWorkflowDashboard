# Custom Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a free-form "custom run" that launches an agent on a task with a prompt written at launch time, still issue-aware and still producing artifacts the board collects.

**Architecture:** A custom run is a *synthetic* `PhaseConfig` built in memory and never added to `config.pipeline`, so it inherits the entire existing spawn path (worktree, prompt file, running marker, all three launchers) while producing no board lane and no reconciler gate. Alongside it, artifact capture is generalised from "the plan phase owns one manifest" to "any run merges into one shared, never-deleted manifest", and a new `{{artifacts}}` prompt variable lets each run read what earlier runs produced.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), tsx, Fastify, React 19 + Vite, zod, execa, vitest.

## Global Constraints

- **`reconcile.ts` must not change.** `test/reconcile.test.ts` staying untouched and green is the assertion.
- **`custom` is never added to `PHASES`** and never appears in `config.yaml`. The zod schema keeps `id: z.enum(PHASES)`, so a config file cannot declare it.
- **No code path may delete an artifact entry or a stored copy.** The only files a run start still clears are the `<kind>.done` marker and the run's own snapshot.
- **`plan.md` stays a separate concept** — it keeps `planPath()`, `planMdExists`, its `RESERVED` entry and its own `DocId` kind.
- **Zero footprint in the Acme checkout.** Everything runtime lives under `MC_HOME` (`%USERPROFILE%\.mc`).
- Tests run with `npm test` (vitest). Type check with `npm run typecheck`. Both must pass before every commit.
- Prompt text lives in `assets/claude/commands/*.md`, never in code. `install.ps1` already globs `*.md`, so new command files need no installer change.

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `src/shared/custom-run.ts` | `CUSTOM_RUN_ID`, `customPhase()`, `resolveRunPhase()`. Shared because the server needs the synthetic phase to spawn it and the web needs it to render the compose form. Pure — no imports beyond types. |
| `assets/claude/commands/mc-custom.md` | The custom run's preamble; hand-editable prompt text. |
| `test/custom-run.test.ts` | Tests for the shared module. |

**Modify**

| File | Change |
|---|---|
| `src/shared/types.ts` | `RunKind`; widen `SpawnRecord.phase` and `LiveSpawn.phase`; add `SpawnRecord.promptSummary`. |
| `src/orchestrator/paths.ts` | `planSnapshotPath` → `runSnapshotPath(issue, kind)`. |
| `src/orchestrator/prompt.ts` | `{{artifacts}}` variable; per-kind `{{donePath}}`. |
| `src/orchestrator/spawn-plan.ts` | `rawPrompt` and `artifacts` options. |
| `src/orchestrator/artifacts.ts` | `writeRunSnapshot`, `shouldCollectRun`, merge-by-`originalPath`, per-kind done marker, snapshot as sentinel. |
| `src/orchestrator/poller.ts` | Evaluate collection once per run kind. |
| `src/orchestrator/spawn.ts` | Snapshot custom runs; `rawPrompt`; `promptSummary`. |
| `src/orchestrator/cli.ts` | `collectArtifacts` signature. |
| `src/server/routes.ts` | `resolveRunPhase`; `includeContext`. |
| `src/web/api.ts` | `RunKind` params; `includeContext`. |
| `src/web/components/drawer/RunTab.tsx` | The Custom button. |
| `src/web/components/drawer/LaunchCompose.tsx` | Custom-mode deltas. |
| `src/web/components/drawer/PromptPreview.tsx` | `RunKind`; `includeContext`. |
| `src/web/components/drawer/HistoryTab.tsx` | Render `promptSummary`. |
| `assets/claude/commands/mc-planner.md` | Read prior artifacts. |
| `test/artifacts.test.ts`, `test/prompt.test.ts`, `test/spawn-plan.test.ts` | Updated and extended. |

---

## Two corrections to the spec

Both were found writing exact code. Implement the plan, not the spec, where they differ.

**1. `collectArtifacts` must write `<kind>.done`, not always `plan.done`.** Today it ends with `writeMarker(issue, 'plan.done')` (`artifacts.ts:232`). If a custom run collected through that line it would write `plan.done`, which `reconcile.ts:41` treats as "the plan is ready" — the card would jump to Implement because you ran a research prompt. Task 4 makes the marker per-kind.

**2. Dropping `planMdExists` from the collect rule opens a race.** The spec's `shouldCollectRun` would fire in the window between a spawn writing its snapshot and the terminal writing its `.running` marker (~1.5s, which is why `routes.ts:178` waits that long before re-deriving). Nothing is live and a snapshot exists, so the poller would collect nothing, delete the snapshot, and the run's real output would never be captured. `planMdExists` masked this for plan runs; a custom run has no equivalent signal.

Fix: a grace period. Collect when the agent signs off with a done marker, or when nothing is live *and* the snapshot is older than `COLLECT_GRACE_MS`. Kept pure by passing the age in. The done marker makes the normal case immediate, so the grace only covers a run that ended without signing off.

---

## Task 1: Shared custom-run vocabulary

**Files:**
- Create: `src/shared/custom-run.ts`
- Modify: `src/shared/types.ts`
- Test: `test/custom-run.test.ts`

**Interfaces:**
- Consumes: `PhaseConfig`, `T3PhaseModes`, `Phase` from `src/shared/types.ts`.
- Produces:
  - `type RunKind = Phase | 'custom'`
  - `const CUSTOM_RUN_ID = 'custom'`
  - `interface RunPhaseSource { pipeline: readonly PhaseConfig[]; agentNames: readonly string[] }`
  - `function customPhase(source: RunPhaseSource): PhaseConfig`
  - `function resolveRunPhase(source: RunPhaseSource, id: string | undefined): PhaseConfig | null`
  - `SpawnRecord.promptSummary?: string`

- [ ] **Step 1: Write the failing test**

Create `test/custom-run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { CUSTOM_RUN_ID, customPhase, resolveRunPhase } from '../src/shared/custom-run.ts';
import type { PhaseConfig } from '../src/shared/types.ts';

const pipeline: PhaseConfig[] = [
  { id: 'plan', label: 'Plan', actor: 'codex', command: 'mc-planner', spawnable: true, gate: { type: 'manual' } },
  { id: 'implement', label: 'Implement', actor: 'claude', command: 'mc-implementer', spawnable: true, gate: { type: 'manual' } },
];

const source = { pipeline, agentNames: ['claude', 'codex'] };

describe('customPhase', () => {
  it('inherits the plan phase actor', () => {
    expect(customPhase(source).actor).toBe('codex');
  });

  it('falls back to the first configured agent when there is no plan phase', () => {
    const noPlan = { pipeline: [pipeline[1]!], agentNames: ['copilot'] };
    expect(customPhase(noPlan).actor).toBe('copilot');
  });

  it('is spawnable, repeatable, and renders from mc-custom', () => {
    const phase = customPhase(source);
    expect(phase.id).toBe(CUSTOM_RUN_ID);
    expect(phase.spawnable).toBe(true);
    expect(phase.repeatable).toBe(true);
    expect(phase.command).toBe('mc-custom');
  });

  it('pins T3 to the safe floor rather than inheriting the plan phase modes', () => {
    expect(customPhase(source).t3).toEqual({
      runtimeMode: 'approval-required',
      interactionMode: 'default',
    });
  });

  it('never becomes part of the pipeline, so it can never become a lane or a gate', () => {
    customPhase(source);
    expect(pipeline.map((p) => p.id)).toEqual(['plan', 'implement']);
  });
});

describe('resolveRunPhase', () => {
  it('returns the synthetic phase for the custom id', () => {
    expect(resolveRunPhase(source, 'custom')!.label).toBe('Custom run');
  });

  it('returns a real pipeline phase by id', () => {
    expect(resolveRunPhase(source, 'implement')!.command).toBe('mc-implementer');
  });

  it('returns null for an unknown id and for undefined', () => {
    expect(resolveRunPhase(source, 'nope')).toBeNull();
    expect(resolveRunPhase(source, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/custom-run.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/custom-run.ts"`.

- [ ] **Step 3: Create the shared module**

Create `src/shared/custom-run.ts`:

```ts
import type { Phase, PhaseConfig, T3PhaseModes } from './types.ts';

/**
 * The free-form run.
 *
 * Deliberately not a member of PHASES: every entry in `config.pipeline` becomes
 * a board lane (Board.tsx), a row in the reconciler's gate table, and — when its
 * gate is manual — a button in the Run tab's "Mark progress" list. A custom run
 * wants none of those, so it is synthesised at launch time instead and never
 * joins the pipeline it is shaped like.
 */
export const CUSTOM_RUN_ID = 'custom';

/**
 * T3 permissions for a free-form run: the safe floor, never inherited from the
 * plan phase. A prompt written at launch time is exactly where auto-accepting
 * edits should not apply.
 */
const CUSTOM_T3_MODES: T3PhaseModes = {
  runtimeMode: 'approval-required',
  interactionMode: 'default',
};

/**
 * What building the synthetic phase actually needs.
 *
 * The server holds a `Config` (agents as a record) and the web holds a
 * `BoardConfig` (agents as an array), so this takes the two things both can
 * supply rather than depending on either concrete shape.
 */
export interface RunPhaseSource {
  pipeline: readonly PhaseConfig[];
  agentNames: readonly string[];
}

/**
 * The synthetic phase a custom run launches through.
 *
 * The actor has to be supplied here because `resolveAgentValues` finds a
 * phase's default agent by looking its id up in the pipeline — a lookup a
 * synthetic phase can never satisfy. The plan phase's actor is the sensible
 * inheritance: it is the one whose work most resembles this.
 */
export function customPhase(source: RunPhaseSource): PhaseConfig {
  const actor =
    source.pipeline.find((phase) => phase.id === 'plan')?.actor ??
    source.agentNames[0] ??
    'claude';

  return {
    // The single seam where the custom id is treated as a Phase. It is safe
    // precisely because this object never enters config.pipeline, so nothing
    // that enumerates phases (lanes, gates, PHASES) ever observes it.
    id: CUSTOM_RUN_ID as Phase,
    label: 'Custom run',
    actor,
    command: 'mc-custom',
    spawnable: true,
    repeatable: true,
    gate: { type: 'manual' },
    t3: CUSTOM_T3_MODES,
  };
}

/** A configured pipeline phase by id, or the synthetic custom one. */
export function resolveRunPhase(
  source: RunPhaseSource,
  id: string | undefined,
): PhaseConfig | null {
  if (id === CUSTOM_RUN_ID) return customPhase(source);
  return source.pipeline.find((phase) => phase.id === id) ?? null;
}
```

- [ ] **Step 4: Widen the two run-identifying types**

In `src/shared/types.ts`, immediately after the `Phase` type declaration (line 23), add:

```ts
/**
 * A thing that can run on a task: a pipeline phase, or the free-form custom
 * run. Distinct from `Phase`, which is strictly a position in the pipeline —
 * only fields that identify a *run* widen to this.
 */
export type RunKind = Phase | 'custom';
```

Change `LiveSpawn.phase` (line 46) from `phase: Phase;` to:

```ts
  phase: RunKind;
```

In `SpawnRecord`, change `phase: Phase;` to `phase: RunKind;` and add a field after `command`:

```ts
  /**
   * The first ~100 characters of a custom run's prompt. Written for custom
   * runs only: a phase run is already identified by its label, so summarising
   * its optional extra instructions would only add noise. With no saved
   * presets, this is the sole thing telling two past custom runs apart.
   */
  promptSummary?: string;
```

- [ ] **Step 5: Run the test and the type check**

Run: `npx vitest run test/custom-run.test.ts && npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. `reconcile.test.ts` in particular must be green and unmodified.

- [ ] **Step 7: Commit**

```bash
git add src/shared/custom-run.ts src/shared/types.ts test/custom-run.test.ts
git commit -m "feat: add the synthetic phase a free-form custom run launches through"
```

---

## Task 2: The `{{artifacts}}` and per-kind `{{donePath}}` prompt variables

**Files:**
- Modify: `src/orchestrator/prompt.ts`
- Test: `test/prompt.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef` from `src/shared/types.ts`; `taskDir` from `./paths.ts`.
- Produces:
  - `function renderArtifactList(refs: readonly ArtifactRef[], issue: number): string`
  - `PromptOptions.artifacts?: readonly ArtifactRef[]`
  - `PromptOptions.doneMarkerName?: string` (defaults to `'plan.done'`)

Why `donePath` becomes a parameter: `prompt.ts:81` hardcodes `markerPath(task.issue, 'plan.done')`. A custom run told to write that file would satisfy the Plan gate, moving the card to Implement because a research prompt finished. Each run must sign off with its own marker.

- [ ] **Step 1: Write the failing tests**

Append to `test/prompt.test.ts`:

```ts
describe('renderArtifactList', () => {
  it('renders one line per artifact, pointing at the stored copy', () => {
    const out = renderArtifactList(
      [
        { name: 'research.md', storedPath: 'artifacts/research.md', origin: 'taskdir', originalPath: 'x' },
        { name: 'design.md', storedPath: 'artifacts/design.md', origin: 'repo', originalPath: 'y' },
      ],
      3060,
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('research.md');
    expect(lines[0]).toMatch(/[\\/]3060[\\/]artifacts[\\/]research\.md$/);
    expect(lines[1]).toContain('design.md');
  });

  it('renders (none) for an empty manifest so the prompt has no dangling heading', () => {
    expect(renderArtifactList([], 3060)).toBe('(none)');
  });
});
```

Then, inside the existing `describe('buildPrompt', …)` block, add:

```ts
  it('substitutes the artifact list into {{artifacts}}', () => {
    writeFileSync(join(commands, 'mc-x.md'), 'Prior work:\n{{artifacts}}\n');
    const text = buildPrompt('mc-x', task, {
      artifacts: [
        { name: 'research.md', storedPath: 'artifacts/research.md', origin: 'taskdir', originalPath: 'x' },
      ],
    });
    expect(text).toContain('research.md');
    expect(text).not.toContain('{{artifacts}}');
  });

  it('renders (none) into {{artifacts}} when nothing has been collected', () => {
    writeFileSync(join(commands, 'mc-x.md'), 'Prior work:\n{{artifacts}}\n');
    expect(buildPrompt('mc-x', task, {})).toContain('(none)');
  });

  it('points {{donePath}} at the named marker, not always plan.done', () => {
    writeFileSync(join(commands, 'mc-x.md'), 'Signal: {{donePath}}\n');
    const text = buildPrompt('mc-x', task, { doneMarkerName: 'custom.done' });
    expect(text).toContain('custom.done');
    expect(text).not.toContain('plan.done');
  });

  it('defaults {{donePath}} to plan.done', () => {
    writeFileSync(join(commands, 'mc-x.md'), 'Signal: {{donePath}}\n');
    expect(buildPrompt('mc-x', task, {})).toContain('plan.done');
  });
```

Add `renderArtifactList` to the import from `../src/orchestrator/prompt.ts` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/prompt.test.ts`
Expected: FAIL — `renderArtifactList` is not exported.

- [ ] **Step 3: Implement**

In `src/orchestrator/prompt.ts`, add `join` to the `node:path` imports (add the import line if absent) and `ArtifactRef` to the type imports:

```ts
import { join } from 'node:path';
import type { ArtifactRef } from '../shared/types.ts';
```

Add above `PromptTask`:

```ts
/**
 * The collected manifest as prompt text.
 *
 * Points at the stored copy rather than `originalPath` because the stored copy
 * is the one Mission Control guarantees exists — an original written into the
 * checkout can be moved, renamed or committed away between runs.
 */
export function renderArtifactList(
  refs: readonly ArtifactRef[],
  issue: number,
): string {
  if (refs.length === 0) return '(none)';
  return refs
    .map((ref) => `- ${ref.name} — ${join(taskDir(issue), ref.storedPath)}`)
    .join('\n');
}
```

Extend `PromptOptions`:

```ts
export interface PromptOptions {
  customInstructions?: string;
  /** Standing rules to prepend, for agents with no system-prompt flag. */
  inlineInstructions?: string;
  /** Collected artifacts, rendered into {{artifacts}}. */
  artifacts?: readonly ArtifactRef[];
  /**
   * The marker this run signs off with, rendered into {{donePath}}. Each run
   * must own its own: a custom run pointed at 'plan.done' would satisfy the
   * Plan gate and move the card to Implement.
   */
  doneMarkerName?: string;
}
```

In `buildPrompt`, change the `donePath` line and add `artifacts`:

```ts
    donePath: markerPath(task.issue, options.doneMarkerName ?? 'plan.done'),
    artifacts: renderArtifactList(options.artifacts ?? [], task.issue),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/prompt.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/prompt.ts test/prompt.test.ts
git commit -m "feat: let a prompt read prior artifacts and name its own done marker"
```

---

## Task 3: `rawPrompt` — launching without a command file

**Files:**
- Modify: `src/orchestrator/spawn-plan.ts`
- Test: `test/spawn-plan.test.ts`

**Interfaces:**
- Consumes: `resolveAgent`, `buildPrompt`, `STANDING_RULES`, `renderArtifactList` (indirectly).
- Produces: `SpawnPlanOptions.rawPrompt?: string`, `SpawnPlanOptions.artifacts?: readonly ArtifactRef[]`. When `rawPrompt` is set, `SpawnPlan.command` is the literal `'raw'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/spawn-plan.test.ts`:

```ts
describe('resolveSpawnPlan with rawPrompt', () => {
  test('uses the raw text as the whole prompt, with no command file', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {
      rawPrompt: '  Investigate the auth flow.  ',
    });
    expect(plan.promptText).toBe('Investigate the auth flow.');
    expect(plan.command).toBe('raw');
  });

  test('still prepends standing rules for an agent with no system-prompt flag', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {
      rawPrompt: 'Investigate the auth flow.',
      agent: 'copilot',
    });
    expect(plan.agent).toBe('copilot');
    expect(plan.promptText.startsWith('You are running inside a git worktree')).toBe(true);
    expect(plan.promptText).toContain('Investigate the auth flow.');
  });

  test('does not need a command on the phase at all', () => {
    const commandless = { ...implementPhase(), command: undefined };
    expect(() =>
      resolveSpawnPlan(config(), task(), commandless, {}, { rawPrompt: 'go' }),
    ).not.toThrow();
  });
});
```

The helpers `config()`, `task()` and `implementPhase()` already exist in that
file (lines 35–75), and `config()` registers both the `claude` and `copilot`
profiles — do not add new helpers. Note this file uses `test(…)`, not `it(…)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/spawn-plan.test.ts`
Expected: FAIL — `command` is `'mc-implementer'`, and the commandless case throws.

- [ ] **Step 3: Implement**

In `src/orchestrator/spawn-plan.ts`, add to the type imports `ArtifactRef`, then extend the options:

```ts
export interface SpawnPlanOptions {
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
  /** Collected artifacts, rendered into the prompt's {{artifacts}}. */
  artifacts?: readonly ArtifactRef[];
  /**
   * Bypass the command file entirely: this text *is* the prompt body. Set when
   * a custom run is launched with issue context turned off.
   */
  rawPrompt?: string;
}
```

Rewrite the body of `resolveSpawnPlan` so the command-file guard no longer runs first:

```ts
export function resolveSpawnPlan(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  phaseDefaults: PhaseDefaults,
  options: SpawnPlanOptions = {},
): SpawnPlan {
  const { agent, model, effort } = resolveAgent(config, task, phase.id, phaseDefaults, {
    agent: options.agent,
    model: options.model,
    effort: options.effort,
  });
  if (!agent) {
    throw new Error(
      `Phase '${phase.id}' has no agent to spawn. Pin one on the task or set a phase default.`,
    );
  }
  const profile = config.agents[agent]!;
  // Agents without a system-prompt flag carry the rules in the prompt body.
  const inline = profile.instructionMode === 'inline' ? STANDING_RULES : undefined;

  // A raw prompt is the operator's text and nothing else — no command file is
  // read, so a phase without one is fine here even though it never is below.
  if (options.rawPrompt !== undefined) {
    const body = options.rawPrompt.trim();
    return {
      agent,
      model,
      effort,
      profile,
      command: 'raw',
      promptText: inline ? `${inline}\n\n${body}` : body,
    };
  }

  if (!phase.command) {
    throw new Error(`Phase '${phase.id}' has no command to render a prompt from.`);
  }

  const promptText = buildPrompt(phase.command, task, {
    customInstructions: options.customInstructions ?? task.overrides?.instructions,
    inlineInstructions: inline,
    artifacts: options.artifacts,
    doneMarkerName: `${phase.id}.done`,
  });

  return { agent, model, effort, profile, command: phase.command, promptText };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/spawn-plan.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/spawn-plan.ts test/spawn-plan.test.ts
git commit -m "feat: allow a spawn plan whose prompt is the operator's raw text"
```

---

## Task 4: Artifacts persist and merge

This is the largest task. Read the whole thing before starting.

**Files:**
- Modify: `src/orchestrator/paths.ts`, `src/orchestrator/artifacts.ts`
- Test: `test/artifacts.test.ts`

**Interfaces:**
- Consumes: `RunKind` from `src/shared/types.ts`.
- Produces:
  - `function runSnapshotPath(issue: number, kind: RunKind): string`
  - `function writeRunSnapshot(config: Config, issue: number, kind: RunKind): void`
  - `function snapshotAgeMs(issue: number, kind: RunKind): number | null`
  - `const COLLECT_GRACE_MS = 90_000`
  - `function shouldCollectRun(i: { liveSpawn: unknown; doneMarker: boolean; snapshotAgeMs: number | null }): boolean`
  - `function collectArtifacts(config, issue, kind: RunKind, trigger?): Promise<ArtifactRef[]>`
- Removed: `planSnapshotPath`, `writePlanSnapshot`, `shouldCollectPlan`.

- [ ] **Step 1: Replace the outdated tests**

In `test/artifacts.test.ts`, **delete** the whole `describe('shouldCollectPlan', …)` block (lines 45–69) and the test named `'is idempotent and a re-snapshot clears the prior manifest'` (lines 133–142) — that test asserts the behaviour this task removes.

Update the imports to:

```ts
import {
  parsePorcelainPaths,
  diffFiles,
  uniqueName,
  shouldCollectRun,
  COLLECT_GRACE_MS,
  resolveArtifactStoredPath,
  writeRunSnapshot,
  snapshotAgeMs,
  collectArtifacts,
  readArtifacts,
} from '../src/orchestrator/artifacts.ts';
import { taskDir, planPath, worktreePath, markerPath } from '../src/orchestrator/paths.ts';
```

Update the two surviving `writePlanSnapshot(config, ISSUE)` calls to `writeRunSnapshot(config, ISSUE, 'plan')`, and the `collectArtifacts(config, ISSUE)` calls to `collectArtifacts(config, ISSUE, 'plan')`.

- [ ] **Step 2: Write the new failing tests**

Add these blocks to `test/artifacts.test.ts`:

```ts
describe('shouldCollectRun', () => {
  const base = { liveSpawn: null, doneMarker: false, snapshotAgeMs: COLLECT_GRACE_MS + 1 };

  it('collects once a run has ended and the grace period has passed', () => {
    expect(shouldCollectRun(base)).toBe(true);
  });

  it('collects immediately on the done marker, even while a process looks live', () => {
    expect(shouldCollectRun({ ...base, liveSpawn: { pid: 1 }, doneMarker: true, snapshotAgeMs: 0 })).toBe(true);
  });

  it('waits while a spawn is live with no done marker', () => {
    expect(shouldCollectRun({ ...base, liveSpawn: { pid: 1 } })).toBe(false);
  });

  it('never collects without a snapshot', () => {
    expect(shouldCollectRun({ ...base, snapshotAgeMs: null })).toBe(false);
    expect(shouldCollectRun({ ...base, snapshotAgeMs: null, doneMarker: true })).toBe(false);
  });

  it('waits out the grace period, so a spawn is never collected before its marker lands', () => {
    // The window between writing the snapshot and the terminal writing
    // <kind>.running: nothing is live yet, but the run has not started either.
    expect(shouldCollectRun({ ...base, snapshotAgeMs: 500 })).toBe(false);
  });
});
```

And, inside the `describe('snapshot + collectArtifacts', …)` block:

```ts
  it('keeps earlier artifacts when a later run collects', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'research.md'), '# research\n');
    await collectArtifacts(config, ISSUE, 'custom');

    writeRunSnapshot(config, ISSUE, 'plan');
    writeFileSync(join(taskDir(ISSUE), 'spec.md'), '# spec\n');
    await collectArtifacts(config, ISSUE, 'plan');

    expect(readArtifacts(ISSUE).map((r) => r.name).sort()).toEqual(['research.md', 'spec.md']);
    expect(existsSync(join(taskDir(ISSUE), 'artifacts', 'research.md'))).toBe(true);
  });

  it('starting a plan run no longer clears what earlier runs produced', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'research.md'), '# research\n');
    await collectArtifacts(config, ISSUE, 'custom');

    writeRunSnapshot(config, ISSUE, 'plan');

    expect(readArtifacts(ISSUE)).toHaveLength(1);
    expect(existsSync(join(taskDir(ISSUE), 'artifacts', 'research.md'))).toBe(true);
  });

  it('two runs claiming the same file produce one entry, not a suffixed duplicate', async () => {
    // Exactly the overlap the poller can hit: a custom run launched while a
    // plan run's output was still uncollected leaves both snapshots pending,
    // and both then see the same new file.
    writeRunSnapshot(config, ISSUE, 'plan');
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'design.md'), 'v1\n');

    await collectArtifacts(config, ISSUE, 'plan');
    await collectArtifacts(config, ISSUE, 'custom');

    expect(readArtifacts(ISSUE).map((r) => r.name)).toEqual(['design.md']);
  });

  it('two different originals sharing a basename both land, suffixed', async () => {
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeRunSnapshot(config, ISSUE, 'plan');
    writeFileSync(join(taskDir(ISSUE), 'notes.md'), 'a\n');
    writeFileSync(join(repo, 'docs', 'notes.md'), 'b\n');

    await collectArtifacts(config, ISSUE, 'plan');

    expect(readArtifacts(ISSUE).map((r) => r.name).sort()).toEqual(['notes-1.md', 'notes.md']);
  });

  it('signs off with the run kind, never with plan.done for a custom run', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    writeFileSync(join(taskDir(ISSUE), 'research.md'), 'x');
    await collectArtifacts(config, ISSUE, 'custom');

    expect(existsSync(markerPath(ISSUE, 'custom.done'))).toBe(true);
    // Writing plan.done here would satisfy the Plan gate and jump the card to
    // Implement because the operator ran a research prompt.
    expect(existsSync(markerPath(ISSUE, 'plan.done'))).toBe(false);
  });

  it('consumes the snapshot, so a finished run is never collected twice', async () => {
    writeRunSnapshot(config, ISSUE, 'custom');
    expect(snapshotAgeMs(ISSUE, 'custom')).not.toBeNull();
    writeFileSync(join(taskDir(ISSUE), 'research.md'), 'x');
    await collectArtifacts(config, ISSUE, 'custom');
    expect(snapshotAgeMs(ISSUE, 'custom')).toBeNull();
  });
```

A note on what is *not* tested here, because the snapshot diff cannot express
it: re-running Plan over a file that is still uncommitted in the worktree will
not re-collect it, since the second run's baseline already contains it. That is
harmless — `resolveWriteTarget` (`documents.ts:51`) reads the original while it
exists, so the doc rail shows the new content regardless of the stored copy.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/artifacts.test.ts`
Expected: FAIL — `shouldCollectRun`, `writeRunSnapshot`, `snapshotAgeMs`, `COLLECT_GRACE_MS` are not exported.

- [ ] **Step 4: Add the per-kind snapshot path**

In `src/orchestrator/paths.ts`, replace the `planSnapshotPath` function with:

```ts
/**
 * The "before" picture captured when a run starts, used to attribute the files
 * it produces. Also the collection sentinel: while it exists, that run's output
 * has not been gathered yet.
 */
export function runSnapshotPath(issue: number, kind: string): string {
  return join(taskDir(issue), `${kind}.snapshot.json`);
}
```

`kind: string` rather than `RunKind` keeps `paths.ts` free of the type import, matching how the rest of that file takes plain values.

- [ ] **Step 5: Rewrite the artifact machinery**

In `src/orchestrator/artifacts.ts`:

Update the imports — drop `planSnapshotPath`, add `runSnapshotPath`, add `statSync` to `node:fs`, and add `RunKind` to the type import.

Replace the `RESERVED` / `isReserved` block with:

```ts
// Task-dir entries that are MC's own bookkeeping, never artifacts. plan.md is
// excluded too: it is the primary signal with its own drawer surface.
const RESERVED = new Set([
  'markers',
  'prompt.txt',
  'plan.md',
  'artifacts',
  'artifacts.json',
  'spawn.json',
]);

function isReserved(name: string): boolean {
  // Every run kind has its own snapshot, so match the suffix rather than
  // listing them — a new kind must never be collectable as its own artifact.
  return RESERVED.has(name) || name.endsWith('.snapshot.json') || name.endsWith('.code-workspace');
}
```

Replace `shouldCollectPlan` with:

```ts
/**
 * How long after a run's snapshot the poller waits before concluding, from the
 * absence of a live process, that the run has finished.
 *
 * A spawn writes its snapshot immediately but its `<kind>.running` marker only
 * once the terminal has started (~1.5s; see the delay in routes.ts). Without
 * this floor the very next poll would find no live spawn, collect nothing,
 * consume the snapshot, and lose everything the run went on to produce.
 * The done marker bypasses it, so a run that signs off is collected at once.
 */
export const COLLECT_GRACE_MS = 90_000;

/**
 * Whether the poller should collect this run's artifacts now.
 *
 * The snapshot is the sentinel in both directions: no snapshot means either
 * nothing is pending or it has already been collected, and collecting consumes
 * it. That single rule replaces the old manifest check, which stopped working
 * once manifests began outliving the run that wrote them.
 */
export function shouldCollectRun(i: {
  liveSpawn: unknown;
  doneMarker: boolean;
  snapshotAgeMs: number | null;
}): boolean {
  if (i.snapshotAgeMs === null) return false;
  if (i.doneMarker) return true;
  if (i.liveSpawn) return false;
  return i.snapshotAgeMs > COLLECT_GRACE_MS;
}

/** Age of a run's pending snapshot, or null when there is none. */
export function snapshotAgeMs(issue: number, kind: RunKind): number | null {
  try {
    return Date.now() - statSync(runSnapshotPath(issue, kind)).mtimeMs;
  } catch {
    return null;
  }
}
```

Replace `writePlanSnapshot` with:

```ts
/**
 * Capture the "before" picture for a run.
 *
 * Note what is *not* here: no artifact is cleared. A run's output has to
 * survive every later run, including a re-plan, so the only thing reset is the
 * run's own sign-off marker — without that, a stale one from the previous run
 * would make the next poll collect before the agent had done anything.
 */
export function writeRunSnapshot(config: Config, issue: number, kind: RunKind): void {
  rmSync(markerPath(issue, `${kind}.done`), { force: true });

  const snapshot: PlanSnapshot = {
    takenAt: new Date().toISOString(),
    taskDirFiles: listDir(taskDir(issue)),
    repoStatus: worktreeExists(issue) ? gitStatusPathsSync(worktreePath(issue)) : [],
    extraRoots: {},
  };
  for (const root of config.repo.artifactRoots ?? []) {
    snapshot.extraRoots[root] = listDir(root);
  }
  mkdirSync(taskDir(issue), { recursive: true });
  writeFileSync(runSnapshotPath(issue, kind), JSON.stringify(snapshot, null, 2), 'utf8');
}
```

Change `readSnapshot` to take the kind:

```ts
function readSnapshot(issue: number, kind: RunKind): PlanSnapshot {
  try {
    return JSON.parse(readFileSync(runSnapshotPath(issue, kind), 'utf8')) as PlanSnapshot;
  } catch {
    return { takenAt: '', taskDirFiles: [], repoStatus: [], extraRoots: {} };
  }
}
```

Replace `collectArtifacts` with:

```ts
/**
 * Diff the roots against the run's snapshot, copy new files in, merge them into
 * the manifest.
 *
 * Merging is keyed on `originalPath`, not on name: re-planning normally
 * rewrites the same design document, and keying on name would accumulate
 * design-1.md, design-2.md in the doc rail instead of refreshing one entry.
 */
export async function collectArtifacts(
  config: Config,
  issue: number,
  kind: RunKind = 'plan',
  trigger: 'command' | 'auto' = 'auto',
): Promise<ArtifactRef[]> {
  const snap = readSnapshot(issue, kind);
  const dir = taskDir(issue);
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

  // Seeded with what earlier runs collected, so nothing is ever dropped and a
  // re-collected file keeps the name the doc rail already shows.
  const byOriginal = new Map<string, ArtifactRef>(
    readArtifacts(issue).map((ref) => [ref.originalPath, ref]),
  );
  const taken = [...byOriginal.values()].map((ref) => ref.name);

  for (const f of found) {
    if (!existsSync(f.abs)) continue; // vanished between snapshot and now
    const prior = byOriginal.get(f.abs);
    const name = prior ? prior.name : uniqueName(taken, f.base);
    if (!prior) taken.push(name);
    try {
      copyFileSync(f.abs, join(store, name));
    } catch {
      continue; // locked/failed copy: record the rest
    }
    byOriginal.set(f.abs, {
      name,
      storedPath: `artifacts/${name}`,
      origin: f.origin,
      originalPath: f.abs,
    });
  }

  const refs = [...byOriginal.values()];

  writeFileSync(
    artifactsManifestPath(issue),
    JSON.stringify({ collectedAt: new Date().toISOString(), trigger, artifacts: refs }, null, 2),
    'utf8',
  );
  // Each run signs off with its own marker. Writing 'plan.done' from a custom
  // run would satisfy the Plan gate and move the card to Implement.
  writeMarker(issue, `${kind}.done`);
  // Consume the sentinel: this run is now collected.
  rmSync(runSnapshotPath(issue, kind), { force: true });
  return refs;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/artifacts.test.ts`
Expected: PASS. Type errors in `poller.ts`, `spawn.ts` and `cli.ts` are expected at this point and are fixed in Tasks 5 and 6.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/paths.ts src/orchestrator/artifacts.ts test/artifacts.test.ts
git commit -m "feat: keep artifacts across runs and merge them into one manifest"
```

---

## Task 5: The poller collects every pending run

**Files:**
- Modify: `src/orchestrator/poller.ts`, `src/orchestrator/cli.ts`

**Interfaces:**
- Consumes: `shouldCollectRun`, `snapshotAgeMs`, `collectArtifacts`, `readArtifacts` from `./artifacts.ts`; `CUSTOM_RUN_ID` from `../shared/custom-run.ts`.
- Produces: nothing new; restores a clean type check.

- [ ] **Step 1: Update the poller's collection block**

In `src/orchestrator/poller.ts`, change the imports:

```ts
import { collectArtifacts, readArtifacts, shouldCollectRun, snapshotAgeMs } from './artifacts.ts';
import { CUSTOM_RUN_ID } from '../shared/custom-run.ts';
```

Remove `artifactsManifestPath` and `planSnapshotPath` from the `./paths.ts` import; if that leaves the import empty, delete the line, and remove the now-unused `existsSync` import if nothing else uses it.

Replace the `if (shouldCollectPlan({ … })) { … }` block (poller.ts:115–128) with:

```ts
        // Both a plan run and a custom run can be waiting to be collected —
        // launching a custom run does not cancel a plan run's pending capture —
        // so each kind is settled on its own. When both fire, the plan's stale
        // baseline also claims the custom run's files; the originalPath merge
        // in collectArtifacts collapses that to one entry either way.
        for (const kind of ['plan', CUSTOM_RUN_ID] as const) {
          if (
            !shouldCollectRun({
              liveSpawn: facts.liveSpawn,
              doneMarker: facts.markers.includes(`${kind}.done`),
              snapshotAgeMs: snapshotAgeMs(task.issue, kind),
            })
          ) {
            continue;
          }
          try {
            await collectArtifacts(config, task.issue, kind, 'auto');
          } catch (e) {
            console.error(`[mc] ${kind} artifact collection failed for #${task.issue}:`, e);
          }
          facts = { ...facts, artifacts: readArtifacts(task.issue) };
        }
```

- [ ] **Step 2: Update the CLI's collect command**

In `src/orchestrator/cli.ts:203`, change:

```ts
        const refs = await collectArtifacts(config, task.issue, 'plan', 'command');
```

- [ ] **Step 3: Verify the type check is clean apart from the spawn path**

Run: `npm run typecheck`
Expected: only errors remaining are in `src/orchestrator/spawn.ts` (`writePlanSnapshot` no longer exists), fixed next.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, including `poller-cadence.test.ts` and `poller-merge.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/poller.ts src/orchestrator/cli.ts
git commit -m "feat: settle each run kind's artifact collection independently"
```

---

## Task 6: Spawning a custom run

**Files:**
- Modify: `src/orchestrator/spawn.ts`
- Test: `test/spawn.test.ts`

**Interfaces:**
- Consumes: `CUSTOM_RUN_ID` from `../shared/custom-run.ts`; `writeRunSnapshot`, `readArtifacts` from `./artifacts.ts`.
- Produces:
  - `SpawnOptions.rawPrompt?: string`
  - `function summarisePrompt(text: string): string`
  - `spawnPhase` returns a `SpawnRecord` carrying `promptSummary` for custom runs.

- [ ] **Step 1: Write the failing test**

Append to `test/spawn.test.ts`:

```ts
describe('summarisePrompt', () => {
  it('flattens whitespace', () => {
    expect(summarisePrompt('  research   the\nauth flow  ')).toBe('research the auth flow');
  });

  it('truncates long prompts with an ellipsis', () => {
    const summary = summarisePrompt('x'.repeat(400));
    expect(summary).toHaveLength(100);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('leaves a short prompt untouched', () => {
    expect(summarisePrompt('go')).toBe('go');
  });
});
```

Add `summarisePrompt` to the import from `../src/orchestrator/spawn.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/spawn.test.ts`
Expected: FAIL — `summarisePrompt` is not exported.

- [ ] **Step 3: Implement**

In `src/orchestrator/spawn.ts`, update the imports:

```ts
import {
  readArtifacts,
  resolveArtifactStoredPath,
  writeRunSnapshot,
} from './artifacts.ts';
import { CUSTOM_RUN_ID } from '../shared/custom-run.ts';
```

Add near `describeAgent`:

```ts
/** A custom run's prompt, flattened and clipped for the history list. */
export function summarisePrompt(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
```

Extend `SpawnOptions`:

```ts
export interface SpawnOptions {
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
  /** Bypass the command file: this text is the whole prompt body. */
  rawPrompt?: string;
}
```

In `spawnPhase`, pass the new options through to `resolveSpawnPlan`:

```ts
  const { agent, model, effort, profile, promptText } = resolveSpawnPlan(
    config,
    task,
    phase,
    getPhaseDefaults(),
    {
      customInstructions: options.customInstructions,
      agent: options.agent,
      model: options.model,
      effort: options.effort,
      rawPrompt: options.rawPrompt,
      // What earlier runs produced, so this one can build on it.
      artifacts: readArtifacts(task.issue),
    },
  );
```

Replace the plan-snapshot line:

```ts
  // Snapshot the "before" picture for the runs whose output we capture. A
  // custom run counts: research and specs are exactly what should reach the
  // doc rail. Implement and the review fixers are not — their output is code.
  if (phase.id === 'plan' || phase.id === CUSTOM_RUN_ID) {
    writeRunSnapshot(config, task.issue, phase.id);
  }
```

Extend the returned record:

```ts
  const summary =
    phase.id === CUSTOM_RUN_ID
      ? summarisePrompt(options.rawPrompt ?? options.customInstructions ?? '')
      : '';

  return {
    phase: phase.id,
    agent: describeAgent(agent, model, effort),
    startedAt: new Date().toISOString(),
    command,
    ...(threadId ? { threadId } : {}),
    ...(summary ? { promptSummary: summary } : {}),
  };
```

- [ ] **Step 4: Run tests and the type check**

Run: `npx vitest run test/spawn.test.ts && npm run typecheck`
Expected: PASS, and the type check is now fully clean.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/spawn.ts test/spawn.test.ts
git commit -m "feat: snapshot and record a custom run when it spawns"
```

---

## Task 7: Routes accept a custom run

**Files:**
- Modify: `src/server/routes.ts`

**Interfaces:**
- Consumes: `resolveRunPhase`, `CUSTOM_RUN_ID` from `../shared/custom-run.ts`; `readArtifacts` from `../orchestrator/artifacts.ts`.
- Produces: both `/spawn` and `/prompt` accept `phase: 'custom'` and an optional `includeContext: boolean` (default `true`).

- [ ] **Step 1: Add the shared phase lookup**

In `src/server/routes.ts`, add the imports:

```ts
import { CUSTOM_RUN_ID, resolveRunPhase } from '../shared/custom-run.ts';
import { readArtifacts } from '../orchestrator/artifacts.ts';
```

Add near the top of the route-registration function, where `config` is in scope:

```ts
  /**
   * Phases the operator can launch: everything in the pipeline, plus the
   * synthetic custom run. Built per call because config.agents can change
   * under a config reload.
   */
  const runPhase = (id: string | undefined) =>
    resolveRunPhase({ pipeline: config.pipeline, agentNames: Object.keys(config.agents) }, id);
```

- [ ] **Step 2: Update the spawn route**

Replace the body type and the phase lookup in `/api/tasks/:issue/spawn`:

```ts
  app.post<{
    Params: { issue: string };
    Body: {
      phase?: string;
      customInstructions?: string;
      agent?: string;
      model?: string;
      effort?: string;
      /** Custom runs only: false sends the operator's text with no preamble. */
      includeContext?: boolean;
    };
  }>('/api/tasks/:issue/spawn', async (req, reply) => {
    const task = getTask(Number(req.params.issue));
    if (!task) return reply.code(404).send({ error: 'task not on the board' });

    const phase = runPhase(req.body?.phase);
    if (!phase) return reply.code(400).send({ error: `unknown phase '${req.body?.phase}'` });
    if (!phase.spawnable) {
      return reply.code(400).send({ error: `phase '${phase.id}' is not spawnable` });
    }

    // Context off means the operator's text is the entire prompt, so there has
    // to be some: a raw run of nothing is not a run.
    const raw =
      phase.id === CUSTOM_RUN_ID && req.body?.includeContext === false
        ? (req.body?.customInstructions ?? '').trim()
        : undefined;
    if (raw === '') {
      return reply
        .code(400)
        .send({ error: 'a custom run with issue context turned off needs a prompt' });
    }

    try {
      const record = await spawnPhase(config, task, phase, {
        customInstructions: req.body?.customInstructions,
        agent: req.body?.agent,
        model: req.body?.model,
        effort: req.body?.effort,
        rawPrompt: raw,
      });
      upsertTask({ ...task, spawnHistory: [...task.spawnHistory, record] });
      // The tab needs a moment to write its running marker before we re-derive.
      setTimeout(() => void refreshAndBroadcast(), 1500);
      return { spawned: record };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
```

- [ ] **Step 3: Update the prompt-preview route**

```ts
  app.post<{
    Params: { issue: string };
    Body: { phase?: string; instructions?: string; includeContext?: boolean };
  }>('/api/tasks/:issue/prompt', async (req, reply) => {
    const task = getTask(Number(req.params.issue));
    if (!task) return reply.code(404).send({ error: 'task not on the board' });

    const phase = runPhase(req.body?.phase);
    if (!phase) return reply.code(400).send({ error: `unknown phase '${req.body?.phase}'` });

    try {
      const plan = resolveSpawnPlan(config, task, phase, getPhaseDefaults(), {
        customInstructions: req.body?.instructions || undefined,
        artifacts: readArtifacts(task.issue),
        rawPrompt:
          phase.id === CUSTOM_RUN_ID && req.body?.includeContext === false
            ? (req.body?.instructions ?? '')
            : undefined,
      });
      return {
        text: plan.promptText,
        command: plan.command,
        words: plan.promptText.trim().split(/\s+/).filter(Boolean).length,
      };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
```

Note the preview deliberately does **not** reject an empty raw prompt — the operator will hit it mid-typing, and it must stay side-effect free and forgiving.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.ts
git commit -m "feat: accept a custom run on the spawn and prompt routes"
```

---

## Task 8: The command files

**Files:**
- Create: `assets/claude/commands/mc-custom.md`
- Modify: `assets/claude/commands/mc-planner.md`

`install.ps1` already globs `*.md` from that folder, so nothing in the installer changes.

- [ ] **Step 1: Write the custom-run preamble**

Create `assets/claude/commands/mc-custom.md`:

```markdown
---
description: Run a free-form instruction against an Acme issue.
---
You are working on GitHub issue #{{issue}} ("{{title}}") on branch {{branch}}.
Read the issue with `gh issue view {{issue}}` before you start.

Write any document you produce into this exact absolute path:

    {{taskDir}}

That path is deliberately outside the repository — writing there keeps the
checkout clean. Mission Control collects files that appear there and shows them
in the task's doc rail.

Research, specs and notes already collected for this issue:

{{artifacts}}

Read anything above that is relevant before you begin, and do not redo work it
already covers.

When you are finished, write an empty file at this exact absolute path to signal
you are done — Mission Control watches for it to collect your output:

    {{donePath}}

Your task:

{{customInstructions}}
```

- [ ] **Step 2: Let the planner read prior work**

In `assets/claude/commands/mc-planner.md`, insert immediately before the `{{customInstructions}}` line:

```markdown
Research, specs and notes already collected for this issue:

{{artifacts}}

Read them before planning. Do not redo work they already cover.

```

- [ ] **Step 3: Install and verify the rendered prompt**

Run:

```bash
pwsh -File scripts/install.ps1
```

Then check both files landed:

```bash
ls ~/.claude/commands/mc-custom.md ~/.claude/commands/mc-planner.md
```

Expected: both exist.

- [ ] **Step 4: Commit**

```bash
git add assets/claude/commands/mc-custom.md assets/claude/commands/mc-planner.md
git commit -m "feat: add the custom-run prompt and let the planner read prior work"
```

---

## Task 9: The drawer

**Files:**
- Modify: `src/web/api.ts`, `src/web/components/drawer/RunTab.tsx`, `src/web/components/drawer/LaunchCompose.tsx`, `src/web/components/drawer/PromptPreview.tsx`, `src/web/components/drawer/HistoryTab.tsx`

**Interfaces:**
- Consumes: `CUSTOM_RUN_ID`, `customPhase` from `../../../shared/custom-run.ts`; `RunKind` from `../../../shared/types.ts`.
- Produces: `api.spawn(issue, phase: RunKind, opts & { includeContext?: boolean })`, `api.previewPrompt(issue, phase: RunKind, instructions?, includeContext?)`.

- [ ] **Step 1: Widen the API client**

In `src/web/api.ts`, add `RunKind` to the type import from `../shared/types.ts`, then replace the `spawn` and `previewPrompt` entries:

```ts
  spawn: (
    issue: number,
    phase: RunKind,
    opts: {
      customInstructions?: string;
      agent?: string;
      model?: string;
      effort?: string;
      includeContext?: boolean;
    } = {},
  ) => post<{ spawned: unknown }>(`/api/tasks/${issue}/spawn`, { phase, ...opts }),

  previewPrompt: (
    issue: number,
    phase: RunKind,
    instructions?: string,
    includeContext?: boolean,
  ) =>
    post<PromptPreview>(`/api/tasks/${issue}/prompt`, { phase, instructions, includeContext }),
```

- [ ] **Step 2: Add the Custom button**

In `src/web/components/drawer/RunTab.tsx`, add the import:

```ts
import { CUSTOM_RUN_ID, customPhase } from '../../../shared/custom-run.ts';
```

Replace the `spawnable` / `phase` lines:

```ts
  const spawnable = config.pipeline.filter((p) => p.spawnable && p.command);
  const custom = customPhase({
    pipeline: config.pipeline,
    agentNames: config.agents.map((a) => a.name),
  });
  const phase =
    armed === CUSTOM_RUN_ID ? custom : (spawnable.find((p) => p.id === armed) ?? null);
```

Add the button after the `spawnable.map(…)` block, still inside the same `div.actions`:

```tsx
            <button
              key={CUSTOM_RUN_ID}
              className="btn is-sm"
              onClick={() => setArmed(CUSTOM_RUN_ID)}
              title="Write the whole prompt yourself"
            >
              ⚡ Custom…
            </button>
```

And update the hint below it:

```tsx
          <p className="hint">
            Underlined is where this task sits now — but any phase can be
            re-run. Custom writes the whole prompt yourself; it never moves the
            card.
          </p>
```

- [ ] **Step 3: Add the custom-mode deltas to the compose box**

In `src/web/components/drawer/LaunchCompose.tsx`, add the import:

```ts
import { CUSTOM_RUN_ID } from '../../../shared/custom-run.ts';
```

Add after the `inheritedSelection` line:

```ts
  const isCustom = phase.id === CUSTOM_RUN_ID;
  const [includeContext, setIncludeContext] = useState(true);
```

Change the two `useState` initialisers so a custom run never inherits the task's
pinned instructions — that field is shared with every phase's compose box, and a
kept research prompt would otherwise ride along into Implement:

```ts
  const [text, setText] = useState(isCustom ? '' : (task.overrides?.instructions ?? ''));
  const [kept, setKept] = useState(!isCustom && Boolean(task.overrides?.instructions));
```

Guard the effect that re-syncs from overrides:

```ts
  useEffect(() => {
    if (isCustom) return;
    setText(task.overrides?.instructions ?? '');
    setKept(Boolean(task.overrides?.instructions));
  }, [task.issue, task.overrides?.instructions, isCustom]);
```

Add a launch guard and pass the flag through:

```ts
  const empty = text.trim() === '';
  const blocked = busy !== null || (isCustom && empty);

  async function launch() {
    if (isCustom && empty) return;
    if (kept) await persist(text.trim() || null);
    return run(phase.id, () =>
      api.spawn(task.issue, phase.id, {
        customInstructions: text.trim() || undefined,
        agent: onceOpen ? once.agent || undefined : undefined,
        model: onceOpen ? once.model || undefined : undefined,
        effort: onceOpen ? once.effort || undefined : undefined,
        ...(isCustom ? { includeContext } : {}),
      }),
    );
  }
```

Replace every `disabled={busy !== null}` on a launch button with `disabled={blocked}`, and every `if (busy === null) void launch();` in the two `onKeyDown` handlers with `if (!blocked) void launch();`.

Make the placeholder mode-aware:

```tsx
        placeholder={
          isCustom
            ? 'What should the agent do?'
            : 'Extra instructions for this run (optional)'
        }
```

Hide **Keep** for a custom run — replace that button with:

```tsx
          {!isCustom && (
            <button
              className={`btn is-sm${kept ? ' is-on' : ''}`}
              onClick={toggleKeep}
              aria-pressed={kept}
              title="Keep for every run of this task"
            >
              📌 {kept ? 'Kept' : 'Keep'}
            </button>
          )}
```

Add the context checkbox immediately after the `compose-meta` div:

```tsx
      {isCustom && (
        <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeContext}
            onChange={(e) => setIncludeContext(e.target.checked)}
          />
          Include issue context — the issue number, branch, where to write output
          and which documents already exist
        </label>
      )}
```

Guard the flush-on-unmount effect so a custom run never writes overrides:

```ts
  const latest = useRef({ kept, text, issue: task.issue, isCustom });
  latest.current = { kept, text, issue: task.issue, isCustom };

  useEffect(() => {
    return () => {
      const { kept: k, text: t, issue, isCustom: c } = latest.current;
      if (c || !k) return;
      const value = t.trim() || null;
      void api.overrides(issue, { instructions: value });
    };
  }, []);
```

Finally pass the flag to the preview, in both places `PromptPreview` is rendered:

```tsx
        <PromptPreview
          issue={task.issue}
          phase={phase.id}
          phaseLabel={phase.label}
          instructions={text}
          includeContext={isCustom ? includeContext : undefined}
          onClose={() => setPreviewing(false)}
        />
```

- [ ] **Step 4: Thread the flag through the preview**

In `src/web/components/drawer/PromptPreview.tsx`, change the `Phase` type import to `RunKind`, then:

```ts
interface Props {
  issue: number;
  phase: RunKind;
  phaseLabel: string;
  instructions: string;
  /** Custom runs only: false previews the raw prompt with no preamble. */
  includeContext?: boolean;
  onClose: () => void;
}
```

Update the signature and the fetch:

```ts
export function PromptPreview({ issue, phase, phaseLabel, instructions, includeContext, onClose }: Props) {
```

```ts
    api
      .previewPrompt(issue, phase, instructions || undefined, includeContext)
      .then((p) => live && setPreview(p))
      .catch((e: Error) => live && setError(e.message));
```

and add `includeContext` to that effect's dependency array:

```ts
  }, [issue, phase, instructions, includeContext]);
```

- [ ] **Step 5: Show the prompt summary in history**

In `src/web/components/drawer/HistoryTab.tsx`, change the spawn line to:

```tsx
              spawn: {new Date(s.startedAt).toLocaleString()} · {s.phase} · {s.agent}
              {s.promptSummary && <> · “{s.promptSummary}”</>}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Check it in the real app**

Run: `npm run dev`

Then in the browser:
1. Open a task's drawer → **Run** tab. Confirm a **⚡ Custom…** button sits after the phase buttons.
2. Click it. Confirm the placeholder reads "What should the agent do?", **📌 Keep** is absent, **Launch Custom run** is disabled, and the **Include issue context** checkbox is on.
3. Type a sentence. Confirm Launch enables.
4. Click **👁 Preview prompt**. Confirm the preamble is rendered around your text, the badge reads `mc-custom`, and the artifact list shows either prior documents or `(none)`.
5. Untick **Include issue context** and preview again. Confirm the prompt is now your text alone and the badge reads `raw`.
6. Confirm the board still shows exactly the configured lanes — no "Custom run" lane — and that the Run tab's **Mark progress** row has no Custom entry.

- [ ] **Step 8: Commit**

```bash
git add src/web
git commit -m "feat: launch a custom run from the drawer"
```

---

## Task 10: End-to-end verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Full suite and type check**

Run: `npm test && npm run typecheck`
Expected: PASS. Confirm `git status` shows `test/reconcile.test.ts` unmodified.

- [ ] **Step 2: Run a real custom run**

With `npm run dev` up, pick a task on the board and launch a custom run with a prompt that produces a file, for example:

> Write a two-paragraph note on how this repo handles authentication, and save it as auth-notes.md.

- [ ] **Step 3: Confirm capture, and that nothing was destroyed**

After the agent finishes, check:

```bash
ls ~/.mc/tasks/<issue>/artifacts/
cat ~/.mc/tasks/<issue>/artifacts.json
ls ~/.mc/tasks/<issue>/markers/
```

Expected: `auth-notes.md` present in `artifacts/` and listed in `artifacts.json`; `custom.done` present in `markers/`; **`plan.done` absent** unless a plan run had already written it; `custom.snapshot.json` gone.

- [ ] **Step 4: Confirm the run chains into Plan**

Launch a Plan run on the same task and preview its prompt before launching. Expected: the artifact list contains `auth-notes.md` with its absolute path.

- [ ] **Step 5: Confirm a re-plan destroys nothing**

Let the plan run finish and collect, then launch Plan again. While it runs, check:

```bash
ls ~/.mc/tasks/<issue>/artifacts/
```

Expected: `auth-notes.md` and the plan's own documents are all still there. Before this change, starting a plan run emptied that folder.

- [ ] **Step 6: Commit any fixes and merge**

```bash
git status
```

Expected: clean. If verification turned up fixes, they should already be committed against the task that owned them.

---

## Self-Review Notes

**Spec coverage.** Every section of `2026-08-09-custom-run-design.md` maps to a task: §1 synthetic phase → Task 1; §2 type widening → Task 1; §3 prompt and context toggle → Tasks 2, 3, 8, 9; §4 `{{artifacts}}` → Tasks 2, 8; §5 persistence → Tasks 4, 5; §5a `plan.md` stays special → enforced by leaving `plan.md` in `RESERVED` (Task 4, Step 5) and asserted by the existing `plan.md is not in the list` test; §6 routes → Task 7; §7 UI → Task 9.

**Deviations from the spec**, both argued in "Two corrections" above: the done marker is per-kind, and `shouldCollectRun` uses a grace period instead of `planMdExists`. The spec's §5b(ii) should be read as amended by this plan.

**Not built, deliberately:** saved presets, a board-level scratch run, artifact cleanup UI, and any `custom` entry in `config.yaml` — all listed as non-goals in the spec.
