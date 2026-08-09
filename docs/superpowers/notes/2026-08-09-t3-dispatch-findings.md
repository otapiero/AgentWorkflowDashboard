# What T3 actually accepts on /api/orchestration/dispatch

Verified against a running T3 Code **0.0.32** on 2026-08-09 by dispatching real
commands and reading the results back out of the snapshot.

This is the part of the plan that was never checked against a live server — the
payloads were built from schemas read out of T3's shipped bundle. Two of the
three assumptions were wrong, and both failed the same way: a `500` with
`reason: "orchestration_dispatch_failed"` and nothing else in the body.

## Read the traceId; T3 logs the real cause

The 500 body carries a `traceId`. That indexes straight into
`~/.t3/userdata/logs/server.trace.ndjson`, where the span for
`environment.orchestration.dispatch` carries an event holding the actual
`cause`. Both root causes below came from there in about a minute each. Do this
first; the HTTP response alone says nothing useful.

```bash
node -e '
const fs=require("fs"), rl=require("readline");
const s=rl.createInterface({input:fs.createReadStream("server.trace.ndjson")});
s.on("line",l=>{ if(l.includes("<traceId>")&&l.includes("cause"))
  (JSON.parse(l).events||[]).forEach(e=>console.log(e.name)); });
'
```

## 1. One active project per workspace root

```
OrchestrationCommandInvariantError, commandType 'project.create',
"Active project 'd0a5b45c-…' already exists for workspace root
 'c:\src\widgets'."
```

`launchT3` minted a fresh UUID and always created, so every spawn failed for
anyone who had already opened their repo in T3 — which is how you would try T3
out in the first place.

Now: recorded id → project T3 already has for this repo → only then create.
The lookup is case- and separator-insensitive, because T3 compares the
normalised path (its refusal quoted the root lowercased while the API returns
it cased), and it skips soft-deleted projects since those do not hold the
invariant.

## 2. `bootstrap.createThread` is not acted on

```
OrchestrationCommandInvariantError, commandType 'thread.turn.start',
"Thread 'b21d313d-…' does not exist for command 'thread.turn.start'."
```

The plan's design was one dispatch: `thread.turn.start` carrying
`bootstrap.createThread`, creating the thread and starting the turn together.

`bootstrap` **is** in the schema, and every field sent matched
`ThreadTurnStartBootstrapCreateThread` exactly:

```
projectId, title, modelSelection, runtimeMode, interactionMode,
branch (nullable), worktreePath (nullable), createdAt
```

So this was never a payload error — the dispatch path simply does not act on
`bootstrap`. There is a first-class `thread.create` command taking those same
fields plus `type`, `commandId` and `threadId`, so Mission Control now sends
two dispatches: create the thread, then start the turn in it.

Confirmed live: `thread.create` → `{"ok":true,"sequence":4}`,
`thread.turn.start` → `{"ok":true,"sequence":6}`, and T3 then tried to spawn
the provider in the worktree it was given.

## 3. Confirmed working, for the record

- The worktree binding holds. T3 spawns the provider process in exactly the
  `worktreePath` it is handed, so `worktreePath(issue)` stays a pure function
  of the issue number and markers/artifacts/badges keep working unchanged.
- A provider that cannot start lands in `session.lastError` on the thread,
  which is what feeds the `t3-error` badge. Observed verbatim:
  `ProviderAdapterProcessError … Failed to spawn Codex App Server process`,
  caused by the worktree path not existing.
- `thread.delete` works and is a **soft** delete: the thread stays in the
  snapshot with `deletedAt` set.

## Known gap

`toT3Fact` matches a thread by id without checking `deletedAt`, so a thread
deleted inside T3 while its last session said `running` would keep a card
showing live. `findProjectForWorkspace` already skips deleted projects; threads
should do the same.

## Version drift

T3 self-updated 0.0.31 → 0.0.32 mid-work, which `mc doctor` reported as a warn
rather than a block, exactly as designed. The snapshot still parsed: 0.0.32
added `threadPinning` and `threadTitleRegeneration` capabilities, absorbed by
the opaque `capabilities` record, and added `thread.pin`/`thread.unpin`
commands that Mission Control does not use.
