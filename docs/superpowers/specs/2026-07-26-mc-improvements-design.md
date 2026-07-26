# Mission Control improvements — done-freeze, usage tracker, plan editor

**Date:** 2026-07-26
**Status:** approved design, pending implementation plan

Three independent, cohesive improvements to Mission Control, chosen
together as one batch. They share no risky coupling and feed a single
implementation plan. Ordered by cost, cheapest first.

---

## Feature 1 — Freeze done missions (stop polling)

### Problem

A mission is `done` when its PR is `MERGED` (`reconcile.ts` `derivePhase`,
first rule). Nothing about being done stops the polling: every poll,
`reconcileAll` calls `gatherFacts` for every task, and `gatherFacts` only
short-circuits when there is *no branch and no worktree*. A merged mission
almost always still has its local branch (often its worktree), so it falls
through to `gatherGitFacts` plus a full `fetchBranchPr` GraphQL call **every
poll interval, forever** — re-learning a fact that can never change, and
spending rate limit to do it.

### Design

**State.** Add two fields to `TaskRecord` in `src/shared/types.ts`:

- `prState: PrState | null` — the last observed PR state (`PrState` is the
  existing PR-state union; reuse it).
- `mergedAt: string | null` — ISO timestamp when merge was first observed.

Both default to `null` for existing records (backward-compatible; the state
loader must not choke on records lacking them).

**Persist on observation.** In `reconcileAll` (`src/orchestrator/poller.ts`),
where the task record is already updated with `prNumber`/`prUrl`, also persist
`prState` from `facts.pr.state`. When it transitions to `MERGED` and `mergedAt`
is still null, set `mergedAt` to now. This rides the existing `dirty` + single
atomic `saveState` path — no new write machinery.

**Short-circuit.** `gatherFacts` (`src/orchestrator/facts.ts`) gains a first
check, before any I/O:

> If `task.prState === 'MERGED'`, return a synthesized merged `Facts` object —
> PR `{ exists: true, number: task.prNumber, url: task.prUrl, state: 'MERGED' }`,
> gates blanked, `checks: 'none'`, empty review, no markers-driven work — without
> calling `gatherGitFacts` or `fetchBranchPr`.

`reconcile` then derives `done` from the synthesized facts exactly as it does
today, so the card is visually identical. It just costs zero git and zero
GraphQL calls.

Merge is terminal (a merged PR never un-merges), so freezing permanently is
safe. Per the design decision, there is **no re-check button** and **no
auto-cleanup** — the card simply freezes in place in the done lane.

### Testing

- `reconcile`: add a case asserting a `MERGED` synthesized facts object yields
  `derivedPhase === 'done'` (extends the existing pure reconcile test surface).
- `gatherFacts`: with `prState: 'MERGED'` on the task, assert neither
  `gatherGitFacts` nor `fetchBranchPr` is invoked (inject fakes / spies) and the
  returned facts describe a merged PR.

### Cost

~1–2 hours.

---

## Feature 2 — Token usage tracker (observability, tokens only)

### Purpose

Pure observability: show how many tokens each MC-launched session and each
mission consumed. **Tokens only, no dollars** — the operator runs the `claude`
CLI on a Claude subscription, so a dollar figure would be a hypothetical
"as-if-API" number rather than money actually spent, while token volume is the
real signal (it is what burns against usage limits). No budgets, no limits, no
alerts.

### Data source (verified on the machine)

Claude Code writes per-session transcripts under
`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. Verified facts:

- A real MC session exists at
  `~/.claude/projects/c--Users-ouriel--mc-worktrees-issue-3130/`.
- Each assistant message line carries `usage` with `input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
- Each line carries `model` and an exact `cwd` field, e.g.
  `"cwd":"c:\\Users\\ouriel\\.mc\\worktrees\\issue-3130"`.
- One `.jsonl` file corresponds to one session.

Attribution is therefore by **exact `cwd` match** against
`worktreePath(issue)` — not fuzzy folder-name matching.

### Design

**New module `src/orchestrator/usage.ts`** — the only code that touches
`~/.claude/projects`. Responsibilities:

- Resolve the projects root (`~/.claude/projects`, overridable via an env var
  for tests, mirroring the `MC_HOME` pattern).
- For a given issue, find transcript lines whose `cwd` equals
  `worktreePath(issue)`. (Scan `.jsonl` files; a line's `cwd` is authoritative,
  so a folder-name heuristic is only an optimization, not correctness.)
- Per file (= one session), compute:
  - `tokens`: sum of the four usage fields across assistant messages.
  - `sessionId`, `model(s)` seen, `startedAt` / `endedAt` from line timestamps.
- Roll session totals up to a per-mission total.
- **Cache** parsed results keyed by file `(path, mtime, size)` so re-opening a
  drawer does not re-parse unchanged transcripts.

Return shape:

```ts
interface SessionUsage {
  sessionId: string;
  tokens: { input: number; output: number; cacheCreate: number; cacheRead: number; total: number };
  models: string[];
  startedAt: string;
  endedAt: string;
}
interface MissionUsage {
  total: SessionUsage['tokens'];
  sessions: SessionUsage[];
  tracked: boolean; // false when no transcripts matched (e.g. Copilot-only)
}
```

**Route.** `GET /api/tasks/:issue/usage` → `MissionUsage`, computed **lazily on
drawer open**. Deliberately *not* folded into the poll loop — parsing
transcripts for every task on every interval would defeat the point of Feature
1 and make polling expensive. The poll loop is unchanged.

**UI.** The drawer's existing **Sessions** section (`Drawer.tsx`) becomes
usage-aware:

- Fetch usage when the drawer opens (same lifecycle as the existing `plan`
  fetch), tolerating a slow/empty result.
- Header line: total tokens for the mission (with input/output/cache broken out
  or summarized).
- One line per session: time range · model · token total. Where a session's
  time range overlaps a recorded spawn in `spawnHistory`, annotate it with that
  spawn's phase (best-effort; never block on a match).
- When `tracked` is false (no matching transcripts — e.g. Copilot sessions),
  show a plain "usage not tracked for this agent" note instead of zeros.

### Scope boundaries

- Claude Code only. Copilot CLI does not expose equivalent transcripts;
  those sessions are shown as untracked, not as zero.
- No board-wide total in v1. If wanted later it is a thin aggregate over the
  same module; left out to keep v1 focused and cheap.

### Testing

The parser is the main new test surface and is pure over fixture JSONL:

- Summing the four usage fields across multiple assistant messages.
- Multi-session rollup to a mission total.
- `cwd` filtering — lines from a different `cwd` in the same folder are excluded.
- The `(path, mtime, size)` cache returns cached results and re-parses on
  change.
- `tracked: false` when no lines match.

### Cost

~1–1.5 days.

---

## Feature 3 — Plan editor (full-screen edit / preview)

### Problem

The plan is shown today as a read-only `<pre>` in a small drawer section
(`Drawer.tsx`), hard to read or change. The plan lives at
`~/.mc/tasks/<issue>/plan.md` (`paths.ts` `planPath`) — MC's own state
dir, **not** the Acme checkout — so editing it breaks no zero-footprint
guarantee. There is currently no write route.

### Design

**Write route.** `PUT /api/tasks/:issue/plan` with `{ content: string }` writes
to `planPath(issue)`, creating the file (and its task dir) if absent — so a
plan can be drafted before any agent has run. Returns the refreshed board (or
`{ ok: true }` and lets the client trigger a refresh), so the `plan-ready`
badge/gate flips automatically through existing reconcile logic once a
non-empty plan exists.

**UI.** The drawer's Plan section gains an **Expand** affordance opening a
full-screen overlay:

- **Edit / Preview toggle.** Edit is a large raw-Markdown textarea; Preview
  renders the Markdown.
- **Save** posts the content, then calls `onChanged()` to refresh the board;
  closing without saving discards. Warn on close with unsaved changes.
- Markdown rendering uses a small dependency (`marked`). Content is
  locally-authored and trusted (single-user local tool), so rendering is
  straightforward; keep the renderer output confined to the preview pane.

### Testing

- Route: round-trip write, create-if-absent (no task dir yet), and that a
  written non-empty plan makes `planReady` true on the next reconcile.
- Component: smoke test for the edit/preview toggle and that Save calls the
  API with the edited content.

### Cost

~half a day.

---

## Non-goals (this batch)

- No UI/UX quick-wins batch (archive lane, needs-you filter, rate-limit chip,
  keyboard nav) — deferred by the operator's selection.
- No dollar-cost estimation or budget limits.
- No Copilot usage tracking.
- No board-wide usage total in v1.
- No re-check or auto-cleanup for done missions.
