# Mission Control

A local, single-user cockpit for driving AI coding agents (Claude Code, GitHub
Copilot CLI, Codex CLI) through a GitHub issue-to-merge pipeline. One screen
shows where every task is and which need you; one click moves any task forward
with no retyped prompts.

Windows only. It leans on Windows Terminal, PowerShell 7 and the `gh` CLI, and
there is no plan to port it.

## Stacked pull requests

An issue can have several PR layers. Expand its Pull requests section to see
their branch order, checks, reviews and dependencies. Select a layer before
launching work. All layers share the issue's worktree. A launch switches that
checkout to the selected PR branch and uses its actual base branch. Commit or
stash uncommitted work before switching layers. Open Folder always opens the
issue checkout without switching branches or requiring a PR selection.

Attach a PR by URL if GitHub's issue links miss it. Detach superseded or invalid
entries, and keep PRs from other repositories as companion links. Fork PRs can
be displayed but cannot be launched through this app. Merging one layer leaves
the remaining layers active; marking the issue Done removes its owned
checkouts. Rebasing, retargeting and merging stay manual.

Status reads share batched GitHub GraphQL requests, with at most 20 selections
per batch and one status selection per unique PR. Discovery uses metadata only
and refreshes every five minutes. Large connections continue on later polls.
Selecting a layer and previewing its prompt make no GitHub requests. A newly
discovered PR gets full status on the next poll. Failed manual lookups retry
every five minutes and can be removed from the drawer.

After upgrading, rerun `powershell -File scripts\install.ps1` to update the phase
scripts. A pending terminal launch reserves the issue until the terminal starts.
If the terminal never opens, use Cancel pending launch before retrying; a delayed
cancelled terminal cannot start the agent with another run's prompt.

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

## Running

```powershell
npm start       # serves the built UI from Fastify on http://127.0.0.1:4317
# or, for UI development with live reload:
npm run dev     # Vite dev server + Fastify
```

After a frontend update, run `npm run build` once. Ordinary launches with
`npm start` or `start-mission-control.bat` reuse that build. Backend-only changes
need a server restart.

The Done view shows 50 tasks per page, and notes show 20 per page in each active
or settled section. Note search covers the complete saved text, and opening a
note shows its full body even when its card only shows a short preview.

Then open http://127.0.0.1:4317. Stop the app with Ctrl+C — it loses nothing,
because state is re-derived from git/GitHub and the workspace on the next start.
Agent terminals opened by a spawn run independently and keep going after the app
closes.

The pull request icon in the top bar counts open PRs waiting for your review in
the active repository, including requests to your teams. Click it for a compact
list of titles, authors and GitHub links. It updates every minute while the tab
is visible; opening the list or clicking Refresh checks again. Draft PRs are
excluded. If GitHub is unavailable, the last successful list stays visible with
a retry message.

Each waiting PR has an **Open for review** button. It checks out the PR's head
in a separate `review-pr-<number>` worktree and opens a VS Code window labeled
**Review PR #<number>**. Reopening keeps the existing checkout and local edits.
Local reviews stay in the list across restarts and after the GitHub review
request disappears. **Finish review** saves uncommitted and ignored files under
the project's `reviews/pr-<number>/rescued-from-worktree` directory, saves local
commits in `commits.bundle`, and removes the checkout. Disposable `node_modules`
directories are excluded. If cleanup fails, the review stays available to retry.
Finish review only manages the local checkout; submit your review on GitHub.

Merged PRs rest in the **Merged** column until you click **Mark Done** in the
task's Run tab. Mark Done moves the card to Done and removes its worktree,
including any uncommitted files, so commit or move anything you want to keep
first. If cleanup fails, the card stays in Merged and the drawer shows an error so
you can retry. Tasks you previously pinned to Done stay there.

## Choosing agent, model and effort

Every spawn resolves an agent, a model and a reasoning-effort level, strongest
wins:

1. **One-time** — in a task's drawer, "Run once with a different agent" applies
   to the next launch only.
2. **Per-task pin** — the drawer's "Pinned agent, model & effort" persists for
   that task.
3. **Per-phase default** — the **Agents** panel (top bar), or the chip on each
   lane header.

Model and effort choices are dropdowns driven by each agent's capabilities. The
model list is whatever the agent's account offers right now, read from T3's
provider caches (`~/.t3/caches`; Copilot's comes from OpenCode's
`github-copilot/` models), so a model an org admin withdraws disappears from the
picker on its own. Without T3 a built-in list is used. A `models:` list under an
agent in `config.yaml` pins the picker by hand; `efforts:` works the same way.
A saved default naming a model that is no longer offered is skipped rather than
sent to the CLI.

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
its worktree and drops the local branch. Nothing is copied out first:
uncommitted and gitignored files go with the checkout.

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

  Requires T3 orchestration protocol 2, verified with T3 Code 0.1.0. Status uses
  `GET /api/orchestration/shell` with `x-t3-orchestration-protocol: 2`. Launches use
  `orchestration.launchThread` over a short-lived authenticated WebSocket. The old
  `/api/orchestration/snapshot` and `/api/orchestration/dispatch` routes are no longer used.

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

  Open the board in a browser as usual. Mission Control does not configure a T3 preview.

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

## Repository notes and agent tools

Open **Notes** beside Board to capture a general note or link one to a task.
Task drawers also have a Notes tab. Notes contain plain text and an optional
title. Settle moves a note to the collapsed Settled section; Reopen returns it
to active notes. Completing or forgetting a task never deletes its notes.

The authoritative file is
`%USERPROFILE%\.mission-control\projects\<owner>__<repo>\notes.json`, separate
from board state and worktrees. `MC_ROOT` relocates the install, `MC_PROJECT`
selects a project, and `MC_HOME` overrides its home. The running server pins
that project until restart. An invalid store disables notes while the board
remains usable, and preserves the original file.

If notes report `NOTES_ALREADY_OPEN`, use the server already running for that
project. If ownership metadata is damaged, stop every server for the project
and back up `notes.json` before repairing the lock directories. Only after
confirming those processes have stopped, remove the damaged `notes.json.lock`
directory and its sibling `notes.json.lock.recovery` if present, then restart.
Never delete `notes.json` to clear a lock. For `NOTES_STORE_INVALID`, restore a
known good backup or repair the file while the server is stopped.

### Connect a local agent

Mission Control's HTTP server must be running for all MCP reads and writes.
Closing the browser is fine. Stopping the server produces `MC_UNAVAILABLE`;
the adapter never writes the data file itself. Its URL must be a loopback HTTP
origin, such as `http://127.0.0.1:4317`. It follows no redirects and checks the
repository on every request.

Run this preparation in PowerShell. Replace the installation path with your
stable Mission Control checkout, where you have run `npm install`. Use a
stable path rather than a task worktree that will later be removed.

```powershell
$mcInstall = (Resolve-Path 'C:\Tools\MissionControl').Path
$mcNode = (Get-Command node).Source
$mcTsx = Join-Path $mcInstall 'node_modules\tsx\dist\cli.mjs'
$mcCli = Join-Path $mcInstall 'src\orchestrator\cli.ts'

# Find the repository slug, for example acme__widgets.
& $mcNode $mcTsx $mcCli project list
$mcProject = 'acme__widgets'
$mcServerUrl = 'http://127.0.0.1:4317'
```

Start Mission Control for that repository in another terminal, or keep its
existing server running. The header should show the intended repository.
For a new server, select its project before launch:

```powershell
$env:MC_PROJECT = 'acme__widgets'
npm start
```

Run `npm start` from the Mission Control installation. If you already set
`MC_HOME`, that explicit home takes precedence over project selection.

Choose the registration command for your client. These add a user-scoped
entry with absolute Node, tsx, and CLI paths; no settings go into the managed
repository. Use a distinct server name and URL for each repository you serve.

```powershell
# Codex CLI, user configuration in ~/.codex/config.toml
codex mcp add mission-control-notes -- $mcNode $mcTsx $mcCli mcp --project $mcProject --server-url $mcServerUrl
codex mcp get mission-control-notes

# Claude Code, explicitly user-scoped
claude mcp add -s user --transport stdio mission-control-notes -- $mcNode $mcTsx $mcCli mcp --project $mcProject --server-url $mcServerUrl
claude mcp list

# Native GitHub Copilot CLI, user configuration in ~/.copilot/mcp-config.json
copilot mcp add mission-control-notes -- $mcNode $mcTsx $mcCli mcp --project $mcProject --server-url $mcServerUrl
copilot mcp list
```

The registration syntax follows the current official guides for
[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code](https://code.claude.com/docs/en/mcp), and
[Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).
Keep your client's normal tool approval settings. Read tools declare that
they are read-only; write approval remains the host's decision.

| Tool | Inputs and behavior |
| --- | --- |
| `tasks_list` | Optional `search`; lists current board issue numbers and titles |
| `notes_list` | `scope`: `all`, `general`, or `task`; task scope requires `taskIssue`. `status`: `active`, `settled`, or `all`, active by default. Optional `search` |
| `notes_get` | `id`; returns full text and the latest revision |
| `notes_create` | Required `body`; optional `title`, `taskIssue`, and UUID `clientRequestId`. Omitted or null task means General |
| `notes_update` | `id`, `expectedRevision`, and changed `title`, `body`, or `taskIssue`. Null title or task clears it |
| `notes_set_status` | `id`, `expectedRevision`, and `status`: `active` to reopen or `settled` |

Task numbers are GitHub issue numbers. An unknown supplied number returns
`TASK_NOT_FOUND`; use `tasks_list` to resolve a task named in prose. Titles
are capped at 240 characters and bodies at 64 KiB in UTF-8, with whitespace
preserved. Tool results include structured data and readable text.

Creation retries use the same UUID. If a creation response is uncertain, its
error includes `clientRequestId`. Retry with that ID and the exact original
body, title, and task association; generating another ID may create a second
note. For revision conflicts, read `currentNote` or call `notes_get` before
deciding on another edit. Uncertain updates are not retried automatically.

Example requests to your agent:

- "Save this as a general note: check the release timing."
- "Create a note for task 42: confirm the deployment order."
- "List the settled notes for task 42, then reopen the deployment note."

### T3 and OpenCode

Native Copilot registration does not configure T3's Copilot provider. That
provider uses OpenCode and needs its own MCP entry in the configuration loaded
by that OpenCode process. Codex and Claude providers may also use different
configuration roots; check the provider's environment before assuming they
share native CLI settings.

For standalone OpenCode, merge the following `mcp` entry into its user config,
`~/.config/opencode/opencode.json`, preserving any existing settings. Replace
all three paths and the project slug with your values. A custom file outside
the repository can instead be selected with `OPENCODE_CONFIG`.

```json
{
  "mcp": {
    "mission-control-notes": {
      "type": "local",
      "command": [
        "C:/Program Files/nodejs/node.exe",
        "C:/Tools/MissionControl/node_modules/tsx/dist/cli.mjs",
        "C:/Tools/MissionControl/src/orchestrator/cli.ts",
        "mcp", "--project", "acme__widgets",
        "--server-url", "http://127.0.0.1:4317"
      ],
      "enabled": true
    }
  }
}
```

Check connection with `opencode mcp list`. See OpenCode's official
[MCP](https://opencode.ai/docs/mcp-servers/) and
[configuration](https://opencode.ai/docs/config/) guides. Standalone OpenCode
connection has been smoke-tested with disposable settings. T3 provider
loading and model-driven note calls in each host have not been verified.

## Layout

```
src/
  shared/types.ts          vocabulary shared by every layer
  shared/notes.ts          note input and response contracts
  orchestrator/            deterministic core (no server required)
    reconcile.ts           PURE: Facts -> phase, gates, badges, needsYou
    facts.ts               gathers git + gh + markers into Facts
    worktree.ts github.ts  git and gh access
    markers.ts             durable phase signals with PID liveness
    spawn/                 builds + launches the detached wt/vscode/T3 run
    poller.ts              interval reconcile + SSE broadcast
    paths.ts               install root vs per-project home
    init.ts                first-run setup
    cli.ts                 headless harness
  server/                  Fastify REST + SSE, static hosting
    app.ts                 the HTTP app, shared by the server and the e2e suite
    routes.ts              registers one *-routes.ts module per API area
  mcp/                     stdio tools calling the loopback notes API
  web/                     React board (instrument panel)
    styles/                one stylesheet per area, imported in cascade order
test/                      vitest unit + process suites
e2e/                       Playwright smoke tests over the real app
assets/
  claude/commands/mc-*.md  shared prompt sources, installed to ~/.claude/commands
  scripts/                 common.ps1, run-phase.ps1
  config.example.yaml    template rendered by mc init
scripts/install.ps1
```

Runtime state lives entirely under `%USERPROFILE%\.mission-control\`: shared
`scripts/` and the T3 credential at the root, and one directory per repository
under `projects/<owner>__<name>/` holding `config.yaml`, `state.json`, `notes.json`,
`tasks/<issue>/` and `worktrees/issue-<n>/`.

## Testing

```powershell
npm test          # unit and process suites (vitest)
npm run test:e2e  # builds the UI, then Playwright smoke tests in Chromium
npm run typecheck
```

The reconciler is the main verification surface and is tested exhaustively
against hand-built facts and against the real recorded shapes of `gh` output.
The e2e suite drives the built UI against the real server over a throwaway
project (`e2e/server.ts`), so it never touches GitHub or your own install.
What makes a test worth keeping is set out in [AGENTS.md](AGENTS.md).

## VS Code companion

The optional VS Code companion is packaged, installed, configured, updated, and
uninstalled as described in [its README](vscode-extension/README.md).

## Licence

MIT — see [LICENSE](LICENSE).
