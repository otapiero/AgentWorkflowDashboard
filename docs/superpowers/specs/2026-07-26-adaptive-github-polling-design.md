# Adaptive, low-cost GitHub polling

## Problem

Mission Control polls GitHub every 30s and exhausts the GitHub API budget once
more than ~2 missions are in flight. The Acme repo is not ours to change, and
Mission Control must stay a standalone tool, so every fix lives on the Mission
Control side.

Two independent costs drive this:

1. **Per-branch query cost.** Each poll issues one GraphQL query per active task
   ([facts.ts:70](../../../src/orchestrator/facts.ts)). The query
   ([github.ts:270](../../../src/orchestrator/github.ts)) requests
   `pullRequests(first:10)` × `reviewThreads(first:100)` × `contexts(first:100)`
   — roughly 2,000 nodes, which GitHub prices at ~20 points. GraphQL's budget is
   5,000 points/hour, so at 120 polls/hour just ~2 active tasks reach the ceiling.
2. **Request burst.** N queries fire in parallel (`Promise.all`) every 30s, plus
   a separate `rateLimit` query. Bursts of concurrent requests can trip GitHub's
   secondary rate limit independently of the point budget.

## Goals

- Cut GitHub API consumption enough to stay well under budget with a realistic
  number of in-flight missions.
- Preserve current behavior for normal PRs and the existing crash-recovery /
  last-good resilience.
- No changes to the Acme repo; Mission Control stays standalone.

## Non-goals

- Config-driven cadence tiers. The new REST/DORMANT tiers are hardcoded
  constants (decision below). `pollIntervalSeconds` is retained as the FAST tier.
- REST/ETag conditional requests. The data path is GraphQL, where ETags do not
  meaningfully help; the point-cost and cadence work is where the savings are.

## Design

### 1. Cheaper query (per-branch cost cut)

In [github.ts](../../../src/orchestrator/github.ts), reduce the node counts in
`BRANCH_PR_QUERY` to what the parser actually consumes:

- `pullRequests(first:10)` → `first:1`. `parseBranchPrResponse` already selects a
  single PR, preferring OPEN. The only case this changes is a branch with a
  reopened/second PR where the newest is not the OPEN one; that edge case is an
  acceptable trade for a ~10× cost cut.
- `reviewThreads(first:100)` → `first:30`.
- `contexts(first:100)` → `first:30`.

Effect: ~20 points/branch → ~2–3 points/branch. No behavior change for normal PRs.

### 2. Batch all branches into one request

Restructure `reconcileAll` in [poller.ts](../../../src/orchestrator/poller.ts)
into two phases:

- **Collect** the set of branches needing a PR query — tasks that have a branch
  or worktree and are not already MERGED (MERGED tasks keep skipping the network
  entirely, as they do today in [facts.ts:45](../../../src/orchestrator/facts.ts)).
- **One GraphQL call** with aliased sub-selections — `b0:`, `b1:`, … one
  `pullRequests(headRefName: …, first:1)` block per branch, branch names passed
  as GraphQL variables (`$b0:String!`, …) rather than inlined, and `rateLimit`
  folded into the same request. Results are distributed back to tasks by matching
  alias index → branch.
- **Git facts stay per-task** (local, cheap) and continue to fail independently.

`gatherFacts` splits so the network PR fetch is lifted out of the per-task path:
the batched result is passed in as a `branch → BranchPrFacts` map (a branch not
present in the map, or a null/absent node, yields `noBranchPr()`).

Resilience: if the whole batched call fails, every active task loses its PR facts
for that poll, but `applyLastGood` in the poller already holds each task at its
last good place. Per-task error isolation for git facts is unchanged.

Effect: N requests/poll → **1** request/poll; the separate `fetchRateLimit`
round-trip is removed (folded into the batched query). Point cost for N branches
at first:1 / first:30 is ~60N/100 — e.g. 6 branches ≈ 4 points in one request,
versus ~120 points across 6 requests today.

### 3. Adaptive cadence (self-scheduling loop)

Replace the `setInterval` in `startPoller` with a `setTimeout` loop that, after
each reconcile completes, picks the next delay from live signals:

| Condition | Interval | Source |
|---|---|---|
| A tab is open **and** any task in flight | FAST | `pollIntervalSeconds` (config, 30s) |
| A tab is open, nothing in flight | REST = 120s | hardcoded constant |
| No tab open | DORMANT = 600s | hardcoded constant ("very slow") |

**In flight** means, for any task on the reconciled board, at least one of: an
open PR with CI pending, a live agent spawn running, or unresolved review gates —
all derivable from the reconciled `TaskWithDerived[]` the poller already holds.

Wiring:

- `startPoller` gains a `hasClients: () => boolean` handler; the server passes
  `() => broadcaster.size > 0`.
- The next-delay decision reads `hasClients()` and the just-reconciled board.
- On client connect, the server calls `poller.runNow()` so opening a tab after a
  dormant stretch refreshes immediately. The existing SSE replay
  ([sse.ts:14](../../../src/server/sse.ts)) still prevents a blank board in the
  meantime.
- A forced `runNow` (user action) reschedules the loop from "now" so the cadence
  timer does not fire a redundant poll right after.

## Combined effect (order of magnitude)

- Idle, no tab open: ~6 calls/hour.
- Tab open, at rest: ~30 calls/hour at ~3 points each.
- Tab open, 4 tasks in flight: ~120 batched calls/hour at ~10 points each
  ≈ 1,200 points/hour — comfortably under the 5,000 budget, where the current
  design reaches ~10,000+.

## Testing

- **`github-parse.test.ts`**: extend for the batched/aliased response shape —
  parsing multiple aliased branch nodes into a `branch → BranchPrFacts` map, and
  reading `rateLimit` folded into the same response. Keep the existing
  single-branch parser tests green (the per-branch fold logic is unchanged).
- **Poller cadence test**: the next-delay selection — in-flight board → FAST,
  at-rest board with clients → REST, no clients → DORMANT — and that a
  client-connect triggers `runNow`.

## Open risks

- **Alias/variable query construction** is built dynamically from the branch
  list. Branch names go through GraphQL variables, so `/` and other legal branch
  characters need no escaping. An empty branch set must short-circuit to a
  no-network poll (still emit the heartbeat).
- **first:1 PR selection** loses the reopened-branch preference for OPEN over
  newest. Documented and accepted above.
