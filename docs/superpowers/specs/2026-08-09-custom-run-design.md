# Custom Run — Validated Design

## Problem

Every way to put an agent to work on an issue goes through a *phase*: Plan,
Implement, Publish, the two review fixers. Each is a `config.pipeline` entry
naming a hand-written command file in `~/.claude/commands/`, and each is also a
lane on the board and a row in the reconciler's gate table.

That coupling is the problem. There is real work that belongs to an issue but is
not a pipeline step — research before planning, writing a spec, a one-off
investigation, whatever comes up next month. Today the only ways to do it are to
overload the Implement box with instructions that do not describe implementing,
or to add a pipeline phase: a config edit, a new command file, a new board lane,
a new gate, forever, for something done occasionally.

The immediate motivation is research and spec, two steps taken only sometimes.
Hardcoding them as phases would be wrong for exactly the reason above. What is
needed is one free-form launch that still knows which issue it serves and still
produces artifacts the board can read.

## Goals

- Launch an agent on a task with a prompt written in full at launch time.
- The agent still knows its issue, branch and worktree, and still knows where to
  write output so Mission Control collects it.
- Output chains: a research run's documents are visible to a later spec run, and
  to Plan.
- No new lane, no new gate, no change to `reconcile.ts`.

## Non-goals

- **No saved presets.** Runs are ad-hoc; the prompt is typed each time. A named
  preset store, and the UI to manage it, is not built.
- **No board-level scratch run.** A custom run always belongs to a task, so it
  always has an issue, a worktree and a task directory.
- **No artifact cleanup UI.** See §5 — the manifest now only grows, and that is
  accepted.
- **No `custom` entry in `config.yaml`.** Nothing about this is configurable
  beyond the command file's text.
- **`plan.md` is not folded into the manifest.** It keeps its own path, its own
  `planMdExists` fact, its own `DocId` kind and its own doc-rail row. Unifying it
  was considered and declined; see §5a.

## Decisions taken

| Decision | Choice |
|---|---|
| Reuse | Ad-hoc only, no presets |
| Artifact storage | One shared `artifacts.json`, no separate lane |
| Issue context | Always on a card; a checkbox toggles the MC preamble |
| Working directory | The task worktree, created if missing, as every phase does |
| Plan-spawn artifact reset | Removed — artifacts persist across runs |
| Cleanup affordance | None; deletion is by hand on disk only |
| `plan.md` | Stays a separate concept, not folded into the manifest |

The working-directory choice has one visible consequence, accepted knowingly:
`reconcile.ts:85` moves a card to **Plan** as soon as a worktree or branch
exists, so a research run launched on an Inbox card moves that card to Plan.

## Architecture

### 1. A custom run is not a phase

Every `config.pipeline` entry becomes a board lane (`Board.tsx:24`), a gate in
`computeGates`, and — when its gate is manual — a button in Run tab's *Mark
progress* list. A custom run wants none of those.

So it is a **synthetic `PhaseConfig`, built in memory at launch and never added
to `config.pipeline`**:

```ts
export const CUSTOM_RUN_ID = 'custom';

function customPhase(config: Config): PhaseConfig {
  return {
    id: CUSTOM_RUN_ID,
    label: 'Custom run',
    actor:
      config.pipeline.find((p) => p.id === 'plan')?.actor ??
      Object.keys(config.agents)[0] ??
      'claude',
    command: 'mc-custom',
    spawnable: true,
    repeatable: true,
    gate: { type: 'manual' },
    t3: { runtimeMode: 'approval-required', interactionMode: 'default' },
  };
}
```

Passed straight to the existing `spawnPhase`, this inherits the whole launch
path unchanged: worktree creation, `spawn.json`, the rendered prompt file, the
`custom.running` marker, and all three launchers including T3. `readLiveSpawn`
(`markers.ts:78`) matches any `*.running` file, so the card gets its **live**
badge with no new code.

T3 modes are pinned to the safe floor rather than inherited from Plan. A
free-form prompt is precisely where `auto-accept-edits` should not apply.

The actor defaults to Plan's so there is always an agent to resolve —
`resolveAgentValues` finds the actor by looking the phase id up in the pipeline
(`agent-selection.ts:34`), which a synthetic phase is absent from, so it must be
supplied. Per-launch override through the existing *change agent* disclosure
still works, since that path passes `oneTime.agent` and outranks everything.

### 2. Type widening

`PHASES` is untouched — `custom` is deliberately not a `Phase`. Two fields carry
a run identifier rather than a pipeline position, and are widened to say so:

```ts
export type RunKind = Phase | 'custom';
```

applied to `SpawnRecord.phase` and `LiveSpawn.phase`. `readLiveSpawn` already
casts the marker's stem, so this makes an existing cast honest rather than
introducing one. `PhaseDefaults` is `Record<string, …>` and needs no change.

### 3. The prompt, and the context toggle

A new `assets/claude/commands/mc-custom.md`, installed by `install.ps1`
alongside the other `mc-*` files. Its body is the Mission Control preamble
followed by the operator's text:

```
You are working on GitHub issue #{{issue}} ("{{title}}") on branch {{branch}}.
Read the issue with `gh issue view {{issue}}` before you start.

Write any document you produce into this directory:

    {{taskDir}}

That path is outside the repository, which keeps the checkout clean. Mission
Control collects files that appear there and shows them in the task's doc rail.

Existing research, specs and notes already collected for this issue:

{{artifacts}}

Your task:

{{customInstructions}}
```

Keeping the preamble in a command file, not in code, matches how every other
phase works: the wording is tuned by hand in `~/.claude/commands/` without a
code change or a restart.

The **Include issue context** checkbox (default on) selects the path:

- **on** — `buildPrompt('mc-custom', task, …)`, exactly as a phase does.
- **off** — the operator's raw text verbatim, with standing rules still applied
  (via `--append-system-prompt` for `claude`, prepended inline for `copilot` and
  `codex`, per `profile.instructionMode`).

`resolveSpawnPlan` gains one option to express this:

```ts
export interface SpawnPlanOptions {
  // …existing
  /** Bypass the command file; the prompt body is the operator's text alone. */
  rawPrompt?: string;
}
```

When set, the `if (!phase.command)` guard is skipped and `promptText` is the raw
text plus any inline instructions. Preview and launch keep sharing one resolver,
which is the invariant that file exists to protect.

### 4. `{{artifacts}}` — how runs chain

This is what turns two independent custom runs into research → spec → plan.

`buildPrompt` gains an `artifacts` variable: the collected manifest rendered as
one line per document,

```
- 2026-08-09-auth-research.md — C:\Users\ouriel\.mc\tasks\3060\artifacts\2026-08-09-auth-research.md
```

or the literal `(none)` when the manifest is empty, so the prompt never reads as
a dangling heading.

The list is passed in through `PromptOptions` from `resolveSpawnPlan` rather
than read from disk inside `buildPrompt`, keeping `prompt.ts` free of filesystem
access and `prompt.test.ts` free of fixtures.

Because it is an ordinary template variable it is available to **every** command
file. `mc-planner.md` gains:

```
Existing research, specs and notes already collected for this issue:

{{artifacts}}

Read them before planning. Do not redo work they already cover.
```

### 5. Artifacts persist

Stated plainly first, because it is the property everything below serves.

**One store, one index.** Every document any run produces is copied to
`tasks/<issue>/artifacts/` and listed in `tasks/<issue>/artifacts.json`. There
is no per-phase or per-kind partition: a plan run and a custom run write to the
same two places, and the doc rail reads that one list.

Originals stay where the agent wrote them, recorded in `originalPath`. That is
deliberate rather than a gap — a design doc the agent put in
`docs/superpowers/specs/` is often one that should be committed to the repo, so
the collected copy is an index into the work, not a relocation of it.
`resolveWriteTarget` (`documents.ts:51`) reads the original while it exists and
the stored copy once it does not.

**Nothing is ever deleted automatically.** After this change no code path
removes an artifact entry or a stored copy. Two files are still cleared when a
plan run starts — the `plan.done` marker and the run's snapshot — and neither is
an artifact; they are phase lifecycle and collection bookkeeping. Re-collecting
a path overwrites its stored copy in place, and editing in the workbench
overwrites too, but no entry disappears. Removing one means deleting the file by
hand under `%USERPROFILE%\.mc\tasks\<issue>\`.

This is a guarantee about *artifacts*, not about all content: re-running Plan
still overwrites `tasks/<issue>/plan.md`, because the agent is told to write to
that exact path. The previous plan's text is lost. That is existing plan-phase
behaviour and this design does not change it.

#### 5a. Why `plan.md` stays outside the manifest

Folding it in was considered. It would collapse `DocId` to a single kind and
make the doc rail uniform, and it could be done without touching `reconcile.ts`,
since `planMdExists` would go on reading the same path. It was declined: the
plan is the one document with a defined role in the pipeline — `reconcile.ts:41`
derives the Implement phase from it and the Plan gate depends on it — and giving
it a dedicated surface reflects that rather than hiding it in a list. The cost
is one special case in `doc-model.ts` and one entry in `RESERVED`, both already
written and both small.

#### 5b. The mechanics

Today `writePlanSnapshot` (`artifacts.ts:159`) opens a plan run by deleting
`artifacts.json`, the whole `artifacts/` directory, and `plan.done`. That reset
is why there is exactly one manifest per task and why it belongs to Plan.

It is removed. Three consequences, each handled:

**i. `plan.done` deletion stays.** It is phase lifecycle, not artifact state.
Without it a stale `plan.done` satisfies `shouldCollectPlan` on the very next
poll, collecting nothing before the agent has done any work.

**ii. The "already collected" sentinel moves to the snapshot.** `artifacts.json`
cannot mean "collected" once it outlives a run. `<kind>.snapshot.json` takes
that job: present means a run is pending collection, and it is deleted once
collection finishes. `shouldCollectPlan` becomes `shouldCollectRun`, drops its
`manifestExists` input, and keeps `snapshotExists` — which now serves both
purposes at once, the guard against sweeping a dirty worktree and the guard
against collecting twice. Plan runs and custom runs then follow one identical
rule, and the explicit `collect` CLI keeps its documented bypass.

Because there are now two kinds of snapshot, the poller evaluates
`shouldCollectRun` **once per kind** and collects each pending run separately.
Both can be pending at once — a custom run launched while a plan run's output
was still uncollected leaves `plan.snapshot.json` and `custom.snapshot.json`
side by side, and neither collects until nothing is live. When they do, the
plan's stale baseline makes it claim the custom run's files too; the
`originalPath` merge in (iii) collapses that to one entry, so the overlap is
harmless whichever order they run in.

**iii. Merge keys on `originalPath`, not on name.** Re-planning normally rewrites
the same design document; keyed by name, `uniqueName` would accumulate
`design-1.md`, `design-2.md` in the doc rail. Keyed by original path, a
re-collected file updates its existing entry in place — same `name`, same
`storedPath`, refreshed copy. `uniqueName` still resolves the genuine case of
two different originals sharing a basename.

Persistence is safe to read because the document layer already prefers the live
file: `resolveWriteTarget` (`documents.ts:51`) addresses `ref.originalPath`
whenever it still exists and falls back to the stored snapshot only when it is
gone. A surviving manifest entry whose original was rewritten therefore shows
current content with no extra work.

`writePlanSnapshot` is renamed `writeRunSnapshot(config, issue, kind)`, taking a
`RunKind`, writing `plan.snapshot.json` or `custom.snapshot.json`, and clearing
`plan.done` only for `kind === 'plan'`.

Accepted cost: the manifest only grows, and nothing in the UI prunes it. A noisy
rail is cleared by deleting `artifacts.json` by hand under
`%USERPROFILE%\.mc\tasks\<issue>\`.

### 6. Routes

No new endpoints. Both existing routes resolve the phase through one helper
instead of `config.pipeline.find` alone:

```ts
function resolveRunPhase(config: Config, id: string | undefined): PhaseConfig | null {
  if (id === CUSTOM_RUN_ID) return customPhase(config);
  return config.pipeline.find((p) => p.id === id) ?? null;
}
```

`POST /api/tasks/:issue/spawn` and `POST /api/tasks/:issue/prompt` both gain an
optional `includeContext?: boolean` in their body, defaulting to `true`, which
becomes `rawPrompt` when false. Preview therefore shows the raw prompt as
faithfully as it shows a rendered one.

The `!phase.spawnable` rejection still applies and still passes, since the
synthetic phase declares `spawnable: true`.

### 7. UI

**`RunTab`** — a `⚡ Custom…` button follows the spawnable phase buttons,
setting `armed` to `custom`. Phase lookup becomes `resolveRunPhase`'s client
twin so `LaunchCompose` receives the synthetic phase. The *Mark progress*
section is untouched: it iterates `config.pipeline`, which `custom` is not in.

**`LaunchCompose`** — three deltas, all keyed off `phase.id === CUSTOM_RUN_ID`:

1. Placeholder becomes *"What should the agent do?"*, and Launch is disabled
   while the box is empty. For a phase the text is optional garnish on a command
   file; for a custom run it is the entire instruction.
2. The **📌 Keep** button is hidden, and the box does not prefill from
   `task.overrides.instructions`. That field is shared with every phase's compose
   box, so a kept research prompt would silently ride along into Implement.
3. An **Include issue context** checkbox, default on, passed to both `api.spawn`
   and the preview call.

The launch hint ("Opens a Windows Terminal tab…") is already launcher-specific
prose and is left as-is.

**History** — `SpawnRecord` gains an optional `promptSummary`: the first ~100
characters of the operator's text, single-spaced and ellipsised. It is written
for custom runs only — a phase run is already identified by its label, and
summarising its optional extra instructions would just add noise. With no preset
names, this is the only thing distinguishing one past custom run from another,
so `HistoryTab` renders it after the phase label when present.

## Error handling

Failure modes are the existing ones and surface unchanged:

- **`mc-custom.md` missing** — `buildPrompt` already throws a message naming the
  file and pointing at `scripts/install.ps1`; the route returns it as a 500 and
  the drawer shows it. Reached only if the operator installed an older build.
- **No agent resolvable** — cannot occur through the UI, since the synthetic
  phase always carries an actor, but `resolveSpawnPlan`'s existing throw remains
  as the backstop.
- **T3 refuses the launch** — `resolveT3Launch` returns its sentence-shaped
  errors as today; the custom run has no special case.
- **Empty prompt with context off** — blocked in the UI by the disabled Launch
  button; the route additionally rejects an empty `customInstructions` when
  `includeContext` is false, since a raw prompt of nothing is not a run.
- **Collection fails** — the poller's existing try/catch logs and continues.

## Testing

Pure functions carry the load, as elsewhere in this codebase.

- `customPhase` — actor falls back to Plan's, then to a configured agent; id is
  absent from `config.pipeline`; T3 modes are the safe floor.
- `resolveRunPhase` — returns the synthetic phase for `custom`, a real one by
  id, `null` otherwise.
- `resolveSpawnPlan` with `rawPrompt` — returns the raw text for `claude`, and
  the raw text prefixed with standing rules for an `instructionMode: 'inline'`
  agent.
- `buildPrompt` artifact rendering — a populated list, and `(none)` when empty.
- `shouldCollectRun` — collects once per snapshot; does not collect with no
  snapshot; does not collect while a spawn is live; a surviving manifest no
  longer suppresses collection.
- `collectArtifacts` merge — a re-collected `originalPath` updates in place
  rather than adding a suffixed duplicate; two distinct originals sharing a
  basename still both land via `uniqueName`; entries from a previous run survive
  a later collection.
- `writeRunSnapshot` — `kind: 'custom'` leaves `artifacts.json`, `artifacts/`
  and `plan.done` intact; `kind: 'plan'` clears `plan.done` only.
- Board — a synthetic custom phase produces no lane and no gate entry
  (`reconcile.test.ts` should stay untouched, which is itself the assertion).

## Risks

- **The manifest grows without bound.** Accepted deliberately; the escape hatch
  is deleting one file by hand.
- **Research on an Inbox card moves it to Plan.** Accepted; a worktree exists, so
  the reconciler is not wrong to say work has started.
- **A raw prompt loses the artifact list.** Turning context off also drops
  `{{artifacts}}`, since there is no template to render it into. This is the
  intended meaning of the toggle, but it is worth knowing before using it for a
  spec run that should read prior research.
