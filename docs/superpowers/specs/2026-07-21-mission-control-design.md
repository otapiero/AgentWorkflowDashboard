> Historical. This is the original design record from when Mission Control
> was built for a single repository, kept for the reasoning it captures. It
> names that repository throughout; the shipped tool is repository-agnostic.

# Mission Control — Validated Design

**A personal, local task cockpit for driving AI coding agents through the Acme development pipeline.**

Owner: Or · Date: 2026-07-21 · Status: approved-pending-review

This document supersedes `plan.md` where the two disagree. It records what was *verified against the real machine* on 2026-07-21, and the decisions Or made where the plan turned out to be wrong or improvable. `plan.md` and `spec.md` remain the background rationale; this is the build contract.

---

## 1. Verified environment facts

Everything in this section was confirmed by running the command, not assumed. `plan.md` explicitly demanded this verification (§16); these are the results.

| Fact | Plan assumed | Verified reality |
|---|---|---|
| GitHub repo | `acme/widgets` | **`acme/widgets`** |
| Local clone path | `C:\src\widgets` | **`C:\src\widgets`** (folder name ≠ repo name) |
| Base branch | `dev` | `dev` ✓ |
| `gh` identity | — | authenticated as **`otapiero`** (scopes: repo, workflow, read:org, gist, read:packages) |
| Branch prefix | `ouriel` | `ouriel` ✓ — a personal convention, *not* the GitHub login |
| Copilot review bot login | "verify it" | **`copilot-pull-request-reviewer`** (`__typename: Bot`) |
| `copilot` CLI | assumed present | not installed at design time; **installed 2026-07-21, v1.0.73** |
| `claude` CLI | — | 2.1.183 |
| `pwsh` | — | 7.6.0 |
| `wt` | — | present at `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` |
| Node / npm | — | v24.18.0 / 11.18.0 |

**Confirmed `claude` flags:** positional `prompt`, `--append-system-prompt <prompt>`, `--model`, `-p/--print`, `--session-id <uuid>`, `-r/--resume`, `-n/--name`. There is **no** `--append-system-prompt-file` in this version — the instruction string must be passed inline.

**Confirmed `copilot` flags (v1.0.73):** `-i, --interactive <prompt>` starts an interactive session and auto-submits the prompt — this is the spawn path. `-p, --prompt <text>` is the non-interactive path. `--model <model>`, `-n/--name`, `--resume`, `-C <directory>` all exist. **There is no `--append-system-prompt` equivalent**, so standing rules must be prepended into the prompt text for this agent.

This makes the two agents differ in two dimensions that the config must express rather than hard-code:

| | `claude` | `copilot` |
|---|---|---|
| Prompt delivery | positional argument | `-i <prompt>` flag |
| Standing rules | `--append-system-prompt <text>` | none — prepend into prompt body |

**Confirmed `gh` shapes:**
- `gh issue list --assignee @me --state open --json number,title` works.
- `gh pr list --json number,url,state,headRefName,reviewDecision` works. **`reviewDecision` returns `""` (empty string), not `null`,** when no review exists — normalize to `'NONE'`.
- The GraphQL `reviewThreads` query from `plan.md` §9 works verbatim.

**Confirmed repo skills:** `/publish-pr` and `/merge-dev` exist as committed skills in `.claude/skills/`. `/publish-pr` invokes `merge-dev` first, requires a clean working tree, parses the issue number from the branch as `<author>/<number>-<rest>`, and targets `dev` on `acme/widgets`.

### 1.1 The prompt-delivery finding (decisive)

`plan.md` §12 proposed passing `/mc-planner 3060` as the agent's initial prompt. **This does not work in Claude Code 2.1.183.** User commands are now surfaced to the model as *skills invoked through the Skill tool*, not as verbatim prompt expansion. Three probes:

| Probe | Result |
|---|---|
| `claude -p "/mc-selftest 3060"` | ❌ Command never ran — model replied "I'm ready to help." |
| `claude -p "Use the mc-selftest skill with argument 3060."` | ✅ Skill invoked, exact expected output |
| `claude -p "<rendered command body verbatim>"` | ✅ Exact expected output |

This triggers the contingency `plan.md` §16 anticipated, and dictates §5 below.

---

## 2. Decisions taken (divergences from `plan.md`)

Each was presented to Or with trade-offs; the chosen option is recorded here.

1. **Real repo coordinates** replace the plan's placeholders throughout config.
2. **Phase marker "done" is not agent-driven.** The `/mc-mark-done` skill is **dropped**. A phase is done when its durable artifact exists on disk (e.g. `plan.md`) *and/or* Or clicks **Mark done** in the board. No `MC_ISSUE` env var, no `finalize.ps1`, no agent-compliance risk. Still crash-safe: the artifact on disk is the durable fact.
3. **One parameterized `run-phase.ps1`** replaces `plan.ps1` / `implement.ps1` / `publish.ps1` / `fix-ci.ps1`, which differed only by parameters.
4. **`/mc-*` command files are kept** and installed to `~/.claude/commands/` — but see §5: they are the *source* of prompt text, rendered and passed verbatim, never invoked as a slash-command initial prompt.
5. **Fresh agent session per spawn.** `--session-id`/`--resume` continuity was offered and declined; each spawn starts cold.
6. **No drag-and-drop in v1.** The manual phase override ships as a "move to phase" menu on the card, hitting the same endpoint. `@dnd-kit` is not a dependency. Revisit in polish.
7. **Manual import only.** No auto-sync of assigned issues. The import dialog offers a picker populated from `gh issue list` for convenience, but nothing lands on the board without an explicit action.
8. **Board starts empty on first run.** No adoption of pre-existing branches/PRs. (In-flight tasks may be imported by hand to test the reconciler against real data.)
9. **Copilot CLI support is built now**, driven entirely by the config's agent profile, and flagged untested until the CLI is installed.
10. **No commit machinery.** Or commits during Implement (personally or by asking the agent), so work is already committed by the time Publish runs. The board only *surfaces* uncommitted/unpushed counts as badges.

---

## 3. Architecture

Three layers, each independently usable:

- **Orchestrator** — pure TypeScript, no server required. Owns config, paths, git worktrees, markers, `gh` reads, and the pure reconciler. Exercised directly by a small CLI so it can be verified before any UI exists.
- **Server** — Fastify. A thin REST + SSE shell over the orchestrator, plus static hosting of the built UI. Contains no business logic.
- **Web** — React + Vite. Renders reconciled state; holds no derivation logic of its own.

The critical invariant from `plan.md` §2.2 is unchanged and non-negotiable: **the app is never the parent process of an agent run.** Spawns go into a detached Windows Terminal tab that outlives the app; the app learns outcomes only by reconciling durable facts.

### 3.1 Tool repo layout

```
AgentWorkflowDashboard/
  package.json  tsconfig.json  vite.config.ts  README.md
  src/
    shared/types.ts            # Phase, TaskRecord, Facts, DerivedState, Config
    orchestrator/
      paths.ts                 # ~/.mc/* absolute path resolution
      config.ts                # load + zod-validate config.yaml
      state.ts                 # read/write state.json (cache only)
      slug.ts                  # issue title -> branch slug
      worktree.ts              # git worktree/branch operations
      markers.ts               # phase markers + spawn liveness
      github.ts                # gh reads -> typed Facts
      prompt.ts                # render ~/.claude/commands/mc-*.md -> prompt.txt
      reconcile.ts             # PURE: Facts -> { derivedPhase, gates, badges, needsYou }
      spawn.ts                 # build + launch detached wt tab
      poller.ts                # interval: gatherFacts -> reconcile -> broadcast
      cli.ts                   # headless verification harness
    server/
      index.ts  routes.ts  sse.ts
    web/
      index.html  main.tsx  App.tsx  api.ts  styles.css
      components/ Board.tsx Lane.tsx Card.tsx Drawer.tsx
  assets/
    claude/commands/
      mc-planner.md  mc-implementer.md  mc-fix-ci.md  mc-fix-review.md
    scripts/ common.ps1  run-phase.ps1
    config.example.yaml
  scripts/install.ps1
  test/reconcile.test.ts
  docs/superpowers/specs/
```

### 3.2 Runtime home — `%USERPROFILE%\.mc\`

```
config.yaml                    # user-edited, zod-validated
state.json                     # cache; rebuildable, never authoritative
scripts/ common.ps1 run-phase.ps1
tasks/<issue>/
  plan.md                      # the durable plan artifact
  prompt.txt                   # last rendered prompt (overwritten per spawn)
  markers/ plan.done implement.done publish.done plan.running ...
worktrees/issue-<n>/           # isolated checkout on ouriel/<n>-<slug>
```

Nothing is ever written into the Acme checkout. Verification: `git -C <repo> status` must be clean after any full run.

---

## 4. Data model

Phases: `inbox → plan → implement → publish → ci → copilot_review → dev_review → merge → done`.

`TaskRecord` is as `plan.md` §5.2 (issue number as primary key; `manualPhase` override; `overrides`; `spawnHistory`).

`Facts` extends `plan.md` §5.3 with three additions justified by verified reality:

```ts
interface Facts {
  issue: number;
  worktreeExists: boolean;
  branchExists: boolean;
  markers: string[];
  planMdExists: boolean;
  hasPushedCommits: boolean;
  dirtyFileCount: number;        // NEW - uncommitted files in the worktree
  unpushedCommits: number;       // NEW - commits ahead of origin
  liveSpawn: { phase: Phase; pid: number; startedAt: string } | null;  // NEW
  pr: { exists, number, url, state };
  checks: 'none' | 'pending' | 'success' | 'failure';
  review: {
    decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NONE';
    unresolvedThreads: number;
    copilotUnresolved: number;   // first comment author == copilot-pull-request-reviewer
  };
}
```

### 4.1 Spawn liveness (fixes a real flaw in the plan)

`plan.md` used a bare `<phase>.running` marker file. If a terminal is closed or crashes, that file persists forever and the card shows "live" indefinitely.

Instead, `<phase>.running` holds JSON `{ pid, startedAt, phase }`. `run-phase.ps1` writes it with `$PID` before launching the agent and deletes it in a `finally` block. The reconciler checks liveness with `process.kill(pid, 0)`; a marker whose process is gone is treated as stale and cleaned up. This is deterministic script work, exactly per principle 2.1.

---

## 5. Prompt delivery — one source of truth

The `/mc-*` command files are installed to `~/.claude/commands/` and remain the single, versioned, hand-editable source of prompt text. They are usable manually (typing `/mc-planner` in any terminal works normally). At spawn time the orchestrator does **not** rely on slash-command expansion, which §1.1 proved unreliable:

```
assets/claude/commands/mc-planner.md   (git-versioned in this repo)
      ↓ install.ps1
~/.claude/commands/mc-planner.md       (machine-global, hand-editable, manually typeable)
      ↓ prompt.ts: strip YAML frontmatter, substitute $ARGUMENTS + {{issue}}
      ↓           {{title}} {{planPath}} {{worktree}} {{branch}} {{customInstructions}}
~/.mc/tasks/<n>/prompt.txt
      ↓ run-phase.ps1 reads the file, passes it as the positional prompt
claude "<rendered body>" --append-system-prompt "<standing rules>"
```

Passing the rendered body verbatim is the path proven to work. A prompt *file* (rather than an inline argument) also avoids nested-quoting hell through `wt` → `pwsh` → `claude`.

**Repo skills are invoked by name in prose,** the second path proven to work — e.g. the publish prompt says *"Use the publish-pr skill to open the PR for this branch"* rather than emitting a bare `/publish-pr`.

---

## 6. Reconciler

A pure function, `reconcile(facts: Facts): { derivedPhase, gates, badges, needsYou }`. No I/O — all I/O lives in `gatherFacts`. This is the primary verification surface and gets exhaustive unit tests written *before* the implementation.

Derivation rules are `plan.md` §10 evaluated top-down, first match wins, with `reviewDecision === ''` normalized to `'NONE'` and copilot threads identified by the verified `copilot-pull-request-reviewer` login.

`displayPhase = manualPhase ?? derivedPhase`. Badges always reflect real facts regardless of where a card is parked, so a card moved to Merge via the card menu still shows a red CI badge.

Badges: `live` · `stale-spawn` · `plan-ready` · `dirty:N` · `unpushed:N` · `ci:pending|success|failure` · `copilot:N` · `review:N` · `approved` · `pr:#N`.

`needsYou` is true when the next move is human: plan ready and unapproved; implement running with no live spawn; CI red; a review landed; merge unlocked.

---

## 7. Spawn model

`run-phase.ps1` is one parameterized setup → agent → cleanup chain:

```powershell
param([int]$Issue, [string]$Phase, [string]$Worktree, [string]$Branch,
      [string]$PromptFile, [string]$Agent = 'claude', [string]$Model)
. "$PSScriptRoot\common.ps1"
Ensure-Worktree -Issue $Issue -Worktree $Worktree -Branch $Branch
Write-RunningMarker -Issue $Issue -Phase $Phase -Pid $PID
try {
  Set-Location $Worktree
  Invoke-Agent -Agent $Agent -PromptFile $PromptFile -Model $Model
} finally {
  Clear-RunningMarker -Issue $Issue -Phase $Phase
}
```

Launched detached via `wt new-tab --title "#<issue> <phase>" -d <worktree> pwsh -NoExit -File ...`. The app records a `SpawnRecord` and returns immediately; it never awaits the tab.

**Ownership split** is `plan.md` §11.5 unchanged: scripts own worktrees, branches, markers, and `gh` reads; agents own planning, coding, reasoning about failures, and opening PRs via `/publish-pr`.

---

## 8. Server API

Per `plan.md` §13, with two additions: `GET /api/config` (phase list for lane rendering) and `GET /api/issues` (populates the manual-import picker). `POST /api/tasks/:issue/move` sets `manualPhase` from the card menu rather than a drag.

---

## 9. Build order

1. **Scaffolding** — repo skeleton, `git init`, package.json, tsx, Fastify hello-world, `paths.ts`, `config.ts`, `state.ts`, `slug.ts`, `install.ps1`.
2. **Orchestrator core, headless** — `worktree.ts`, `markers.ts`, `github.ts`, and the pure `reconcile.ts`. **Unit tests for `reconcile` written first.** Prove end-to-end with `cli.ts reconcile 3060` against real issues.
3. **Spawn — the riskiest piece, de-risked early.** `common.ps1`, `run-phase.ps1`, `prompt.ts`, `mc-planner.md`. Run a real planning session in a `wt` tab against a real Acme issue. Verify: the plan is written; killing the app mid-session loses nothing; `git status` in Acme stays clean.
4. **Server + board** — REST + SSE; lanes, cards, badges, drawer, move menu.
5. **Full pipeline** — repeatable Implement with custom instructions, one-click Publish via `/publish-pr`, CI and review gates read-only, manual Merge + worktree cleanup.
6. **Polish** — needs-you filter, spawn history, force-reconcile.

## 10. Verification gates

- `reconcile` unit-tested across every rule and every fallback, using hand-built `Facts`.
- Crash-safety: start a plan spawn, kill Node, let the agent finish, restart → task shows plan ready.
- Zero-footprint: `git -C C:\src\widgets status` clean after any full run.
- Real-data reconciler check: importing PR #3119's issue should derive `copilot_review` with 2 unresolved Copilot threads.

## 11. Out of scope

Generalization to other repos; auto-merge or anything that ships code without Or; Copilot's cloud coding agent; committing any of this tooling into Acme; drag-and-drop; session resume; auto-import.
