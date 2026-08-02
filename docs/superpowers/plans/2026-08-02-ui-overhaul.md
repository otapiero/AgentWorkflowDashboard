# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Mission Control's three UI surfaces — a needs-you rail above lanes that size to their contents, a drawer of tabs behind a permanent status header, and a phase-first launch flow that shows the operator the real prompt before it spawns.

**Architecture:** Everything user-visible lives in `src/web`. Two additive backend changes support it: a read-only prompt-preview endpoint, and making the overrides endpoint merge instead of replace. All new *logic* is extracted into pure functions in their own modules so it can be unit-tested by the existing node-only vitest setup; the React components that consume them stay thin.

**Tech Stack:** TypeScript (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), React 19 + Vite, Fastify 5, vitest 3.

**Design doc:** `docs/superpowers/specs/2026-08-02-ui-overhaul-design.md`

## Global Constraints

- **Import paths carry the `.ts`/`.tsx` extension.** `allowImportingTsExtensions` is on and every existing import uses it. `import { api } from '../api.ts'`.
- **`verbatimModuleSyntax` is on.** Type-only imports MUST use `import type { X } from '…'`. A plain `import { SomeType }` fails the build.
- **`noUncheckedIndexedAccess` is on.** `array[0]` is `T | undefined`. Narrow or use `!` where genuinely safe, as the existing code does (`config.agents[agent]!`).
- **Test runner is node-only.** There is no jsdom, no `@testing-library/react`, and no React test in the repo. **Do not add those dependencies.** UI tasks are verified by running the app; logic is verified by extracting it into a pure module and testing that.
- **Zero footprint in the Acme checkout.** No task writes anything into `config.repo.path`.
- **Typecheck must pass** after every task: `npm run typecheck`.
- **Full test suite must pass** after every task: `npm test`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/orchestrator/spawn-plan.ts` | Pure resolution of *what would be spawned* — agent, model, effort, command, prompt text. Shared by spawn and preview so they cannot drift. |
| `src/orchestrator/overrides.ts` | `mergeOverrides` — patch semantics for `TaskOverrides` (absent = leave, `null` = clear). |
| `src/web/board-model.ts` | Pure board maths: lane width allocation, attention-rail membership. |
| `src/web/components/AttentionRail.tsx` | The needs-you strip. |
| `src/web/components/drawer/RunTab.tsx` | Phase list ⇄ compose view, plus Mark progress. |
| `src/web/components/drawer/LaunchCompose.tsx` | Compose box, grow behaviour, full-window + preview + 📌. |
| `src/web/components/drawer/PromptPreview.tsx` | Resolved prompt with instructions highlighted. |
| `src/web/components/drawer/PlanTab.tsx` | Plan + artifacts. |
| `src/web/components/drawer/HistoryTab.tsx` | Usage + spawn history. |
| `src/web/components/drawer/SetupTab.tsx` | Pin, placement, workspace, destructive actions. |
| `test/spawn-plan.test.ts`, `test/overrides.test.ts`, `test/board-model.test.ts` | Their unit tests. |

**Modify:** `src/orchestrator/spawn.ts` (delegate to `spawn-plan`), `src/server/routes.ts` (preview endpoint, merging overrides), `src/web/api.ts` (two client methods), `src/web/components/Drawer.tsx` (becomes a shell), `src/web/components/Lane.tsx` (collapsed rendering), `src/web/components/Board.tsx` (widths), `src/web/App.tsx` (rail, topbar), `src/web/styles.css` (throughout).

---

## Task 1: Shared spawn resolution

Extract "what would be spawned" out of `spawnPhase` so the preview endpoint can call exactly the same code. A preview that disagrees with the launch is worse than no preview, so this is the one piece of shared machinery the whole feature rests on.

**Files:**
- Create: `src/orchestrator/spawn-plan.ts`
- Create: `test/spawn-plan.test.ts`
- Modify: `src/orchestrator/spawn.ts:244-274`

**Interfaces:**
- Consumes: `resolveAgent` from `agents.ts`, `buildPrompt` from `prompt.ts`, `STANDING_RULES` from `spawn.ts`.
- Produces: `resolveSpawnPlan(config, task, phase, phaseDefaults, options) → SpawnPlan` with `{ agent, model, effort, profile, command, promptText }`. Task 2 and Task 7 both call it.

**Note on purity:** `phaseDefaults` is passed in rather than read via `getPhaseDefaults()` inside, so the function is pure and testable without touching `~/.mc`. Callers do the reading.

- [ ] **Step 1: Write the failing test**

Create `test/spawn-plan.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSpawnPlan } from '../src/orchestrator/spawn-plan.ts';
import { claudeCommandsDir } from '../src/orchestrator/paths.ts';
import type {
  AgentProfile,
  Config,
  PhaseConfig,
  TaskRecord,
} from '../src/shared/types.ts';

let home: string;

const claude: AgentProfile = {
  launch: 'claude',
  promptMode: 'positional',
  modelFlag: '--model',
  effortFlag: '--effort',
  instructionMode: 'flag',
  instructionFlag: '--append-system-prompt',
};

const copilot: AgentProfile = {
  launch: 'copilot',
  promptMode: 'flag',
  promptFlag: '-i',
  modelFlag: '--model',
  effortFlag: '--effort',
  instructionMode: 'inline',
};

function config(): Config {
  return {
    repo: {
      path: 'C:\\repo',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'dev',
      branchPrefix: 'ouriel',
    },
    github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
    agents: { claude, copilot },
    pipeline: [implementPhase()],
    server: { port: 4317 },
  } as unknown as Config;
}

function implementPhase(): PhaseConfig {
  return {
    id: 'implement',
    label: 'Implement',
    actor: 'claude',
    command: 'mc-implementer',
    spawnable: true,
    gate: { type: 'manual' },
  } as PhaseConfig;
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    issue: 3060,
    title: 'Add progress bar',
    slug: 'add-progress-bar',
    branch: 'ouriel/3060-Add-progress-bar',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    ...overrides,
  } as TaskRecord;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-spawn-plan-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  mkdirSync(claudeCommandsDir(), { recursive: true });
  writeFileSync(
    join(claudeCommandsDir(), 'mc-implementer.md'),
    '---\ndescription: x\n---\nImplement #$ARGUMENTS on `{{branch}}`.\n\n{{customInstructions}}\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('resolveSpawnPlan', () => {
  test('renders the command with the task context', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {});
    expect(plan.command).toBe('mc-implementer');
    expect(plan.agent).toBe('claude');
    expect(plan.promptText).toContain('Implement #3060');
    expect(plan.promptText).toContain('ouriel/3060-Add-progress-bar');
  });

  test('one-off instructions win over the task-level saved ones', () => {
    const plan = resolveSpawnPlan(
      config(),
      task({ overrides: { instructions: 'saved text' } }),
      implementPhase(),
      {},
      { customInstructions: 'one-off text' },
    );
    expect(plan.promptText).toContain('one-off text');
    expect(plan.promptText).not.toContain('saved text');
  });

  test('falls back to the saved task instructions when none are passed', () => {
    const plan = resolveSpawnPlan(
      config(),
      task({ overrides: { instructions: 'saved text' } }),
      implementPhase(),
      {},
      {},
    );
    expect(plan.promptText).toContain('saved text');
  });

  test('an inline-mode agent carries the standing rules in the prompt body', () => {
    const plan = resolveSpawnPlan(
      config(),
      task(),
      implementPhase(),
      {},
      { agent: 'copilot' },
    );
    expect(plan.agent).toBe('copilot');
    expect(plan.promptText).toContain('worktree that Mission Control already prepared');
  });

  test('a flag-mode agent does not', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {});
    expect(plan.promptText).not.toContain('worktree that Mission Control already prepared');
  });

  test('throws when the phase has no command', () => {
    const phase = { ...implementPhase(), command: undefined } as PhaseConfig;
    expect(() => resolveSpawnPlan(config(), task(), phase, {}, {})).toThrow(
      /no command/,
    );
  });

  test('throws when no agent can be resolved', () => {
    const phase = { ...implementPhase(), actor: 'none' } as PhaseConfig;
    expect(() => resolveSpawnPlan(config(), task(), phase, {}, {})).toThrow(
      /no agent/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/spawn-plan.test.ts`
Expected: FAIL — `Failed to resolve import "../src/orchestrator/spawn-plan.ts"`.

- [ ] **Step 3: Write the module**

Create `src/orchestrator/spawn-plan.ts`:

```ts
import { resolveAgent } from './agents.ts';
import { buildPrompt } from './prompt.ts';
import { STANDING_RULES } from './spawn.ts';
import type {
  AgentProfile,
  Config,
  PhaseConfig,
  PhaseDefaults,
  TaskRecord,
} from '../shared/types.ts';

/**
 * Everything a spawn would use, resolved but not yet acted on.
 *
 * Preview and launch both go through here. If they resolved separately they
 * would eventually disagree, and a preview that lies about what is going to
 * run is worse than showing nothing at all.
 */
export interface SpawnPlan {
  agent: string;
  model: string | null;
  effort: string | null;
  profile: AgentProfile;
  command: string;
  promptText: string;
}

export interface SpawnPlanOptions {
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

export function resolveSpawnPlan(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  phaseDefaults: PhaseDefaults,
  options: SpawnPlanOptions = {},
): SpawnPlan {
  if (!phase.command) {
    throw new Error(`Phase '${phase.id}' has no command to render a prompt from.`);
  }

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

  const promptText = buildPrompt(phase.command, task, {
    customInstructions: options.customInstructions ?? task.overrides?.instructions,
    // Agents without a system-prompt flag carry the rules in the prompt body.
    inlineInstructions: profile.instructionMode === 'inline' ? STANDING_RULES : undefined,
  });

  return { agent, model, effort, profile, command: phase.command, promptText };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/spawn-plan.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Make `spawnPhase` delegate to it**

In `src/orchestrator/spawn.ts`, replace the body from the `if (!phase.command)` guard through the `buildPrompt(...)` call (currently lines 250-274) with:

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
    },
  );
```

Add to the imports at the top of `spawn.ts`:

```ts
import { resolveSpawnPlan } from './spawn-plan.ts';
```

Then remove the now-unused `buildPrompt` and `resolveAgent` imports if nothing else in the file uses them — check with a search before deleting, `writePromptFile` and `agentCapabilities` are still needed.

**Note:** `spawn-plan.ts` imports `STANDING_RULES` from `spawn.ts` while `spawn.ts` imports `resolveSpawnPlan` from `spawn-plan.ts`. This circular import is fine under ESM here because `STANDING_RULES` is a module-level const consumed only inside a function body at call time, not during module evaluation. If it causes trouble, move `STANDING_RULES` into `spawn-plan.ts` and have `spawn.ts` re-export it — `spawn.test.ts` imports it from neither, so nothing breaks.

- [ ] **Step 6: Verify the whole suite and types still pass**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (including the existing `spawn.test.ts` and `prompt.test.ts`), no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/spawn-plan.ts src/orchestrator/spawn.ts test/spawn-plan.test.ts
git commit -m "$(cat <<'EOF'
refactor: extract spawn resolution so preview and launch share it

Preview needs to answer "what would run" without running it. Resolving
that separately would let the two drift, and a preview that lies about
the prompt is worse than no preview.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Prompt preview endpoint

**Files:**
- Modify: `src/server/routes.ts` (add a route near the spawn route, ~line 152)
- Modify: `src/web/api.ts:68-77`

**Interfaces:**
- Consumes: `resolveSpawnPlan` from Task 1.
- Produces: `api.previewPrompt(issue, phase, instructions?) → Promise<PromptPreview>` where `PromptPreview = { text: string; command: string; words: number }`. Task 7 renders it.

- [ ] **Step 1: Add the route**

In `src/server/routes.ts`, add this immediately after the `/api/tasks/:issue/spawn` handler ends (after line 152's closing `});`):

```ts
  /**
   * What the agent *would* receive. Read-only: no prompt file, no plan
   * snapshot, no spawn record — this must never have a side effect, because
   * the operator will hit it repeatedly while writing.
   */
  app.post<{
    Params: { issue: string };
    Body: { phase?: string; instructions?: string };
  }>('/api/tasks/:issue/prompt', async (req, reply) => {
    const task = getTask(Number(req.params.issue));
    if (!task) return reply.code(404).send({ error: 'task not on the board' });

    const phase = config.pipeline.find((p) => p.id === req.body?.phase);
    if (!phase) return reply.code(400).send({ error: `unknown phase '${req.body?.phase}'` });

    try {
      const plan = resolveSpawnPlan(config, task, phase, getPhaseDefaults(), {
        customInstructions: req.body?.instructions || undefined,
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

Add to the imports at the top of `routes.ts`:

```ts
import { resolveSpawnPlan } from '../orchestrator/spawn-plan.ts';
```

- [ ] **Step 2: Add the client method**

In `src/web/api.ts`, add this exported type above `export const api = {`:

```ts
export interface PromptPreview {
  text: string;
  command: string;
  words: number;
}
```

and add this method inside the `api` object, right after `spawn`:

```ts
  previewPrompt: (issue: number, phase: Phase, instructions?: string) =>
    post<PromptPreview>(`/api/tasks/${issue}/prompt`, { phase, instructions }),
```

- [ ] **Step 3: Verify types**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Verify the endpoint by hand**

Run `npm start`, then in a second terminal (substitute a real issue number that is on your board):

```bash
curl -s -X POST http://127.0.0.1:4317/api/tasks/3060/prompt \
  -H 'Content-Type: application/json' \
  -d '{"phase":"implement","instructions":"TEST MARKER"}'
```

Expected: JSON with `command: "mc-implementer"`, a `words` count, and a `text` containing both the real branch name and `TEST MARKER`.

Then confirm it wrote nothing: `ls ~/.mc/tasks/3060/` must **not** contain a newly-modified `prompt.txt` (compare its mtime before and after).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.ts src/web/api.ts
git commit -m "$(cat <<'EOF'
feat: read-only endpoint returning the prompt a phase would spawn with

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Overrides merge instead of replace

`POST /api/tasks/:issue/overrides` currently rebuilds the whole object from the body, so any omitted field is dropped. Once the Run tab writes `instructions` and the Setup tab writes `agent`/`model`/`effort`, whichever saves last wipes the other. Fix it before either surface exists.

**Files:**
- Create: `src/orchestrator/overrides.ts`
- Create: `test/overrides.test.ts`
- Modify: `src/server/routes.ts:197-218`

**Interfaces:**
- Produces: `mergeOverrides(current, patch) → TaskOverrides | undefined`. Absent key leaves the field alone, `null` clears it, a value sets it. Returns `undefined` when nothing is left, so the state file stays clean.

- [ ] **Step 1: Write the failing test**

Create `test/overrides.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { mergeOverrides } from '../src/orchestrator/overrides.ts';

describe('mergeOverrides', () => {
  test('an absent key leaves the existing value alone', () => {
    const result = mergeOverrides(
      { agent: 'claude', instructions: 'keep me' },
      { model: 'opus' },
    );
    expect(result).toEqual({ agent: 'claude', model: 'opus', instructions: 'keep me' });
  });

  test('this is the regression that would eat kept instructions', () => {
    // The Setup tab saves an agent pin; the Run tab's kept text must survive.
    const result = mergeOverrides(
      { instructions: 'do not touch the migrations' },
      { agent: 'claude', model: 'opus', effort: 'high' },
    );
    expect(result?.instructions).toBe('do not touch the migrations');
  });

  test('null clears exactly that field', () => {
    const result = mergeOverrides(
      { agent: 'claude', instructions: 'kept' },
      { instructions: null },
    );
    expect(result).toEqual({ agent: 'claude' });
  });

  test('a value replaces the existing one', () => {
    const result = mergeOverrides({ agent: 'claude' }, { agent: 'copilot' });
    expect(result).toEqual({ agent: 'copilot' });
  });

  test('an empty string clears, matching the old || undefined behaviour', () => {
    const result = mergeOverrides({ agent: 'claude', model: 'opus' }, { model: '' });
    expect(result).toEqual({ agent: 'claude' });
  });

  test('merging onto nothing works', () => {
    expect(mergeOverrides(undefined, { agent: 'claude' })).toEqual({ agent: 'claude' });
  });

  test('clearing the last field yields undefined, not an empty object', () => {
    expect(mergeOverrides({ agent: 'claude' }, { agent: null })).toBeUndefined();
  });

  test('an empty patch is a no-op', () => {
    expect(mergeOverrides({ agent: 'claude' }, {})).toEqual({ agent: 'claude' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/overrides.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator/overrides.ts`.

- [ ] **Step 3: Write the module**

Create `src/orchestrator/overrides.ts`:

```ts
import type { TaskOverrides } from '../shared/types.ts';

/**
 * A patch over TaskOverrides: absent leaves a field alone, null clears it.
 *
 * The distinction matters because two independent surfaces write this object —
 * the Run tab owns `instructions`, the Setup tab owns agent/model/effort — and
 * a replace-everything write from either would silently delete the other's
 * work.
 */
export type OverridePatch = {
  [K in keyof TaskOverrides]?: TaskOverrides[K] | null;
};

const KEYS = ['agent', 'model', 'effort', 'instructions'] as const;

export function mergeOverrides(
  current: TaskOverrides | undefined,
  patch: OverridePatch,
): TaskOverrides | undefined {
  const next: TaskOverrides = { ...current };

  for (const key of KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    // null and '' both mean "clear"; '' keeps the old `|| undefined` semantics
    // that every existing caller relies on.
    if (value) next[key] = value;
    else delete next[key];
  }

  return Object.keys(next).length > 0 ? next : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/overrides.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Use it in the route**

In `src/server/routes.ts`, replace the `upsertTask({...})` call inside the `/api/tasks/:issue/overrides` handler (currently lines 208-216) with:

```ts
    upsertTask({
      ...task,
      overrides: mergeOverrides(task.overrides, req.body ?? {}),
    });
```

Widen the route's `Body` type on line 199 so `null` is accepted:

```ts
    Body: {
      agent?: string | null;
      model?: string | null;
      effort?: string | null;
      instructions?: string | null;
    };
```

Add to the imports at the top of `routes.ts`:

```ts
import { mergeOverrides } from '../orchestrator/overrides.ts';
```

- [ ] **Step 6: Drop the defensive pass-through in the client**

In `src/web/api.ts`, widen the `overrides` signature so callers can clear a field:

```ts
  overrides: (
    issue: number,
    o: {
      agent?: string | null;
      model?: string | null;
      effort?: string | null;
      instructions?: string | null;
    },
  ) => post<TaskWithDerived[]>(`/api/tasks/${issue}/overrides`, o),
```

In `src/web/components/Drawer.tsx`, delete the line
`instructions: task.overrides?.instructions,` from the "Save pin" handler (currently line 245). It was only there to survive the replace-everything write, and keeping it would now let a stale value overwrite a fresh one.

- [ ] **Step 7: Verify everything**

Run: `npm test && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/overrides.ts test/overrides.test.ts src/server/routes.ts src/web/api.ts src/web/components/Drawer.tsx
git commit -m "$(cat <<'EOF'
fix: merge task overrides instead of replacing the whole object

The handler rebuilt overrides from the request body, so any field the
caller omitted was dropped. That was survivable while one caller passed
every field back; it stops being survivable now that the Run tab owns
instructions and the Setup tab owns agent/model/effort. Saving an agent
pin would silently delete kept instructions.

Absent key leaves a field alone, null clears it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Drawer becomes a shell of tabs

Pure restructuring — every section keeps its current behaviour, it just moves into a tab. No new features. Doing this first gives the launch flow somewhere to live.

**Files:**
- Modify: `src/web/components/Drawer.tsx` (469 lines → ~140)
- Create: `src/web/components/drawer/RunTab.tsx`, `PlanTab.tsx`, `HistoryTab.tsx`, `SetupTab.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Produces: each tab is `({ task, config, busy, error, run }: TabProps) => JSX.Element` where

  ```ts
  export interface TabProps {
    task: TaskWithDerived;
    config: BoardConfig;
    busy: string | null;
    run: (label: string, action: () => Promise<unknown>) => Promise<void>;
    onClose: () => void;
    onChanged: () => void;
  }
  ```

  Export `TabProps` from `src/web/components/drawer/types.ts` so all four tabs and Task 6 share one definition.

- [ ] **Step 1: Create the shared tab props**

Create `src/web/components/drawer/types.ts`:

```ts
import type { BoardConfig } from '../../api.ts';
import type { TaskWithDerived } from '../../../shared/types.ts';

export interface TabProps {
  task: TaskWithDerived;
  config: BoardConfig;
  /** Label of the action currently in flight, or null. Disables buttons. */
  busy: string | null;
  /** Runs an action with busy/error bookkeeping handled by the shell. */
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  onChanged: () => void;
}

export type DrawerTab = 'run' | 'plan' | 'history' | 'setup';
```

- [ ] **Step 2: Move the plan and artifacts sections into `PlanTab`**

Create `src/web/components/drawer/PlanTab.tsx`. Move the `Plan` section (`Drawer.tsx:311-329`) and the `Artifacts` section (`Drawer.tsx:331-366`) verbatim, plus the `plan`/`editingPlan` state and the `api.plan()` fetch from the parent's effect:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { PlanEditor } from '../PlanEditor.tsx';
import type { TabProps } from './types.ts';

export function PlanTab({ task, busy, run, onChanged }: TabProps) {
  const [plan, setPlan] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setPlan(null);
    setEditing(false);
    api
      .plan(task.issue)
      .then((r) => setPlan(r.content))
      .catch(() => setPlan(null));
  }, [task.issue]);

  return (
    <>
      <section className="section">
        <div className="section-label">
          Plan
          <button className="disclose" style={{ marginLeft: 8 }} onClick={() => setEditing(true)}>
            {plan ? 'Expand / edit' : 'Write a plan'}
          </button>
        </div>
        {plan ? (
          <pre className="plan">{plan}</pre>
        ) : (
          <p className="note">
            No plan attached. Run Plan to have an agent write one, or write one yourself.
          </p>
        )}
      </section>

      {task.derived.artifacts.length > 0 && (
        <section className="section">
          <div className="section-label">Artifacts</div>
          <div className="stack">
            {task.derived.artifacts.map((a) => (
              <div
                key={a.name}
                className="actions"
                style={{ justifyContent: 'space-between', alignItems: 'center' }}
              >
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

      {editing && (
        <PlanEditor
          issue={task.issue}
          initial={plan ?? ''}
          onClose={() => setEditing(false)}
          onSaved={(content) => {
            setPlan(content);
            onChanged();
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 3: Move usage and spawn history into `HistoryTab`**

Create `src/web/components/drawer/HistoryTab.tsx`. Move the `Sessions & usage` section (`Drawer.tsx:368-404`) and the `fmtTokens` helper (`Drawer.tsx:13-17`) verbatim, owning the `usage` state and its fetch:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import type { MissionUsage } from '../../api.ts';
import type { TabProps } from './types.ts';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function HistoryTab({ task }: TabProps) {
  const [usage, setUsage] = useState<MissionUsage | null>(null);

  useEffect(() => {
    setUsage(null);
    api.usage(task.issue).then(setUsage).catch(() => setUsage(null));
  }, [task.issue]);

  return (
    <section className="section">
      <div className="section-label">Sessions &amp; usage</div>
      {usage && usage.tracked ? (
        <>
          <div className="usage-total">
            <strong>{fmtTokens(usage.total.total)}</strong> tokens
            <span className="usage-breakdown">
              {' '}· in {fmtTokens(usage.total.input)} · out {fmtTokens(usage.total.output)} ·
              cache {fmtTokens(usage.total.cacheCreate + usage.total.cacheRead)}
            </span>
          </div>
          <div className="history">
            {usage.sessions.map((s) => (
              <div key={s.sessionId}>
                {s.startedAt ? new Date(s.startedAt).toLocaleString() : 'session'} ·{' '}
                {s.models.join(', ') || 'claude'} · {fmtTokens(s.tokens.total)} tok
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="note">
          {usage
            ? 'Usage not tracked for this agent (only Claude Code sessions are counted).'
            : 'Loading usage…'}
        </p>
      )}
      {task.spawnHistory.length > 0 && (
        <div className="history" style={{ marginTop: 8 }}>
          {[...task.spawnHistory].reverse().map((s, i) => (
            <div key={`${s.startedAt}-${i}`}>
              spawn: {new Date(s.startedAt).toLocaleString()} · {s.phase} · {s.agent}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Move pin, placement and workspace into `SetupTab`**

Create `src/web/components/drawer/SetupTab.tsx`. Move the `Pinned agent…` section (`Drawer.tsx:225-257`), `Placement` (`259-309` minus Mark progress), and `Workspace` (`406-454`) — **but drop the `Open in VS Code` button, which moves to the header in Step 5**, and drop the `instructions` pass-through per Task 3:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { AgentPicker } from '../AgentPicker.tsx';
import type { AgentSelection } from '../AgentPicker.tsx';
import type { Phase } from '../../../shared/types.ts';
import type { TabProps } from './types.ts';

const EMPTY: AgentSelection = { agent: '', model: '', effort: '' };

export function SetupTab({ task, config, busy, run, onClose }: TabProps) {
  const [pin, setPin] = useState<AgentSelection>(EMPTY);

  useEffect(() => {
    setPin({
      agent: task.overrides?.agent ?? '',
      model: task.overrides?.model ?? '',
      effort: task.overrides?.effort ?? '',
    });
  }, [task.issue]);

  const pinDirty =
    pin.agent !== (task.overrides?.agent ?? '') ||
    pin.model !== (task.overrides?.model ?? '') ||
    pin.effort !== (task.overrides?.effort ?? '');

  return (
    <>
      <section className="section">
        <div className="section-label">Pinned agent, model &amp; effort</div>
        <div className="stack">
          <AgentPicker
            agents={config.agents}
            value={pin}
            onChange={setPin}
            inheritedAgent={task.pinned.agent}
            inheritAgentLabel="Use phase default"
          />
          <div className="actions">
            <button
              className="btn is-sm"
              disabled={busy !== null || !pinDirty}
              onClick={() =>
                run('pin', () =>
                  api.overrides(task.issue, {
                    agent: pin.agent || null,
                    model: pin.model || null,
                    effort: pin.effort || null,
                  }),
                )
              }
            >
              {busy === 'pin' ? 'Saving…' : 'Save pin'}
            </button>
          </div>
          <p className="hint">
            Applies to every run of this task, unless overridden for a single run.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-label">Placement</div>
        <select
          className="field"
          style={{ width: '100%' }}
          value={task.manualPhase ?? ''}
          onChange={(e) =>
            run('move', () => api.move(task.issue, (e.target.value || null) as Phase | null))
          }
        >
          <option value="">Follow real status</option>
          {['inbox', ...config.pipeline.map((p) => p.id), 'done'].map((id) => (
            <option key={id} value={id}>
              Pin to {id}
            </option>
          ))}
        </select>
        {task.manualPhase && (
          <p className="hint">
            Pinned to {task.manualPhase}; badges still show real status (derived:{' '}
            {task.derived.derivedPhase}).
          </p>
        )}
      </section>

      <section className="section">
        <div className="section-label">Workspace</div>
        <dl className="meta">
          <div className="meta-row">
            <dt>Derived phase</dt>
            <dd>{task.derived.derivedPhase}</dd>
          </div>
          <div className="meta-row">
            <dt>Last checked</dt>
            <dd>
              {task.lastReconciledAt
                ? new Date(task.lastReconciledAt).toLocaleTimeString()
                : 'never'}
            </dd>
          </div>
        </dl>
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="btn is-sm"
            disabled={busy !== null}
            onClick={() => run('cleanup', () => api.cleanup(task.issue))}
          >
            Remove worktree
          </button>
          <button
            className="btn is-sm is-danger"
            disabled={busy !== null}
            onClick={() =>
              run('forget', async () => {
                await api.forget(task.issue);
                onClose();
              })
            }
          >
            Remove from board
          </button>
        </div>
        <p className="hint">
          Removing from the board forgets the card only. Your branch, PR and commits
          are untouched.
        </p>
      </section>
    </>
  );
}
```

- [ ] **Step 5: Move the run + mark-progress sections into `RunTab`**

Create `src/web/components/drawer/RunTab.tsx`. For now this is a **verbatim move** of the existing "Run a phase" section (`Drawer.tsx:175-223`) and "Mark progress" (`259-284`) — Task 6 replaces the run half. Keeping this step a pure move means Task 4 can be reviewed as a refactor with no behaviour change:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { AgentPicker } from '../AgentPicker.tsx';
import type { AgentSelection } from '../AgentPicker.tsx';
import { IconPlay } from '../bits.tsx';
import type { Phase } from '../../../shared/types.ts';
import type { TabProps } from './types.ts';

const EMPTY: AgentSelection = { agent: '', model: '', effort: '' };

export function RunTab({ task, config, busy, run }: TabProps) {
  const [instructions, setInstructions] = useState('');
  const [onceOpen, setOnceOpen] = useState(false);
  const [once, setOnce] = useState<AgentSelection>(EMPTY);

  useEffect(() => {
    setInstructions('');
    setOnceOpen(false);
    setOnce(EMPTY);
  }, [task.issue]);

  const spawnable = config.pipeline.filter((p) => p.spawnable && p.command);

  function spawn(phase: Phase) {
    return run(phase, () =>
      api.spawn(task.issue, phase, {
        customInstructions: instructions.trim() || undefined,
        agent: onceOpen ? once.agent || undefined : undefined,
        model: onceOpen ? once.model || undefined : undefined,
        effort: onceOpen ? once.effort || undefined : undefined,
      }),
    );
  }

  return (
    <>
      <section className="section">
        <div className="section-label">Run a phase</div>
        <div className="stack">
          <textarea
            className="field textarea"
            placeholder="Extra instructions for this run (optional)"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <div className="actions">
            {spawnable.map((phase) => (
              <button
                key={phase.id}
                className={`btn is-sm${
                  phase.id === task.derived.derivedPhase ? ' is-primary' : ''
                }`}
                disabled={busy !== null}
                onClick={() => spawn(phase.id)}
              >
                <IconPlay /> {busy === phase.id ? 'Opening…' : phase.label}
              </button>
            ))}
          </div>

          {!onceOpen ? (
            <button className="disclose" onClick={() => setOnceOpen(true)}>
              Run once with a different agent…
            </button>
          ) : (
            <div className="stack">
              <AgentPicker
                agents={config.agents}
                value={once}
                onChange={setOnce}
                inheritedAgent={task.pinned.agent}
                inheritAgentLabel="Use pinned agent"
              />
              <p className="hint">Applies to the next phase you launch only. Nothing is saved.</p>
            </div>
          )}

          <p className="hint">
            Opens a Windows Terminal tab and hands the session over. The tab keeps
            running if you close Mission Control.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-label">Mark progress</div>
        <div className="actions">
          {config.pipeline
            .filter((p) => p.gate.type === 'manual' && p.id !== 'merge')
            .map((phase) => {
              const done = task.derived.gates[phase.id];
              return (
                <button
                  key={phase.id}
                  className="btn is-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    run(`mark-${phase.id}`, () =>
                      done
                        ? api.unmarkDone(task.issue, phase.id)
                        : api.markDone(task.issue, phase.id),
                    )
                  }
                >
                  {done ? `Undo ${phase.label}` : `${phase.label} done`}
                </button>
              );
            })}
        </div>
      </section>
    </>
  );
}
```

- [ ] **Step 6: Rewrite `Drawer.tsx` as the shell**

Replace the entire contents of `src/web/components/Drawer.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import type { BoardConfig } from '../api.ts';
import { AgentChip } from './bits.tsx';
import { RunTab } from './drawer/RunTab.tsx';
import { PlanTab } from './drawer/PlanTab.tsx';
import { HistoryTab } from './drawer/HistoryTab.tsx';
import { SetupTab } from './drawer/SetupTab.tsx';
import type { DrawerTab, TabProps } from './drawer/types.ts';
import type { TaskWithDerived } from '../../shared/types.ts';

interface Props {
  task: TaskWithDerived;
  config: BoardConfig;
  onClose: () => void;
  onChanged: () => void;
}

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'run', label: 'Run' },
  { id: 'plan', label: 'Plan' },
  { id: 'history', label: 'History' },
  { id: 'setup', label: 'Setup' },
];

/**
 * Everything about one task, and every action on it.
 *
 * The header is permanent — status must never be a tab away — and the body
 * switches. Tabs reset to Run on every task switch: the drawer's job on open
 * is "launch something", and remembering you were last on History is not a
 * service.
 */
export function Drawer({ task, config, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<DrawerTab>('run');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTab('run');
    setError(null);
    closeRef.current?.focus();
  }, [task.issue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = useCallback<TabProps['run']>(
    async (label, action) => {
      setBusy(label);
      setError(null);
      try {
        await action();
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  const issueUrl = `https://github.com/${config.repo.owner}/${config.repo.name}/issues/${task.issue}`;
  const tabProps: TabProps = { task, config, busy, run, onClose, onChanged };

  return (
    <>
      <button className="scrim" onClick={onClose} aria-label="Close details" />
      <aside className="drawer" role="dialog" aria-label={`Issue ${task.issue}`}>
        <header className="drawer-head">
          <div className="drawer-eyebrow">
            <span>#{task.issue}</span>
            <a className="link" href={issueUrl} target="_blank" rel="noreferrer">
              issue
            </a>
            {task.prUrl && (
              <a className="link" href={task.prUrl} target="_blank" rel="noreferrer">
                PR #{task.prNumber}
              </a>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 7 }}>
              <button
                className="btn is-sm is-ghost"
                disabled={busy !== null}
                onClick={() => run('open-code', () => api.openCode(task.issue))}
              >
                {busy === 'open-code' ? 'Opening…' : '✎ VS Code'}
              </button>
              <button ref={closeRef} className="btn is-sm is-ghost" onClick={onClose}>
                Close
              </button>
            </span>
          </div>
          <h2 className="drawer-title">{task.title}</h2>
          <div className="drawer-branch">{task.branch}</div>
          <div className="badges" style={{ marginTop: 9 }}>
            {task.pinned.agent && (
              <AgentChip
                agent={task.pinned.agent}
                model={task.pinned.model}
                effort={task.pinned.effort}
              />
            )}
            {task.derived.badges.length === 0 && !task.pinned.agent ? (
              <span className="badge">not started</span>
            ) : (
              task.derived.badges.map((b) => (
                <span key={`${b.kind}-${b.label}`} className={`badge tone-${b.tone}`}>
                  {b.label}
                </span>
              ))
            )}
          </div>
          {task.derived.needsYouReason && (
            <p className="card-status status-attention" style={{ marginTop: 10, marginBottom: 0 }}>
              {task.derived.needsYouReason}
            </p>
          )}
        </header>

        <nav className="drawer-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`drawer-tab${tab === t.id ? ' is-on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'history' && task.spawnHistory.length > 0 && (
                <span className="drawer-tab-n">{task.spawnHistory.length}</span>
              )}
            </button>
          ))}
        </nav>

        {error && (
          <div className="section">
            <p className="error">{error}</p>
          </div>
        )}

        <div className="drawer-body">
          {tab === 'run' && <RunTab {...tabProps} />}
          {tab === 'plan' && <PlanTab {...tabProps} />}
          {tab === 'history' && <HistoryTab {...tabProps} />}
          {tab === 'setup' && <SetupTab {...tabProps} />}
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 7: Add the tab styles**

Append to `src/web/styles.css`, after the `.drawer-branch` rule (~line 618):

```css
.drawer-tabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  background: var(--bg);
  border-bottom: 1px solid var(--line-soft);
  position: sticky;
  top: 0;
  z-index: 1;
}

.drawer-tab {
  padding: 9px 14px;
  font-size: 12.5px;
  color: var(--dim);
  border-bottom: 2px solid transparent;
  display: flex;
  align-items: center;
  gap: 6px;
}

.drawer-tab:hover {
  color: var(--ink);
}

.drawer-tab.is-on {
  color: var(--live);
  border-bottom-color: var(--live);
  font-weight: 620;
}

.drawer-tab-n {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--dimmer);
}
```

Change `.drawer-head` so it is no longer `position: sticky` (the tab strip takes over that job) — delete `position: sticky;` and `top: 0;` from it, keeping the rest.

- [ ] **Step 8: Verify by running the app**

Run: `npm run typecheck && npm run dev`

Open http://127.0.0.1:4317 and check, on a task that has a plan and at least one spawn:
- Header shows issue, links, title, branch, agent chip, badges, `✎ VS Code`, `Close`, and never scrolls away.
- Four tabs; opens on **Run**.
- Every section is present in exactly one tab and still works: launch a phase, mark a phase done, edit the plan, save a pin, change placement.
- Selecting a different card resets the tab to Run.
- `✎ VS Code` opens the worktree.

- [ ] **Step 9: Commit**

```bash
git add src/web/components/Drawer.tsx src/web/components/drawer/ src/web/styles.css
git commit -m "$(cat <<'EOF'
refactor: split the drawer into tabs behind a permanent header

Nine sections in one 480px scroll gave Placement, set once a month, the
same weight as Run a phase. The header now carries status permanently so
it is never a tab away, and the body switches between Run, Plan, History
and Setup. Open in VS Code moves up out of the destructive-button
cluster it was sharing a row with.

Behaviour is otherwise unchanged; this is a move.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Drag-resizable drawer width

**Files:**
- Modify: `src/web/components/Drawer.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: the `Drawer` shell from Task 4.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the width state and drag handler to `Drawer.tsx`**

Add these constants above the `Drawer` function:

```tsx
const WIDTH_KEY = 'mc-drawer-width';
const MIN_W = 420;
const DEFAULT_W = 620;

function clampWidth(px: number): number {
  return Math.max(MIN_W, Math.min(px, Math.min(1100, window.innerWidth * 0.9)));
}
```

Add inside the component, next to the other state:

```tsx
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : DEFAULT_W;
  });

  // Drag from the left edge. Listeners live on window so the pointer can leave
  // the 6px handle mid-drag without the resize sticking.
  const startDrag = useCallback((down: React.PointerEvent) => {
    down.preventDefault();
    const move = (e: PointerEvent) => setWidth(clampWidth(window.innerWidth - e.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);
```

Apply the width and render the handle — change the `<aside>` opening tag and add the handle as its first child:

```tsx
      <aside
        className="drawer"
        role="dialog"
        aria-label={`Issue ${task.issue}`}
        style={{ width }}
      >
        <div
          className="drawer-grip"
          onPointerDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
        />
```

- [ ] **Step 2: Add the styles**

In `src/web/styles.css`, change `.drawer`'s width line from `width: min(480px, 100vw);` to `max-width: 100vw;` (the inline style now sets the width), and append:

```css
.drawer-grip {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}

.drawer-grip:hover {
  background: var(--live);
  opacity: 0.5;
}
```

- [ ] **Step 3: Verify by running the app**

Run: `npm run dev`

- Drawer opens at 620px.
- Dragging the left edge resizes it; the cursor becomes `col-resize` over the edge.
- It refuses to go below ~420px or above 90% of the window.
- Reload the page and reopen a card: the width you left it at is restored.
- Releasing the drag outside the window does not leave it stuck in resize mode.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/Drawer.tsx src/web/styles.css
git commit -m "$(cat <<'EOF'
feat: drag-resizable drawer, width remembered

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Phase-first launch flow

Replace the Run tab's spawn UI: choose a phase, then compose. **Two clicks to launch, always** — no Ctrl+click, no per-phase shortcut. A phase button that sometimes launches and sometimes composes is exactly the ambiguity that costs an accidental spawn.

**Files:**
- Create: `src/web/components/drawer/LaunchCompose.tsx`
- Modify: `src/web/components/drawer/RunTab.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `TabProps` from Task 4.
- Produces: `LaunchCompose` with props

  ```ts
  interface LaunchComposeProps {
    task: TaskWithDerived;
    config: BoardConfig;
    phase: PhaseConfig;
    busy: string | null;
    run: TabProps['run'];
    onBack: () => void;
  }
  ```

  Tasks 7, 8 and 9 add to this component; keep the prop shape.

- [ ] **Step 1: Write `LaunchCompose`**

Create `src/web/components/drawer/LaunchCompose.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';

import { api } from '../../api.ts';
import { AgentPicker } from '../AgentPicker.tsx';
import type { AgentSelection } from '../AgentPicker.tsx';
import type { BoardConfig } from '../../api.ts';
import { IconPlay } from '../bits.tsx';
import type { PhaseConfig, TaskWithDerived } from '../../../shared/types.ts';
import type { TabProps } from './types.ts';

const EMPTY: AgentSelection = { agent: '', model: '', effort: '' };

interface LaunchComposeProps {
  task: TaskWithDerived;
  config: BoardConfig;
  phase: PhaseConfig;
  busy: string | null;
  run: TabProps['run'];
  onBack: () => void;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Compose and launch one phase.
 *
 * The box grows with its content to 40% of the drawer, past which Full window
 * is the intended escape rather than an ever-taller drawer.
 */
export function LaunchCompose({
  task,
  config,
  phase,
  busy,
  run,
  onBack,
}: LaunchComposeProps) {
  const [text, setText] = useState('');
  const [onceOpen, setOnceOpen] = useState(false);
  const [once, setOnce] = useState<AgentSelection>(EMPTY);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
  }, [phase.id]);

  // Grow to fit, capped. Reset to auto first or it can only ever get taller.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  function launch() {
    return run(phase.id, () =>
      api.spawn(task.issue, phase.id, {
        customInstructions: text.trim() || undefined,
        agent: onceOpen ? once.agent || undefined : undefined,
        model: onceOpen ? once.model || undefined : undefined,
        effort: onceOpen ? once.effort || undefined : undefined,
      }),
    );
  }

  return (
    <section className="section">
      <div className="compose-head">
        <button className="btn is-sm is-ghost" onClick={onBack} aria-label="Back to phases">
          ←
        </button>
        <span className="compose-crumb">
          Run a phase › <b>{phase.label}</b>
        </span>
        <button className="disclose" style={{ marginLeft: 'auto' }} onClick={() => setOnceOpen((v) => !v)}>
          {onceOpen ? 'use default agent' : 'change agent'}
        </button>
      </div>

      {onceOpen && (
        <div className="stack" style={{ marginBottom: 10 }}>
          <AgentPicker
            agents={config.agents}
            value={once}
            onChange={setOnce}
            inheritedAgent={task.pinned.agent}
            inheritAgentLabel="Use pinned agent"
          />
          <p className="hint">Applies to this launch only. Nothing is saved.</p>
        </div>
      )}

      <textarea
        ref={boxRef}
        className="field compose-box"
        placeholder="Extra instructions for this run (optional)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (busy === null) void launch();
          }
        }}
      />

      <div className="compose-meta">
        <span>{countWords(text)} words</span>
        <span>Ctrl+Enter launches</span>
      </div>

      <div className="compose-actions">
        <div className="compose-tools" />
        <button
          className="btn is-primary is-launch"
          disabled={busy !== null}
          onClick={() => void launch()}
        >
          <IconPlay /> {busy === phase.id ? 'Opening…' : `Launch ${phase.label}`}
        </button>
      </div>

      <p className="hint">
        Opens a Windows Terminal tab and hands the session over. The tab keeps
        running if you close Mission Control.
      </p>
    </section>
  );
}
```

`.compose-tools` is an empty flex slot on purpose — Tasks 7, 8 and 9 each drop a button into it, so their diffs stay additive.

- [ ] **Step 2: Rewrite `RunTab` to switch between the two views**

Replace the run half of `src/web/components/drawer/RunTab.tsx` (keep the Mark progress section exactly as it is):

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { LaunchCompose } from './LaunchCompose.tsx';
import { IconPlay } from '../bits.tsx';
import type { TabProps } from './types.ts';

export function RunTab({ task, config, busy, run, onClose, onChanged }: TabProps) {
  const [armed, setArmed] = useState<string | null>(null);

  // A different task is a different launch; never carry a phase across.
  useEffect(() => setArmed(null), [task.issue]);

  const spawnable = config.pipeline.filter((p) => p.spawnable && p.command);
  const phase = spawnable.find((p) => p.id === armed) ?? null;

  return (
    <>
      {phase ? (
        <LaunchCompose
          task={task}
          config={config}
          phase={phase}
          busy={busy}
          run={run}
          onBack={() => setArmed(null)}
        />
      ) : (
        <section className="section">
          <div className="section-label">Run a phase</div>
          <div className="actions">
            {spawnable.map((p) => (
              <button
                key={p.id}
                className={`btn is-sm${
                  p.id === task.derived.derivedPhase ? ' is-current' : ''
                }`}
                onClick={() => setArmed(p.id)}
              >
                <IconPlay /> {p.label}
              </button>
            ))}
          </div>
          <p className="hint">
            Underlined is where this task sits now — but any phase can be re-run.
          </p>
        </section>
      )}

      <section className="section">
        <div className="section-label">Mark progress</div>
        <div className="actions">
          {config.pipeline
            .filter((p) => p.gate.type === 'manual' && p.id !== 'merge')
            .map((p) => {
              const done = task.derived.gates[p.id];
              return (
                <button
                  key={p.id}
                  className="btn is-sm"
                  disabled={busy !== null}
                  onClick={() =>
                    run(`mark-${p.id}`, () =>
                      done ? api.unmarkDone(task.issue, p.id) : api.markDone(task.issue, p.id),
                    )
                  }
                >
                  {done ? `Undo ${p.label}` : `${p.label} done`}
                </button>
              );
            })}
        </div>
      </section>
    </>
  );
}
```

Note the unused `onClose`/`onChanged` in the signature — remove them from the destructuring if TypeScript flags them; `TabProps` still supplies them.

- [ ] **Step 3: Add the styles**

Append to `src/web/styles.css`:

```css
.btn.is-current {
  border-color: var(--live);
  color: var(--live);
  box-shadow: inset 0 -2px 0 var(--live);
}

.compose-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.compose-crumb {
  font-size: 12px;
  color: var(--dim);
}

.compose-crumb b {
  color: var(--live);
}

.compose-box {
  width: 100%;
  min-height: 38px;
  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
}

.compose-box:focus {
  border-color: var(--attention);
}

.compose-meta {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--dimmer);
  margin-top: 5px;
}

.compose-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.compose-tools {
  display: flex;
  gap: 6px;
  flex: 1;
}

.btn.is-launch {
  font-size: 13px;
  font-weight: 700;
  padding: 8px 16px;
}
```

- [ ] **Step 4: Verify by running the app**

Run: `npm run typecheck && npm run dev`

- Run tab shows only the phase buttons; the one matching the task's derived phase is underlined.
- Clicking a phase opens compose; **nothing spawns**.
- `←` returns to the phase list.
- The box grows as you type past one line and stops growing around 40% of the window height, then scrolls.
- `Launch <Phase>` spawns the terminal, and the instructions you typed appear in the agent's prompt.
- Ctrl+Enter in the box launches.
- Switching to another card and back returns you to the phase list, not compose.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/drawer/ src/web/styles.css
git commit -m "$(cat <<'EOF'
feat: phase-first launch flow with a compose step

The blank textarea above five equal buttons put an optional input ahead
of the action, and gave nowhere to write anything longer than two lines.
Now the phase is chosen first and the section becomes a compose view
whose box grows with the text.

Two clicks to launch, deliberately: a phase button that sometimes
launches and sometimes composes is how you get an accidental spawn.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Prompt preview

The fix for "too vague to trust". Shows the fully-resolved text with the operator's part highlighted, so what the agent already knows is visible and what is worth adding becomes obvious.

**Files:**
- Create: `src/web/components/drawer/PromptPreview.tsx`
- Modify: `src/web/components/drawer/LaunchCompose.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `api.previewPrompt` from Task 2, `LaunchCompose` from Task 6.
- Produces: `PromptPreview` component, props `{ issue, phase, phaseLabel, instructions, onClose }`.

- [ ] **Step 1: Write the component**

Create `src/web/components/drawer/PromptPreview.tsx`:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import type { PromptPreview as Preview } from '../../api.ts';
import type { Phase } from '../../../shared/types.ts';

interface Props {
  issue: number;
  phase: Phase;
  phaseLabel: string;
  instructions: string;
  onClose: () => void;
}

/**
 * The real text the agent will receive.
 *
 * The operator's instructions are located inside the resolved prompt and
 * highlighted in place — seeing *where* they land is the whole point, and is
 * what makes it obvious which parts of the prompt need no repeating.
 */
export function PromptPreview({ issue, phase, phaseLabel, instructions, onClose }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    api
      .previewPrompt(issue, phase, instructions || undefined)
      .then((p) => live && setPreview(p))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [issue, phase, instructions]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const typed = instructions.trim();
  // Locate the operator's block so it can be highlighted where it lands.
  const at = typed && preview ? preview.text.indexOf(typed) : -1;

  return (
    <div className="plan-editor-scrim" role="dialog" aria-label={`Prompt for ${phaseLabel}`}>
      <div className="plan-editor">
        <header className="plan-editor-head">
          <strong>
            Prompt · {phaseLabel} · #{issue}
          </strong>
          {preview && (
            <span className="badge" style={{ marginLeft: 8 }}>
              {preview.command} · {preview.words} words
            </span>
          )}
          <span style={{ marginLeft: 'auto' }}>
            <button className="btn is-sm is-ghost" onClick={onClose}>
              ← Back to editing
            </button>
          </span>
        </header>
        <div className="plan-editor-body">
          {error ? (
            <p className="error" style={{ margin: 16 }}>
              {error}
            </p>
          ) : !preview ? (
            <p className="note" style={{ margin: 16 }}>
              Rendering…
            </p>
          ) : (
            <pre className="prompt-preview">
              {at >= 0 ? (
                <>
                  {preview.text.slice(0, at)}
                  <mark className="prompt-mine">{preview.text.slice(at, at + typed.length)}</mark>
                  {preview.text.slice(at + typed.length)}
                </>
              ) : (
                preview.text
              )}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the button into `LaunchCompose`**

In `src/web/components/drawer/LaunchCompose.tsx`, add the import:

```tsx
import { PromptPreview } from './PromptPreview.tsx';
```

Add the state next to the others:

```tsx
  const [previewing, setPreviewing] = useState(false);
```

Put the button in the `.compose-tools` slot — replace `<div className="compose-tools" />` with:

```tsx
        <div className="compose-tools">
          <button className="btn is-sm" onClick={() => setPreviewing(true)}>
            👁 Preview prompt
          </button>
        </div>
```

And render it at the end, just before the closing `</section>`:

```tsx
      {previewing && (
        <PromptPreview
          issue={task.issue}
          phase={phase.id}
          phaseLabel={phase.label}
          instructions={text}
          onClose={() => setPreviewing(false)}
        />
      )}
```

- [ ] **Step 3: Add the styles**

Append to `src/web/styles.css`:

```css
.prompt-preview {
  margin: 0;
  padding: 16px 18px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.65;
  color: var(--dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt-mine {
  background: rgba(242, 161, 60, 0.16);
  border-left: 2px solid var(--attention);
  color: var(--attention);
  padding: 2px 6px;
  border-radius: 3px;
}
```

- [ ] **Step 4: Verify by running the app**

Run: `npm run dev`

- In compose, `👁 Preview prompt` opens the real rendered prompt for the armed phase.
- The header shows the source command (`mc-implementer`) and a word count.
- With text typed, it appears highlighted in orange **inside** the prompt, at the position `{{customInstructions}}` occupies.
- Arming a different phase and previewing shows that phase's command instead.
- Escape and `← Back to editing` both return with the typed text intact.
- Previewing does not spawn anything.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/drawer/PromptPreview.tsx src/web/components/drawer/LaunchCompose.tsx src/web/styles.css
git commit -m "$(cat <<'EOF'
feat: preview the resolved prompt before launching

The instructions box went unused because its relationship to the rest of
the prompt was invisible — you could not tell what the agent had already
been told, so you could not tell what was worth adding. Showing the whole
resolved text with your part highlighted in place makes the box's purpose
self-evident.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full-window editor

**Files:**
- Modify: `src/web/components/drawer/LaunchCompose.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `LaunchCompose` from Task 6, `PromptPreview` from Task 7.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the full-window state and overlay to `LaunchCompose`**

Add the state:

```tsx
  const [full, setFull] = useState(false);
```

Add the button into `.compose-tools`, before the preview button:

```tsx
          <button className="btn is-sm" onClick={() => setFull(true)}>
            ⛶ Full window
          </button>
```

Render the overlay at the end of the component, next to the preview:

```tsx
      {full && (
        <div className="plan-editor-scrim" role="dialog" aria-label="Instructions">
          <div className="plan-editor">
            <header className="plan-editor-head">
              <strong>
                Instructions · {phase.label} · #{task.issue}
              </strong>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn is-sm" onClick={() => setPreviewing(true)}>
                  👁 Preview
                </button>
                <button
                  className="btn is-sm is-primary"
                  disabled={busy !== null}
                  onClick={() => void launch()}
                >
                  ▶ Launch
                </button>
                <button className="btn is-sm is-ghost" onClick={() => setFull(false)}>
                  Close
                </button>
              </span>
            </header>
            <div className="plan-editor-body">
              <textarea
                className="plan-editor-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (busy === null) void launch();
                  }
                }}
                autoFocus
              />
            </div>
          </div>
        </div>
      )}
```

**Note:** unlike `PlanEditor` there is no dirty-state confirm on close — the text is not persisted anywhere and closing returns to the compose box with it intact, so there is nothing to lose.

- [ ] **Step 2: Handle Escape without stealing it from the preview**

The full-window overlay must close on Escape, but when the preview is stacked on top of it, Escape should close the preview first. Add this effect to `LaunchCompose`:

```tsx
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      // The preview owns Escape while it is up.
      if (e.key === 'Escape' && !previewing) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, previewing]);
```

The drawer's own Escape handler (`Drawer.tsx`) also fires and would close the whole drawer. Guard it — in `Drawer.tsx`, change its key handler to ignore Escape while any overlay is open:

```tsx
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An overlay (plan editor, prompt preview, full-window compose) owns
      // Escape while it is up.
      if (document.querySelector('.plan-editor-scrim')) return;
      onClose();
    };
```

- [ ] **Step 3: Verify by running the app**

Run: `npm run dev`

- `⛶ Full window` opens a full-screen editor pre-filled with what you had typed.
- Typing there and closing returns the text to the inline box.
- `👁 Preview` from inside full window works, and Escape closes **only** the preview, leaving the editor open.
- Escape from the editor closes it and leaves the drawer open.
- Escape with nothing open still closes the drawer.
- `▶ Launch` from the editor header spawns.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/drawer/LaunchCompose.tsx src/web/components/Drawer.tsx src/web/styles.css
git commit -m "$(cat <<'EOF'
feat: full-window editor for longer run instructions

Escape now unwinds one layer at a time instead of closing the drawer out
from under an open editor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: The 📌 keep-instructions toggle

Reaches `overrides.instructions`, which `spawn.ts` has always fallen back to and no UI has ever been able to set.

**Files:**
- Modify: `src/web/components/drawer/LaunchCompose.tsx`
- Modify: `src/web/components/Drawer.tsx` (header indicator)
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `api.overrides` with `null`-to-clear from Task 3, `LaunchCompose` from Task 6.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Prefill from the saved value and track the pin**

In `LaunchCompose`, change the text state to seed from the task and add the pin state:

```tsx
  const [text, setText] = useState(task.overrides?.instructions ?? '');
  const [kept, setKept] = useState(Boolean(task.overrides?.instructions));
```

Re-seed when the task changes:

```tsx
  useEffect(() => {
    setText(task.overrides?.instructions ?? '');
    setKept(Boolean(task.overrides?.instructions));
  }, [task.issue, task.overrides?.instructions]);
```

- [ ] **Step 2: Add the toggle and its persistence**

Add this handler inside the component:

```tsx
  /** Persist (or clear) the task-level instructions. */
  function persist(value: string | null) {
    return run('keep', () => api.overrides(task.issue, { instructions: value }));
  }

  function toggleKeep() {
    const next = !kept;
    setKept(next);
    void persist(next ? text.trim() || null : null);
  }
```

Add the button into `.compose-tools`, after the preview button:

```tsx
          <button
            className={`btn is-sm${kept ? ' is-on' : ''}`}
            onClick={toggleKeep}
            aria-pressed={kept}
            title="Keep for every run of this task"
          >
            📌 {kept ? 'Kept' : 'Keep'}
          </button>
```

- [ ] **Step 3: Save edits while pinned, on launch and on leaving compose**

Change `launch()` so it persists first when the pin is lit:

```tsx
  async function launch() {
    if (kept) await persist(text.trim() || null);
    return run(phase.id, () =>
      api.spawn(task.issue, phase.id, {
        customInstructions: text.trim() || undefined,
        agent: onceOpen ? once.agent || undefined : undefined,
        model: onceOpen ? once.model || undefined : undefined,
        effort: onceOpen ? once.effort || undefined : undefined,
      }),
    );
  }
```

And flush on unmount, so backing out of compose does not lose a kept edit. Use a ref so the cleanup reads current values rather than the ones captured at mount:

```tsx
  const latest = useRef({ kept, text, issue: task.issue });
  latest.current = { kept, text, issue: task.issue };

  useEffect(() => {
    return () => {
      const { kept: k, text: t, issue } = latest.current;
      if (!k) return;
      const value = t.trim() || null;
      // Fire-and-forget: the component is going away and the board refreshes
      // on its own poll regardless.
      void api.overrides(issue, { instructions: value });
    };
  }, []);
```

- [ ] **Step 4: Show the state in the drawer header**

In `src/web/components/Drawer.tsx`, add a pin badge next to the agent chip in the header badges block:

```tsx
            {task.overrides?.instructions && (
              <span className="badge" title="This task has kept instructions">
                📌 kept
              </span>
            )}
```

Place it immediately after the `{task.pinned.agent && (<AgentChip … />)}` block.

- [ ] **Step 5: No new style needed — confirm the existing one**

`.btn.is-on` already exists at `src/web/styles.css:218` and renders orange
(`--attention`). **Add nothing.** Orange is the right colour here: it is the
same one the preview uses to highlight the operator's text, so a lit pin and
the highlighted block in the prompt read as the same thing.

Verify it is unchanged:

```bash
sed -n '218,223p' src/web/styles.css
```

Expected: a rule setting `background: rgba(242, 161, 60, 0.14)`, `border-color: var(--attention)`, `color: var(--attention)`.

- [ ] **Step 6: Verify by running the app**

Run: `npm run dev`

- Compose on a fresh task: box is empty, pin reads `📌 Keep`.
- Type text, click the pin → it lights and reads `Kept`; the header gains a `📌 kept` badge.
- Back out to the phase list, re-enter compose → the box is **prefilled** with the kept text and the pin is lit.
- Preview now shows the kept text highlighted even though you did not retype it.
- Arm a *different* phase and preview → the kept text is in that phase's prompt too (scope is the task, not the phase).
- Click the pin again → it clears; the header badge disappears; the text stays in the box for this launch only.
- Go to **Setup**, change the agent pin and Save → return to Run: **the kept instructions are still there.** This is the Task 3 regression; if the text vanished, `mergeOverrides` is not wired up.
- Close and reopen the app: kept text survives.

- [ ] **Step 7: Commit**

```bash
git add src/web/components/drawer/LaunchCompose.tsx src/web/components/Drawer.tsx src/web/styles.css
git commit -m "$(cat <<'EOF'
feat: pin to keep run instructions for every run of a task

Reaches overrides.instructions, which spawn.ts has always fallen back to
and no UI could ever set. Instructions stay one-off by default; the pin
opts into keeping them.

Compose prefills from the kept value and the header shows a badge, so
kept text is never an invisible rider on prompts you did not write it
for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Board model — lane widths and rail membership

Pure functions first, so the board maths is tested before any component consumes it.

**Files:**
- Create: `src/web/board-model.ts`
- Create: `test/board-model.test.ts`

**Interfaces:**
- Produces: `laneLayout(counts) → LaneLayout[]` and `attentionTasks(tasks) → TaskWithDerived[]`. Tasks 11 and 12 consume both.

- [ ] **Step 1: Write the failing test**

Create `test/board-model.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { attentionTasks, laneLayout } from '../src/web/board-model.ts';
import type { DerivedState, Phase, TaskWithDerived } from '../src/shared/types.ts';

function task(issue: number, needsYou: boolean): TaskWithDerived {
  return {
    issue,
    title: `task ${issue}`,
    derived: { needsYou, needsYouReason: needsYou ? 'changes requested' : null } as DerivedState,
  } as TaskWithDerived;
}

describe('laneLayout', () => {
  test('an empty lane collapses and takes no share of the width', () => {
    const [inbox, plan] = laneLayout([
      { id: 'inbox' as Phase, count: 0 },
      { id: 'plan' as Phase, count: 2 },
    ]);
    expect(inbox?.collapsed).toBe(true);
    expect(inbox?.grow).toBe(0);
    expect(plan?.collapsed).toBe(false);
    expect(plan?.grow).toBeGreaterThan(0);
  });

  test('a busier lane gets a larger share', () => {
    const [one, four] = laneLayout([
      { id: 'plan' as Phase, count: 1 },
      { id: 'implement' as Phase, count: 4 },
    ]);
    expect(four!.grow).toBeGreaterThan(one!.grow);
  });

  test('the weighting saturates so one lane cannot starve the others', () => {
    const [four, twenty] = laneLayout([
      { id: 'plan' as Phase, count: 4 },
      { id: 'implement' as Phase, count: 20 },
    ]);
    expect(twenty!.grow).toBe(four!.grow);
  });

  test('a four-card lane gets roughly twice a one-card lane', () => {
    const [one, four] = laneLayout([
      { id: 'plan' as Phase, count: 1 },
      { id: 'implement' as Phase, count: 4 },
    ]);
    expect(four!.grow / one!.grow).toBeCloseTo(1.69, 2);
  });

  test('order is preserved exactly', () => {
    const layout = laneLayout([
      { id: 'inbox' as Phase, count: 0 },
      { id: 'plan' as Phase, count: 3 },
      { id: 'done' as Phase, count: 0 },
    ]);
    expect(layout.map((l) => l.id)).toEqual(['inbox', 'plan', 'done']);
  });

  test('an all-empty board leaves every lane collapsed', () => {
    const layout = laneLayout([
      { id: 'inbox' as Phase, count: 0 },
      { id: 'plan' as Phase, count: 0 },
    ]);
    expect(layout.every((l) => l.collapsed)).toBe(true);
  });
});

describe('attentionTasks', () => {
  test('keeps only the tasks that need you, in board order', () => {
    const result = attentionTasks([task(1, false), task(2, true), task(3, true)]);
    expect(result.map((t) => t.issue)).toEqual([2, 3]);
  });

  test('is empty when nothing needs you — the rail vanishes', () => {
    expect(attentionTasks([task(1, false)])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/board-model.test.ts`
Expected: FAIL — cannot resolve `../src/web/board-model.ts`.

- [ ] **Step 3: Write the module**

Create `src/web/board-model.ts`:

```ts
import type { Phase, TaskWithDerived } from '../shared/types.ts';

export interface LaneCount {
  id: Phase;
  count: number;
}

export interface LaneLayout {
  id: Phase;
  count: number;
  collapsed: boolean;
  /** flex-grow. 0 for a collapsed lane, which takes a fixed rail width. */
  grow: number;
}

/** Past this many cards, extra ones stop buying width. */
const SATURATION = 4;

/**
 * Lanes sized to their contents.
 *
 * Nine equal lanes meant a lane holding four cards truncated its titles while
 * an empty one held open a ninth of the screen. Empty lanes collapse to a
 * rail; the rest divide what is left, weighted by how full they are. The
 * weighting saturates so one busy lane can never starve its neighbours.
 */
export function laneLayout(counts: LaneCount[]): LaneLayout[] {
  return counts.map(({ id, count }) => ({
    id,
    count,
    collapsed: count === 0,
    grow: count === 0 ? 0 : 1 + Math.min(count, SATURATION) * 0.3,
  }));
}

/** The tasks the rail shows. Board order is kept — it is a filter, not a sort. */
export function attentionTasks(tasks: TaskWithDerived[]): TaskWithDerived[] {
  return tasks.filter((t) => t.derived.needsYou);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/board-model.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/web/board-model.ts test/board-model.test.ts
git commit -m "$(cat <<'EOF'
feat: pure board model for lane widths and rail membership

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Attention rail + lane collapsing + card density

**Files:**
- Create: `src/web/components/AttentionRail.tsx`
- Modify: `src/web/components/Board.tsx`, `src/web/components/Lane.tsx`, `src/web/App.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `laneLayout`, `attentionTasks` from Task 10.
- Produces: `AttentionRail` with props `{ tasks, config, selectedIssue, onOpen }`.

- [ ] **Step 1: Write the rail**

Create `src/web/components/AttentionRail.tsx`:

```tsx
import { attentionTasks } from '../board-model.ts';
import type { BoardConfig } from '../api.ts';
import { IconAlert } from './bits.tsx';
import type { TaskWithDerived } from '../../shared/types.ts';

interface Props {
  tasks: TaskWithDerived[];
  config: BoardConfig;
  selectedIssue: number | null;
  onOpen: (issue: number) => void;
}

/**
 * What needs you, above everything else.
 *
 * The rail's emptiness is the signal: from across the room, no orange means
 * nothing is waiting. That is the whole reason it is permanent rather than a
 * filter you have to remember to click.
 */
export function AttentionRail({ tasks, config, selectedIssue, onOpen }: Props) {
  const needing = attentionTasks(tasks);
  if (needing.length === 0) return null;

  const label = (id: string) =>
    config.pipeline.find((p) => p.id === id)?.label ?? id;

  return (
    <section className="rail" aria-label={`${needing.length} tasks need you`}>
      <div className="rail-head">Needs you — {needing.length}</div>
      <div className="rail-row">
        {needing.map((task) => (
          <button
            key={task.issue}
            type="button"
            className={`rail-card${task.issue === selectedIssue ? ' is-selected' : ''}`}
            onClick={() => onOpen(task.issue)}
            aria-label={`Issue ${task.issue}, ${task.title}. ${task.derived.needsYouReason ?? ''}`}
          >
            <div className="rail-top">
              <span className="card-issue">#{task.issue}</span>
              <span className="badge">{label(task.derived.displayPhase)}</span>
            </div>
            <div className="card-title">{task.title}</div>
            <div className="card-status status-attention">
              <IconAlert /> {task.derived.needsYouReason}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Apply lane widths in `Board.tsx`**

In `src/web/components/Board.tsx`, add the import and compute the layout, passing `grow`/`collapsed` down:

```tsx
import { laneLayout } from '../board-model.ts';
```

Replace the `return` block:

```tsx
  const layout = laneLayout(
    lanes.map((phase) => ({ id: phase.id, count: (byPhase.get(phase.id) ?? []).length })),
  );

  return (
    <div className="board">
      {lanes.map((phase, i) => (
        <Lane
          key={phase.id}
          phase={phase}
          tasks={byPhase.get(phase.id) ?? []}
          config={config}
          collapsed={layout[i]!.collapsed}
          grow={layout[i]!.grow}
          selectedIssue={selectedIssue}
          onOpen={onOpen}
          onEditDefault={onEditDefault}
        />
      ))}
    </div>
  );
```

- [ ] **Step 3: Render the collapsed lane in `Lane.tsx`**

Add `collapsed: boolean;` and `grow: number;` to `Props`, then at the top of the component body:

```tsx
  if (collapsed) {
    return (
      <section className="lane is-collapsed" aria-label={`${phase.label}, empty`}>
        <button
          className="lane-rail"
          onClick={() => isAgentPhase && onEditDefault(phase.id)}
          title={
            isAgentPhase ? 'Set the default agent and model for this phase' : phase.label
          }
        >
          {phase.label}
        </button>
      </section>
    );
  }
```

and apply the grow to the open lane's root element:

```tsx
    <section
      className={`lane${needsAttention ? ' has-attention' : ''}`}
      style={{ flexGrow: grow }}
    >
```

- [ ] **Step 4: Mount the rail in `App.tsx`**

Add the import:

```tsx
import { AttentionRail } from './components/AttentionRail.tsx';
```

Render it immediately above `<Board … />`:

```tsx
      <AttentionRail
        tasks={visible}
        config={config}
        selectedIssue={selected}
        onOpen={setSelected}
      />
```

- [ ] **Step 5: Add the styles**

In `src/web/styles.css`, change `.lane`'s `flex: 1 1 0;` to `flex: 1 1 0; min-width: 0;` (grow is now set inline) and append:

```css
.lane.is-collapsed {
  flex: 0 0 24px;
  min-width: 24px;
}

.lane-rail {
  width: 100%;
  height: 100%;
  background: var(--lane-head);
  color: var(--dimmer);
  font-size: 11px;
  writing-mode: vertical-rl;
  text-orientation: mixed;
  padding: 10px 0;
  white-space: nowrap;
  overflow: hidden;
}

.lane-rail:hover {
  color: var(--dim);
}

.rail {
  padding: 10px 14px;
  background: linear-gradient(90deg, rgba(242, 161, 60, 0.09), transparent);
  border-bottom: 1px solid var(--line-soft);
  flex-shrink: 0;
}

.rail-head {
  font-size: 10.5px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--attention);
  font-weight: 700;
  margin-bottom: 8px;
}

.rail-row {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.rail-card {
  flex: 1 1 240px;
  min-width: 220px;
  max-width: 420px;
  text-align: left;
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid var(--attention);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.rail-card:hover {
  background: var(--card-hi);
}

.rail-card.is-selected {
  border-color: var(--live);
  border-left-color: var(--attention);
}

.rail-top {
  display: flex;
  align-items: center;
  gap: 7px;
}

```

Then make the cards denser by **editing the existing `.card` rule in place** at `src/web/styles.css:370` — do not append a second one. Change only its padding line:

```css
  padding: 11px 12px 12px;   /* before */
  padding: 8px 10px 9px;     /* after  */
```

`.card` is `display: block`, so do not add a `gap` — it would have no effect. The spacing between a card's rows comes from the margins on `.card-title` and `.card-status`; leave those alone.

- [ ] **Step 6: Verify by running the app**

Run: `npm run typecheck && npm test && npm run dev`

- The rail appears above the lanes listing exactly the cards whose status line is orange/red, with their phase as a chip.
- With nothing needing attention, the rail is **absent** — no empty bar.
- Clicking a rail card opens that task's drawer.
- Empty lanes are ~24px vertical strips with rotated labels; clicking an agent-phase strip still opens its phase default.
- Non-empty lanes are visibly wider than before, and the busiest is widest.
- Lane order is unchanged, left to right.

- [ ] **Step 7: Commit**

```bash
git add src/web/components/AttentionRail.tsx src/web/components/Board.tsx src/web/components/Lane.tsx src/web/App.tsx src/web/styles.css
git commit -m "$(cat <<'EOF'
feat: needs-you rail above lanes that size to their contents

Nine equal lanes meant the busy ones truncated titles while empty ones
held open a ninth of the screen, and "what needs me" was behind a filter
button. The rail is permanent and its emptiness is the signal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Topbar tidy

**Files:**
- Modify: `src/web/App.tsx:151-204`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: the rail from Task 11 (which supersedes the Needs-you toggle).
- Produces: nothing.

- [ ] **Step 1: Remove the Needs-you toggle and the Refresh button**

In `src/web/App.tsx`, delete the `Needs you` button and the `Refresh` button from `.topbar-actions`. Also delete the now-unused `onlyNeedsYou` state, its `setOnlyNeedsYou`, and the `needsYouCount` memo, and change

```tsx
  const visible = onlyNeedsYou ? tasks.filter((t) => t.derived.needsYou) : tasks;
```

to

```tsx
  const visible = tasks;
```

(Keep `visible` rather than inlining `tasks` — Board and the rail both read it, and it stays the seam if filtering ever returns.)

- [ ] **Step 2: Make the freshness readout the refresh control**

Replace the `poll-status` span with a button:

```tsx
          {pollMeta && (
            <button
              className="poll-status"
              onClick={refresh}
              title="Click to re-check GitHub now"
            >
              <span className="poll-checked">checked {ago(pollMeta.checkedAt, now)}</span>
              {pollMeta.rateLimit && (
                <span
                  className={`poll-budget${
                    pollMeta.rateLimit.remaining < 500 ? ' is-low' : ''
                  }`}
                  title={`GitHub GraphQL API: ${pollMeta.rateLimit.remaining} of ${pollMeta.rateLimit.limit} calls left this hour`}
                >
                  {pollMeta.rateLimit.remaining.toLocaleString()} API
                </span>
              )}
            </button>
          )}
```

- [ ] **Step 3: Group the remaining controls**

Wrap the status cluster so the primary action reads primary. The action order becomes: `+ New from issue` (primary), `Agents`, bell — then a spacer, then the status cluster (`checked …`, lamp). Add to `src/web/styles.css`:

```css
.poll-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 7px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.poll-status:hover {
  background: rgba(255, 255, 255, 0.04);
}

.topbar-actions .btn:not(.is-primary):not(.is-icon) {
  color: var(--dim);
}
```

- [ ] **Step 4: Verify by running the app**

Run: `npm run typecheck && npm run dev`

- No `Needs you` button; the rail carries that job.
- No `Refresh` button; clicking `checked Ns ago` re-checks and the counter resets to `0s ago`.
- `+ New from issue` is the only visually primary control.
- The live/offline lamp and API budget still read correctly.

- [ ] **Step 5: Run the full suite one last time**

Run: `npm test && npm run typecheck && npm run build`
Expected: all tests PASS, no type errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/web/App.tsx src/web/styles.css
git commit -m "$(cat <<'EOF'
refactor: tidy the topbar now the rail carries needs-you

Drops the Needs-you toggle the rail supersedes and folds Refresh into the
freshness readout, which already meant "how current is this".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 Step 1, choose the phase | 6 |
| §1 Step 2, compose | 6 |
| §1 Two clicks, no shortcut | 6 (explicit) |
| §1 Keeping instructions, 📌 | 9 |
| §1 Full window | 8 |
| §1 Preview prompt | 7 |
| §1 Backend 1, preview endpoint | 2 |
| §1 Backend 2, overrides merge | 3 |
| §1 Shared resolution helper | 1 |
| §2 Attention rail | 10, 11 |
| §2 Lane sizing | 10, 11 |
| §2 Card density | 11 |
| §3 Permanent header + VS Code promotion | 4 |
| §3 Tabs, reset to Run | 4 |
| §3 Width, resizable + persisted | 5 |
| §4 Topbar | 12 |
| §5 Component structure | 4, 6, 7, 11 |
| Testing: prompt resolution | 1 |
| Testing: lane widths | 10 |
| Testing: rail membership | 10 |
| Testing: overrides merge | 3 |

No gaps.

**Placeholder scan:** No TBD/TODO, no "add error handling", no "similar to Task N", no "write tests for the above". Every code step carries the actual code.

**Type consistency:** `resolveSpawnPlan` is defined in Task 1 and called with the same 5-argument signature in Tasks 1 and 2. `TabProps` is defined in Task 4 and used unchanged in 4, 6 and 9. `LaunchComposeProps` is defined in Task 6 and extended without shape changes in 7, 8 and 9. `laneLayout`/`attentionTasks` are defined in Task 10 and consumed in 11 with matching field names (`collapsed`, `grow`, `id`, `count`). `PromptPreview` the API type is aliased to `Preview` inside the component of the same name to avoid the collision.

**One deviation worth flagging:** the spec's §5 lists `RunTab`, `LaunchCompose`, `PromptPreview`, `PlanTab`, `HistoryTab`, `SetupTab`. The plan adds `drawer/types.ts` for the shared `TabProps`, which the spec did not name. It is four lines of interface and prevents the same props being redeclared in four files.
