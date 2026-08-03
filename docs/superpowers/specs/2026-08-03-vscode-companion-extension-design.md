# VS Code Companion Extension — Validated Design

## Priority

Performance is the first requirement. The extension must feel native, remain
effectively idle when Mission Control has nothing new to report, and stay small
enough that opening another VS Code window does not create meaningful resource
pressure. A feature that cannot meet the performance budgets in this document
must be optimized or deferred from v1.

## Problem

Mission Control already owns the difficult parts of the workflow: durable task
state, reconciliation, GitHub polling, worktree creation, prompt construction,
agent selection and agent spawning. VS Code is where the implementation work
happens, but the operator still moves between the dashboard and several editor
windows to answer four routine questions:

1. Which worktree belongs to this task?
2. What needs attention now?
3. Which phase, agent, model and effort should run next?
4. Did an agent, CI run or review state finish while another window was active?

The integration should remove that navigation and awareness cost without
creating a second orchestrator or moving durable state into VS Code.

## Goals

- Open any Mission Control task in its canonical worktree in a new VS Code
  window, preserving the current workspace.
- Put the current worktree first, a global attention queue second, and the full
  pipeline behind a collapsed explorer section.
- Start the Mission Control server automatically when it is not already
  available.
- Keep every VS Code window synchronized through the existing REST and SSE
  server.
- Launch a phase with server-provided agent, model and effort choices.
- Notify only on approved actionable state transitions, without replaying old
  notifications after restart.
- Meet explicit activation, latency, memory, CPU and package-size budgets.
- Package the extension as a locally installable `.vsix` with repository
  installation instructions.

## Non-goals

- Reimplementing reconciliation, GitHub polling, prompt construction, worktree
  management, task persistence or agent spawning in the extension.
- Embedding the full Mission Control dashboard in v1.
- Inline agent chat, editor decorations, source-control automation or automatic
  merge actions.
- Publishing to the public VS Code Marketplace in v1.
- Replacing the existing web dashboard or command-line workflow.
- Automatically stopping Mission Control or running agents when a VS Code
  window closes.

## Decisions

| Area | Chosen | Rejected or deferred |
| --- | --- | --- |
| Integration shape | Thin native companion using the existing server | Backend inside the extension |
| Primary layout | Worktree-first explorer | Pipeline-first explorer |
| Navigation | Open selected worktree in a new VS Code window | Replace the current workspace |
| Server lifecycle | Health-check and auto-start; server survives window closure | Server tied to one extension host |
| Synchronization | Initial REST snapshot plus one SSE stream per window | Continuous polling |
| Notifications | Actionable transitions only, persistently deduplicated | Notify on every refresh or badge |
| Launch flow | Phase, agent, model, effort, confirmation | Raw terminal command construction |
| Source of truth | Mission Control server and orchestrator | Extension-maintained task state |
| v1 distribution | Local `.vsix` | Marketplace publishing |

---

## 1. Architecture and ownership

The VS Code extension is a client of the existing Fastify server at
`http://127.0.0.1:4317` by default.

Mission Control continues to own:

- reconciliation and derived task state;
- GitHub polling and review/CI facts;
- durable files under `MC_HOME`;
- canonical worktree paths and worktree lifecycle;
- prompt resolution and task instructions;
- agent, model and effort validation;
- spawning Claude, Copilot, Codex and future configured agents.

The extension owns only editor integration:

- server discovery and optional startup;
- REST/SSE transport;
- an in-memory view of server state;
- current-worktree matching;
- native task navigation, commands and status;
- actionable notification delivery and deduplication.

All mutations go through REST. The extension never edits `config.yaml`, the
Mission Control state file, markers, plans or worktrees directly.

Closing a VS Code window disposes that window's connection and UI resources but
does not stop the server or agents. Multiple windows connect independently to
the same server and render the same authoritative state.

## 2. Extension package and component boundaries

The extension lives in an isolated `vscode-extension/` package so its build,
tests, dependencies and `.vsix` output do not complicate the existing web
application build.

### `MissionControlClient`

A typed boundary over the REST and SSE API. It loads health, config and tasks;
subscribes to `tasks` and `poll` events; invokes spawn; and translates HTTP or
transport failures into stable error values. It contains no VS Code UI code.

### `ServerManager`

Checks readiness, starts Mission Control when configured to do so, coordinates
startup across VS Code windows, records ownership of a process it launched and
reports lifecycle diagnostics. It never stops the server during normal
extension deactivation.

### `TaskStore`

Holds one normalized config/task snapshot and connection status. It applies an
incoming task payload by issue number, computes a minimal change set and emits
targeted events. Views consume its public selectors rather than interpreting
raw SSE messages independently.

### `WorkspaceMatcher`

Normalizes the current workspace folder and compares it for exact equality
with server-provided canonical worktree paths. It performs no directory scans
and no fuzzy issue-number matching.

### `MissionControlTreeProvider`

Builds the Current Worktree, Needs Attention and All Tasks sections. It keeps
stable tree item identities so one task transition refreshes only the affected
item and any section count that changed.

### `NotificationCoordinator`

Compares the previous and next structured task signals, emits only approved
transitions and stores a bounded atomic delivery ledger in the extension's
machine-wide global storage. It receives no initial `previous` state until the
baseline snapshot has loaded, preventing startup floods.

### `CommandController`

Registers navigation, launch, dashboard, server and diagnostic commands. It
reads current values from `TaskStore`, delegates network calls to
`MissionControlClient`, and owns all user-facing progress and error messages.

These units communicate through typed interfaces and can be tested without a
running VS Code window, except for the thin registration adapters.

## 3. Additive server contract

The existing routes remain authoritative:

- `GET /api/config`
- `GET /api/tasks`
- `GET /api/events`
- `POST /api/tasks/:issue/spawn`
- `POST /api/reconcile`

Two additive contract changes support a reliable, efficient extension.

### Health and compatibility

Add `GET /api/health`:

```ts
interface HealthResponse {
  status: 'ok';
  apiVersion: 1;
  serverVersion: string;
  pid: number;
  startedAt: string;
}
```

The extension checks `apiVersion` before enabling commands. A newer compatible
server may add fields; removing or changing a field requires an API version
change.

### Structured editor integration state

Extend each `TaskWithDerived` response and SSE task with an additive
`integration` field:

```ts
interface EditorIntegrationState {
  workspacePath: string;
  worktreeExists: boolean;
  liveSpawn: LiveSpawn | null;
  checks: ChecksState;
  review: {
    decision: ReviewDecision;
    unresolvedThreads: number;
    copilotUnresolved: number;
  };
  approvalRequired: boolean;
}
```

`workspacePath` is the deterministic result of the orchestrator's existing
`worktreePath(issue)` function, not the legacy nullable field on the stored task
record. The server populates the integration state from facts already gathered
during reconciliation. This must not add GitHub calls or a second filesystem
walk.

The extension uses structured fields for transitions. It must not parse badge
labels or `needsYouReason` prose. Existing web clients may ignore the additive
field.

## 4. Activation and server lifecycle

Activation performs only synchronous registration work. Network and process
operations begin asynchronously so the Extension Host is never blocked.

The connection sequence is:

1. Register views, commands and status placeholders.
2. Request `GET /api/health` from the configured server URL.
3. If healthy and compatible, load config/tasks and attach SSE.
4. If unavailable and auto-start is enabled, acquire the startup lock.
5. The lock owner starts `npm start` in the configured Mission Control
   installation directory. Other windows wait for health rather than spawning.
6. Poll health with a short bounded readiness schedule.
7. Load the REST baseline, connect SSE, then refresh once after SSE opens to
   close the snapshot/subscription race.

The startup lock is an atomic file in the extension's machine-wide global
storage. It contains an owner identifier and timestamp and expires after the
readiness timeout, so a crashed extension host cannot block future startup.

The manager stores the PID and health identity of a process it launched. The
`Restart Server` command may stop only a process whose current health identity
matches that stored ownership record. If the server was started externally,
the command explains that it will not terminate an unowned process and offers
diagnostics instead.

Closing a window never invokes restart or shutdown.

## 5. Native VS Code experience

The Activity Bar gains a Mission Control container with one worktree-first tree
view.

### Current Worktree

When a workspace folder exactly matches a task's `integration.workspacePath`,
the section shows:

- issue number and title;
- display phase;
- live agent state;
- resolved agent, model and effort;
- View Session, Run Phase and Open Dashboard actions.

When the current workspace is unrelated to Mission Control, the section says
so without treating it as an error.

View Session is enabled only when this window matches the task and a live spawn
exists. It reveals a terminal in the current Extension Host whose shell
integration working directory exactly matches `workspacePath`. If no such
terminal is available, the action remains disabled; v1 does not claim it can
attach to a terminal owned by another VS Code window.

### Needs Attention

A global queue contains tasks whose derived state needs the operator. Rows show
the issue, phase and concise structured reason. Selecting a row opens that
task's worktree in a new VS Code window.

The section is visible even when the current workspace belongs to a different
repository. It is sorted by severity, then most recent relevant transition,
then issue number for stability.

### All Tasks

Collapsed by default. Expanding it shows tasks grouped by configured pipeline
phase with a filter action and manual refresh. Stable ordering prevents rows
from jumping unnecessarily.

### Status bar

When the current workspace maps to a task, the status bar uses the compact
shape:

```text
#3060 · Implement | Codex · model | ● MC connected
```

When disconnected, the connection item changes visibly and offers Retry or
Show Logs. Task-specific commands are disabled until the server is ready.

### Commands

- `Mission Control: Open Task`
- `Mission Control: Run Current Phase`
- `Mission Control: Open Dashboard`
- `Mission Control: Restart Server`
- `Mission Control: Show Logs`

Selecting a task invokes VS Code's folder-opening command with
`forceNewWindow = true`. The extension passes the exact server-provided path
and never constructs or guesses it.

## 6. Phase launch flow

`Run Current Phase` and the equivalent task action use native sequential picks:

```text
phase → agent → model → effort → confirmation
```

- Only server-configured spawnable phases appear.
- Agent choices come from `GET /api/config`.
- Model and effort choices are filtered by the selected agent.
- The current task/phase defaults preselect valid values.
- Switching agents immediately clears a model or effort unsupported by the new
  agent, matching the dashboard's corrected behavior.
- Agents without effort support skip the effort step.
- Confirmation states the issue, phase, agent, model and effort before sending.

The final action calls `POST /api/tasks/:issue/spawn`. Mission Control remains
responsible for resolving defaults, validating the combination, constructing
the prompt, preparing the worktree and launching the terminal/session. A server
rejection is displayed verbatim in a concise error action with Show Logs.

## 7. Synchronization and notifications

Each VS Code window uses one REST baseline and one SSE connection. The task
store replaces its authoritative snapshot from `tasks` events and consumes
`poll` events only for freshness/connection metadata.

Notification comparisons begin only after the baseline exists. Approved
transitions are:

| Notification | Transition |
| --- | --- |
| Agent finished | Previous `liveSpawn` is non-null and current `liveSpawn` is null |
| CI failed | `checks` enters `failure` |
| CI passed | `checks` enters `success` and the CI gate can advance |
| Review comments arrived | Either unresolved review count increases |
| Approval required | `approvalRequired` changes from false to true |

Task removal does not produce an agent-finished notification. A reconnect that
returns the same structured state does not produce any notification.

Every delivered notification receives a fingerprint formed from issue,
notification kind, the current task's server-generated `lastReconciledAt`, and
the relevant state value/counter. That makes one transition identical in every
window while allowing a later fail-pass-fail cycle to notify again. A null
`lastReconciledAt` is not eligible to notify. Delivery uses a short atomic lock
around a newest-first ledger in machine-wide global storage. The first window
that records a new fingerprint may notify; concurrent windows see the recorded
value and remain silent. The ledger keeps at most 500 entries and is pruned only
when a new notification is written, so deduplication requires no background
timer. This prevents replay across windows and restarts without allowing
unbounded growth.

Notification actions are contextual:

- Open Worktree
- View PR when a PR URL exists
- Run Phase when the task is eligible
- Open Dashboard as the fallback

Users may disable all notifications or individual categories without changing
the attention queue.

## 8. Performance requirements

### Operating rules

- Keep one normalized task snapshot rather than duplicating task objects per
  view.
- Use one SSE connection per window and perform no background polling while it
  is healthy.
- Perform no recursive filesystem scan. Current-worktree matching is exact
  normalized path comparison.
- Batch bursts for at most one short UI frame and refresh only changed task
  items, affected section counts and the current-worktree item.
- Bound notification fingerprints, reconnect state and diagnostic history.
- Dispose every listener, stream, retry timer and UI registration on
  deactivation.
- Use capped exponential backoff with jitter only while disconnected.
- Coordinate cold startup so concurrent windows do not create competing server
  processes.

### Budgets

| Measurement | Required budget |
| --- | ---: |
| Synchronous extension activation | ≤ 50 ms from `activate` entry until control returns and asynchronous connection work is scheduled |
| View ready after an already-running server responds | ≤ 500 ms from successful health response to the first populated tree notification |
| SSE event to UI update dispatch | ≤ 100 ms from receipt of a complete `tasks` event to targeted tree/status events being fired |
| Added steady-state heap with 500 tasks | ≤ 25 MB retained-heap delta after GC in an isolated Extension Host |
| Idle CPU while connected | Effectively 0% between server events; no client-generated recurring timer |
| Packaged extension size excluding source maps | ≤ 500 KiB |
| Notification fingerprint storage | ≤ 500 entries |
| Reconnect delay | Exponential with jitter and a fixed maximum |

Cold server startup is measured separately because Node and Mission Control
startup time are outside synchronous extension activation. The editor must
remain responsive during that wait.

The performance suite uses a deterministic 500-task fixture and a burst fixture
that changes many tasks in one SSE payload. CI records the measurements at the
boundaries defined in the table, plus cache bounds and packaged size. Manual
acceptance records idle CPU after the connection reaches steady state.

## 9. Configuration

The extension contributes these settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `missionControl.serverUrl` | `http://127.0.0.1:4317` | REST/SSE origin |
| `missionControl.installationPath` | empty | Directory containing the Mission Control `package.json` |
| `missionControl.autoStart` | `true` | Start the server after a failed health check |
| `missionControl.notifications.enabled` | `true` | Master notification switch |
| `missionControl.notifications.agentFinished` | `true` | Agent transition alerts |
| `missionControl.notifications.ci` | `true` | CI failed/passed alerts |
| `missionControl.notifications.review` | `true` | Review comment/approval alerts |

If auto-start is enabled but no valid installation path can be resolved, the
extension shows Configure Installation rather than searching arbitrary parent
directories. The chosen path is validated by the expected package name and
start script before a process is launched.

## 10. Failure handling

### Server unavailable

Retain the last in-memory tree for the life of the window, mark it stale and
disable mutating commands. Show Retry, Configure Installation and Show Logs.
Do not repeatedly launch processes after a readiness timeout.

### SSE interrupted

Keep the last view, show a disconnected state and reconnect with capped
exponential backoff. After SSE reopens, fetch a REST snapshot before enabling
commands so missed events cannot leave the extension stale.

### API incompatibility

Disable task commands and report the expected and actual API versions. Do not
attempt best-effort mutations against an unknown contract.

### Missing worktree

If `worktreeExists` is false, do not call VS Code's open-folder command. Explain
that the worktree does not exist and offer Run Phase or Open Dashboard. The
extension never creates a worktree directly.

### Invalid launch selection

Prevent invalid model/effort selections client-side, then rely on the server as
the final validator. Surface the server error without silently substituting a
different model.

### Diagnostics

Use a dedicated Mission Control output channel for lifecycle, connection and
API errors. Do not log prompt bodies, custom instructions, environment values
or secrets. Normal SSE payloads are not logged.

## 11. Testing and verification

### Unit tests

- task normalization and minimal change sets;
- exact cross-platform worktree path matching;
- Current Worktree, Needs Attention and All Tasks selectors;
- agent/model/effort filtering and clearing on agent changes;
- every notification transition and startup suppression;
- bounded cross-window notification deduplication;
- startup lock acquisition, expiry and ownership checks;
- reconnect backoff, cancellation and disposal;
- health/API version compatibility.

### Server contract tests

- `/api/health` shape and version;
- additive integration state in REST and SSE task payloads;
- workspace path comes from the canonical orchestrator helper;
- integration state reuses gathered facts and causes no extra GitHub request;
- spawn requests for Claude, Copilot and Codex preserve selected model/effort.

### Extension-host tests

- activation and contribution registration;
- worktree-first tree rendering and incremental refresh;
- command enablement across connected/disconnected states;
- status bar behavior;
- task selection calls the new-window folder operation;
- settings changes reconnect or reconfigure only what changed;
- all disposables are released on deactivation.

### Performance tests

- enforce every automatable budget in section 8;
- process a 500-task snapshot without exceeding the heap budget;
- process a burst payload within the event-to-view budget;
- verify a steady healthy connection creates no polling timer;
- verify repeated reconnects and notifications keep bounded memory;
- fail packaging when the `.vsix` payload exceeds its budget.

### Manual acceptance

Run on Windows with:

- server already running;
- cold auto-start;
- two VS Code windows opening simultaneously;
- server restart and SSE interruption;
- a missing worktree;
- each notification type;
- Claude, Copilot and Codex phase launches;
- an agent switch from a model-bearing agent to one that does not support the
  selected model or effort;
- VS Code window closure while an agent continues running.

## 12. Acceptance criteria

The v1 extension is complete when:

1. All automated tests pass and every automatable performance budget is met.
2. Opening a task always uses the canonical path in a new VS Code window.
3. Current Worktree and Needs Attention answer the operator's primary questions
   without opening the dashboard.
4. The extension starts an unavailable server once, without duplicate launches
   from concurrent windows.
5. Closing VS Code leaves the server and agents running.
6. REST/SSE reconnects recover to an authoritative state without event replay.
7. Notifications occur only for the approved transitions and remain
   deduplicated across windows and restarts.
8. Launch picks contain only valid server-configured choices and switching
   agents clears incompatible selections.
9. Claude, Copilot and Codex launch successfully through the same generic path.
10. The repository produces an installable `.vsix` and documents installation,
    configuration, update and uninstall steps.

## Follow-up opportunities

After v1 proves useful and stays within its resource budgets, separate specs
may consider an embedded dashboard, inline session output/chat, editor
decorations, source-control actions, richer task creation and Marketplace
publishing. None of those are prerequisites for this companion.
