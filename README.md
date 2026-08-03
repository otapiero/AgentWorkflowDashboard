# Mission Control

A personal, local task cockpit for driving AI coding agents (Claude Code,
GitHub Copilot CLI, and Codex CLI) through the Acme development pipeline. One screen shows
where every task is and which need you; one click moves any task forward with
no retyped prompts.

Built for one machine and one repository (`acme/widgets`). Not
a general tool.

## The three principles

- **Deterministic scripts over agents.** Worktrees, branches, markers, and `gh`
  reads are done by scripts. Agents are reserved for cognition: planning, coding,
  reasoning about a review comment, opening a PR.
- **The app is a reconciler over durable facts.** The running app is never the
  source of truth. Truth lives on disk (plan files, phase markers) and in
  git/GitHub (branches, PRs, checks, reviews). Every phase is recomputed from
  those facts, so closing or crashing the app never loses state.
- **Zero footprint in the project repo.** No config, state, worktree, or marker
  is ever written into the Acme checkout. Prompts are delivered at spawn time;
  everything else lives under `%USERPROFILE%\.mc\`.

## Requirements

`node`, `git`, `gh` (authenticated), `wt` (Windows Terminal), `pwsh` 7+, and at
least one agent CLI — `claude`, `copilot`, and/or `codex`.

## Setup

```powershell
npm install
npm run build
powershell -File scripts\install.ps1   # seeds ~/.mc, installs mc-* commands
```

`install.ps1` copies the phase scripts and the `mc-*` command files, writes a
`config.yaml` from the example if none exists, and runs sanity checks (tools on
PATH, `gh` authenticated, repo path valid). Edit
`%USERPROFILE%\.mc\config.yaml` to match your machine.

## Running

```powershell
npm start       # serves the built UI from Fastify on http://127.0.0.1:4317
# or, for UI development with live reload:
npm run dev     # Vite dev server + Fastify
```

Then open http://127.0.0.1:4317. Stop the app with Ctrl+C — it loses nothing,
because state is re-derived from git/GitHub and the workspace on the next start.
Agent terminals opened by a spawn run independently and keep going after the app
closes.

## Choosing agent, model and effort

Every spawn resolves an agent, a model and a reasoning-effort level, strongest
wins:

1. **One-time** — in a task's drawer, "Run once with a different agent" applies
   to the next launch only.
2. **Per-task pin** — the drawer's "Pinned agent, model & effort" persists for
   that task.
3. **Per-phase default** — the **Agents** panel (top bar), or the chip on each
   lane header.

Model and effort choices are dropdowns driven by each agent's capabilities. Edit
the `models:` / `efforts:` lists under an agent in `config.yaml` if the CLI's
options change.

Codex runs in its interactive TUI with a workspace-write sandbox and on-request
approvals. Mission Control also grants the task's own directory with `--add-dir`
so Codex can write plan and marker artifacts without granting broad filesystem
access. Reasoning effort is passed as `-c model_reasoning_effort=...`.

Existing installations keep their `config.yaml`. To enable Codex without
replacing your repository settings, copy the `agents.codex` block from
`assets/config.example.yaml` into `%USERPROFILE%\.mc\config.yaml`; Codex
then appears automatically in every agent picker.

## Where agents open

The **Agents** panel also picks the launcher:

- **Windows Terminal** (default) — one titled tab per task.
- **VS Code** — opens the task's worktree in VS Code and runs the agent in the
  integrated terminal. The task lives in a generated `.code-workspace` under
  `~/.mc`, never in the repo checkout. The window is launched with
  `--disable-workspace-trust`, so a fresh worktree does not open in Restricted
  Mode and stall the run behind a trust prompt; that flag applies to the launched
  window only and does not change your trust settings for any other folder.

## Headless orchestrator

Every layer below the UI is usable and testable from the CLI:

```powershell
npm run mc -- doctor            # environment + tool check
npm run mc -- issues            # list open GitHub issues
npm run mc -- import 3060       # put an issue on the board
npm run mc -- reconcile 3060    # print derived phase, gates, badges
npm run mc -- facts 3060        # dump the raw gathered facts
npm run mc -- list              # reconcile the whole board
npm run mc -- spawn 3060 plan   # open a phase in a Windows Terminal tab
```

## How a spawn works

The app never parents an agent — a child would die with it. Instead it writes a
small spec file and launches a **detached** Windows Terminal tab running
`run-phase.ps1`, which:

1. ensures the task's worktree exists (fetching the latest `dev` first),
2. writes a `<phase>.running` marker containing its own PID,
3. hands the rendered prompt to the agent as an interactive session,
4. clears the running marker in a `finally` block when the session ends.

The app then forgets the tab and learns the outcome only by reconciling. The PID
in the running marker is what lets the board tell a live session apart from a
terminal that was closed.

### Prompt delivery

Claude Code 2.1.x surfaces user commands as *skills the model chooses to invoke*
rather than expanding them as text, so passing `/mc-planner 3060` as an initial
prompt does not reliably run the command (verified 2026-07-21). The installed
`~/.claude/commands/mc-*.md` files stay the single editable source of prompt
text; Mission Control reads them, strips the frontmatter, renders the task
context, and passes the result to the agent verbatim — the delivery path that
does work. Your repo's own `/publish-pr` is invoked by naming it in the prompt.

## Layout

```
src/
  shared/types.ts          vocabulary shared by every layer
  orchestrator/            deterministic core (no server required)
    reconcile.ts           PURE: Facts -> phase, gates, badges, needsYou
    facts.ts               gathers git + gh + markers into Facts
    worktree.ts github.ts  git and gh access
    markers.ts             durable phase signals with PID liveness
    spawn.ts               builds + launches the detached wt tab
    poller.ts              interval reconcile + SSE broadcast
    cli.ts                 headless harness
  server/                  Fastify REST + SSE, static hosting
  web/                     React board (instrument panel)
assets/
  claude/commands/mc-*.md  shared prompt sources, installed to ~/.claude/commands
  scripts/                 common.ps1, run-phase.ps1
  config.example.yaml
scripts/install.ps1
```

Runtime state lives entirely under `%USERPROFILE%\.mc\`
(`config.yaml`, `state.json`, `tasks/<issue>/`, `worktrees/issue-<n>/`).

## Testing

```powershell
npm test          # 179 unit tests
npm run typecheck
```

The reconciler is the main verification surface and is tested exhaustively
against hand-built facts and against the real recorded shapes of `gh` output.

## VS Code companion

The optional VS Code companion is packaged, installed, configured, updated, and
uninstalled as described in [its README](vscode-extension/README.md).
