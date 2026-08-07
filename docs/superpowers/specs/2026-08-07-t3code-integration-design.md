# T3 Code Integration — Validated Design

## Priority

Independence from the upstream project is the first requirement. T3 Code is
someone else's application, shipping multiple nightly releases a day at version
0.0.32. Mission Control must consume it the way it consumes `gh` — as an
external tool with a version-pinned interface — and must never fork it, patch
it, or vendor its source. Any part of this design that cannot survive an
upstream breaking change by *degrading* rather than *failing* must be redesigned
or deferred.

## Problem

Mission Control launches an agent by writing a spec file and handing a detached
Windows Terminal tab to `run-phase.ps1`. That works and is crash-safe, but the
launched session is opaque: the board learns nothing about it except whether a
recorded PID is still alive. Three costs follow.

1. **Liveness is a guess.** `<phase>.running` markers hold a pwsh PID. The
   reconciler checks the process still exists. That distinguishes "terminal
   closed" from "still open" — not "agent working" from "agent blocked".
2. **Approvals are invisible.** When an agent stops to ask permission, the board
   cannot know. The attention rail — the feature whose entire job is telling the
   operator what needs them — is blind to the most common reason a run stalls.
3. **Terminals scatter.** Each spawn opens its own window. Four tasks in flight
   means four terminals plus the board plus an editor, with nothing tying them
   together.

T3 Code is an agent-harness control surface with exactly the affordances that
are missing: per-thread session state, approval events, managed terminals, diff
and checkpoint views, and an in-app browser panel. It supports Codex, Claude and
OpenCode as first-class providers.

This design connects the two without owning any of T3 Code's code.

## Non-goals

- Forking, patching, or vendoring T3 Code.
- Replacing Mission Control's board. The board remains the cockpit.
- Moving durable pipeline history out of `~/.mc`.
- Removing the `wt` launcher or the VS Code companion. Both keep working.
- Live push updates. The first version polls, matching the existing reconcile
  loop. The WebSocket RPC stays available for a later change.

---

## 1. Integration surfaces

T3 Code publishes three interfaces intended for consumption from outside the
application. This design uses all three and touches nothing else.

### 1.1 REST API

Defined in T3's `packages/contracts/src/environmentHttp.ts`.

| Endpoint | Auth | Use |
| --- | --- | --- |
| `GET /.well-known/t3/environment` | none | discovery, version pin, capability report |
| `GET /api/auth/session` | none | auth posture; tells us how to pair |
| `POST /oauth/token` | credential in body | exchange a pairing credential for a bearer token |
| `GET /api/orchestration/snapshot` | bearer | projects and threads with session state |
| `GET /api/orchestration/threads/:threadId` | bearer | thread detail |
| `POST /api/orchestration/dispatch` | bearer | run an orchestration command |

The three orchestration endpoints sit behind T3's `EnvironmentAuthenticatedAuth`
middleware. The two well-known-style endpoints do not, which is what makes
discovery and diagnosis possible before any credential exists. All verified by
request against the running 0.0.31 server; see §2.2.

### 1.2 WebSocket RPC

`ws://<host>:<port>` exposes roughly seventy methods, including
`vcs.createWorktree`, `terminal.*`, `preview.*` and
`orchestration.subscribeThread`.

**Version 1 does not use the WebSocket at all.** It is documented here because
its method set is disjoint from the REST surface — `/api/orchestration/dispatch`
accepts only the `project.*` and `thread.*` command union, so every `vcs.*`,
`terminal.*` and `preview.*` operation is WebSocket-only. Nothing in this design
needs one. A later change may swap polling for `subscribeThread`, or reach for
`terminal.*`, and that is the point at which a WebSocket client becomes
necessary.

### 1.3 The `t3.json` project-script schema

T3 publishes a JSON Schema at `https://t3.codes/schema/t3.json` describing
project scripts. A script carries `name`, `command`, `icon`,
`runOnWorktreeCreate`, and optionally `previewUrl` and `autoOpenPreview`. The
last two open a URL in T3's in-app Chromium preview panel.

Scripts can be supplied two ways: a `t3.json` file at the workspace root, or the
`project.meta.update` orchestration command. **This design uses the command
only**, so nothing is written into the Acme checkout and Mission Control's
zero-footprint principle is preserved.

---

## 2. Architecture

One new module joins the orchestrator as a second external-facts source,
alongside `github.ts`. No existing module changes shape.

```
src/orchestrator/
  reconcile.ts   PURE            unchanged signature, richer Facts
  facts.ts                       + gathers T3 thread state
  github.ts      gh              unchanged
  markers.ts     disk            unchanged — still the durable history
  worktree.ts    git             unchanged — MC still owns the checkout
  t3.ts          NEW             discovery, auth, dispatch, snapshot
  spawn.ts                       launcher gains a third value
```

### 2.1 Discovery

T3's server writes its own runtime state to
`<state-dir>/server-runtime.json`, where `<state-dir>` defaults to
`~/.t3/userdata`. Verified live against the installed desktop build — the file
appeared at `C:\Users\ouriel\.t3\userdata\server-runtime.json` with exactly this
shape:

```jsonc
{ "version": 1, "pid": 5132, "host": "127.0.0.1", "port": 3773,
  "origin": "http://127.0.0.1:3773", "startedAt": "2026-08-07T09:09:13.504Z" }
```

Note that the desktop app keeps two separate directories: Electron's own
Chromium profile lives under `%APPDATA%\t3code`, while everything this design
reads lives under `~/.t3`. Only the latter matters.

`t3.ts` resolves the endpoint by:

1. reading that file (path overridable in `config.yaml` for a non-default
   `--state-dir`),
2. confirming `pid` names a live process — the same liveness discipline the
   phase markers already use,
3. probing `GET {origin}/.well-known/t3/environment`.

Any step failing means "T3 is not available", which is a first-class state, not
an error.

Mission Control **never spawns T3's server**. The desktop application owns its
own lifecycle. This preserves the principle that the app is never the parent of
a run: a phase started in T3 survives Mission Control closing, exactly as a
detached terminal does today.

### 2.2 Authentication

Verified live against the installed desktop build (T3 Code 0.0.31). The server
advertises its posture at `GET /api/auth/session`, which is itself
unauthenticated:

```jsonc
{ "authenticated": false,
  "auth": { "policy": "desktop-managed-local",
            "bootstrapMethods": ["desktop-bootstrap"],
            "sessionMethods": ["browser-session-cookie",
                               "bearer-access-token",
                               "dpop-access-token"],
            "sessionCookieName": "t3_session_3773" } }
```

Two consequences matter, and both contradict the simpler story assumed before
the server was running:

- **Loopback is not trusted.** `GET /api/orchestration/snapshot` returns `401`
  from `127.0.0.1` with no credential. Being on the same machine buys nothing.
- **Mission Control cannot bootstrap itself.** The only advertised bootstrap
  method is `desktop-bootstrap`, a handoff reserved for T3's own renderer, and
  the endpoint that mints credentials for other clients
  (`POST /api/auth/pairing-token`) is itself behind the authenticated
  middleware. There is no self-service path from unauthenticated to
  authenticated.

So the credential must be minted **once, by hand**, from T3's own UI — the
"Create pairing link" affordance in settings, which calls that endpoint from the
already-authenticated renderer and accepts a `label` and a `scopes` array.
Mint it with `orchestration:read` and `orchestration:operate`.

Mission Control stores that credential at `~/.mc/t3-credential` and
exchanges it for a bearer access token at `POST /oauth/token`, form-urlencoded:

```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<the pairing credential>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate
client_label=Mission Control
client_device_type=bot
client_os=windows
```

The reply is `{ access_token, issued_token_type, token_type: "Bearer",
expires_in, scope }`. Mission Control caches the token with its expiry in
memory only — never on disk — and re-exchanges when it is within a minute of
expiring or when any call returns `401`. Requests carry
`Authorization: Bearer <access_token>`.

A pairing credential that has been revoked from T3's client list, or that has
expired, fails the exchange. That is the same first-class "T3 is not available"
state as a missing runtime file, not an error: the board keeps working on PID
liveness. `npm run mc -- doctor` distinguishes the three cases — server absent,
credential absent, credential rejected — because they need different fixes.

The `unsafe-no-auth` policy would remove all of this. This design does not use
it, and `t3.ts` should refuse to treat it as a supported configuration.

### 2.3 Transport and validation

`t3.ts` uses `fetch` and hand-written zod schemas covering only the fields this
design consumes. It does not depend on `@t3tools/contracts` or
`@t3tools/client-runtime`; both are marked `"private": true` in T3's monorepo and
are not published to npm.

Every response is validated at the boundary. A validation failure is logged once
per interval and yields `undefined`, never a throw. This is the mechanism that
turns an upstream breaking change into lost liveness rather than a broken board.

---

## 3. Spawning a phase through T3

### 3.1 What is unchanged

`spawnPhase` keeps its entire front half: `resolveSpawnPlan` (the one-time /
per-task pin / per-phase default precedence), prompt rendering from
`~/.claude/commands/mc-*.md`, `writePromptFile`, and `writePlanSnapshot` for the
plan phase. Only the launch tail branches.

`LauncherKind` in `src/shared/types.ts` gains a third value:

```ts
export type LauncherKind = 'wt' | 'vscode' | 't3';
```

`run-phase.ps1`, `spawn.json` and `PROMPT_TOKEN` remain in place for the `wt` and
`vscode` launchers. They are simply not on the `t3` path.

### 3.2 Worktree ownership

**Mission Control creates the worktree, exactly as it does today.**
`ensureWorktree` runs unchanged on the `t3` path, producing
`~/.mc/worktrees/issue-<n>`. `worktreePath(issue)` therefore stays a pure
function of the issue number, and every path derived from it — markers,
artifacts, badges — keeps working without modification.

T3 is never asked to create a worktree. Its `bootstrap.prepareWorktree` option
is deliberately unused: it hard-codes `path: null` and chooses its own directory
under `~/.t3/worktrees`, which would make the checkout location a lookup rather
than a derivation. The `vcs.createWorktree` RPC does honour a caller-supplied
path, but it is WebSocket-only (§1.2) and buys nothing here — T3 needs the
worktree's *path*, not its authorship. Git status, diffs and checkpoints all
operate correctly on a worktree T3 did not create.

### 3.3 The dispatch call

With the worktree present, one call creates the thread and starts the turn:

```jsonc
POST /api/orchestration/dispatch
{ "type": "thread.turn.start",
  "commandId": "<uuid>",
  "threadId": "<uuid>",
  "message": { "messageId": "<uuid>", "role": "user",
               "text": "<MC's rendered prompt>", "attachments": [] },
  "runtimeMode": "approval-required",
  "interactionMode": "plan",
  "bootstrap": { "createThread": {
      "projectId": "<acme project id>",
      "title": "#3060 plan",
      "worktreePath": "C:\\Users\\ouriel\\.mc\\worktrees\\issue-3060",
      "branch": "ouriel/3060-Add-…",
      "modelSelection": { "instanceId": "codex", "model": "gpt-5.6-sol",
                          "options": [{ "id": "effort", "value": "high" }] },
      "runtimeMode": "approval-required",
      "interactionMode": "plan",
      "createdAt": "2026-08-07T…" } },
  "createdAt": "2026-08-07T…" }
```

`bootstrap.createThread.worktreePath` is passed straight through to the thread,
which is what binds the agent's working directory to Mission Control's checkout.

The project is created once, lazily, on the first `t3` spawn:
`project.create` with `workspaceRoot` set to `config.repo.path`. Its id is
persisted in `state.json` so later spawns reuse it.

### 3.4 Agent, model and effort

The three-tier resolution is unchanged. Only its output format changes: instead
of CLI flags it renders a `ModelSelection`.

```ts
{ instanceId: string,                             // which configured provider
  model: string,
  options?: Array<{ id: string, value: string | boolean }> }
```

`buildAgentArgs` gains a sibling, `buildModelSelection`, driven by the same
agent profile. Reasoning effort becomes `options: [{ id: 'effort', value }]` —
the canonical array shape. The per-CLI flag divergence that `buildAgentArgs`
exists to absorb (claude's positional prompt versus copilot's `-i`) is not
Mission Control's concern on this path; T3's provider drivers handle it.

Agent names map to T3 provider instances through a new `t3Instance` key on each
agent profile in `config.yaml`:

| MC agent | `t3Instance` | Notes |
| --- | --- | --- |
| `claude` | `claudeAgent` | direct |
| `codex` | `codex` | direct |
| `copilot` | `opencode` | OpenCode authenticated to a GitHub Copilot subscription |

The Copilot route is a substitution, not a passthrough: it runs **OpenCode's
agent loop using Copilot's models**, not the GitHub Copilot CLI harness that the
`wt` launcher drives. It requires Copilot Pro, Pro+, Business or Enterprise;
Copilot Free does not authorize the endpoints OpenCode needs. An agent with no
`t3Instance` is not launchable through T3, and the board says so rather than
failing at dispatch.

Instance ids are validated at spawn time against the live provider list, so a
renamed or unconfigured instance produces a clear error instead of a rejected
dispatch.

### 3.5 Runtime and interaction modes

T3 carries two per-thread mode settings that Mission Control has no equivalent
for today:

- `runtimeMode`: `approval-required` | `auto-accept-edits` | `auto` | `full-access`
- `interactionMode`: `default` | `plan`

Both become per-phase settings in `config.yaml`, defaulting to:

| Phase | `runtimeMode` | `interactionMode` |
| --- | --- | --- |
| `plan` | `approval-required` | `plan` |
| `implement` | `auto-accept-edits` | `default` |
| `fix-review` | `auto-accept-edits` | `default` |
| `publish` | `approval-required` | `default` |

These defaults are a starting point chosen to match each phase's intent, not a
validated preference. They are configuration precisely so they can be tuned
after first use without a code change.

### 3.6 Thread model

**One thread per phase**, all bound to the same worktree. This preserves the
existing "fresh agent session per spawn" decision. Thread titles follow
`#<issue> <phase>`, so T3's sidebar groups them legibly.

The thread id is recorded in the `SpawnRecord` and persisted, which is what lets
the board link a card to its thread and lets `facts.ts` look up session state.

---

## 4. Facts and reconciliation

### 4.1 The new fact

`reconcile.ts` stays pure and its signature does not change. `Facts` gains one
optional field:

```ts
t3?: {
  threadId: string;
  sessionStatus: 'idle' | 'starting' | 'running' | 'ready'
               | 'interrupted' | 'stopped' | 'error';
  activeTurnId: string | null;
  awaitingApproval: boolean;
  lastError: string | null;
};
```

`facts.ts` populates it by fetching `GET /api/orchestration/snapshot` once per
reconcile interval and indexing threads by the ids recorded at spawn — one
request per interval regardless of task count, matching the existing GitHub
polling budget.

`awaitingApproval` is derived from the thread's latest activity carrying
`tone: "approval"`.

### 4.2 What the reconciler does with it

**`liveSpawn`** — currently derived from a pwsh PID in a `<phase>.running`
marker. It becomes:

```
liveSpawn = t3 ? (sessionStatus ∈ {starting, running} || activeTurnId !== null)
               : <existing PID liveness check>
```

The fallback is not vestigial. It covers `wt`- and `vscode`-launched phases, and
it covers a board running while T3 is down.

**`needsYou`** — gains `t3.awaitingApproval` as a new trigger. A thread blocked
on an approval request is precisely what the attention rail exists to surface,
and Mission Control has no way to detect it today.

**`t3.lastError`** surfaces on the card as a failure badge.

### 4.3 What stays on disk

Markers remain the durable history. `<phase>.done` files and the artifact
manifest under `~/.mc` continue to be written and continue to be the sole
input to phase derivation. T3 contributes *liveness and attention*, never
*history*.

The consequence is the intended one: wiping `~/.t3/userdata`, or T3 failing to
start, leaves the board able to reconstruct every task's phase correctly. It
simply cannot say what is running right now.

`<phase>.running` markers are still written on the `t3` path. They cost nothing,
and they keep phase-in-progress visible when T3 is unreachable.

---

## 5. The board inside T3 Code

On first `t3` spawn, Mission Control pushes a project script through
`project.meta.update`:

```jsonc
{ "id": "mission-control",
  "name": "Mission Control",
  "icon": "configure",
  "command": "curl -sf http://127.0.0.1:4317/health || echo 'Mission Control is not running'",
  "previewUrl": "http://127.0.0.1:4317",
  "autoOpenPreview": true,
  "runOnWorktreeCreate": false }
```

`command` is required by the schema, so it probes the board's existing `/health`
endpoint. This is deliberately not a launcher: T3 runs project scripts in a
worktree-scoped terminal, and starting the board from there would tie its
lifetime to a thread. The board is started as it is today.

The script is stored in T3's own database, not in the Acme checkout. Running
it opens the board in T3's in-app Chromium preview panel, beside the threads and
terminals.

This is desktop-only: the preview panel is an Electron `<webview>` and is
documented by T3 as ignored on the web build.

Board-side changes:

- Cards gain an **Open thread** action, enabled when a thread id is recorded.
- `RunTab` shows T3 session status and last error instead of only recording that
  a terminal was launched.
- The Agents settings panel gains `t3` in the launcher selector.

### 5.1 Verification status

Still the least-verified section. Reading T3's schema, contracts and desktop
preview code supports it, and the installed app does create a dedicated
`Partitions\t3code-preview-<hash>` session on first launch — so the webview
preview is real and separately partitioned. What remains unconfirmed is the only
thing that matters: whether the Mission Control board actually renders inside
that panel, and whether its SSE stream survives there.

Implementation must begin by confirming it — point a project script's
`previewUrl` at `http://127.0.0.1:4317` and look. This is the cheapest possible
check and it gates §5 only; §§2–4 stand independently of the outcome.

---

## 6. Failure modes

| Condition | Behavior |
| --- | --- |
| `server-runtime.json` missing, or its `pid` is dead | `t3` launcher reports T3 not running and offers a `wt` fallback for that spawn. Board reconciles normally without liveness. |
| Pairing credential missing, expired, or revoked | `doctor` fails loudly, naming which of the three it is, with "mint a new pairing link in T3's settings" as the remedy. Never silent, never retried in a loop. |
| A call returns `401` mid-session | One token re-exchange, then retry once. A second `401` degrades to T3-unavailable rather than looping. |
| Snapshot fails zod validation after an upstream upgrade | `facts.t3` is `undefined`; the board degrades to today's PID-based behavior. Logged once per interval, not per task. |
| Dispatch rejected (bad instance id, unconfigured provider) | Spawn fails with T3's error surfaced verbatim on the card. No marker is written; the phase is not consumed. |
| Thread deleted inside T3 | Markers still hold the history. The card shows the phase's true state; the thread link is disabled. |
| Worktree deleted behind T3's back | `ensureWorktree` recreates it on the next spawn, as today. The stale thread is orphaned and its link disabled. |

The governing rule: **an upstream change costs liveness, never correctness.**

---

## 7. Testing

- **Reconciler.** New `liveSpawn` and `needsYou` cases are pure additions,
  tested against hand-built `Facts` exactly like the existing suite. Both
  branches — `t3` present and absent — are covered.
- **`t3.ts`.** Tested against recorded snapshot and dispatch fixtures captured
  from a real T3 instance, mirroring how `github.ts` is tested against recorded
  `gh` output. Fixtures record the pinned version they came from.
- **Boundary validation.** A malformed-snapshot fixture asserts that
  `facts.t3` becomes `undefined` and nothing throws. This is the test that
  protects the degradation guarantee, and it is the one that must never be
  deleted.
- **`buildModelSelection`.** Pure, table-driven, one case per agent profile
  including the missing-`t3Instance` case.
- **Discovery.** Unit tests for missing file, dead pid, and unreachable origin.

---

## 8. Version pinning

`config.yaml` records the T3 Code version the fixtures were captured against.
`doctor` compares it to `serverVersion` from
`GET /.well-known/t3/environment` — unauthenticated, so this check works even
when pairing is broken — and warns, never blocks, on a mismatch. Upgrading T3 is
therefore an explicit act: re-record fixtures, run the suite, bump the pin.

The descriptor also carries a `capabilities` object, which the installed build
reports as:

```jsonc
{ "repositoryIdentity": true, "connectionProbe": true,
  "threadSettlement": true, "threadSnooze": true,
  "serverSelfUpdate": "desktop-managed" }
```

`doctor` should print it verbatim. It is upstream's own statement of what this
server can do, and it will grow.

Given upstream's release cadence (four nightly builds published on the day this
design was written; winget shipped 0.0.31), this is the single most important
operational discipline in the integration. Note that `serverSelfUpdate:
"desktop-managed"` means the app updates itself without asking — the pin will
drift on its own, which is exactly why `doctor` must check it rather than trust
it.

---

## 9. Scope

| Area | Estimate |
| --- | --- |
| `src/orchestrator/t3-auth.ts` — token exchange, caching, 401 retry | ~120 lines |
| `src/orchestrator/t3.ts` — discovery, snapshot, dispatch, validation | ~300 lines |
| `spawn.ts` — the `t3` branch, `buildModelSelection` | ~150 lines |
| `facts.ts` / `reconcile.ts` / `types.ts` | ~100 lines |
| `src/web` — Open thread, RunTab, launcher selector | ~150 lines |
| `config.example.yaml`, `install.ps1`, `doctor` | ~50 lines |
| Tests and fixtures | proportional |

**Explicitly out of scope:** the VS Code companion is untouched and keeps
working; live WebSocket subscriptions; T3's terminal, diff and checkpoint RPCs;
any change to the document workbench.
