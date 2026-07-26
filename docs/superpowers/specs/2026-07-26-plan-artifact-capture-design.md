# Plan Artifact Capture — Validated Design

## Problem

When Mission Control spawns a planning agent, the agent plans "however it
normally would." Its normal workflow may pull in a planning tool of its own —
superpowers `brainstorming` (which writes a `docs/superpowers/specs/…-design.md`),
GitHub spec-kit (which scaffolds a `specs/` or `.specify/` tree), some other
framework, or nothing at all beyond `plan.md`. Every one of those produces
**side artifacts MC never sees.** The board's entire world is a single file:
`reconcile.ts` treats the plan phase as ready when `plan.md` exists. Design docs,
specs, and diagrams the run produced are invisible, unlinked, and — when written
into the Acme checkout — quietly break the zero-footprint guarantee.

We want the board to know about **every** artifact a planning run produced,
tied to its task, **without changing how the agent plans.**

## Goals

- Capture all files a planning run creates, regardless of which planning tool
  (if any) produced them.
- Surface them on the task card as clickable links.
- Flag artifacts that landed inside the Acme checkout so the user can act.
- Do it without instructing the agent *how* to plan or *where* to write.

## Non-goals

- Teaching MC about specific planning tools (superpowers, spec-kit, …). The
  design is deliberately tool-agnostic; no code branch names a tool.
- Auto-cleaning the checkout. MC copies, never deletes (the user commits things
  himself).
- Changing what makes the plan phase "ready" — `plan.md` remains the signal.

## Constraints honored

- **Zero footprint.** MC writes only under `%USERPROFILE%\.mc\`. The one
  in-repo touch is *reading* `git status`; nothing is written to the checkout.
- **Pure reconciler.** Artifacts become a *recomputed fact*, never stored state.
  All I/O stays in `gatherFacts`; the side-effecting collection lives in the
  poller (the impure loop), never in `reconcile`.
- **Non-interference.** The agent gets at most one *bracketing* line ("when
  done, run this"), never a constraint on how or where it plans. Capture works
  even if the agent ignores that line.

## 1. Core idea — one collection routine, two triggers

Capture is a filesystem **diff**, not a parse of any tool's output. That is what
makes it tool-agnostic: superpowers, spec-kit, freehand, and "nothing but
plan.md" all reduce to "these files appeared during the run."

The agent's sign-off command and the crash-safe fallback invoke the **same**
routine, `collectArtifacts(issue)`. It is idempotent — re-running only refreshes
the manifest.

## 2. Watch roots

Coverage equals the roots MC watches. Two natural sinks cover the realistic
universe, because a planning tool either writes relative to its working
directory (the repo) or is told to write into the task dir:

1. **Repo / worktree** — the agent's working directory. Detected via
   `git status --porcelain`, bounding the candidate set to changed/untracked
   files rather than scanning the tree.
2. **Task dir** — `~/.mc/tasks/<issue>/`, excluding MC's own files
   (`markers/`, `prompt.txt`, `plan.snapshot.json`, `artifacts/`,
   `artifacts.json`).

**Escape hatch:** an optional `artifactRoots: []` list in `config.yaml`, empty by
default (YAGNI). If a future tool writes to a third, arbitrary location, the user
points MC at it without a code change.

## 3. Data

### 3.1 `plan.snapshot.json` (the "before" picture)

Written by MC into the task dir **at spawn time** — MC owns the spawn, so this is
zero agent involvement and zero repo footprint. Records, per root, the set of
file paths present before the run. For the repo root it stores the pre-run
`git status --porcelain` set, so a checkout that was *already* dirty is not
miscredited to this run.

### 3.2 `artifacts.json` (the manifest)

```json
{
  "collectedAt": "2026-07-26T12:00:00Z",
  "trigger": "command",
  "artifacts": [
    {
      "name": "2026-07-26-foo-design.md",
      "storedPath": "artifacts/2026-07-26-foo-design.md",
      "origin": "repo",
      "originalPath": "C:/Users/…/Acme/docs/superpowers/specs/2026-07-26-foo-design.md"
    }
  ]
}
```

- `trigger`: `"command"` (agent signed off) or `"auto"` (poller fallback).
- `storedPath`: relative to the task dir. Collection **copies** each detected
  file into `tasks/<issue>/artifacts/`, so the manifest always points at a stable
  copy MC owns — even for repo-origin files whose originals may later change.
- `origin`: `"repo"` lights the "in checkout" badge; `"taskdir"` does not.

## 4. Collection routine — `collectArtifacts(issue)`

1. Read `plan.snapshot.json`. If absent (task predates this feature), fall back
   to "current task-dir contents + current untracked repo files" — unattributed
   but functional.
2. Diff each root against the snapshot → new/changed files = this run's
   artifacts.
3. Copy each into `tasks/<issue>/artifacts/`. A file that vanished between
   snapshot and collect is skipped; a locked/failed copy is logged and the
   manifest records the rest.
4. Write `artifacts.json`; drop the `plan.done` marker.

Never throws into the caller — the poller's existing per-task `catch` guards it,
but collection also fails soft internally.

## 5. Triggers

- **Belt — agent signs off.** The existing spawn prompt (same `{{planPath}}`
  render machinery) gains one line: *"When your plan is complete, run:
  `<mc-cli> collect <issue>`."* The issue number is baked in at render time — no
  context-guessing. This maps to a new `collect <issue>` subcommand on the
  existing CLI, which calls `collectArtifacts`. (A `/mc-plan-done` slash-command
  wrapper is optional sugar over the same line; not built here.)
- **Suspenders — agent didn't.** The poller already detects a stale plan spawn
  (a `.running` marker with no live process — see `computeBadges`). When a plan
  spawn ended **without** `plan.done`, the poller calls `collectArtifacts` with
  `trigger: "auto"`. Nothing is ever lost, matching the board's crash-safe
  design.

## 6. Facts, reconciler, badges

- **`gatherFacts`** gains one read: `artifacts.json` → `facts.artifacts:
  ArtifactRef[]` (empty when the file is absent). Stays read-only.
- **`reconcile`** stays pure: passes `artifacts` through to `DerivedState`, and
  adds a badge when any artifact has `origin: "repo"`:
  `{ kind: 'artifacts-in-repo', label: 'N in checkout', tone: 'warn' }`.
- `plan.md`-as-signal is unchanged; artifacts never gate a phase.

## 7. UI surfacing

The task card renders `derivedState.artifacts` as a small list of clickable
links, each opening its `storedPath` copy. The "N in checkout" badge sits with
the other badges. No new phase, no layout upheaval — a list plus a badge fed by
the new fact.

## 8. Error handling & degradation

| Situation | Behavior |
| --- | --- |
| Snapshot missing (old task) | Fall back to task-dir + untracked-repo scan, unattributed. |
| File gone between snapshot & collect | Skipped; not in manifest. |
| Copy fails (locked file) | Logged; manifest records the rest. |
| Collection error | Fails soft; poller per-task catch already guards the loop. |
| Agent never signs off | Poller auto-collects on stale-spawn. |

## 9. Testing

- `collectArtifacts` — unit tests against a temp `MC_HOME` + fake repo dir:
  snapshot → add files (task-dir case and repo-origin case) → assert manifest
  contents, `origin` tagging, and idempotency of a second run.
- `reconcile` — a case with `facts.artifacts` containing a `repo`-origin item
  asserts the `artifacts-in-repo` badge; a `taskdir`-only case asserts no badge.
  Keeps the pure reconciler the primary test surface, as today.

## 10. Decisions taken (divergences from prior design)

- **Partially reverses "no agent-driven marking."** The original build recorded
  *"No `/mc-mark-done` skill … no agent-driven marking."* This adds an *optional*
  agent sign-off (`collect`) — but it is belt-and-suspenders, not authoritative:
  the poller fallback means marking never depends on the agent remembering. The
  spirit of the original decision (never *rely* on the agent to mark) holds.
- **Copy-only, warn — never delete from the checkout.** Preserves the user's
  "I commit things myself" workflow; MC never mutates the repo.
- **Capture and surface in one feature.** Capture is useless until the artifacts
  are visible, so the task-card list ships with the capture.

## 11. Out of scope

- Deleting or moving in-repo originals.
- A dedicated `/mc-plan-done` slash command (the rendered CLI line suffices).
- Artifact-driven phase gating.
- Populating `artifactRoots` — the knob ships empty.
