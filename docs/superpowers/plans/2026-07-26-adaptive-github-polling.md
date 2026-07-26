# Adaptive, low-cost GitHub polling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Mission Control's GitHub API consumption so it stays well under the 5,000 pts/hour GraphQL budget with several missions in flight, by shrinking the per-branch query, batching all branches into one request, and polling adaptively based on browser presence and in-flight work.

**Architecture:** One GraphQL request per poll fetches every active branch's PR (aliased sub-selections) plus the rate-limit block. A self-scheduling `setTimeout` loop replaces the fixed `setInterval`, choosing the next delay from three tiers: FAST (config `pollIntervalSeconds`, when a tab is open and work is in flight), REST (120s, tab open but at rest), DORMANT (600s, no tab open). A total batch failure holds all active cards at their last-good place via the existing `applyLastGood`.

**Tech Stack:** TypeScript (ESM, `.ts` imports), Node, Fastify, `gh` CLI via `execa`, Vitest.

## Global Constraints

- Language/module: TypeScript ESM; intra-repo imports carry the `.ts` extension (e.g. `import { gh } from './github.ts'`). Match this in every new import.
- No changes to the Acme repo; all work is inside this repo's `src/`.
- All GitHub access goes through the authenticated `gh` CLI via the existing `gh(args, cwd)` helper in `src/orchestrator/github.ts`. Do not add new HTTP clients or tokens.
- Pure parser functions stay separate from the functions that fetch, so they can be tested against recorded payloads without the network (existing convention in `github.ts`).
- FAST tier = `config.github.pollIntervalSeconds` (unchanged config field). REST and DORMANT tiers are hardcoded constants: `REST_MS = 120_000`, `DORMANT_MS = 600_000`.
- Reduced query node counts: `pullRequests(first:1)`, `reviewThreads(first:30)`, `contexts(first:30)`.
- Test runner: `npm test` (vitest). Typecheck: `npm run build` (or the project's tsc script).

---

### Task 1: Cadence decision helpers (pure)

Two pure functions decide, from the reconciled board and browser presence, how long to wait before the next poll. They live in `board.ts` alongside the other pure board helpers so they can be unit-tested with no I/O.

**Files:**
- Modify: `src/orchestrator/board.ts` (add `anyInFlight`, `nextDelayMs`, `REST_MS`, `DORMANT_MS`)
- Test: `test/poller-cadence.test.ts` (create)

**Interfaces:**
- Consumes: `TaskWithDerived` from `../shared/types.ts` (already has `derived.badges: Badge[]`, each `{ kind, label, tone }`).
- Produces:
  - `export const REST_MS = 120_000;`
  - `export const DORMANT_MS = 600_000;`
  - `export function anyInFlight(tasks: TaskWithDerived[]): boolean`
  - `export function nextDelayMs(tasks: TaskWithDerived[], hasClients: boolean, fastMs: number): number`

- [ ] **Step 1: Write the failing test**

Create `test/poller-cadence.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import {
  anyInFlight,
  nextDelayMs,
  REST_MS,
  DORMANT_MS,
} from '../src/orchestrator/board.ts';
import type { Badge, TaskWithDerived } from '../src/shared/types.ts';

/** Minimal board card carrying only the badges the cadence logic reads. */
function card(badges: Badge[]): TaskWithDerived {
  return {
    issue: 1, title: 't', slug: 's', branch: 'b', worktreePath: null,
    prNumber: null, prUrl: null, prState: null, mergedAt: null,
    manualPhase: null, spawnHistory: [], lastReconciledAt: null,
    pinned: { agent: null, model: null, effort: null },
    derived: {
      issue: 1, derivedPhase: 'ci', displayPhase: 'ci',
      gates: {} as never, badges, needsYou: false, needsYouReason: null,
    },
  };
}

const live: Badge = { kind: 'live', label: 'implement running', tone: 'busy' };
const ciBusy: Badge = { kind: 'ci', label: 'CI pending', tone: 'busy' };
const ciGood: Badge = { kind: 'ci', label: 'CI success', tone: 'good' };
const copilot: Badge = { kind: 'copilot', label: '1 Copilot', tone: 'warn' };
const review: Badge = { kind: 'review', label: '1 review', tone: 'warn' };
const approved: Badge = { kind: 'approved', label: 'approved', tone: 'good' };

describe('anyInFlight', () => {
  test('a live spawn is in flight', () => {
    expect(anyInFlight([card([live])])).toBe(true);
  });
  test('pending CI is in flight', () => {
    expect(anyInFlight([card([ciBusy])])).toBe(true);
  });
  test('unresolved Copilot or human review is in flight', () => {
    expect(anyInFlight([card([copilot])])).toBe(true);
    expect(anyInFlight([card([review])])).toBe(true);
  });
  test('a green, approved board at rest is not in flight', () => {
    expect(anyInFlight([card([ciGood, approved])])).toBe(false);
  });
  test('an empty board is not in flight', () => {
    expect(anyInFlight([])).toBe(false);
  });
});

describe('nextDelayMs', () => {
  const fast = 30_000;
  test('no clients means dormant regardless of work', () => {
    expect(nextDelayMs([card([live])], false, fast)).toBe(DORMANT_MS);
    expect(nextDelayMs([], false, fast)).toBe(DORMANT_MS);
  });
  test('clients + in-flight work means fast', () => {
    expect(nextDelayMs([card([ciBusy])], true, fast)).toBe(fast);
  });
  test('clients but nothing in flight means rest', () => {
    expect(nextDelayMs([card([ciGood])], true, fast)).toBe(REST_MS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- poller-cadence`
Expected: FAIL — `anyInFlight`/`nextDelayMs` not exported from `board.ts`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/orchestrator/board.ts` (after the existing exports):

```ts
/** Poll cadence tiers. FAST comes from config; these two are fixed. */
export const REST_MS = 120_000;
export const DORMANT_MS = 600_000;

/**
 * Whether any card is doing something worth watching at the fast cadence: an
 * agent spawn running, CI still pending, or an open PR with unresolved review
 * threads. Read from the derived badges the board already carries.
 */
export function anyInFlight(tasks: TaskWithDerived[]): boolean {
  return tasks.some((t) =>
    t.derived.badges.some(
      (b) =>
        b.kind === 'live' ||
        (b.kind === 'ci' && b.tone === 'busy') ||
        b.kind === 'copilot' ||
        b.kind === 'review',
    ),
  );
}

/**
 * How long to wait before the next poll. No open tab: dormant (very slow). A
 * tab is open: fast while work is in flight, otherwise rest.
 */
export function nextDelayMs(
  tasks: TaskWithDerived[],
  hasClients: boolean,
  fastMs: number,
): number {
  if (!hasClients) return DORMANT_MS;
  return anyInFlight(tasks) ? fastMs : REST_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- poller-cadence`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/board.ts test/poller-cadence.test.ts
git commit -m "Add pure cadence helpers: anyInFlight and nextDelayMs"
```

---

### Task 2: Batched, cheaper branch-PR query

Replace the single-branch GraphQL call with one aliased query covering every active branch, and fold the rate-limit block into the same request. Node counts drop to `first:1 / first:30 / first:30`. The parser is refactored so the per-branch fold logic is shared and the existing single-branch parser tests keep passing.

**Files:**
- Modify: `src/orchestrator/github.ts`
- Test: `test/github-parse.test.ts` (add `parseBranchPrsResponse` cases)

**Interfaces:**
- Consumes: existing `parseChecksRollup`, `normalizeReviewDecision`, `parseReviewThreads`, `parseRateLimit`, `BranchPrNode`, `BranchPrFacts`, `noBranchPr`, `gh`, `Config`, `RateLimit`.
- Produces:
  - `export interface BatchedBranchPrs { ok: boolean; byBranch: Map<string, BranchPrFacts>; rateLimit: RateLimit | null }`
  - `export function parseBranchPrsResponse(raw: unknown, branches: string[], copilotLogin: string): Map<string, BranchPrFacts>`
  - `export async function fetchBranchPrs(config: Config, branches: string[]): Promise<BatchedBranchPrs>`
  - `parseBranchPrResponse` keeps its current signature (now delegates to a shared `foldBranchPrNodes`).
- Removed from use: `fetchBranchPr` and `fetchRateLimit` are no longer called anywhere after Tasks 3–4. Delete both in Task 4's cleanup step (they are removed once no caller remains). This task leaves them in place.

- [ ] **Step 1: Write the failing test**

Add to `test/github-parse.test.ts` (import `parseBranchPrsResponse` in the existing import block, then append this describe block):

```ts
describe('parseBranchPrsResponse', () => {
  // The batched envelope: one aliased connection per branch, keyed b0, b1, ...
  const prNode = (state: 'OPEN' | 'CLOSED' | 'MERGED', number: number) => ({
    number,
    url: `https://x/pull/${number}`,
    state,
    reviewDecision: '',
    reviewThreads: { nodes: [] },
    commits: {
      nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }],
    },
  });

  test('maps each aliased connection back to its branch', () => {
    const raw = {
      data: {
        repository: {
          b0: { nodes: [prNode('OPEN', 11)] },
          b1: { nodes: [] },
        },
      },
    };
    const map = parseBranchPrsResponse(raw, ['feat-a', 'feat-b'], COPILOT);
    expect(map.get('feat-a')?.pr).toEqual({
      exists: true, number: 11, url: 'https://x/pull/11', state: 'OPEN',
    });
    expect(map.get('feat-b')?.pr).toEqual({
      exists: false, number: null, url: null, state: null,
    });
  });

  test('a branch missing from the response folds to no PR', () => {
    const map = parseBranchPrsResponse({ data: { repository: {} } }, ['x'], COPILOT);
    expect(map.get('x')?.pr.exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- github-parse`
Expected: FAIL — `parseBranchPrsResponse` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/orchestrator/github.ts`:

(a) Extract the fold logic. Replace the body of `parseBranchPrResponse` so it delegates to a new shared helper:

```ts
/** Fold one branch's PR connection nodes into facts (shared by both parsers). */
function foldBranchPrNodes(
  nodes: BranchPrNode[] | null | undefined,
  copilotLogin: string,
): BranchPrFacts {
  if (!nodes || nodes.length === 0) return noBranchPr();

  // Prefer an open PR; otherwise the most recent one (nodes are newest-first).
  const node = nodes.find((n) => n.state === 'OPEN') ?? nodes[0]!;
  const state = (node.state ?? null) as PrState | null;
  const pr = {
    exists: true,
    number: node.number ?? null,
    url: node.url ?? null,
    state,
  };

  // A merged or closed PR has no live gates worth reporting.
  if (state !== 'OPEN') return { ...noBranchPr(), pr };

  const contexts =
    node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  return {
    pr,
    checks: parseChecksRollup(contexts),
    review: {
      decision: normalizeReviewDecision(node.reviewDecision),
      ...parseReviewThreads(node.reviewThreads?.nodes, copilotLogin),
    },
  };
}

export function parseBranchPrResponse(
  raw: unknown,
  copilotLogin: string,
): BranchPrFacts {
  const nodes = (
    raw as {
      data?: { repository?: { pullRequests?: { nodes?: BranchPrNode[] } } };
    }
  )?.data?.repository?.pullRequests?.nodes;
  return foldBranchPrNodes(nodes, copilotLogin);
}

/** Fold a batched, aliased response into a branch -> facts map. */
export function parseBranchPrsResponse(
  raw: unknown,
  branches: string[],
  copilotLogin: string,
): Map<string, BranchPrFacts> {
  const repo = (
    raw as { data?: { repository?: Record<string, { nodes?: BranchPrNode[] }> } }
  )?.data?.repository;
  const map = new Map<string, BranchPrFacts>();
  branches.forEach((branch, i) => {
    map.set(branch, foldBranchPrNodes(repo?.[`b${i}`]?.nodes, copilotLogin));
  });
  return map;
}
```

(b) Add the batched fetch. Add a `BatchedBranchPrs` interface and `buildBatchQuery` + `fetchBranchPrs`, and reduce the node counts. Add this near the existing `BRANCH_PR_QUERY` / `fetchBranchPr`:

```ts
export interface BatchedBranchPrs {
  /** False when the whole request failed, so callers can hold at last-good. */
  ok: boolean;
  byBranch: Map<string, BranchPrFacts>;
  rateLimit: RateLimit | null;
}

/** The per-branch selection, shared by every alias in the batched query. */
const PR_FIELDS = `
  nodes{
    number url state reviewDecision
    reviewThreads(first:30){
      nodes{ isResolved comments(first:1){ nodes{ author{ login } } } }
    }
    commits(last:1){
      nodes{ commit{ statusCheckRollup{ contexts(first:30){ nodes{
        __typename
        ... on CheckRun{ status conclusion }
        ... on StatusContext{ state }
      } } } } }
    }
  }`;

/**
 * One GraphQL query for every active branch's PR at once, using aliases
 * (b0, b1, …) and one string variable per branch. `first:1` keeps each alias
 * cheap; the reduced first:30 counts cut the point cost ~10x versus first:100.
 * `rateLimit` is folded in so the budget read costs no extra round trip.
 */
function buildBatchQuery(count: number): string {
  const vars = ['$owner:String!', '$name:String!'];
  const aliases: string[] = [];
  for (let i = 0; i < count; i++) {
    vars.push(`$b${i}:String!`);
    aliases.push(
      `b${i}: pullRequests(headRefName:$b${i}, first:1, orderBy:{field:CREATED_AT, direction:DESC}){${PR_FIELDS}\n    }`,
    );
  }
  return `query(${vars.join(',')}){
  repository(owner:$owner,name:$name){
    ${aliases.join('\n    ')}
  }
  rateLimit { limit remaining resetAt }
}`;
}

export async function fetchBranchPrs(
  config: Config,
  branches: string[],
): Promise<BatchedBranchPrs> {
  // No active branch: no network at all this poll. The heartbeat still fires;
  // the budget simply reports null for this cycle.
  if (branches.length === 0) {
    return { ok: true, byBranch: new Map(), rateLimit: null };
  }
  try {
    const args = [
      'api', 'graphql',
      '-f', `query=${buildBatchQuery(branches.length)}`,
      '-f', `owner=${config.repo.owner}`,
      '-f', `name=${config.repo.name}`,
    ];
    branches.forEach((b, i) => {
      args.push('-f', `b${i}=${b}`);
    });
    const raw = JSON.parse(await gh(args, config.repo.path));
    return {
      ok: true,
      byBranch: parseBranchPrsResponse(
        raw,
        branches,
        config.github.copilotReviewerLogin,
      ),
      rateLimit: parseRateLimit(raw),
    };
  } catch {
    // The whole request failed. Report it so the poller holds active cards at
    // last-good rather than blanking every PR at once.
    return { ok: false, byBranch: new Map(), rateLimit: null };
  }
}
```

Note: `noBranchPr`, `parseChecksRollup`, `normalizeReviewDecision`, `parseReviewThreads`, `parseRateLimit`, `BranchPrNode`, `BranchPrFacts`, `gh`, and `PrState` already exist in this file; no new imports are needed beyond confirming `RateLimit` is in the type import list (it is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- github-parse`
Expected: PASS — new `parseBranchPrsResponse` cases pass and all existing `parseBranchPrResponse`, `parseChecksRollup`, `parseRateLimit` cases stay green (the fold logic is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/github.ts test/github-parse.test.ts
git commit -m "Add batched fetchBranchPrs with reduced query node counts"
```

---

### Task 3: `gatherFacts` reads from the batch, does no network

`gatherFacts` stops issuing its own GraphQL call and instead takes the batched result. An active task whose branch could not be fetched (`batch.ok === false`) throws, so the poller's existing per-task catch holds it at last-good. Merged and never-started tasks still short-circuit with no network.

**Files:**
- Modify: `src/orchestrator/facts.ts`
- Test: `test/facts-frozen.test.ts` (rewrite the mocks/assertions)

**Interfaces:**
- Consumes: `BatchedBranchPrs` from `./github.ts` (Task 2), `gatherGitFacts`/`worktreeExists` from `./worktree.ts`.
- Produces: new signature
  `export async function gatherFacts(config: Config, task: TaskRecord, branches: Set<string>, batch: BatchedBranchPrs): Promise<Facts>`

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `test/facts-frozen.test.ts`:

```ts
import { describe, expect, test, vi, beforeEach } from 'vitest';

const gatherGitFacts = vi.fn();

vi.mock('../src/orchestrator/worktree.ts', () => ({
  gatherGitFacts: (...a: unknown[]) => gatherGitFacts(...a),
  worktreeExists: () => true,
}));

import { gatherFacts } from '../src/orchestrator/facts.ts';
import type { BatchedBranchPrs } from '../src/orchestrator/github.ts';
import type { BranchPrFacts } from '../src/orchestrator/github.ts';
import type { Config, TaskRecord } from '../src/shared/types.ts';

const config = {} as Config;
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    issue: 3130, title: 't', slug: 's', branch: 'b', worktreePath: null,
    prNumber: 42, prUrl: 'https://x/pull/42', manualPhase: null,
    spawnHistory: [], lastReconciledAt: null, prState: 'MERGED',
    mergedAt: '2026-07-01T00:00:00Z', ...overrides,
  };
}
const openPr: BranchPrFacts = {
  pr: { exists: true, number: 42, url: 'u', state: 'OPEN' },
  checks: 'success',
  review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
};
function batch(over: Partial<BatchedBranchPrs> = {}): BatchedBranchPrs {
  return { ok: true, byBranch: new Map(), rateLimit: null, ...over };
}

beforeEach(() => {
  gatherGitFacts.mockReset();
});

describe('gatherFacts — merged freeze', () => {
  test('a merged task makes no git call and freezes its PR', async () => {
    const facts = await gatherFacts(config, task(), new Set(['b']), batch());
    expect(gatherGitFacts).not.toHaveBeenCalled();
    expect(facts.pr).toEqual({
      exists: true, number: 42, url: 'https://x/pull/42', state: 'MERGED',
    });
  });
});

describe('gatherFacts — active task', () => {
  beforeEach(() => {
    gatherGitFacts.mockResolvedValue({
      dirtyFileCount: 0, unpushedCommits: 0, hasPushedCommits: true,
    });
  });

  test('reads PR facts from the batch, not the network', async () => {
    const facts = await gatherFacts(
      config,
      task({ prState: 'OPEN', mergedAt: null }),
      new Set(['b']),
      batch({ byBranch: new Map([['b', openPr]]) }),
    );
    expect(gatherGitFacts).toHaveBeenCalledOnce();
    expect(facts.pr.state).toBe('OPEN');
    expect(facts.checks).toBe('success');
  });

  test('a failed batch throws so the poller can hold last-good', async () => {
    await expect(
      gatherFacts(
        config,
        task({ prState: 'OPEN', mergedAt: null }),
        new Set(['b']),
        batch({ ok: false }),
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- facts-frozen`
Expected: FAIL — `gatherFacts` still has the old 3-arg signature and imports `fetchBranchPr`.

- [ ] **Step 3: Write minimal implementation**

Edit `src/orchestrator/facts.ts`:

Change the import line
```ts
import { fetchBranchPr } from './github.ts';
```
to
```ts
import type { BatchedBranchPrs } from './github.ts';
```

Change the signature and body. Replace the parameter list and the network section:

```ts
export async function gatherFacts(
  config: Config,
  task: TaskRecord,
  branches: Set<string>,
  batch: BatchedBranchPrs,
): Promise<Facts> {
```

Then, in the body, after the block
```ts
  if (!hasBranch && !hasWorktree) return facts;
```
insert:
```ts
  // Active task, but the batched PR request failed this cycle: throw so the
  // poller's per-task catch holds this card at its last good place instead of
  // showing it as PR-less.
  if (!batch.ok) throw new Error(`branch PR batch unavailable for #${task.issue}`);
```

And replace
```ts
  // One GraphQL call yields the PR plus its checks, decision and threads; the
  // parser already blanks the gates for a merged or closed PR.
  const branchPr = await fetchBranchPr(config, task.branch);
  facts.pr = branchPr.pr;
  facts.checks = branchPr.checks;
  facts.review = branchPr.review;
  return facts;
```
with
```ts
  // The PR, its checks, decision and threads come from the one batched call the
  // poller already made this cycle. A branch with no PR simply is not in the map.
  const branchPr = batch.byBranch.get(task.branch);
  if (branchPr) {
    facts.pr = branchPr.pr;
    facts.checks = branchPr.checks;
    facts.review = branchPr.review;
  }
  return facts;
```

(`config` stays a parameter — `gatherGitFacts(config, …)` still uses it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- facts-frozen`
Expected: PASS — merged freeze makes no git call; active task reads batch facts; failed batch rejects.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/facts.ts test/facts-frozen.test.ts
git commit -m "gatherFacts reads PR facts from the batch instead of fetching"
```

---

### Task 4: Poller — collect branches, batch once, self-scheduling cadence

`reconcileAll` gathers the active branch set, makes the single batched call, threads the result into every `gatherFacts`, and returns the rate limit alongside the board. `startPoller` swaps its fixed `setInterval` for a `setTimeout` loop driven by `nextDelayMs`, and learns whether a browser is connected via a new `hasClients` handler. Dead code (`fetchBranchPr`, `fetchRateLimit`, the old `BRANCH_PR_QUERY`) is removed.

**Files:**
- Modify: `src/orchestrator/poller.ts`
- Modify: `src/orchestrator/github.ts` (delete now-unused `fetchBranchPr`, `fetchRateLimit`, `BRANCH_PR_QUERY`)

**Interfaces:**
- Consumes: `fetchBranchPrs` (Task 2), `nextDelayMs` + `anyInFlight` (Task 1), `gatherFacts(config, task, branches, batch)` (Task 3), `worktreeExists` from `./worktree.ts`.
- Produces:
  - `reconcileAll(config: Config): Promise<{ results: TaskWithDerived[]; rateLimit: RateLimit | null }>` (return type changes from `TaskWithDerived[]`).
  - `PollHandlers` gains `hasClients: () => boolean`.
  - `startPoller` / `Poller` public shape (`stop`, `runNow`) unchanged.

- [ ] **Step 1: Update `reconcileAll` to batch and return the rate limit**

In `src/orchestrator/poller.ts`:

Update imports:
```ts
import { applyLastGood, boardSignature, nextDelayMs } from './board.ts';
import { gatherFacts } from './facts.ts';
import { fetchBranchPrs } from './github.ts';
import { loadState, saveState } from './state.ts';
import { listBranches, worktreeExists } from './worktree.ts';
```
(Remove the `fetchRateLimit` import; add `fetchBranchPrs`, `worktreeExists`, and `nextDelayMs`. Keep the rest.)

Add `RateLimit` to the type import from `../shared/types.ts`.

Change the `reconcileAll` signature and add the collect+batch phase. Replace:
```ts
export async function reconcileAll(config: Config): Promise<TaskWithDerived[]> {
  // Load the board once and gather the branch list once, rather than re-reading
  // state and running `git branch -a` per task.
  const state = loadState();
  const phaseDefaults = state.phaseDefaults ?? {};
  const branches = new Set(await listBranches(config));

  let dirty = false;
  const results = await Promise.all(
    state.tasks.map(async (task): Promise<TaskWithDerived> => {
      try {
        const facts = await gatherFacts(config, task, branches);
```
with:
```ts
export async function reconcileAll(
  config: Config,
): Promise<{ results: TaskWithDerived[]; rateLimit: RateLimit | null }> {
  // Load the board once and gather the branch list once, rather than re-reading
  // state and running `git branch -a` per task.
  const state = loadState();
  const phaseDefaults = state.phaseDefaults ?? {};
  const branches = new Set(await listBranches(config));

  // One batched GraphQL call covers every active branch's PR plus the budget.
  // Active = not merged and actually started (has a branch or a worktree).
  const activeBranches = [
    ...new Set(
      state.tasks
        .filter(
          (t) =>
            t.prState !== 'MERGED' &&
            (branches.has(t.branch) || worktreeExists(t.issue)),
        )
        .map((t) => t.branch),
    ),
  ];
  const batch = await fetchBranchPrs(config, activeBranches);

  let dirty = false;
  const results = await Promise.all(
    state.tasks.map(async (task): Promise<TaskWithDerived> => {
      try {
        const facts = await gatherFacts(config, task, branches, batch);
```

Then change the two return points of `reconcileAll`. At the end, replace:
```ts
  if (dirty) saveState(state);
  return results;
}
```
with:
```ts
  if (dirty) saveState(state);
  return { results, rateLimit: batch.rateLimit };
}
```

(The per-task `catch` block that builds the `unreachable` fallback is unchanged — a thrown `gatherFacts`, including the new failed-batch throw, still lands there.)

- [ ] **Step 2: Update `runReconcile` to use the returned rate limit**

Replace:
```ts
  async function runReconcile(force: boolean): Promise<TaskWithDerived[]> {
    const [raw, rateLimit] = await Promise.all([
      reconcileAll(config),
      fetchRateLimit(config),
    ]);

    const applied = applyLastGood(raw, lastGood);
```
with:
```ts
  async function runReconcile(force: boolean): Promise<TaskWithDerived[]> {
    const { results: raw, rateLimit } = await reconcileAll(config);

    const applied = applyLastGood(raw, lastGood);
```

- [ ] **Step 3: Add `hasClients` to `PollHandlers` and swap to a self-scheduling loop**

Update the interface:
```ts
export interface PollHandlers {
  /** The full board. Sent only when it actually changed, or on a forced run. */
  onTasks: (tasks: TaskWithDerived[]) => void;
  /** The heartbeat: freshness and budget, sent on every poll regardless. */
  onPoll: (meta: PollMeta) => void;
  /** Whether at least one browser tab is currently connected. */
  hasClients: () => boolean;
}
```

Replace the interval/bootstrap tail of `startPoller`:
```ts
  timer = setInterval(() => {
    void exec(false);
  }, config.github.pollIntervalSeconds * 1000);

  void exec(false);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    runNow: () => exec(true),
  };
}
```
with a `setTimeout` loop that reschedules from the just-reconciled board:
```ts
  function scheduleNext(tasks: TaskWithDerived[]): void {
    if (timer) clearTimeout(timer);
    const ms = nextDelayMs(
      tasks,
      handlers.hasClients(),
      config.github.pollIntervalSeconds * 1000,
    );
    timer = setTimeout(() => void tick(), ms);
  }

  async function tick(): Promise<void> {
    const tasks = await exec(false);
    scheduleNext(tasks);
  }

  // Reconcile once immediately (crash recovery), then schedule adaptively.
  void tick();

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
    },
    runNow: () => {
      const settled = exec(true);
      // A forced run resets the cadence timer so the next tick is measured from
      // now, and picks up any change in client presence or in-flight work.
      void settled.then(scheduleNext, () => scheduleNext([]));
      return settled;
    },
  };
}
```
Also change the `timer` declaration comment/type is fine as `NodeJS.Timeout | null` (works for `setTimeout` too). No other change to `exec`, `active`, `lastSignature`, or `lastGood`.

- [ ] **Step 4: Delete the now-dead github calls**

In `src/orchestrator/github.ts`, delete the `BRANCH_PR_QUERY` constant, the `fetchBranchPr` function, and the `fetchRateLimit` function (all three now have no callers — `fetchBranchPrs` and `parseRateLimit` replace them). Keep `parseRateLimit` (used by `fetchBranchPrs`) and every parser.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npm run build`
Expected: no type errors (all `reconcileAll` callers updated; no references to deleted functions).

Run: `npm test`
Expected: PASS — `poller-cadence`, `github-parse`, `facts-frozen`, `poller-merge`, and every other existing test.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/poller.ts src/orchestrator/github.ts
git commit -m "Poller batches one PR request per poll and schedules adaptively"
```

---

### Task 5: Server wiring — client presence and refresh-on-connect

Give the poller a way to know a tab is open, and refresh once when the first tab connects after a dormant stretch.

**Files:**
- Modify: `src/server/index.ts` (pass `hasClients`)
- Modify: `src/server/routes.ts` (refresh on the 0→1 client transition)

**Interfaces:**
- Consumes: `Broadcaster.size` (already exists, `src/server/sse.ts:28`), `poller.runNow` (passed as `refresh` into routes), the new `PollHandlers.hasClients` (Task 4).
- Produces: no new exported surface.

- [ ] **Step 1: Pass `hasClients` into the poller**

In `src/server/index.ts`, update the `startPoller` call:
```ts
  const poller = startPoller(config, {
    onTasks: (tasks) => broadcaster.send('tasks', tasks),
    onPoll: (meta) => broadcaster.send('poll', meta),
    hasClients: () => broadcaster.size > 0,
  });
```

- [ ] **Step 2: Refresh when the first client connects**

In `src/server/routes.ts`, the `/api/events` handler currently ends with `broadcaster.add(reply);`. Replace that tail:
```ts
    reply.raw.write(': connected\n\n');
    // add() replays the latest tasks + poll payloads, so the tab paints at once
    // without forcing a fresh reconcile per connection.
    broadcaster.add(reply);
```
with:
```ts
    reply.raw.write(': connected\n\n');
    // The 0->1 transition means a tab opened after a dormant stretch: kick one
    // fresh reconcile so the board is current. add() still replays the last
    // payloads immediately, so the tab is never blank while that runs.
    const wasEmpty = broadcaster.size === 0;
    broadcaster.add(reply);
    if (wasEmpty) void refresh();
```

- [ ] **Step 3: Typecheck and full suite**

Run: `npm run build`
Expected: no type errors — `Deps.refresh` is already `poller.runNow`; `hasClients` satisfies the updated `PollHandlers`.

Run: `npm test`
Expected: PASS (unchanged from Task 4; this task is glue with no new unit).

- [ ] **Step 4: Manual smoke verification**

Because the loop and server glue have little branching logic, verify them by running the app:

1. Start the server (the project's dev/start command, e.g. `npm run dev` or the documented start script) with the UI built.
2. With **no browser open**, confirm the console/logs show polls at the ~10-minute dormant cadence (or simply that it is not polling every 30s). A quick way: watch for `gh api graphql` process activity, or temporarily add a `console.log` in `tick()` reporting the chosen delay, then remove it.
3. Open the dashboard. Confirm one immediate refresh fires on connect (board paints current) and that, with an in-flight mission (open PR with pending CI or a live spawn), polling tightens to the 30s FAST cadence.
4. Close all tabs; confirm the cadence relaxes again on the following tick.
5. Confirm the rate-limit readout in the UI still updates on polls that have at least one active branch.

Record the observed cadences in the commit message or PR description.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/server/routes.ts
git commit -m "Wire client presence into the poller and refresh on first connect"
```

---

## Self-Review

**Spec coverage:**
- Cheaper query (spec §1) → Task 2 (`first:1`, `first:30`, `first:30`).
- Batch all branches into one request + fold rate limit (spec §2) → Task 2 (`fetchBranchPrs`, `parseBranchPrsResponse`) + Task 4 (`reconcileAll` collect phase, returns `rateLimit`).
- `gatherFacts` split so network leaves the per-task path (spec §2) → Task 3.
- Whole-batch failure held at last-good (spec §2, "Open risks") → Task 2 (`ok` flag) + Task 3 (throw on `!ok`) + existing `applyLastGood`.
- Adaptive cadence FAST/REST/DORMANT (spec §3) → Task 1 (`nextDelayMs`) + Task 4 (self-scheduling loop).
- In-flight definition (spec §3) → Task 1 (`anyInFlight`).
- `hasClients` handler + `broadcaster.size` (spec §3) → Task 4 (interface) + Task 5 (index.ts).
- Refresh on client connect (spec §3) → Task 5 (0→1 transition in routes.ts).
- Forced run reschedules from now (spec §3) → Task 4 (`runNow` → `scheduleNext`).
- Empty branch set → no-network poll, still heartbeat (spec "Open risks") → Task 2 (`fetchBranchPrs` early return) + Task 4 (heartbeat still emitted in `runReconcile`).
- Branch names via GraphQL variables, no escaping (spec "Open risks") → Task 2 (`$b{i}` + `-f b{i}=…`).
- `first:1` reopened-branch trade-off (spec "Open risks") → accepted; parser still prefers OPEN when multiple nodes are present.

**Placeholder scan:** No TBD/TODO. Every code step carries full code. The one prose note in Task 3 Step 1 flags an intentional simplification of a test expectation and states the exact replacement — not a placeholder.

**Type consistency:** `BatchedBranchPrs { ok; byBranch; rateLimit }` is produced in Task 2 and consumed with the same field names in Tasks 3 and 4. `gatherFacts(config, task, branches, batch)` is defined in Task 3 and called with exactly those four args in Task 4. `reconcileAll` returns `{ results, rateLimit }` in Task 4 and is destructured as such in `runReconcile`. `nextDelayMs(tasks, hasClients, fastMs)` / `anyInFlight(tasks)` signatures match between Task 1 and Task 4. `PollHandlers.hasClients: () => boolean` defined in Task 4, supplied in Task 5.
