> Historical. This is the original design record from when Mission Control
> was built for a single repository, kept for the reasoning it captures. It
> names that repository throughout; the shipped tool is repository-agnostic.

# Mission Control — Specification

**A personal, local task cockpit for driving AI coding agents through the Acme development pipeline.**

Owner: Or · Scope: personal tooling for the `widgets` (Acme) repo only · Status: draft v0.3

---

## 1. Problem & goal

Today, shipping one Acme task means manually running the same loop by hand: open an agent to plan, open another to implement, ask one to open the PR, watch CI, re-run an agent to fix CI, read Copilot's automatic review and fix it, read a teammate's review and fix that, then merge. The prompts and commands are almost always the same (`/publish-pr`, "see and fix CI", etc.), and running several tasks at once means constant context-switching and manual polling to know "where is each task and what needs me right now."

**Goal:** one local place where every task is visible as a card moving through the pipeline, showing live status pulled from GitHub, with the right agent and the right canned prompt one click away — so the repetitive typing, status-checking, and juggling disappear, and the human stays purely in the *manager* seat.

**Guiding principle — you are the manager, the app is your assistant.** By default nothing spawns or advances without an explicit click. The human decides when each step happens; the app removes the friction of doing it. A few *optional, opt-in* automations (e.g. auto-spawn a CI fixer when checks go red) can be enabled per step later, but the default is manual.

---

## 2. Design principles

These three principles shape every decision below.

### 2.1 Deterministic scripts over agent delegation
Anything that *can* be done reliably and **deterministically** by a script must be done by a script, not asked of an agent. Everything mechanical — creating a git worktree, checking out a branch, moving the plan file into place, marking a phase, pushing an already-made commit — is owned by the orchestrator's scripts. Agents are reserved for open-ended cognition: writing a plan, writing code, reasoning about a review comment.

**The test is determinism, not whether it "touches git."** Some git-heavy work is genuinely cognitive and must stay with an agent/skill — e.g. opening a PR the Acme way means checking the branch is in good state, exploring the diff, composing a good description from it, and merging `dev` in (possibly resolving conflicts). That is a *skill*, not a script (see §4, Publish — Acme already has a `/publish-pr` skill for exactly this). The split is more reliable and cheaper, and it shrinks what the agent must be told (see 2.3).

> Example: to isolate a task in its own git worktree, the app runs `git worktree add …` itself and then spawns the agent already inside that directory with "work only here" — rather than asking the agent to please create a worktree. The environment is prepared *for* the agent, deterministically.

### 2.2 The app is a reconciler over durable facts (crash-safe)
The running app is **not** the source of truth. Truth lives in durable facts that survive the app being closed or crashed:
- **Filesystem** — the task workspace on disk (attached `plan.md`, phase marker files).
- **Git / GitHub** — branch exists, commits pushed, PR open, checks green, reviews.

Every agent run is bracketed by wrapper scripts (§5) that write durable results on completion, independently of whether the app process is alive. On startup the app **reconciles**: it scans the workspace markers and queries GitHub, then recomputes each task's phase from those facts. So: start a planner → close the app → planner finishes and its wrapper attaches `plan.md` and writes a `plan.done` marker → reopen the app → the task correctly shows "plan ready." Nothing is lost.

### 2.3 Zero footprint in the project repo
None of this tooling — config, state, agent instructions, skills, prompts, worktrees, markers — may be committed to `widgets` or appear as untracked noise in its working copy. Agent instructions are delivered at spawn time via runtime flags and external asset files (§7), never via in-repo files like `./CLAUDE.md` or `.github/copilot-instructions.md`. Worktrees and the state store live under a personal folder outside the repo. Because scripts (not agents) do the bookkeeping (2.1), the agent needs almost no special in-repo instruction in the first place.

Note the difference between *our tooling's* instructions (must stay out of the repo) and the *project's own* skills that already live in Acme (e.g. the existing `/publish-pr` skill): the app is free to invoke those — they are part of the project and legitimately committed. Zero-footprint forbids adding Mission Control's files to the repo, not using the repo's own skills.

---

## 3. Core concepts

- **Task** — one unit of work, tied to a GitHub issue and (once opened) a branch + PR + dedicated worktree. Has a current phase, a per-task workspace folder, attached artifacts (plan, notes), and optional per-task overrides of agent/model/instructions.
- **Phase** — a stage in the pipeline (Plan, Implement, Publish, CI, Copilot review, Dev review, Merge). The set of phases is **configurable**.
- **Agent** — a terminal coding agent the app can spawn. Both **Claude Code** and **GitHub Copilot CLI** are supported and interchangeable — each is "a CLI you launch in a terminal with a prompt." `none/human` and `you` are also valid actors.
- **Skill** — a named, agent-run capability that performs multi-step *cognitive* work (e.g. Acme's existing `/publish-pr`, which checks branch state, explores the diff, writes a description, and merges `dev`). Invoked *through* an agent; deliberately distinct from a deterministic script.
- **Orchestrator** — the app's deterministic script layer that owns all mechanical operations (worktrees, branches, file moves, plain `gh` reads, markers). Does not require the GUI to run.
- **Spawn wrapper** — the bracketed command chain that runs *setup → agent → finalize* for a single agent session (§5).
- **Marker** — a small durable file the wrapper writes into the task workspace to record phase progress (e.g. `plan.done`), used for crash-safe reconciliation.
- **Gate** — the condition that lets a task advance out of a phase: **manual** (you click) or **automatic** (a readable GitHub signal). Manual is the default.
- **State store** — the personal record of all tasks, **outside the git repo**.
- **Board (GUI)** — the dashboard: lanes = phases, cards = tasks, plus a per-task detail drawer.

---

## 4. The pipeline (default — fully customizable)

Every row — including **who acts** — is editable, because agents and workflow change constantly. Phases can be added, removed, reordered, or reassigned.

| Phase | Default actor | How it starts | Gate to advance (default) |
|---|---|---|---|
| Plan | Claude Code (spawn) | You click **Plan** on an issue | Manual — plan attached & you approve |
| Implement | Claude Code (spawn, repeatable) | You click **Implement** (plan passed in) | Manual — you mark implementation done |
| Publish | Claude Code running the repo's `/publish-pr` skill | You click **Publish** | Auto — PR exists |
| CI | GitHub Actions (no agent) | On PR push | Auto — all checks green (red → you click to spawn a fixer) |
| Copilot review | Copilot bot → you/agent fix | Automatic on PR | Assisted — Copilot comments resolved |
| Dev review | Teammate → you/agent fix | Teammate reviews | Assisted — approved & threads resolved |
| Merge | You (always manual) | You click | — you merge yourself |

How this maps to how Or actually works:

- **Plan → attach → implement.** The planner writes its plan; the wrapper attaches it to the task workspace as `plan.md` and marks `plan.done`. Once attached and approved, the task sits in **Implement**, where one click spawns an implementer with the plan path already provided.
- **Implementation can be multiple sessions.** Implement is *repeatable*: spawn, stop, spawn again later. The task stays in Implement until **you** mark it complete — the app never decides that.
- **Per-spawn custom instructions.** Any spawn (especially Implement) can take extra ad-hoc instructions appended to the base prompt.
- **Publish is one click, but it is a *skill*, not a script.** Acme already has a `/publish-pr` skill that checks the branch is in good state, explores the changes, writes a good description from them, merges `dev` in, and opens the PR — judgment end-to-end. The app just triggers that existing skill through the configured agent; it does not reimplement it.
- **You always merge.** Never automated.

---

## 5. Execution model: worktrees + spawn wrappers

This is where principles 2.1 and 2.2 become concrete.

### 5.1 One worktree per task
When a task first needs a working copy (Plan or Implement), the orchestrator runs `git worktree add` deterministically, creating an isolated checkout at e.g. `%USERPROFILE%\.mc\worktrees\issue-142\` on the task's branch. Parallel tasks never collide, and the main repo working copy stays untouched. The worktree is removed by the orchestrator after merge. Tool artifacts (plan, markers) live in the task workspace under `.mc`, **not** inside the worktree, so the checkout stays clean.

### 5.2 Every agent run is bracketed
A spawn is not "launch agent." It is a script chain run in the terminal tab:

```
setup      →   run agent (interactive)   →   finalize
```

- **setup** (deterministic): ensure worktree exists & is on the right branch; place/refresh the plan path; write a `<phase>.running` marker.
- **run agent**: the interactive Claude Code / Copilot CLI session, prompt preloaded, that you talk to normally.
- **finalize** (deterministic): attach outputs to the workspace (e.g. copy the produced `plan.md`), write the `<phase>.done` marker, and where appropriate `git add/commit/push` and make `gh` calls.

Because this chain is an ordinary shell sequence running in the tab, **finalize completes whether or not the app/GUI is alive.** The app doesn't need to be watching.

### 5.3 Reconciliation makes it crash-safe
On startup and on refresh, the orchestrator recomputes each task's phase from durable facts, preferring markers but falling back to raw evidence:
- `plan.md` present (even if the `plan.done` marker is missing, e.g. terminal closed mid-finalize) ⇒ plan effectively ready.
- branch has pushed commits ⇒ implementation has real work.
- PR exists ⇒ published; checks state ⇒ CI gate; review state ⇒ review gates.

So closing the laptop, killing the app, or a terminal dying never corrupts state — the worst case is a manual "refresh/reconcile" that re-derives the truth.

### 5.4 Ownership split — script vs agent
| Operation | Owner |
|---|---|
| Create/remove git worktree, checkout branch | Script |
| Place plan file, attach outputs, write phase markers | Script (wrapper) |
| Push an already-made commit; read CI/review state; advance the board | Script |
| Write the plan content | Agent |
| Write / change code | Agent |
| Reason about & fix a review comment or CI failure | Agent |
| Open the PR — branch check, diff, description, merge `dev` | Agent / skill (`/publish-pr`) |

Rule of thumb: if the outcome is deterministic, a script does it; if it needs judgment, the agent (or a repo skill) does it — and even then inside an environment the scripts prepared. This is exactly why publishing a PR is a skill, not a script.

---

## 6. Agent abstraction

Both supported agents are terminal-native and driven the same way:

- **Claude Code** — `claude` (interactive) / `claude -p` (headless). Model selection; slash-command skills.
- **GitHub Copilot CLI** — `copilot` (interactive) / `copilot -p` (programmatic). GA since Feb 2026; agentic, reads issues/PRs, runs git/gh, uses MCP.

An **agent profile** in config declares: launch command, how to pass a prompt, how to pass a model, how to inject the plan path, and how to inject runtime instructions (§7). A phase references a profile by name. Swapping "who acts" = changing one field; adding a future agent = adding one profile. Spawns are interactive by default; headless (`-p`) is reserved for mechanical steps and future opt-in automations.

A phase's **actor** may be any of: an agent profile (`claude` / `copilot`); a repo **skill** invoked *through* an agent (e.g. `/publish-pr`); a deterministic `script`; `none` (external, like CI); or `you`. Skills are how genuinely cognitive multi-step work is run without pretending it's deterministic.

---

## 7. Agent instructions without touching the repo

Agents need a little context ("write the plan to this path", "work only in this worktree", "don't do git bookkeeping yourself"). This is delivered **without ever writing a file into the project repo** (principle 2.3):

- **Runtime injection at spawn** — the app builds the prompt and passes standing rules via flags such as Claude Code's `--append-system-prompt`, or inline in the prompt. Nothing persists in the repo.
- **External asset folder** — reusable prompt templates / skills live in `%USERPROFILE%\.mc\agent-assets\` and are referenced by path at spawn, never copied into the repo.
- **User-scoped agent config** — if a global instruction is ever needed, use the agent's *user-level* config (e.g. `~/.claude/`), which is global to the machine and not part of the project's git — not the repo-level `./CLAUDE.md` or `.github/copilot-instructions.md`.
- **Minimal by design** — because scripts do the board/git bookkeeping (§5), the agent rarely needs "how to mark the board" instructions at all; the instruction surface stays tiny, which is the safest way to avoid repo leakage.

---

## 8. Launching agents (Windows)

- **Mechanism:** each spawn opens a **Windows Terminal tab**, titled with the issue number (e.g. `#142`), `cd`'d into the task's worktree, running the setup→agent→finalize chain (§5.2) with the prompt preloaded. `wt` is cleanly scriptable and gives one interactive tab per task — ideal for parallel work.
- **Prompt delivery:** built from the phase template + task context (issue, branch, plan path, per-spawn custom instructions) + runtime instructions (§7).
- **VS Code option (later):** a saved terminal profile can run the same chain in the integrated terminal; reliable programmatic injection into VS Code's integrated terminal from outside is limited on Windows, so Windows Terminal is the v1 target.

---

## 9. GitHub integration (status & gates)

CI is **GitHub Actions**, so every gate signal is readable from one surface via `gh` / the API:

- **CI:** check-run state on the PR head → "all green?" gate; a red run surfaces on the card with a one-click "spawn fixer."
- **PR existence & metadata:** confirms Publish; links the card to the PR.
- **Copilot automatic review:** its comments/threads → the Copilot-review gate.
- **Dev review:** review decision + unresolved threads → the Dev-review gate.

**Auth:** the already-authenticated `gh`, or a local token with repo scope stored in config outside the repo. Reads are polled on an interval and on manual refresh (refresh also triggers reconciliation, §5.3).

---

## 10. State store (personal, never in git)

- Location: `%USERPROFILE%\.mc\`.
- Contents:
  - `config.yaml` — pipeline, agent profiles, token.
  - `state.(json|sqlite)` — tasks + current phase + history (a *cache* of reconciled truth, not the sole source).
  - `tasks/<issue>/` — per-task workspace: attached `plan.md`, notes, and phase markers (`plan.done`, …).
  - `worktrees/issue-<n>/` — isolated git worktrees.
  - `agent-assets/` — external prompt templates / skills.
- Nothing here is committed to Acme; the app only *reads* the repo's git to create worktrees and run agents.

---

## 11. The GUI

### 11.1 Board
Lanes = phases; cards = tasks. Each card shows issue #, short title, pinned agent chip, and a live status badge (queued / live terminal / CI running / N review comments / waiting on <name> / ready). A card turns "ready" (green) exactly when its gate is satisfied. A **"needs you"** filter surfaces only cards awaiting a human action.

### 11.2 Task detail drawer
Linked issue + PR, current phase, attached plan (viewable), spawn history, live CI checks and review state, and the **current-phase action buttons** — *Plan*, *Implement (+ optional custom instructions)*, *Publish*, *Spawn CI fixer*, *Open PR*, *Advance*, *Merge* (unlocked only when all gates pass).

### 11.3 Form factor
Local web app (runs on your machine, opens in the browser) — easiest way to build a rich board with live badges and a detail drawer, and trivially local.

---

## 12. Customization model

Everything workflow-shaped lives in `config.yaml`, editable without code:

```yaml
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
    actor: claude              # who acts — change freely
    spawnable: true
    prompt: |
      Read issue #{{issue}} and produce an implementation plan.
      Write it to {{planPath}}. Work only in {{worktree}}.
    gate: { type: manual }      # you approve

  - id: implement
    label: Implement
    actor: claude
    spawnable: true
    repeatable: true            # multiple sessions allowed
    prompt: |
      Implement issue #{{issue}} following {{planPath}}.
      Work only in {{worktree}}. {{customInstructions}}
    gate: { type: manual }      # you mark done

  - id: publish
    label: Publish
    actor: claude               # runs the repo's existing skill
    skill: '/publish-pr'        # cognitive: branch check, diff, description, merge dev, open PR
    gate: { type: auto, signal: pr_exists }

  - id: ci
    label: CI
    actor: none
    gate: { type: auto, signal: checks_green }
    onFail: { offerSpawn: fixer }   # opt-in, one-click, not automatic

  - id: copilot_review
    label: Copilot review
    actor: claude
    gate: { type: auto, signal: copilot_comments_resolved }

  - id: dev_review
    label: Dev review
    actor: claude
    gate: { type: auto, signal: approved_and_threads_resolved }

  - id: merge
    label: Merge
    actor: you
    gate: { type: manual }
```

Per-task overrides (different agent/model/instructions for one task) sit on the task record and win over the phase default.

---

## 13. Notifications (bonus)

When a card crosses into a "needs you" state — CI went red, a review landed, merge unlocked — fire a Windows toast and mark it in the "needs you" filter. Where most reclaimed time comes from when juggling parallel tasks. Nice-to-have, not required for v1.

---

## 14. Scope: v1 vs later

### v1 (minimum useful)
- Local web board with the default Acme phases and cards.
- State store + `config.yaml` outside the repo; reconciliation on startup/refresh (§5.3).
- Orchestrator scripts: worktree create/remove, branch checkout, plan attach, markers, `gh pr create`, GitHub reads.
- Spawn wrappers (setup→agent→finalize) so runs are crash-safe.
- One-click spawn of Claude Code / Copilot CLI into a Windows Terminal tab, prompt + runtime instructions preloaded (nothing written to the repo).
- Plan attachment; repeatable Implement; manual "mark done / advance"; one-click Publish.
- Manual advance everywhere; **nothing auto-runs.**

### Later / iterate
- Notifications (toast + "needs you" filter).
- Opt-in per-step automations (e.g. auto-spawn CI fixer on red).
- Full pipeline editing from the GUI (not just YAML).
- Per-task overrides in the UI.
- Spawn transcript capture / logs in the drawer.
- VS Code integrated-terminal launch option.
- Richer plan handling (versions; plan-vs-implementation diff).

### Explicitly out of scope
- Any generalization for repos other than Acme.
- Auto-merge or any action that ships code without Or.
- Driving Copilot's *cloud* coding agent (interactive Copilot CLI instead).
- Committing any of this tooling, or leaving untracked artifacts, in the Acme repo.

---

## 15. Open decisions (settle at build time)

- **Effort tier / first cut:** ship a status-only board first (visibility + one-click spawns, no gate engine) and grow the engine onto it, vs. build the whole v1 at once. *Deferred.*
- **State cache format:** JSON (simplest) vs SQLite (better history). Truth is reconstructable either way, so this is just the cache.
- **Tech stack:** likely a small Node/TypeScript orchestrator (spawns terminals, runs `gh`, owns scripts) + a lightweight web front-end. Confirm at build.
- **Finalize robustness:** how much the wrapper commits/pushes automatically vs. leaves to you; how aggressively reconciliation infers phase from raw git facts when markers are missing.
- **Trusting "resolved" gates** for Copilot/dev-review automatically vs. leaving them manual early on.

---

## 16. Success criteria

The tool succeeds if, on a normal day with several tasks in flight, Or can (a) open one screen and immediately see where every task is and which need him, (b) move any task forward with a single click and no retyped prompts, and (c) never manually poll CI or reviews — while still personally approving plans, implementations, and every merge; and if closing or crashing the app at any moment never loses or corrupts a task's state.