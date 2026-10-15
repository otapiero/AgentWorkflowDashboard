# Stacked pull requests implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display every PR layer for an issue and launch work against the selected layer without a GitHub request per layer.

**Architecture:** Separate the pure stack graph from a stateful batched GitHub collector and from execution-target resolution. Keep the issue as the board identity and use explicit layer identities for launch requests. Preserve scalar PR fields for existing extension consumers.

**Tech Stack:** TypeScript, React 19, Fastify, gh GraphQL, Vitest, PowerShell and the existing T3 integration. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-stacked-pull-requests-design.md`

## Global constraints

- Use the existing serialized poll loop and one batched GraphQL request per ordinary poll.
- Refresh membership every five minutes, at startup and after an explicit membership change.
- Do not make a GitHub request when rendering a card, opening a drawer, selecting a layer or previewing a prompt.
- Paginate with pages of at most 100 and continue pages on subsequent polls.
- Automatic rebasing, retargeting, merging, package release detection and creating future stack layers are outside this change.
- Keep issue-level run bookkeeping serialized: allow only one active issue run, regardless of layer.
- Use neutral fixtures only. For invariant tests, temporarily break the source invariant, observe failure, then restore it.
- Run `npm run typecheck && npm test` and `npm --prefix vscode-extension run verify`.

## Review focus

- A fork with an identical branch name must not become another repository's parent. Task 1 covers repository-qualified matching.
- A previously merged scalar task may have an open child. Task 3 covers migration and continued discovery.
- A partial or truncated response must not clear membership or complete a task. Tasks 2 and 3 cover cursor completion and last-good facts.
- An existing checkout can contain the wrong branch or be occupied elsewhere. Task 4 checks branch identity before changing files.
- Two launches may race before a running marker exists. Task 4 acquires the issue lock before any prompt/spec writes and checks durable liveness on restart.

## Task 1: Shared stack model and graph

**Files:** Create `src/shared/pr-stack.ts`, `src/orchestrator/pr-stack.ts`, `test/pr-stack.test.ts`; modify `src/shared/types.ts`.

**Interfaces:** `PrIdentity = { host: string; repository: string; number: number }`; `prKey(pr: PrIdentity): string`; `PrLayer` adds title, URL, state, head/base repository and branch, head SHA, checks/review facts, availability and provenance. `TaskStack` contains layers, selected key, excluded keys, external links and discovery completeness. `buildStack(layers: PrLayer[], baseBranch: string): StackView` returns ordered layers, parents, warnings and completion. `TaskRecord.stack?: TaskStack` and `Facts.stack?: StackView` preserve old records.

- [ ] Write graph tests with an `acme/widgets` fixture builder and reversed inputs. Include siblings, independent roots, missing metadata, forks, cycles, multiple parent candidates, closed layers and retained membership after retargeting. The core assertions are:

```ts
expect(buildStack([child, parent], 'main').layers.map(p => p.number)).toEqual([10, 11]);
expect(buildStack([mergedParent, openChild], 'main').complete).toBe(false);
expect(buildStack([foreignParent, child], 'main').layers.find(p => p.number === 11)?.parentKey).toBeNull();
```

- [ ] Run `npx vitest run test/pr-stack.test.ts`; confirm failures identify missing graph behavior.
- [ ] Implement matching by repository plus branch, deterministic topological order, cycle/ambiguity warnings and completion requiring all layers merged with complete discovery and available facts. Retain distinct roots rather than forcing a chain.

```ts
const candidates = layers.filter(parent =>
  parent.headRepository.toLowerCase() === child.baseRepository.toLowerCase() &&
  parent.headBranch === child.baseBranch && prKey(parent) !== prKey(child));
```

- [ ] Run the suite, temporarily match only branch names and verify the fork regression fails, then restore the repository check.
- [ ] Commit the model and graph as `feat: model ordered PR stacks`.

## Task 2: Batched discovery and status collection

**Files:** Create `src/orchestrator/github-stack.ts`, `test/github-stack.test.ts`; modify `src/orchestrator/github.ts` to share transport and existing status parsers.

**Interfaces:** `createStackCollector(config: Config, deps?: { now?: () => number; query?: (query: string, variables: Record<string, unknown>) => Promise<unknown> })` returns `{ collect(tasks: TaskRecord[]): Promise<StackCollection>; invalidate(issue: number): void }`. `StackCollection` contains stack snapshots keyed by issue, unavailable layer/issue keys and rate limit. Collector state belongs to one configured project and survives consecutive polls, not a process-global test singleton.

- [ ] Add recording-transport tests for one ordinary request across multiple layers, unique status aliases across shared PRs, five-minute membership cadence, unknown child status until the next poll, no network for Done tasks, partial GraphQL errors and complete index publication after pagination. Use a fake clock, not sleeps.

```ts
await collector.collect(tasks);
recorded.length = 0;
await collector.collect(tasks);
expect(recorded).toHaveLength(1);
expect(recorded[0].query.match(/pullRequest\(number:\$pr10\)/g)).toHaveLength(1);
```

- [ ] Run `npx vitest run test/github-stack.test.ts` and observe missing collector behavior.
- [ ] Build requests from deduplicated identities and metadata-only membership/index selections. Bootstrap directly attached status once; use explicit PR status aliases thereafter. Refresh branch metadata with status. Join the completed open-PR index transitively to all known members and apply explicit exclusions.
- [ ] Bound each request to 20 full-status aliases, each fetching at most 30 checks and 30 threads. Bound issue membership aliases to 20 per request, each fetching at most 100 metadata nodes. Pack the index page and metadata work into the first available batch. Use GraphQL variables for numbers and cursors. Additional capacity batches run sequentially; do not execute recursive pagination in one poll.
- [ ] Carry per-connection cursors and staging buffers into the next poll. If head SHA changes, discard check pagination for the old head. Do not mark review/check gates complete until their pages finish. Preserve last-good members and completed index on connection failures.
- [ ] Verify the scheduling tests, temporarily remove status deduplication to make its regression fail, restore, and commit `feat: collect stack facts in bounded GitHub batches`.

## Task 3: Reconciliation and backward compatibility

**Files:** Modify `src/orchestrator/poller.ts`, `src/orchestrator/facts.ts`, `src/orchestrator/reconcile.ts`, `src/orchestrator/board.ts`, `src/orchestrator/state.ts`; extend `test/poller-issue-pr.test.ts`, `test/facts-frozen.test.ts`, `test/reconcile.test.ts`, `test/board.test.ts`.

**Interfaces:** Poller consumes `StackCollection`; facts carry `StackView`. Scalar `prNumber`, `prUrl`, `prState`, checks and review project the earliest actionable layer, independent of the user's launch selection. `mergedAt` describes whole-stack completion and clears if new work reactivates it. `StackView` exposes counts and warnings for the UI.

- [ ] Add tests that migrate a scalar merged record to a stack with an open child, preserve Done overrides, keep a closed unmerged layer unresolved and retain state when one member's status fails.

```ts
expect(reconcile({ ...facts, stack: incompleteStack }).derivedPhase).not.toBe('merged');
expect(reconcile({ ...facts, stack: allMergedStack }).derivedPhase).toBe('merged');
expect(reconcile({ ...facts, stack: unavailableStack }).gates.merge).toBe(false);
```

- [ ] Run the affected suites and record their failures before implementation.
- [ ] Replace scalar merge-freeze filtering with stack-aware collection. Preserve active polling for open layers; terminal layers need membership rediscovery every five minutes until manual Done. No refresh storms when a new child appears.
- [ ] Derive per-layer pipeline status using existing rules, then aggregate issue phase, failure/review badges and blocked-merge explanations. Prevent unknown/truncated facts from satisfying gates. Include stack facts in board signatures so SSE updates layer changes.
- [ ] Run affected suites; temporarily restore scalar merge freezing and confirm migration regression fails; restore and commit `feat: reconcile issue progress across all PR layers`.

## Task 4: Execution targets and owned layer checkouts

**Files:** Create `src/orchestrator/execution-target.ts`, `src/orchestrator/layer-worktrees.ts`, `test/execution-target.test.ts`, `test/layer-worktrees.test.ts`; modify `src/orchestrator/paths.ts`, `src/orchestrator/spawn-plan.ts`, `src/orchestrator/prompt.ts`, `src/orchestrator/spawn/phase.ts`, `src/orchestrator/spawn/spec.ts`, `src/orchestrator/spawn/t3.ts`, `src/orchestrator/spawn/launchers.ts`, `src/server/run-routes.ts`, `src/orchestrator/cleanup.ts`, `src/server/task-routes.ts`, `assets/scripts/common.ps1`, `assets/scripts/run-phase.ps1` and publishing/review templates. Register process suites in `vite.config.ts`.

**Interfaces:** `resolveExecutionTarget(config: Config, task: TaskRecord, layerKey?: string): ExecutionTarget` is pure and returns PR identity, branch, base and workspace path. `ensureLayerWorktree(config: Config, task: TaskRecord, target: ExecutionTarget): Promise<void>` verifies or creates an owned checkout. Spawn/prompt API bodies gain `layerKey?: string`; `SpawnRecord` gains optional PR identity and workspace path. Target resolution occurs once and is passed into every launcher.

- [ ] Test target choice, missing selection on multiple layers, unknown/unavailable layer rejection, fork rejection, correct raw-prompt checkout, actual base substitution and agreement among preview/launch specs. Assert issue-level planning still uses the legacy target.

```ts
const target = resolveExecutionTarget(config, task, prKey(child));
expect(target.branch).toBe(child.headBranch);
expect(target.baseBranch).toBe(parent.headBranch);
expect(target.worktreePath).not.toBe(worktreePath(task.issue));
```

- [ ] Add real temporary-git tests for branch mismatch, branch already checked out elsewhere and legacy checkout reuse only when its actual branch matches. Add a deferred launch test proving two concurrent requests cannot both write shared files. Run and observe failures.
- [ ] Resolve and validate target before launch writes. Acquire a per-issue launch reservation synchronously, check durable marker/T3 liveness, retain reservation until handoff liveness can be established, and release on failure. Validate stale metadata with local branch/head information; require normal refresh rather than silently targeting another branch.
- [ ] Use owned per-task/per-layer paths with validated identifiers, create writable branches from the selected remote head, and verify branch identity in both Node and PowerShell. Pass target paths through prompt variables, argument expansion, T3 threads, snapshots and launch specs. Refuse fork execution with an actionable error.
- [ ] Enumerate only owned checkouts for cleanup, reuse rescue receipts, and preserve checkouts owned by other tasks. Make Done cleanup run even when the issue checkout is absent but layer checkouts exist. Record layer identity in spawn history.
- [ ] Run target, worktree, spawn, prompt and cleanup suites; break the target's base substitution once and verify failure; restore and commit `feat: launch agents against explicit PR layers`.

## Task 5: Layer selection and membership UI

**Files:** Create `src/server/stack-routes.ts`, `src/web/components/drawer/StackLayers.tsx`, `src/web/styles/stack.css`, `test/stack-routes.test.ts`; modify `src/server/app.ts`, `src/web/api.ts`, `src/web/components/Card.tsx`, `src/web/components/Drawer.tsx`, `src/web/components/drawer/types.ts`, `src/web/components/drawer/RunTab.tsx`, `src/web/components/drawer/LaunchCompose.tsx`, `src/web/components/drawer/PromptPreview.tsx`, `src/web/components/drawer/HistoryTab.tsx`, `src/web/styles/index.css`, and `e2e/smoke.spec.ts` with deterministic stack data.

**Interfaces:** `POST /api/tasks/:issue/stack` accepts one operation: select layer, attach PR URL, detach layer, add companion URL or remove companion URL. Routes validate host/repository/identity locally, update membership intent atomically and invalidate discovery only on membership changes. Selecting layers does not invoke GitHub or poll refresh. Attachments remain pending until the collector validates them.

- [ ] Test invalid/foreign attachments, persisted exclusions, detach clearing selection, companions remaining outside branch ordering and selection producing zero gh calls. Run the route suite red.
- [ ] Render ordered PR rows with links, target branch, per-layer statuses and warnings. Render discovery-incomplete and unavailable states explicitly. Use a compact aggregate card badge. Require explicit multi-layer selection for PR-specific launches; auto-select a sole layer. Show selected PR, branch, base and checkout in composition and preview.
- [ ] Send the same `layerKey` for preview and launch and show the PR identity in history. Disable invalid actions while allowing issue-level planning and child CI/review repair. Add the membership and external-link forms with actionable errors.
- [ ] Extend the browser fixture to two layers and assert selection changes preview target without changing the issue's summary phase. Use fixture route responses, not live repository identifiers. Run route tests and the focused smoke scenario, then commit `feat: display and select stacked PR layers`.

## Task 6: Verify and publish

**Files:** Update `README.md`, the spec status and this plan's checkboxes with final behavior and evidence.

- [ ] Inspect all changes against the spec and fix omissions. Check repository-neutral fixtures and remove tests for the replaced scalar-only behavior when they no longer represent supported logic. Run `git diff --check`.
- [ ] Run `npm run typecheck` followed by `npm test`, then `npm --prefix vscode-extension run verify`. Do not increase timeouts. Fix failures and repeat only affected checks before rerunning required gates.
- [ ] Use T3 `preview_status`, then `preview_open` if needed, and inspect the deterministic stack fixture. Verify keyboard selection, warnings, composition and prompt preview. Do not use production state for UI fixtures.
- [ ] Review recorded transport evidence: ordinary multi-layer polls use one batch within capacity, discovery is at five-minute intervals, status aliases are deduplicated, pagination advances one page per connection per poll, and drawer interactions produce no GitHub traffic.
- [ ] Commit final docs, push `feat/stacked-pull-requests`, open a PR against `master` with validation and request-budget evidence, call `link_pull_request` immediately, and reconcile with `list_thread_pull_requests` before reporting the PR URL.

## Execution review

Recommended execution method: native, in this session. The graph, collector,
reconciler and execution target share interfaces, so implementing them in order
keeps those boundaries consistent. No implementation has started; the written
plan is ready for the required review.
