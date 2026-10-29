# Dashboard performance implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline. The user has authorized execution.

**Goal:** Reduce repeated CPU, disk, subprocess, and UI work without changing freshness or the launcher.

**Architecture:** Keep Fastify and React. Deduplicate at action boundaries, bound Git execution, isolate local clocks, retain unchanged task references, and page rendered history.

**Tech Stack:** TypeScript, React, Fastify, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-29-dashboard-performance-design.md`

## Global constraints

- Preserve polling intervals, launcher, notifications, drafts, search, and VS Code/MCP contracts.
- Tests exercise owned logic and plausible failures. Use neutral fixtures and prove invariants by source mutation.
- Run process-starting Vitest suites in PROCESS_SUITES. Never raise timeouts.
- Finish on a feature branch and open a PR after all required checks pass.

## Review focus

- An action returning an empty board must clear the UI without another reconcile.
- Document saves still trigger a reconcile, while editor-opening actions do not.
- Git command errors must release queue capacity for later tasks.
- Search and reveal must find notes beyond the first page, including settled notes and reopened notes.
- Timestamp-only PR updates must not hide real check/review/availability changes or overwrite concurrent selections.

### Task 1: Refresh and persistence

**Files:** `src/web/App.tsx`, `src/web/components/Drawer.tsx`, `src/web/components/Settings.tsx`, `src/web/components/drawer/SetupTab.tsx`, `src/orchestrator/poller.ts`, regression tests.

**Interfaces:** Consume existing mutation task-array responses; pass task updates separately from explicit reconcile requests. Compare stack content without checkedAt.

- [ ] Add and run failing regression tests for duplicate action requests and timestamp-only state-file writes.
- [ ] Consume mutation results, retain document/manual reconcile behavior, reload settings configuration independently.
- [ ] Ignore checkedAt when comparing persisted stacks; preserve meaningful changes.
- [ ] Run targeted tests and deliberately break the write invariant once.
- [ ] Commit the task and record verification.

### Task 2: Git concurrency

**Files:** `src/orchestrator/worktree.ts`, a focused scheduling helper if needed, `test/git-concurrency.test.ts`.

**Interfaces:** Keep existing Git result semantics; bound every worktree-module subprocess across concurrent callers.

- [ ] Write and run a failing concurrency/error-recovery test using deferred external-command results.
- [ ] Add a four-slot queue with finally-based release.
- [ ] Verify task Git facts and fallback behavior under queueing; deliberately bypass the limit and observe failure.
- [ ] Commit the task and record verification.

### Task 3: Rendering

**Files:** `src/web/App.tsx`, `src/web/components/ConnectionStatus.tsx`, `src/web/components/AttentionRail.tsx`, `src/web/components/Board.tsx`, `src/web/components/Card.tsx`, task identity helper/tests.

**Interfaces:** Preserve fresh task metadata while reusing unchanged render data; keep seconds and minute clocks below App.

- [ ] Add regression coverage for task identity, actual changed cards, and clock isolation.
- [ ] Isolate the clocks, stabilize callbacks/counts, group lanes in linear time, and memoize cards with stable inputs.
- [ ] Run regressions and prove an identity invariant by mutation.
- [ ] Commit the task and record verification.

### Task 4: Historical lists and final checks

**Files:** `src/web/components/Lane.tsx`, `src/web/components/notes/NotesList.tsx`, `src/web/components/notes/NoteCard.tsx`, `src/web/components/drawer/PlanTab.tsx`, `src/web/components/Drawer.tsx`, `e2e/smoke.spec.ts`, supporting list tests.

**Interfaces:** Page task/note rendering; search full retained collections; reveal targets regardless of page; lazily load large UI modules without changing note contracts.

- [ ] Add failing tests for bounded lists and off-page note reveal/search.
- [ ] Implement pagination, bounded previews, and lazy loading.
- [ ] Prove pagination/reveal invariants by mutation and run production browser checks.
- [ ] Run `npm run typecheck`, `npm test`, `npm --prefix vscode-extension run verify`, and `npm run test:e2e`.
- [ ] Obtain one independent whole-branch review, fix material findings, commit, push, create and link the PR.
