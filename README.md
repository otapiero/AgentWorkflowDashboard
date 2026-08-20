# Mission Control

A local, single-user cockpit for driving AI coding agents (Claude Code, GitHub
Copilot CLI, Codex CLI) through a GitHub issue-to-merge pipeline. One screen
shows where every task is and which need you; one click moves any task forward
with no retyped prompts.

Windows only. It leans on Windows Terminal, PowerShell 7 and the `gh` CLI, and
there is no plan to port it.

## The three principles

- **Deterministic scripts over agents.** Worktrees, branches, markers, and `gh`
  reads are done by scripts. Agents are reserved for cognition: planning, coding,
  reasoning about a review comment, opening a PR.
- **The app is a reconciler over durable facts.** The running app is never the
  source of truth. Truth lives on disk (plan files, phase markers) and in
  git/GitHub (branches, PRs, checks, reviews). Every phase is recomputed from
  those facts, so closing or crashing the app never loses state.
- **Zero footprint in the project repo.** No config, state, worktree, or marker
  is ever written into your own project checkout. Prompts are delivered at spawn
  time; everything else lives under `%USERPROFILE%\.mission-control\`.

## Requirements

`node`, `git`, `gh` (authenticated), `wt` (Windows Terminal), `pwsh` 7+, and at
least one agent CLI — `claude`, `copilot`, and/or `codex`. T3 Code is optional
and needed only for the `t3` launcher.

## Setup

```powershell
npm install
npm run build
powershell -File scripts\install.ps1
```

`install.ps1` seeds `%USERPROFILE%\.mission-control\` with the phase scripts and
the `mc-*` command files, and checks that `git`, `gh`, `wt` and `pwsh` are on
PATH and that `gh` is authenticated.

Then point it at a repository. Run this from inside the checkout you want to
drive:

```powershell
npm run mc -- init
```

`init` reads the repository owner, name and default branch from `git` and `gh`,
and your login from `gh api user`, and writes a ready `config.yaml`. Nothing to
fill in by hand, though everything in it is yours to edit.

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

A config written by an earlier version is never replaced. To add an agent the
template has gained since, copy its block from `assets/config.example.yaml`
into your project's `config.yaml` (`npm run mc -- project list` prints the
path); it then appears automatically in every agent picker.

### Marking a task done retires its checkout

Pin a task to **done** (drawer → Setup → Placement) and Mission Control removes
its worktree and drops the local branch. Before the checkout goes, anything git
still reports as uncommitted is copied into the task's own directory under
`tasks/<issue>/rescued-from-worktree/` — scratch notes, exported fixtures,
research an agent wrote beside the code. Cleanup never destroys work that was
never committed. Gitignored files are left alone, so build output and
`node_modules` are not dragged along.

A merged PR does **not** trigger this. That is GitHub's opinion about the code;
marking the task done is yours about the work, and you may still want the
checkout after the merge lands.

The branch is force-deleted because squash merges leave a branch's own commits
out of the base branch, so `git branch -d` would refuse every merged branch it
is handed.

Turn either half off in `config.yaml`:

```yaml
cleanup:
  onDone: true
  deleteBranch: true
```

### The pipeline is opinionated

`config.yaml` lets you relabel each phase, change which agent runs it, and
change its gate. It does not let you add, remove or reorder phases — the set
(`plan → implement → publish → ci → copilot_review → dev_review → merge`) is
built into the reconciler. If a phase does not apply to your project, set its
actor to `you` and its gate to `manual` and click through it.

## Where agents open

The **Agents** panel also picks the launcher:

- **Windows Terminal** (default) — one titled tab per task.
- **VS Code** — opens the task's worktree in VS Code and runs the agent in the
  integrated terminal. The task lives in a generated `.code-workspace` under
  `~/.mission-control`, never in the repo checkout. The window is launched with
  `--disable-workspace-trust`, so a fresh worktree does not open in Restricted
  Mode and stall the run behind a trust prompt; that flag applies to the launched
  window only and does not change your trust settings for any other folder.
- **T3 Code** — runs the phase as a thread in [T3 Code](https://github.com/pingdotgg/t3code),
  bound to the same worktree Mission Control already creates. T3 then reports whether a
  session is genuinely running and when it is blocked on an approval, which retires the
  PID guess for those phases. Mission Control never starts T3's server and never modifies
  T3 itself; it attaches to the one the desktop application already runs.

  One-time setup:

  1. Install T3 Code: `winget install T3Tools.T3Code`
  2. Start it, then **Settings → This environment → Authorized clients → Create link**,
     and copy the **"This machine"** pairing URL. It looks like
     `http://127.0.0.1:3773/pair#token=XXXXXXXX`.
  3. Save it to `%USERPROFILE%\.mission-control\t3-credential` **immediately** — the link is
     single-use and expires about three minutes after you create it. Paste the whole
     URL; Mission Control reads the token out of the fragment.
  4. Give each agent a `t3Instance` in `config.yaml` (`claude` → `claudeAgent`,
     `codex` → `codex`, `copilot` → `opencode`).
  5. `npm run mc -- doctor` reports whether each instance can actually run.

  The pairing token is spent on first use, but the access token it buys is good for
  30 days and is cached at `~/.mission-control/t3-token.json`, so restarting the board does
  not need a new link. When that token expires, `doctor` says so — the renewal runbook
  is [docs/t3-credential-renewal.md](docs/t3-credential-renewal.md).

  If **Create link** is missing, turn on network access for the environment — the
  `one-time-token` bootstrap method only exists once T3 is reachable beyond loopback.

  `copilot` through T3 is a substitution, not a passthrough: it runs OpenCode's agent
  loop using Copilot's models, and needs the `opencode` CLI installed and authenticated
  against a Copilot Pro, Pro+, Business or Enterprise subscription.

  T3 0.0.31 has no preview panel, so the board is not surfaced inside T3; open it in a
  browser as usual. See
  [the finding](docs/superpowers/notes/2026-08-07-t3-preview-panel-finding.md).

## Headless orchestrator

Every layer below the UI is usable and testable from the CLI:

```powershell
npm run mc -- init              # set up the repo you are standing in
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

1. ensures the task's worktree exists (fetching the latest base branch first),
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
does work. If your project has its own PR-publishing skill or command,
`mc-publish` will use it by name.

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
    paths.ts               install root vs per-project home
    init.ts migrate.ts     first-run setup and the legacy move
    cli.ts                 headless harness
  server/                  Fastify REST + SSE, static hosting
  web/                     React board (instrument panel)
assets/
  claude/commands/mc-*.md  shared prompt sources, installed to ~/.claude/commands
  scripts/                 common.ps1, run-phase.ps1
  config.example.yaml    template rendered by mc init
scripts/install.ps1
```

Runtime state lives entirely under `%USERPROFILE%\.mission-control\`: shared
`scripts/` and the T3 credential at the root, and one directory per repository
under `projects/<owner>__<name>/` holding `config.yaml`, `state.json`,
`tasks/<issue>/` and `worktrees/issue-<n>/`.

## Testing

```powershell
npm test          # 633 unit tests
npm run typecheck
```

The reconciler is the main verification surface and is tested exhaustively
against hand-built facts and against the real recorded shapes of `gh` output.

## VS Code companion

The optional VS Code companion is packaged, installed, configured, updated, and
uninstalled as described in [its README](vscode-extension/README.md).

## Licence

MIT — see [LICENSE](LICENSE).
