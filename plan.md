# Mission Control — Implementation Design

**A personal, local task cockpit for driving AI coding agents (Claude Code / GitHub Copilot CLI) through the Acme development pipeline.**

Owner: Or (GitHub username `ouriel`) · Target OS: **Windows** · Status: build-ready design v1

---

## 0. How to read this document

You are a coding agent implementing this project from scratch with **no prior context**. This document is the complete source of truth. Read it top to bottom before writing code. It gives you:

- What the tool is and the three non-negotiable principles that shape every decision (§1–§2).
- The exact tech stack and why (§3).
- The on-disk layouts — both the tool's own repo and its runtime home folder (§4).
- The data model and the `config.yaml` schema (§5–§6).
- The deterministic orchestrator: git/worktree/branch rules, GitHub reads, markers (§7–§9).
- The **reconciler** — the pure function that derives each task's phase from durable facts (§10).
- The **spawn model** — how agents are launched crash-safely in Windows Terminal (§11).
- Skills & prompt-commands installed to `~/.claude` with **zero footprint** in the project repo (§12).
- Backend API and the React board UI (§13–§14).
- Build order, milestones, and how to verify each (§15–§17).

When something is genuinely a runtime detail you cannot know statically (e.g. the exact current flags of a third-party CLI), the doc says so and tells you to verify it against `--help` before hard-coding. Do that rather than guessing.

---

## 1. Problem & goal

Today, shipping one Acme task means running the same loop by hand: spawn an agent to plan, spawn another to implement, ask one to open the PR, watch CI, re-run an agent to fix CI, read Copilot's automatic review and fix it, read a teammate's review and fix that, then merge. The prompts and commands are almost always identical. Running several tasks at once means constant context-switching and manual polling to know "where is each task and what needs me right now."

**Goal:** one local place where every task is a card moving through the pipeline, showing live status pulled from GitHub, with the right agent and the right canned prompt one click away — so the repetitive typing, status-checking, and juggling disappear, and Or stays purely in the *manager* seat.

**Guiding principle — the human is the manager, the app is the assistant.** By default nothing spawns or advances without an explicit click. The human decides when each step happens; the app removes the friction. A few *optional, opt-in* automations (e.g. auto-spawn a CI fixer when checks go red) may be added later, but **the default is always manual**.

The tool is **personal and single-user**, for **one repository only**: `widgets` (referred to as "Acme"). Do not generalize it for other repos.

---

## 2. The three principles (these override any convenience)

### 2.1 Deterministic scripts over agent delegation
Anything that can be done reliably and deterministically by a script **must** be done by a script, not asked of an agent. Everything mechanical — creating a git worktree, checking out a branch, moving the plan file into place, writing a phase marker, pushing an already-made commit, reading CI state — is owned by the orchestrator. Agents are reserved for open-ended cognition: writing a plan, writing code, reasoning about a review comment, composing a PR description.

The test is **determinism, not "does it touch git."** Some git-heavy work is genuinely cognitive and stays with an agent/skill — e.g. opening a PR the Acme way means checking branch state, exploring the diff, composing a description, and merging `dev` in (possibly resolving conflicts). Acme already has a `/publish-pr` skill for exactly this. That is a skill, not a script.

### 2.2 The app is a reconciler over durable facts (crash-safe)
**The running app is NOT the source of truth.** Truth lives in durable facts that survive the app being closed or crashed:
- **Filesystem** — the task workspace on disk (`plan.md`, phase marker files).
- **Git / GitHub** — branch exists, commits pushed, PR open, checks green, reviews.

Every agent run is bracketed by a wrapper script that writes durable results on completion, **independently of whether the app process is alive**. On startup and refresh the app **reconciles**: it scans workspace markers and queries GitHub, then recomputes each task's phase from those facts.

Concretely: start a planner → close the app → the planner finishes and its wrapper attaches `plan.md` and writes `plan.done` → reopen the app → the task correctly shows "plan ready." Nothing is lost. **This single requirement dictates the whole architecture: the app must never be the parent process of an agent run** (a child process dies with its parent). Instead the app launches a detached terminal that runs the wrapper, then forgets it and learns the outcome only by reconciling.

### 2.3 Zero footprint in the project repo
None of this tooling — config, state, agent instructions, skills, prompts, worktrees, markers — may be committed to `widgets` or appear as untracked noise in its working copy. Agent instructions and canned prompts are delivered at spawn time via **user-scoped** Claude Code assets (`~/.claude/…`) and CLI flags — never via in-repo files like `./CLAUDE.md` or `.github/copilot-instructions.md`. Worktrees and all state live under a personal folder outside the repo.

**Distinction:** the project's *own* skills that already live in Acme (e.g. `/publish-pr`) are legitimately committed and the app is free to invoke them. Zero-footprint forbids adding *Mission Control's* files to the repo, not using the repo's own skills.

---

## 3. Tech stack (final — build with exactly this)

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript**, run via **`tsx`** (no compile step) | Typed, but zero build friction for the backend. |
| Backend | **Node.js + Fastify** (one small, mature framework) with `@fastify/static` | Serves the built UI, a small REST API, and an SSE stream. Easier to get right than hand-rolled `node:http`. |
| Subprocess calls | **`execa`** | Clean promises + argument handling for `git`, `gh`, `wt`. |
| Config parsing | **`js-yaml`** + **`zod`** (validation) | `config.yaml` is user-edited; validate it. |
| State cache | **A single `state.json` file** (via `fs`) | Lightweight, no native build (deliberately avoid `better-sqlite3`/node-gyp). It's only a *cache* — truth is re-derived by the reconciler, so JSON is safe. |
| Frontend | **React + Vite** (plain CSS or CSS modules — **no Tailwind**) | The board needs drag-and-drop between lanes, a detail drawer, and live badges; React earns its keep here. Vite dev server proxies to Fastify; production build is served statically by Fastify. |
| Drag & drop | **`@dnd-kit/core`** (or native HTML5 DnD if you prefer zero deps) | Cards drag between lanes. |
| Live updates | **Server-Sent Events (SSE)** | One-directional server→client push of reconciled state. Simpler than WebSockets. |
| Agent CLIs | **Claude Code (`claude`)** and **GitHub Copilot CLI (`copilot`)** | Terminal-native, interchangeable. |
| GitHub reads/writes | **`gh` CLI** (already authenticated on the machine) | No token juggling for v1. |
| Terminal launcher | **Windows Terminal (`wt`)** + **PowerShell (`pwsh`)** | Scriptable, one interactive tab per task, ideal for parallel work. |

**Keep the dependency list roughly this small.** Backend: `fastify`, `@fastify/static`, `execa`, `js-yaml`, `zod`, `tsx`. Frontend: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, optionally `@dnd-kit/core`. Nothing else unless clearly necessary.

There is **no database, no ORM, no state framework, and no per-task generated script files.** If a choice makes the project bigger or adds a native build step, prefer the simpler option.

---

## 4. On-disk layouts

### 4.1 The tool's own repository (what you are building)
Build this as its own Git repo, entirely separate from Acme. Suggested name: `mission-control`.

```
mission-control/
  package.json
  tsconfig.json
  vite.config.ts
  README.md
  src/
    server/
      index.ts            # Fastify bootstrap, static serving, SSE, REST routes
      routes.ts           # REST endpoints (see §13)
      sse.ts              # SSE broadcast helper
    orchestrator/
      config.ts           # load + zod-validate config.yaml
      state.ts            # read/write state.json (the cache)
      worktree.ts         # git worktree add/remove, branch creation (§7)
      github.ts           # gh reads/writes → typed Facts (§9)
      markers.ts          # read/write phase markers (§8)
      spawn.ts            # build wt command, launch detached tab (§11)
      reconcile.ts        # PURE function: Facts -> DerivedState (§10)
      poller.ts           # interval loop: gather facts, reconcile, broadcast
      slug.ts             # issue title -> branch slug
      paths.ts            # resolves ~/.mc/* absolute paths
    shared/
      types.ts            # Task, Phase, Facts, DerivedState, Config types
    web/                  # React app (Vite root)
      index.html
      main.tsx
      App.tsx
      components/
        Board.tsx
        Lane.tsx
        Card.tsx
        Drawer.tsx
      api.ts              # fetch wrappers + SSE subscription
      styles.css
  assets/                 # installed to the machine on setup (see §12)
    claude/
      commands/
        mc-planner.md
        mc-implementer.md
        mc-fix-ci.md
      skills/
        mc-mark-done/
          SKILL.md
          finalize.ps1
    scripts/
      common.ps1
      plan.ps1
      implement.ps1
      publish.ps1
      fix-ci.ps1
    config.example.yaml
  scripts/
    install.ps1           # copies assets/claude/* -> ~/.claude/*, scripts -> ~/.mc/scripts, seeds config
```

### 4.2 The runtime home folder (state, worktrees, assets) — **never committed to Acme**
Everything the tool creates at runtime lives here:

```
%USERPROFILE%\.mc\
  config.yaml                 # pipeline, agent profiles, repo path, settings
  state.json                  # cache of reconciled truth (rebuildable)
  scripts/                    # per-step PowerShell scripts + common.ps1 (installed from assets/)
    common.ps1
    plan.ps1
    implement.ps1
    publish.ps1
    fix-ci.ps1
  tasks/
    <issue>/                  # per-task workspace (NOT inside the worktree)
      plan.md                 # attached plan artifact
      notes.md                # optional
      markers/
        plan.running
        plan.done
        implement.done
        ...
      prompt.txt              # last generated prompt for a spawn (temp, overwritten)
  worktrees/
    issue-<n>/                # isolated git checkout on branch ouriel/<n>-<slug>
```

And the **user-scoped Claude Code assets** (global to the machine, not in any repo):
```
%USERPROFILE%\.claude\
  commands/
    mc-planner.md
    mc-implementer.md
    mc-fix-ci.md
  skills/
    mc-mark-done/
      SKILL.md
      finalize.ps1            # or SKILL.md calls into ~/.mc/scripts
```

> **Why user-scoped `~/.claude` works and is safe:** Claude Code discovers skills and slash-commands from a **user-level** folder (`~/.claude/skills/`, `~/.claude/commands/`) in addition to project-level (`.claude/…` inside the repo). User-level assets are available to an agent **regardless of which folder it runs in** (including a worktree) and are **never committed** to any repo. That is exactly the zero-footprint guarantee (§2.3). Namespace everything `mc-*` so it never collides with Acme's own committed skills (project skills override user skills on a name clash). Verify current discovery behavior against Claude Code's docs/`--help` at build time, but this is the design intent.

---

## 5. Data model

Types live in `src/shared/types.ts`.

### 5.1 Phases (the pipeline)
Ordered pipeline IDs (default; the set is configurable via `config.yaml`):

```
inbox → plan → implement → publish → ci → copilot_review → dev_review → merge → done
```

- `inbox` — a GitHub issue that exists but has not been started (no branch/worktree yet).
- `done` — PR merged; terminal.

### 5.2 Task record (persisted in `state.json`)
```ts
type Phase =
  | 'inbox' | 'plan' | 'implement' | 'publish'
  | 'ci' | 'copilot_review' | 'dev_review' | 'merge' | 'done';

interface TaskRecord {
  issue: number;               // GitHub issue number — the primary key
  title: string;               // from gh issue view
  slug: string;                // sanitized title for the branch name
  branch: string;              // ouriel/<issue>-<slug>
  worktreePath: string | null; // absolute path once created
  prNumber: number | null;
  prUrl: string | null;

  manualPhase: Phase | null;   // user drag override; wins for placement when set
  overrides?: {                // per-task overrides beat phase defaults (§6)
    agent?: string;
    model?: string;
    instructions?: string;
  };

  spawnHistory: SpawnRecord[]; // for the drawer
  lastReconciledAt: string;    // ISO timestamp
  notes?: string;
}

interface SpawnRecord {
  phase: Phase;
  agent: string;
  startedAt: string;
  command: string;             // the wt/pwsh command used (for debugging)
}
```

### 5.3 Facts (gathered fresh every reconcile — NOT persisted as truth)
```ts
interface Facts {
  issue: number;
  worktreeExists: boolean;
  branchExists: boolean;
  markers: string[];                 // e.g. ['plan.running','plan.done']
  planMdExists: boolean;
  hasPushedCommits: boolean;         // branch has commits ahead of origin/dev, pushed
  pr: {
    exists: boolean;
    number: number | null;
    url: string | null;
    state: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  };
  checks: 'none' | 'pending' | 'success' | 'failure';
  review: {
    decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NONE';
    unresolvedThreads: number;
    copilotUnresolved: number;       // unresolved threads authored by the Copilot bot
  };
}
```

### 5.4 Derived state (output of the reconciler)
```ts
interface DerivedState {
  issue: number;
  derivedPhase: Phase;               // computed purely from Facts
  displayPhase: Phase;               // manualPhase ?? derivedPhase
  gates: Record<Phase, boolean>;     // which gates are satisfied
  badges: Badge[];                   // what to render on the card
  needsYou: boolean;                 // true when a human action is the next step
}
```

---

## 6. `config.yaml` — schema and default

Loaded and zod-validated by `orchestrator/config.ts`. Everything workflow-shaped lives here so it can change without code edits. Ship `assets/config.example.yaml` and have `install.ps1` copy it to `~/.mc/config.yaml` if none exists.

```yaml
# ~/.mc/config.yaml
repo:
  # Absolute path to the LOCAL clone of widgets on this machine.
  path: 'C:\src\widgets'
  owner: 'acme'                 # GitHub owner/org — verify actual value
  name: 'widgets'
  baseBranch: 'dev'               # tasks branch from origin/dev
  branchPrefix: 'ouriel'          # ouriel/<issue>-<slug>

github:
  auth: gh-cli                    # use the already-authenticated gh CLI
  pollIntervalSeconds: 30         # poll open-PR tasks on this interval

agents:
  claude:
    launch: 'claude'
    headlessFlag: '-p'
    modelFlag: '--model'
    instructionFlag: '--append-system-prompt'
    model: default
  copilot:
    launch: 'copilot'
    headlessFlag: '-p'
    modelFlag: '--model'
    model: default

pipeline:
  - id: plan
    label: Plan
    actor: claude
    script: plan.ps1              # per-step script in ~/.mc/scripts
    command: '/mc-planner'        # user-scoped Claude slash command carrying the prompt
    spawnable: true
    gate: { type: manual }        # you approve the plan

  - id: implement
    label: Implement
    actor: claude
    script: implement.ps1
    command: '/mc-implementer'
    spawnable: true
    repeatable: true              # multiple sessions allowed
    gate: { type: manual }        # you mark done (agent calls /mc-mark-done)

  - id: publish
    label: Publish
    actor: claude
    script: publish.ps1
    command: '/publish-pr'        # Acme's OWN committed skill — invoked, not reimplemented
    spawnable: true
    gate: { type: auto, signal: pr_exists }

  - id: ci
    label: CI
    actor: none
    gate: { type: auto, signal: checks_green }
    onFail: { offerSpawn: fix-ci.ps1 }   # opt-in, one-click, NOT automatic

  - id: copilot_review
    label: Copilot review
    actor: claude
    script: fix-ci.ps1                   # reuse a generic "fix review comments" flow, or a dedicated script
    gate: { type: auto, signal: copilot_comments_resolved }

  - id: dev_review
    label: Dev review
    actor: claude
    gate: { type: auto, signal: approved_and_threads_resolved }

  - id: merge
    label: Merge
    actor: you
    gate: { type: manual }               # you always merge yourself
```

`zod` schema must enforce: unique phase `id`s; `actor ∈ {claude, copilot, none, you}`; `gate.type ∈ {manual, auto}`; `gate.signal ∈ {pr_exists, checks_green, copilot_comments_resolved, approved_and_threads_resolved}` when `auto`.

**Per-task overrides** (`TaskRecord.overrides`) beat the phase default: a task can pin a different agent/model or extra instructions for its next spawn.

---

## 7. Git: branch & worktree convention (deterministic — `orchestrator/worktree.ts`)

**Every task works on a brand-new branch cut from the latest `dev`, in its own worktree.**

Branch name: `ouriel/{issue}-{slug}` where `slug` is derived from the GitHub issue title by `orchestrator/slug.ts`:
- lowercase; replace any run of non-`[a-z0-9]` with a single `-`; trim leading/trailing `-`; cap length (~50 chars).
- Example: issue #142 "Add student progress dashboard" → `ouriel/142-add-student-progress-dashboard`.

Creating a task's working copy (called lazily the first time Plan or Implement runs):

```powershell
# in config.repo.path
git fetch origin dev
git worktree add -b ouriel/142-add-student-progress-dashboard `
    "%USERPROFILE%\.mc\worktrees\issue-142" origin/dev
```

Rules:
- **Always `git fetch origin dev` first**, so the branch is cut from the latest `dev`.
- One worktree per task under `~/.mc\worktrees\issue-<n>`; parallel tasks never collide and the main working copy is untouched.
- If the branch already exists (task re-opened), use `git worktree add <path> ouriel/<n>-<slug>` (without `-b`).
- Remove the worktree after merge: `git worktree remove <path>` (and `git worktree prune`).
- **Tool artifacts (plan.md, markers) live in `~/.mc/tasks/<issue>/`, NOT inside the worktree**, so the checkout stays clean (zero footprint).

Expose typed helpers: `ensureWorktree(issue): Promise<{path, branch}>`, `removeWorktree(issue)`, `worktreeExists(issue)`, `branchExists(issue)`.

---

## 8. Markers (durable phase signals — `orchestrator/markers.ts`)

A marker is a small empty file under `~/.mc/tasks/<issue>/markers/`. They record progress so reconciliation is precise even if the app was closed.

- `plan.running`, `plan.done`
- `implement.running`, `implement.done`
- `publish.running`, `publish.done`

Helpers: `writeMarker(issue, name)`, `hasMarker(issue, name)`, `listMarkers(issue): string[]`, `clearMarker(issue, name)`.

Markers are the **preferred** signal, but reconciliation must also fall back to raw evidence when a marker is missing (e.g. terminal closed mid-finalize) — see §10.

---

## 9. GitHub integration (`orchestrator/github.ts`)

All reads/writes go through the already-authenticated **`gh` CLI** via `execa`. Run each with `cwd = config.repo.path`. **Verify exact JSON field names against `gh <cmd> --help` at build time**; the intent is below.

- **Issue title (for slug/branch):**
  `gh issue view <n> --json number,title,body`
- **PR for a task's branch:**
  `gh pr list --head ouriel/<n>-<slug> --json number,url,state,mergeable` → `.[0]` or none.
- **CI checks on the PR:**
  `gh pr checks <prNumber>` (exit code / rollup), or `gh pr view <prNumber> --json statusCheckRollup` → map to `none|pending|success|failure`.
- **Review decision:**
  `gh pr view <prNumber> --json reviewDecision` → `APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null`.
- **Unresolved review threads + Copilot threads:** requires GraphQL (the `--json` flags don't expose thread resolution):
  ```
  gh api graphql -f query='
    query($owner:String!,$name:String!,$pr:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$pr){
          reviewThreads(first:100){
            nodes{ isResolved comments(first:1){ nodes{ author{ login } } } }
          }
        }
      }
    }' -F owner=<owner> -F name=<name> -F pr=<prNumber>
  ```
  Count `isResolved == false` for `unresolvedThreads`; of those, count ones whose first comment author login is the Copilot bot (verify the bot's exact login, commonly a `copilot`/`github-copilot[bot]`-style handle) for `copilotUnresolved`.
- **Open the PR:** done by the **`/publish-pr` skill through the agent** (cognitive), not here. The orchestrator only *reads* PR state.
- **Merge:** Or does this himself in GitHub; the app never merges. (Optionally provide a button that just opens the PR URL.)

Wrap all of the above into a single `gatherFacts(task): Promise<Facts>` that also reads markers and git state (§7–§8). Only hit `gh` for tasks that have a branch/PR — don't poll `inbox` tasks.

---

## 10. The reconciler (`orchestrator/reconcile.ts`) — a PURE function

This is the heart of the system and your main verification surface. Keep it **pure**: `reconcile(facts: Facts): { derivedPhase, gates }`. No I/O inside it — I/O happens in `gatherFacts`. This makes it trivially unit-testable with hand-built `Facts` objects.

**Derivation rules (evaluate top-down; first match wins for `derivedPhase`):**

1. `pr.state === 'MERGED'` → `done`.
2. `pr.exists && review.decision === 'APPROVED' && review.unresolvedThreads === 0` → `merge` (ready to merge).
3. `pr.exists && review.decision === 'CHANGES_REQUESTED'` (or unresolved non-Copilot threads > 0) → `dev_review`.
4. `pr.exists && review.copilotUnresolved > 0` → `copilot_review`.
5. `pr.exists && checks === 'failure'` → `ci` (surface the fixer).
6. `pr.exists && checks === 'pending'` → `ci`.
7. `pr.exists` (checks success, no reviews yet) → `copilot_review` (waiting for review) — or `ci` satisfied; treat as "past CI." Use `copilot_review` as the resting place until a review lands.
8. `hasPushedCommits && hasMarker('implement.done')` → `publish` (ready to publish).
9. `planMdExists || hasMarker('plan.done')` → `implement`.
10. `worktreeExists || branchExists || hasMarker('plan.running')` → `plan`.
11. else → `inbox`.

**Gate satisfaction** (independent booleans for badges/buttons):
- `plan`: `planMdExists || hasMarker('plan.done')`.
- `implement`: `hasMarker('implement.done')`. (Manual — the agent calls `/mc-mark-done implement`, which writes it.)
- `publish`: `pr.exists`.
- `ci`: `checks === 'success'`.
- `copilot_review`: `pr.exists && review.copilotUnresolved === 0`.
- `dev_review`: `review.decision === 'APPROVED' && review.unresolvedThreads === 0`.
- `merge`: always manual (never auto-satisfied).

**`displayPhase = task.manualPhase ?? derivedPhase`.** A card the user dragged stays where they put it, but its badges still reflect real `Facts` (so a card dragged to Merge still shows a red CI badge). A "clear override" action sets `manualPhase = null` and lets derivation take over.

**`needsYou`** is true when the next action is human: plan attached & awaiting approval; implement awaiting "mark done"; CI red; a review landed; merge unlocked.

**Fallback robustness:** always prefer markers, but never require them — `plan.md` present without `plan.done` still counts as plan-ready (rule 9); pushed commits without `implement.done` still count as real implementation work (they keep the card in `implement` until you mark done, which is correct). This is what makes closing/crashing the app safe: worst case is a manual "Refresh" that re-derives truth.

---

## 11. Spawn model — crash-safe agent launches (`orchestrator/spawn.ts`)

### 11.1 The core rule (from §2.2)
The app **must not** run an agent as its own child process. Instead it launches a **detached Windows Terminal tab** that runs a **per-step PowerShell script**; that script outlives the app. The app then forgets about it and only learns the result by reconciling.

### 11.2 One script per step, plus a shared library
In `~/.mc/scripts/` (installed from `assets/scripts/`):
- `common.ps1` — dot-sourced by the others; shared helpers: `Ensure-Worktree`, `Write-Marker`, `Get-TaskPaths`, prompt-file handling.
- `plan.ps1`, `implement.ps1`, `publish.ps1`, `fix-ci.ps1` — one per phase.

Each step script is a **parameterized** setup→agent chain. There is **no per-task generated script** — variation comes from parameters + a small prompt file. Shape of a step script (`plan.ps1`):

```powershell
param(
  [int]$Issue,
  [string]$Worktree,
  [string]$Branch,
  [string]$PlanPath,
  [string]$PromptFile,     # temp file: ~/.mc/tasks/<n>/prompt.txt
  [string]$Agent = 'claude'
)
. "$PSScriptRoot\common.ps1"

# --- setup (deterministic) ---
Ensure-Worktree -Issue $Issue -Worktree $Worktree -Branch $Branch
Write-Marker -Issue $Issue -Name 'plan.running'

# --- run agent (interactive; blocks while Or works) ---
Set-Location $Worktree
$prompt = Get-Content -Raw $PromptFile
# Claude Code: pass the canned slash-command + context as the initial prompt.
# VERIFY exact invocation against `claude --help`; intent shown:
claude $prompt --append-system-prompt "You are inside a prepared git worktree. Do NOT create branches, worktrees, or run git bookkeeping. Only do the cognitive task. When finished, run /mc-mark-done plan."

# --- finalize fallback (deterministic) ---
# The agent is expected to call /mc-mark-done (which writes plan.done + attaches plan.md).
# As a safety net, if plan.md exists in the workspace but the marker is missing, write it.
Finalize-IfNeeded -Issue $Issue -Phase 'plan' -PlanPath $PlanPath
```

The **prompt file** is written by the orchestrator just before launch (built from the phase `command` + task context + any per-spawn custom instructions), so nothing is squeezed through nested CLI quotes.

### 11.3 Launching the tab
`spawn.ts` builds and runs (via `execa`) a `wt` command:

```
wt new-tab --title "#142" -d "<worktree>" `
   pwsh -NoExit -File "%USERPROFILE%\.mc\scripts\plan.ps1" `
   -Issue 142 -Worktree "<worktree>" -Branch "ouriel/142-..." `
   -PlanPath "<tasks>\142\plan.md" -PromptFile "<tasks>\142\prompt.txt" -Agent claude
```

- `--title "#142"` → one identifiable tab per task.
- `-NoExit` keeps the tab open so finalize output is visible and the tab survives the agent exiting.
- The app returns immediately; it does **not** await the tab. It records a `SpawnRecord` and moves on.

### 11.4 How "done" is detected (two complementary signals)
1. **Agent-driven (precise):** the prompt instructs the agent to call `/mc-mark-done <phase>` when the cognitive work is truly finished. That skill runs a script that writes the phase marker and attaches artifacts (§12). This is the intended primary signal — the agent knows when it's actually done, not when a terminal happened to close.
2. **Reconciliation fallback (safety net):** even if the agent forgets, `plan.md` present / pushed commits / PR existing let the reconciler derive the phase anyway (§10). Belt and suspenders.

### 11.5 Ownership split (script vs agent) — enforce this
| Operation | Owner |
|---|---|
| Create/remove worktree, checkout branch, fetch dev | **Script** |
| Attach outputs, write phase markers | **Script** (via `/mc-mark-done` skill or finalize fallback) |
| Push an already-made commit, read CI/review state, advance the board | **Script** |
| Write the plan content | Agent |
| Write / change code | Agent |
| Reason about & fix a review comment or CI failure | Agent |
| Open the PR (branch check, diff, description, merge `dev`) | Agent via Acme's `/publish-pr` skill |

---

## 12. Skills & prompt-commands — zero footprint (`assets/claude/`, installed to `~/.claude/`)

These are **user-scoped Claude Code assets**, installed by `install.ps1`. They are global to the machine and never touch the Acme repo (§2.3, §4.2).

### 12.1 Canned prompts as slash-commands (`~/.claude/commands/`)
Instead of passing big prompt strings, each phase references a versioned command file. Example `mc-planner.md`:

```markdown
---
description: Produce an Acme implementation plan for an issue.
---
Read GitHub issue #$ARGUMENTS in the current repository and produce a concise,
actionable implementation plan. Write the plan to the path provided in your
context as PLAN_PATH. Do not write code yet. Work only in the current worktree.
When the plan is complete and saved, run /mc-mark-done plan.
```

`mc-implementer.md` (takes the plan path, allows appended custom instructions), `mc-fix-ci.md` (reads the failing check and fixes it) follow the same pattern. Publishing uses **Acme's own** `/publish-pr` (committed in the repo) — do not recreate it.

### 12.2 The done-marking skill (`~/.claude/skills/mc-mark-done/`)
A skill whose *underlying work is a deterministic script*, invoked by the agent when it decides it is finished — the clean handoff between "agent knows it's done" and "script does the bookkeeping."

`SKILL.md`:
```markdown
---
name: mc-mark-done
description: Mark the current Mission Control phase complete. Use ONLY when the
  cognitive work for the phase is genuinely finished. Takes the phase id as an
  argument, e.g. "plan" or "implement".
---
When invoked, run the finalize script for the given phase. It attaches produced
artifacts to the task workspace and writes the durable phase marker so Mission
Control's reconciler records the phase as done, whether or not the app is running.

Run: pwsh -File ~/.mc/scripts/... (or call finalize.ps1 in this skill dir)
with the current issue number and phase.
```

`finalize.ps1` (or a call into `~/.mc/scripts/`): copies the produced `plan.md` from the worktree into `~/.mc/tasks/<issue>/`, writes `<phase>.done`, and — where appropriate for the phase — `git add/commit/push`. Because this runs inside the terminal tab, it completes independently of the app (crash-safe).

> The agent needs the current issue number to call this. Provide it via the injected prompt context and/or an environment variable set by the step script (e.g. `$env:MC_ISSUE = $Issue` before launching the agent), and have `SKILL.md`/`finalize.ps1` read it. Choose one mechanism and keep it consistent.

### 12.3 Runtime instructions (never in the repo)
Standing rules ("you're in a prepared worktree; don't do git bookkeeping; call /mc-mark-done when done") are passed at spawn via Claude Code's `--append-system-prompt` flag (see §11.2). Nothing is written into the project repo. Keep this instruction surface tiny — because scripts own the bookkeeping, the agent barely needs instructions.

---

## 13. Backend API (`src/server/`)

Fastify. Serves the built React app statically (`@fastify/static`) and exposes:

- `GET /api/tasks` → array of `{ ...TaskRecord, derived: DerivedState }` (current cache + latest derivation).
- `POST /api/tasks/import` `{ issue }` → fetch issue title via `gh`, create a `TaskRecord` in `inbox`. (Optionally `GET /api/issues` to list open Acme issues via `gh issue list` for a picker.)
- `POST /api/tasks/:issue/spawn` `{ phase, customInstructions? }` → build prompt file, launch the step's `wt` tab (§11). Returns immediately.
- `POST /api/tasks/:issue/mark-done` `{ phase }` → manual "mark done" button; writes the marker directly (mirror of what the skill does), for when Or wants to mark done from the UI.
- `POST /api/tasks/:issue/move` `{ phase }` → sets `manualPhase` (drag-and-drop).
- `POST /api/tasks/:issue/clear-override` → `manualPhase = null`.
- `POST /api/tasks/:issue/overrides` `{ agent?, model?, instructions? }` → per-task overrides.
- `POST /api/reconcile` → force a full reconcile now (also runs on startup and on the poll interval).
- `POST /api/tasks/:issue/merge-cleanup` → after Or merges: `git worktree remove`, mark `done`.
- `GET /api/events` → **SSE stream**; server pushes the full reconciled task list whenever the poller updates or an action mutates state.

Poller (`orchestrator/poller.ts`): every `pollIntervalSeconds`, for each task with a branch/PR, run `gatherFacts` → `reconcile` → update `state.json` → broadcast over SSE. Also reconcile once on startup (crash recovery).

---

## 14. Frontend — the board (`src/web/`)

A single React app. Keep it small and legible.

### 14.1 Board (`Board.tsx`, `Lane.tsx`, `Card.tsx`)
- **Lanes = phases** in pipeline order (`inbox … merge`). Read the phase list from `/api/tasks` config echo or a `/api/config` endpoint.
- **Cards = tasks**, placed in the lane of their `displayPhase`.
- Each card shows: issue `#`, short title, pinned agent chip, and a **live status badge** driven by `DerivedState.badges` (queued / live terminal / CI running / CI failed / N review comments / waiting on review / ready). A card is **green ("ready")** when its current-phase gate is satisfied.
- **Drag-and-drop:** dragging a card to another lane calls `POST /move` (sets `manualPhase`). Badges continue to reflect real facts regardless of where it's parked. A small control on the card clears the override.
- **"Needs you" filter:** toggle that shows only cards with `derived.needsYou === true`.
- Subscribe to `GET /api/events` (SSE) and re-render on every push. No manual polling in the UI.

### 14.2 Task detail drawer (`Drawer.tsx`)
Opens on card click. Shows: linked issue + PR (links), current phase, the attached plan (render `plan.md`), spawn history, live CI checks and review state, and the **current-phase action buttons**:
- *Plan*, *Implement (+ optional custom instructions textarea)*, *Publish*, *Spawn CI fixer* (shown when CI red), *Mark done*, *Open PR* (opens PR URL), *Advance* (clears override / nudges to next lane), *Merge* (opens PR; app never merges — after Or merges, a *Cleanup* action removes the worktree).
- Buttons are enabled/disabled based on `gates` and current phase.

### 14.3 Styling
Plain CSS or CSS modules. Clean, dense, dark-friendly. No component library required.

---

## 15. Build order (milestones — implement in this sequence)

1. **Scaffolding + config + state.** Repo skeleton (§4.1), `package.json`, `tsx`, Fastify hello-world, `config.ts` (load+validate `config.yaml`), `state.ts` (read/write `state.json`), `paths.ts`, `slug.ts`. `install.ps1` seeds `~/.mc/` and copies `~/.claude/` assets.
2. **Orchestrator core, headless (no UI).** `worktree.ts`, `markers.ts`, `github.ts` (`gatherFacts`), and the **pure `reconcile.ts`**. Prove it with a tiny CLI: `tsx src/orchestrator/cli.ts reconcile 142` prints the derived phase + gates. **Write unit tests for `reconcile` first** (hand-built `Facts`).
3. **Spawn wrapper — the riskiest piece; de-risk early.** Write `common.ps1` + `plan.ps1`, the `/mc-planner` command and `/mc-mark-done` skill. Launch a real Claude Code planning session in a `wt` tab against a real Acme issue. **Verify:** the plan gets written, `/mc-mark-done` writes the marker + attaches `plan.md`, and **killing the app mid-session loses nothing** (reopen → reconcile → "plan ready").
4. **Server + board.** Fastify REST + SSE; React board with lanes/cards/badges from reconciled state; the detail drawer with action buttons; drag-to-move with `manualPhase`.
5. **Wire the full pipeline.** Repeatable Implement (with custom instructions), one-click Publish (invokes Acme's `/publish-pr`), CI/review gates read-only (start dev/copilot "resolved" gates as *assisted*, i.e. surfaced but requiring your confirmation), manual Merge + worktree cleanup.
6. **Polish.** "Needs you" filter, spawn history in drawer, force-reconcile button.

Then optionally: Windows toast notifications on entering "needs you"; opt-in auto-spawn CI fixer on red; per-task overrides UI; full pipeline editing from the GUI; VS Code integrated-terminal launch option.

---

## 16. Verification & testing (do this, don't skip)

- **Unit-test `reconcile`** exhaustively with constructed `Facts` covering every rule in §10 (no PR; PR pending; PR failure; copilot unresolved; changes requested; approved+resolved; merged; markers-missing fallbacks). This is cheap and catches the most important logic.
- **Crash-safety test (manual, milestone 3):** start a plan spawn, kill the Node app, let the agent finish, reopen → confirm the task shows "plan ready" purely from disk/git facts.
- **Zero-footprint check:** after any full run, `git -C <repo> status` in Acme must show a clean tree — no Mission Control files, no stray untracked artifacts, no worktree noise inside the checkout. Worktrees live only under `~/.mc/worktrees/`.
- **`gh` field verification:** before hard-coding any `--json` field or GraphQL path, confirm it against `gh <cmd> --help` / a live call; field names evolve.
- **CLI invocation verification:** confirm the exact way to pass an initial prompt / slash-command and flags to `claude` and `copilot` against their `--help` before finalizing the step scripts. If passing a slash-command as the initial prompt is unreliable, fall back to embedding the full prompt text in the prompt file.

---

## 17. Scope

**In scope (v1):** local board with the default Acme phases and cards; `config.yaml` + `state.json` outside the repo; reconciliation on startup/refresh/poll; orchestrator scripts (worktree create/remove, branch checkout from latest dev, plan attach, markers, `gh` reads); per-step spawn scripts (setup→agent) that are crash-safe; one-click spawn of Claude Code / Copilot CLI into a Windows Terminal tab with prompt + runtime instructions preloaded (nothing written to the repo); plan attachment; repeatable Implement; manual "mark done / advance"; one-click Publish via Acme's `/publish-pr`; drag cards by hand; **manual advance everywhere — nothing auto-runs.**

**Later / iterate:** Windows toast notifications + "needs you" surfacing; opt-in per-step automations (e.g. auto-spawn CI fixer on red); full pipeline editing from the GUI; per-task overrides in the UI; spawn transcript/log capture in the drawer; VS Code integrated-terminal launch; richer plan handling (versions; plan-vs-implementation diff).

**Explicitly out of scope:** any generalization to repos other than Acme; auto-merge or any action that ships code without Or; driving Copilot's *cloud* coding agent (use interactive Copilot CLI instead); committing any tooling, or leaving untracked artifacts, in the Acme repo.

---

## 18. Success criteria

The tool succeeds if, on a normal day with several tasks in flight, Or can (a) open one screen and immediately see where every task is and which need him, (b) move any task forward with a single click and no retyped prompts, and (c) never manually poll CI or reviews — while still personally approving plans, implementations, and every merge; and if closing or crashing the app at any moment never loses or corrupts a task's state.

---

## 19. Open decisions — chosen defaults (change only with reason)

- **State cache format:** **JSON** (`state.json`). Truth is reconstructable, so no database.
- **First cut:** build the **thin full v1** (through milestone 5), not a status-only board — the spawn wrapper is the hard part and is needed for any real use.
- **Finalize aggressiveness:** conservative. Finalize attaches artifacts and writes markers; for Implement it **leaves commit/push to Or** (reconciliation infers work from raw git facts). Publish's commit/PR is owned by `/publish-pr`.
- **"Resolved" review gates:** start **assisted** (surfaced, you confirm), not fully automatic, until trusted.
- **Prompt delivery:** user-scoped slash-commands (`/mc-*`) + a temp prompt file; runtime rules via `--append-system-prompt`. Verify exact CLI invocation at build time (§16).
```