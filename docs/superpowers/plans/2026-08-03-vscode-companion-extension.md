# VS Code Companion Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a performance-first VS Code companion that connects to Mission Control, opens canonical task worktrees in new windows, launches configured agents, and surfaces a deduplicated attention queue and actionable notifications.

**Architecture:** Add a small structured integration contract to the existing Fastify/orchestrator boundary, then build an isolated desktop VS Code extension as a thin REST/SSE client. The extension keeps one normalized in-memory task store per window, performs exact path matching, coordinates server startup and notification delivery through atomic files in machine-wide extension storage, and delegates every workflow mutation to Mission Control.

**Tech Stack:** Existing TypeScript 5.8/Fastify/Vitest application; desktop VS Code Extension API targeting the installed VS Code 1.131 line; TypeScript, esbuild, Vitest, `@vscode/test-cli`, `@vscode/test-electron`, and `@vscode/vsce` in `vscode-extension/`; native Node `fetch`, web streams, filesystem, and child-process APIs.

## Global Constraints

- Performance is the first acceptance gate; optimize or defer any feature that misses a budget.
- Synchronous `activate()` work: **≤ 50 ms**.
- Healthy-server response to first populated tree notification: **≤ 500 ms**.
- Complete SSE `tasks` event to UI update dispatch: **≤ 100 ms**.
- Retained heap delta with 500 tasks in an isolated Extension Host: **≤ 25 MB**.
- Idle CPU between server events: effectively **0%**, with no client-generated recurring timer.
- Packaged `.vsix`, excluding source maps: **≤ 500 KiB**.
- Notification delivery ledger: **≤ 500 entries**.
- One REST baseline and one SSE connection per VS Code window; no polling while SSE is healthy.
- Never scan recursively or infer worktrees from issue numbers; use exact normalized server-provided paths.
- Never edit Mission Control durable state directly; all mutations go through REST.
- Opening a task must call `vscode.openFolder` with `{ forceNewWindow: true }`.
- Closing VS Code must not stop Mission Control or an agent process.
- Do not touch the user's unrelated existing change in `assets/scripts/run-phase.ps1`.
- Follow the official VS Code references for [Tree Views](https://code.visualstudio.com/api/extension-guides/tree-view), [activation events](https://code.visualstudio.com/api/references/activation-events), [extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension), [built-in commands](https://code.visualstudio.com/api/references/commands), and [VSIX packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

---

## Planned File Structure

### Existing application

- `src/shared/types.ts` — public API DTOs, including health and structured editor integration state.
- `src/orchestrator/editor-integration.ts` — maps already-gathered facts to the editor integration DTO.
- `src/orchestrator/poller.ts` — includes structured integration state in every task result.
- `src/server/health.ts` — creates the stable health/version identity for one server process.
- `src/server/routes.ts` — exposes `GET /api/health` and returns the additive task fields.
- `src/server/index.ts` — constructs the health identity once and injects it into routes.
- `src/shared/agent-selection.ts` — shared pure agent/model/effort compatibility logic.
- `src/web/components/AgentPicker.tsx` — delegates agent switching to the shared selector.
- `test/editor-integration.test.ts`, `test/server-health.test.ts`, `test/agent-selection.test.ts` — backend/shared contract coverage.

### Extension package

- `vscode-extension/package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.mjs`, `.vscode-test.mjs`, `.vscodeignore` — package, build, unit/host test, and VSIX configuration.
- `vscode-extension/resources/mission-control.svg` — Activity Bar view-container icon.
- `vscode-extension/src/client/sse.ts` — dependency-free SSE parser.
- `vscode-extension/src/client/mission-control-client.ts` — typed REST/SSE client.
- `vscode-extension/src/task-store.ts` — normalized state, selectors, and minimal change sets.
- `vscode-extension/src/workspace-matcher.ts` — exact normalized path matching.
- `vscode-extension/src/storage/atomic-file.ts` — cross-window atomic file lease primitive.
- `vscode-extension/src/server-manager.ts` — health, compatibility, startup, ownership, and restart.
- `vscode-extension/src/notifications/notification-events.ts` — pure transition classification.
- `vscode-extension/src/notifications/delivery-ledger.ts` — bounded atomic cross-window deduplication.
- `vscode-extension/src/notifications/notification-coordinator.ts` — baseline suppression and delivery orchestration.
- `vscode-extension/src/tree-model.ts` — pure worktree-first tree model and ordering.
- `vscode-extension/src/tree-provider.ts` — native `TreeDataProvider` adapter with targeted refreshes.
- `vscode-extension/src/status-bar.ts` — current task and connection status.
- `vscode-extension/src/launch-flow.ts` — phase/agent/model/effort Quick Pick flow.
- `vscode-extension/src/commands.ts` — navigation, launch, dashboard, terminal, restart, and logs.
- `vscode-extension/src/runtime.ts` — lifecycle composition and reconnect state machine.
- `vscode-extension/src/extension.ts` — synchronous VS Code registration entry point.
- `vscode-extension/test/unit/fixtures.ts` and focused `*.test.ts` files — pure unit tests.
- `vscode-extension/test/extension/extension.test.ts` — Extension Development Host tests.
- `vscode-extension/test/fixtures/workspace/.vscode/settings.json` — host-test workspace with auto-start disabled.
- `vscode-extension/test/performance/run.ts` — deterministic budget checks.
- `vscode-extension/scripts/check-vsix-size.mjs` — hard package-size gate.
- `vscode-extension/README.md`, `CHANGELOG.md` — local install, update, configuration, diagnostics, and uninstall instructions.

---

### Task 1: Add the Structured Server Integration Contract

**Files:**
- Create: `src/orchestrator/editor-integration.ts`
- Create: `src/server/health.ts`
- Create: `test/editor-integration.test.ts`
- Create: `test/server-health.test.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/orchestrator/poller.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/server/index.ts`
- Modify: task fixtures in `test/board.test.ts`, `test/board-model.test.ts`, `test/notify.test.ts`, and `test/poller-cadence.test.ts`

**Interfaces:**
- Consumes: `Facts`, `LiveSpawn`, `ChecksState`, `ReviewDecision`, `TaskWithDerived`, and `worktreePath(issue)` from the existing orchestrator.
- Produces: `HealthResponse`, `EditorIntegrationState`, `toEditorIntegration(facts)`, `createHealthResponse(serverVersion, startedAt?)`, `GET /api/health`, and required `TaskWithDerived.integration` data used by all extension tasks.

- [ ] **Step 1: Write failing editor-integration tests**

```ts
// test/editor-integration.test.ts
import { describe, expect, test } from 'vitest';
import { toEditorIntegration } from '../src/orchestrator/editor-integration.ts';
import type { Facts } from '../src/shared/types.ts';

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    issue: 3060,
    worktreeExists: true,
    branchExists: true,
    markers: [],
    planMdExists: true,
    artifacts: [],
    hasPushedCommits: true,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn: { phase: 'implement', pid: 42, startedAt: '2026-08-03T09:00:00.000Z' },
    pr: { exists: true, number: 99, url: 'https://github.test/pr/99', state: 'OPEN' },
    checks: 'success',
    review: { decision: 'REVIEW_REQUIRED', unresolvedThreads: 2, copilotUnresolved: 1 },
    ...overrides,
  };
}

describe('toEditorIntegration', () => {
  test('copies gathered signals and supplies the canonical worktree path', () => {
    const result = toEditorIntegration(facts());
    expect(result.workspacePath).toMatch(/[\\/]issue-3060$/);
    expect(result).toMatchObject({
      worktreeExists: true,
      checks: 'success',
      approvalRequired: true,
      review: { decision: 'REVIEW_REQUIRED', unresolvedThreads: 2, copilotUnresolved: 1 },
    });
  });

  test('does not require approval without an open PR awaiting review', () => {
    expect(toEditorIntegration(facts({
      pr: { exists: false, number: null, url: null, state: null },
    })).approvalRequired).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `npm test -- test/editor-integration.test.ts`

Expected: FAIL because `src/orchestrator/editor-integration.ts` and `EditorIntegrationState` do not exist.

- [ ] **Step 3: Add the DTOs and fact mapper**

```ts
// add to src/shared/types.ts
export interface EditorIntegrationState {
  workspacePath: string;
  worktreeExists: boolean;
  liveSpawn: LiveSpawn | null;
  checks: ChecksState;
  review: Facts['review'];
  approvalRequired: boolean;
}

export interface HealthResponse {
  status: 'ok';
  apiVersion: 1;
  serverVersion: string;
  pid: number;
  startedAt: string;
}

// add to TaskWithDerived
integration: EditorIntegrationState;
```

```ts
// src/orchestrator/editor-integration.ts
import { worktreePath } from './paths.ts';
import type { EditorIntegrationState, Facts } from '../shared/types.ts';

export function toEditorIntegration(facts: Facts): EditorIntegrationState {
  return {
    workspacePath: worktreePath(facts.issue),
    worktreeExists: facts.worktreeExists,
    liveSpawn: facts.liveSpawn,
    checks: facts.checks,
    review: { ...facts.review },
    approvalRequired: facts.pr.exists && facts.review.decision === 'REVIEW_REQUIRED',
  };
}
```

- [ ] **Step 4: Attach integration data in both successful and fallback reconciliation paths**

In `src/orchestrator/poller.ts`, import `toEditorIntegration`. In the successful path, return `integration: toEditorIntegration(facts)`. In the catch path, assign the existing fallback facts object to a local `fallbackFacts`, call `reconcile(fallbackFacts, ...)`, and add `integration: toEditorIntegration(fallbackFacts)`. Update every direct `TaskWithDerived` test fixture with an explicit neutral integration value.

```ts
const neutralIntegration = {
  workspacePath: 'C:\\mc\\worktrees\\issue-1',
  worktreeExists: false,
  liveSpawn: null,
  checks: 'none' as const,
  review: { decision: 'NONE' as const, unresolvedThreads: 0, copilotUnresolved: 0 },
  approvalRequired: false,
};
```

- [ ] **Step 5: Run root tests and typecheck**

Run: `npm test -- test/editor-integration.test.ts test/board.test.ts test/board-model.test.ts test/notify.test.ts test/poller-cadence.test.ts && npm run typecheck`

Expected: all focused tests PASS and TypeScript reports no errors.

- [ ] **Step 6: Write failing health-route tests**

```ts
// test/server-health.test.ts
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { createHealthResponse } from '../src/server/health.ts';
import { registerRoutes } from '../src/server/routes.ts';
import { Broadcaster } from '../src/server/sse.ts';
import type { Config } from '../src/shared/types.ts';

const config = {
  repo: { path: 'C:\\repo', owner: 'o', name: 'r', baseBranch: 'main', branchPrefix: 'ouriel/' },
  github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
  agents: {},
  pipeline: [],
  server: { port: 4317 },
} satisfies Config;

describe('GET /api/health', () => {
  test('returns a stable process identity and API version', async () => {
    const app = Fastify();
    const health = createHealthResponse('0.1.0', '2026-08-03T10:00:00.000Z');
    registerRoutes(app, { config, broadcaster: new Broadcaster(), refresh: async () => [], health });
    const first = await app.inject({ method: 'GET', url: '/api/health' });
    const second = await app.inject({ method: 'GET', url: '/api/health' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
    expect(first.json()).toMatchObject({ status: 'ok', apiVersion: 1, serverVersion: '0.1.0' });
    await app.close();
  });
});
```

- [ ] **Step 7: Run the health test and verify it fails**

Run: `npm test -- test/server-health.test.ts`

Expected: FAIL because `src/server/health.ts` and the `health` route dependency do not exist.

- [ ] **Step 8: Implement stable health identity and route injection**

```ts
// src/server/health.ts
import type { HealthResponse } from '../shared/types.ts';

export function createHealthResponse(
  serverVersion: string,
  startedAt = new Date().toISOString(),
): HealthResponse {
  return Object.freeze({ status: 'ok', apiVersion: 1, serverVersion, pid: process.pid, startedAt });
}
```

Extend the `Deps` interface in `src/server/routes.ts` with `health: HealthResponse`, destructure it, and register `app.get('/api/health', async () => health)`. In `src/server/index.ts`, read `version` once from the root `package.json`, construct `createHealthResponse(version)` once before route registration, and inject it.

```ts
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };
const health = createHealthResponse(packageJson.version);
registerRoutes(app, { config, broadcaster, refresh: poller.runNow, health });
```

- [ ] **Step 9: Run the full root verification and commit**

Run: `npm test && npm run typecheck && npm run build`

Expected: existing and new tests PASS; typecheck and web build succeed.

```bash
git add src/shared/types.ts src/orchestrator/editor-integration.ts src/orchestrator/poller.ts src/server/health.ts src/server/routes.ts src/server/index.ts test/editor-integration.test.ts test/server-health.test.ts test/board.test.ts test/board-model.test.ts test/notify.test.ts test/poller-cadence.test.ts
git commit -m "feat: expose editor integration contract"
```

---

### Task 2: Scaffold the Isolated Extension Package

**Files:**
- Create: `vscode-extension/package.json`
- Create: `vscode-extension/package-lock.json`
- Create: `vscode-extension/tsconfig.json`
- Create: `vscode-extension/vitest.config.ts`
- Create: `vscode-extension/esbuild.mjs`
- Create: `vscode-extension/.vscode-test.mjs`
- Create: `vscode-extension/.vscodeignore`
- Create: `vscode-extension/resources/mission-control.svg`
- Create: `vscode-extension/src/extension.ts`
- Create: `vscode-extension/test/unit/manifest.test.ts`
- Create: `vscode-extension/test/fixtures/workspace/.vscode/settings.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `HealthResponse`, `BoardConfig`, `TaskWithDerived`, `Phase`, and `EditorIntegrationState` as type-only imports from `../src/shared/types.ts` after `BoardConfig` and `AgentInfo` move there from `src/web/api.ts`.
- Produces: the `otapiero.mission-control` desktop extension package, CommonJS bundle at `vscode-extension/dist/extension.cjs`, unit-test command, and extension-host test configuration used by later tasks.

- [ ] **Step 1: Move API configuration DTOs into shared types**

Move `AgentInfo` and `BoardConfig` from `src/web/api.ts` to `src/shared/types.ts`; update `src/web/api.ts` to import and re-export them. This leaves runtime behavior unchanged and gives the extension one compile-time contract.

- [ ] **Step 2: Create the minimal package and unit-test harness**

Create `vscode-extension/package.json` with name `mission-control`, publisher `otapiero`, version `0.1.0`, `private: true`, `engines.vscode: ^1.131.0`, `extensionKind: ["ui"]`, `main: ./dist/extension.cjs`, and these scripts:

```json
{
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test:extension": "npm run build:test && vscode-test",
    "build:test": "node esbuild.mjs --tests",
    "vscode:prepublish": "npm run build"
  }
}
```

Then install and lock development dependencies:

```powershell
npm --prefix vscode-extension install --save-dev typescript@^5.8.3 @types/node@^24.0.10 @types/vscode@^1.131.0 esbuild@^0.28.1 vitest@^3.2.4 @vscode/test-cli @vscode/test-electron @vscode/vsce
```

- [ ] **Step 3: Write a failing manifest test**

```ts
// vscode-extension/test/unit/manifest.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('extension manifest', () => {
  test('targets the installed desktop API and activates after startup', () => {
    expect(manifest.engines.vscode).toBe('^1.131.0');
    expect(manifest.extensionKind).toEqual(['ui']);
    expect(manifest.activationEvents).toContain('onStartupFinished');
    expect(manifest.main).toBe('./dist/extension.cjs');
  });
});
```

- [ ] **Step 4: Run the unit test and verify the activation declaration fails**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/manifest.test.ts`

Expected: FAIL because `activationEvents` has not been added.

- [ ] **Step 5: Add activation, compiler, bundler, test-host, ignore, icon, and entry files**

Add `"activationEvents": ["onStartupFinished"]` to the manifest. Use this compiler configuration, configure Vitest to include `test/unit/**/*.test.ts`, and configure esbuild to bundle `src/extension.ts` for `platform: 'node'`, `format: 'cjs'`, `external: ['vscode']`, `outfile: 'dist/extension.cjs'`, with no source map in package mode. `--tests` also bundles `test/extension/extension.test.ts` to `dist/test/extension.test.cjs`.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node", "vscode", "vitest/globals"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test", "../src/shared/types.ts", "../src/shared/agent-selection.ts"]
}
```

```ts
// vscode-extension/src/extension.ts
import type * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {}
export function deactivate(): void {}
```

```js
// vscode-extension/.vscode-test.mjs
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist/test/**/*.test.cjs',
  version: 'stable',
  workspaceFolder: 'test/fixtures/workspace',
  mocha: { ui: 'tdd', timeout: 20_000 },
  launchArgs: ['--disable-extensions'],
});
```

Use a simple monochrome local SVG with a square control-board outline and `M` glyph at `resources/mission-control.svg`. Set `missionControl.autoStart` to `false` in `test/fixtures/workspace/.vscode/settings.json`, so host tests never spawn a real server. Add `vscode-extension/dist/`, `vscode-extension/.vscode-test/`, and `vscode-extension/*.vsix` to `.gitignore`. Exclude `src`, `test`, configuration files, `node_modules`, and all `*.map` files in `.vscodeignore`.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
  <rect x="3" y="3" width="18" height="18" rx="3"/>
  <path d="M7 16V8l5 5 5-5v8"/>
</svg>
```

```text
# vscode-extension/.vscodeignore
src/**
test/**
scripts/**
node_modules/**
*.map
tsconfig.json
vitest.config.ts
esbuild.mjs
.vscode-test.mjs
package-lock.json
```

- [ ] **Step 6: Run scaffold verification and commit**

Run: `npm --prefix vscode-extension run test:unit && npm --prefix vscode-extension run typecheck && npm --prefix vscode-extension run build`

Expected: manifest test PASS, typecheck succeeds, and `dist/extension.cjs` exists.

```bash
git add .gitignore src/shared/types.ts src/web/api.ts vscode-extension
git commit -m "build: scaffold Mission Control VS Code extension"
```

---

### Task 3: Implement the Typed REST and SSE Client

**Files:**
- Create: `vscode-extension/src/client/sse.ts`
- Create: `vscode-extension/src/client/mission-control-client.ts`
- Create: `vscode-extension/test/unit/sse.test.ts`
- Create: `vscode-extension/test/unit/mission-control-client.test.ts`
- Create: `vscode-extension/test/unit/fixtures.ts`

**Interfaces:**
- Consumes: shared `HealthResponse`, `BoardConfig`, `TaskWithDerived`, `PollMeta`, and `Phase` DTOs.
- Produces: `parseSse(stream, signal)`, `MissionControlClient`, `MissionControlClient.connect(handlers, signal)`, and `ApiError`. Later tasks depend only on these public methods.

- [ ] **Step 1: Write failing SSE parser tests**

```ts
// vscode-extension/test/unit/sse.test.ts
import { describe, expect, test } from 'vitest';
import { parseSse } from '../../src/client/sse.ts';

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('parses split CRLF frames and joins multiline data', async () => {
  const events = [];
  for await (const event of parseSse(stream([
    'event: tasks\r\ndata: [{"issue":',
    '1}]\r\ndata: tail\r\n\r\n',
  ]), new AbortController().signal)) events.push(event);
  expect(events).toEqual([{ event: 'tasks', data: '[{"issue":1}]\ntail' }]);
});
```

- [ ] **Step 2: Run the parser test and verify the missing-module failure**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/sse.test.ts`

Expected: FAIL because `src/client/sse.ts` does not exist.

- [ ] **Step 3: Implement a streaming, abort-aware SSE parser**

Implement `parseSse` with one `TextDecoder`, a carry buffer, CRLF normalization, blank-line frame boundaries, comment-line ignoring, multiline `data:` joining, and reader cancellation in `finally`.

```ts
export interface SseEvent { event: string; data: string }

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n').filter((line) => !line.startsWith(':'));
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) yield { event, data };
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
```

- [ ] **Step 4: Write failing client tests**

Test that `health`, `config`, `tasks`, `spawn`, and `reconcile` use the configured origin, JSON headers, abort signal, and typed errors; test that `connect` dispatches `tasks` and `poll`, reports open/closed exactly once, and ends on abort.

Create the shared fixture API used by every later extension task:

```ts
// vscode-extension/test/unit/fixtures.ts
import type { BoardConfig, ChecksState, Phase, TaskWithDerived } from '../../../src/shared/types.ts';

export const config: BoardConfig = {
  repo: { path: 'C:\\repo', owner: 'otapiero', name: 'repo', baseBranch: 'main', branchPrefix: 'ouriel/' },
  pipeline: [
    { id: 'plan', label: 'Plan', actor: 'codex', spawnable: true, gate: { type: 'manual' } },
    { id: 'implement', label: 'Implement', actor: 'codex', spawnable: true, gate: { type: 'manual' } },
    { id: 'ci', label: 'CI', actor: 'ci', gate: { type: 'auto', signal: 'checks_green' } },
  ],
  agents: [{ name: 'codex', models: ['gpt-5.6-sol'], efforts: ['medium', 'high'], hasEffort: true }],
  phaseDefaults: {},
  launcher: 'vscode',
};

export function task(options: {
  issue?: number;
  phase?: Phase;
  needsYou?: boolean;
  workspacePath?: string;
  worktreeExists?: boolean;
  checks?: ChecksState;
  lastReconciledAt?: string | null;
} = {}): TaskWithDerived {
  const issue = options.issue ?? 3060;
  const phase = options.phase ?? 'implement';
  const checks = options.checks ?? 'none';
  return {
    issue,
    title: `Task ${issue}`,
    slug: `task-${issue}`,
    branch: `ouriel/${issue}`,
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    lastReconciledAt: options.lastReconciledAt ?? '2026-08-03T10:00:00.000Z',
    derived: {
      issue,
      derivedPhase: phase,
      displayPhase: phase,
      gates: { inbox: true, plan: false, implement: false, publish: false, ci: checks === 'success', copilot_review: false, dev_review: false, merge: false, done: false },
      badges: [],
      artifacts: [],
      needsYou: options.needsYou ?? false,
      needsYouReason: options.needsYou ? 'Needs attention' : null,
    },
    pinned: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    integration: {
      workspacePath: options.workspacePath ?? `C:\\mc\\worktrees\\issue-${issue}`,
      worktreeExists: options.worktreeExists ?? true,
      liveSpawn: null,
      checks,
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
      approvalRequired: false,
    },
  };
}

export function taskWithPath(workspacePath: string): TaskWithDerived {
  return task({ workspacePath, worktreeExists: true });
}
```

Populate every required `TaskWithDerived` field with deterministic neutral values; override only the options shown above.

```ts
const fetchMock = vi.fn<typeof fetch>();
const client = new MissionControlClient('http://127.0.0.1:4317/', fetchMock);
fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'ok', apiVersion: 1 }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));
await client.health(new AbortController().signal);
expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/api/health', expect.any(Object));
```

- [ ] **Step 5: Implement `MissionControlClient`**

Expose these exact methods:

```ts
export class MissionControlClient {
  constructor(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch);
  health(signal: AbortSignal): Promise<HealthResponse>;
  config(signal: AbortSignal): Promise<BoardConfig>;
  tasks(signal: AbortSignal): Promise<TaskWithDerived[]>;
  reconcile(signal: AbortSignal): Promise<TaskWithDerived[]>;
  spawn(issue: number, request: SpawnRequest, signal: AbortSignal): Promise<{ spawned: unknown }>;
  connect(handlers: SseHandlers, signal: AbortSignal): Promise<void>;
}

export interface SpawnRequest {
  phase: Phase;
  customInstructions?: string;
  agent?: string;
  model?: string;
  effort?: string;
}

export interface SseHandlers {
  onOpen(): void | Promise<void>;
  onTasks(tasks: TaskWithDerived[]): void | Promise<void>;
  onPoll(meta: PollMeta): void;
  onClosed(error: Error | null): void;
}
```

Normalize the base URL once, use a private generic `request<T>()`, throw `ApiError(status, message)` after reading `{ error }`, require `response.body` for SSE, parse `tasks`/`poll` JSON only for known event names, and never log payload bodies.

- [ ] **Step 6: Run client tests, typecheck, and commit**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/sse.test.ts test/unit/mission-control-client.test.ts && npm --prefix vscode-extension run typecheck`

Expected: all transport tests PASS.

```bash
git add vscode-extension/src/client vscode-extension/test/unit/sse.test.ts vscode-extension/test/unit/mission-control-client.test.ts vscode-extension/test/unit/fixtures.ts
git commit -m "feat: add Mission Control extension client"
```

---

### Task 4: Add the Normalized Task Store and Exact Workspace Matching

**Files:**
- Create: `vscode-extension/src/task-store.ts`
- Create: `vscode-extension/src/workspace-matcher.ts`
- Create: `vscode-extension/test/unit/task-store.test.ts`
- Create: `vscode-extension/test/unit/workspace-matcher.test.ts`

**Interfaces:**
- Consumes: `BoardConfig`, `TaskWithDerived`, `PollMeta`, and workspace folder URIs.
- Produces: `TaskStore.applyBaseline`, `TaskStore.applyTasks`, `TaskStore.setConnection`, `TaskStore.snapshot`, targeted `StoreChange`, selectors for current/attention/phase tasks, `normalizeWorkspacePath`, and `matchWorkspace`.

- [ ] **Step 1: Write failing store tests**

Cover stable issue ordering, one object per issue, changed-issue detection, attention section changes, phase section changes, no event for an identical payload, connection updates, and a 500-task snapshot.

```ts
test('reports only the task and sections changed by one update', () => {
  const store = new TaskStore();
  store.applyBaseline(config, [task({ issue: 1, phase: 'ci' }), task({ issue: 2, phase: 'implement' })]);
  const changes: StoreChange[] = [];
  store.onDidChange((change) => changes.push(change));
  store.applyTasks([task({ issue: 1, phase: 'ci', needsYou: true }), task({ issue: 2, phase: 'implement' })]);
  expect(changes).toEqual([{ issues: new Set([1]), sections: new Set(['attention']) }]);
});
```

- [ ] **Step 2: Run store tests and verify the missing-module failure**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/task-store.test.ts`

Expected: FAIL because `TaskStore` does not exist.

- [ ] **Step 3: Implement map-backed state and minimal signatures**

Use `Map<number, TaskWithDerived>`, cache a per-task signature that omits `lastReconciledAt`, and emit one `StoreChange` per payload. Keep config, poll metadata, connection state, and baseline-ready state separately. Expose immutable arrays from selectors rather than the mutable map.

```ts
export interface StoreChange {
  issues: ReadonlySet<number>;
  sections: ReadonlySet<'current' | 'attention' | 'all' | Phase>;
}

export type ConnectionState = 'starting' | 'connected' | 'disconnected' | 'incompatible';
```

- [ ] **Step 4: Write failing cross-platform matcher tests**

```ts
test('matches Windows paths case-insensitively and trims trailing separators', () => {
  const current = { scheme: 'file', fsPath: 'C:\\MC\\worktrees\\issue-3060\\' };
  expect(matchWorkspace(current, [taskWithPath('c:\\mc\\worktrees\\issue-3060')], 'win32')?.issue).toBe(3060);
});

test('does not fuzzy-match a parent, issue number, or non-file URI', () => {
  expect(matchWorkspace({ scheme: 'file', fsPath: 'C:\\repo\\3060' }, [taskWithPath('C:\\mc\\issue-3060')], 'win32')).toBeNull();
  expect(matchWorkspace({ scheme: 'vscode-remote', fsPath: '/mc/issue-3060' }, [taskWithPath('/mc/issue-3060')], 'linux')).toBeNull();
});
```

- [ ] **Step 5: Implement exact matching without filesystem I/O**

`normalizeWorkspacePath(path, platform)` must use `path.win32.resolve`/`path.posix.resolve`, strip trailing separators except the root, and lowercase only on Windows. `matchWorkspace` returns a task only for a `file` URI whose normalized path equals one `integration.workspacePath` exactly.

```ts
export function matchWorkspace(
  uri: { scheme: string; fsPath: string } | undefined,
  tasks: readonly TaskWithDerived[],
  platform: NodeJS.Platform = process.platform,
): TaskWithDerived | null {
  if (!uri || uri.scheme !== 'file') return null;
  const current = normalizeWorkspacePath(uri.fsPath, platform);
  return tasks.find((task) =>
    normalizeWorkspacePath(task.integration.workspacePath, platform) === current,
  ) ?? null;
}
```

- [ ] **Step 6: Run store/matcher tests and commit**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/task-store.test.ts test/unit/workspace-matcher.test.ts && npm --prefix vscode-extension run typecheck`

Expected: all store and matcher tests PASS.

```bash
git add vscode-extension/src/task-store.ts vscode-extension/src/workspace-matcher.ts vscode-extension/test/unit/task-store.test.ts vscode-extension/test/unit/workspace-matcher.test.ts
git commit -m "feat: add normalized extension task state"
```

---

### Task 5: Coordinate Server Startup, Ownership, and Reconnection

**Files:**
- Create: `vscode-extension/src/storage/atomic-file.ts`
- Create: `vscode-extension/src/server-manager.ts`
- Create: `vscode-extension/test/unit/atomic-file.test.ts`
- Create: `vscode-extension/test/unit/server-manager.test.ts`

**Interfaces:**
- Consumes: `MissionControlClient.health`, extension `globalStorageUri`, server URL, installation path, auto-start setting, and injectable process/filesystem/time functions.
- Produces: `acquireAtomicLease(path, staleMs)`, `ServerManager.ensureReady`, `ServerManager.restartOwned`, `ServerManager.dispose`, and `ServerReady` health identity.

- [ ] **Step 1: Write failing atomic lease tests**

Test exclusive acquisition, refusal while live, stale lock replacement, token-checked release, and release after action failure using a temporary directory.

```ts
const first = await acquireAtomicLease(join(temp, 'start.lock'), 10_000, now);
expect(first).not.toBeNull();
expect(await acquireAtomicLease(join(temp, 'start.lock'), 10_000, now)).toBeNull();
await first!.release();
expect(await acquireAtomicLease(join(temp, 'start.lock'), 10_000, now)).not.toBeNull();
```

- [ ] **Step 2: Implement token-checked atomic lease files**

Use `mkdir({ recursive: true })`, `open(path, 'wx')`, JSON `{ token, createdAt }`, and a random UUID. On `EEXIST`, read and expire only records older than `staleMs`, then retry once. `release()` rereads the file and unlinks only when the token still matches.

```ts
export interface AtomicLease { token: string; release(): Promise<void> }

export async function acquireAtomicLease(
  file: string,
  staleMs: number,
  now: () => number = Date.now,
): Promise<AtomicLease | null>;
```

- [ ] **Step 3: Write failing `ServerManager` tests**

Use injected `health`, `spawn`, `kill`, `delay`, and package-reader fakes. Cover:

- healthy compatible server returns without spawning;
- API version mismatch returns `incompatible`;
- non-loopback or malformed server URL is a configuration error;
- invalid installation package never spawns;
- two managers sharing a lock produce one spawn;
- readiness uses the bounded schedule `[0, 100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000, 1_000]`;
- a launched child is detached, hidden on Windows, and unreferenced;
- restart kills only when stored `{ pid, startedAt }` matches current health;
- dispose aborts waits but does not kill the server.

- [ ] **Step 4: Implement `ServerManager` with explicit dependencies**

```ts
export interface ServerManagerOptions {
  client: MissionControlClient;
  storagePath: string;
  installationPath: string | undefined;
  autoStart: boolean;
  expectedApiVersion: 1;
  process: Pick<typeof import('node:child_process'), 'spawn'>;
  kill: (pid: number) => void;
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type EnsureReadyResult =
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'incompatible'; health: HealthResponse }
  | { kind: 'configuration-error'; message: string }
  | { kind: 'unavailable'; message: string };
```

Accept only `http:` URLs whose hostname is `127.0.0.1` or `localhost`. Validate that the installation directory's `package.json` has name `mission-control` and a string `scripts.start`. Spawn `npm.cmd` on Windows and `npm` elsewhere with `['start']`, `{ cwd, detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, MC_PORT: parsedUrl.port || '4317' } }`; call `unref()`. Atomically store `{ pid, startedAt }` in `server-owner.json` only after health returns the child PID. Never start a repeating timer.

- [ ] **Step 5: Run lifecycle tests and commit**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/atomic-file.test.ts test/unit/server-manager.test.ts && npm --prefix vscode-extension run typecheck`

Expected: all lock/lifecycle tests PASS, with no process created by tests.

```bash
git add vscode-extension/src/storage/atomic-file.ts vscode-extension/src/server-manager.ts vscode-extension/test/unit/atomic-file.test.ts vscode-extension/test/unit/server-manager.test.ts
git commit -m "feat: manage Mission Control server lifecycle"
```

---

### Task 6: Add Actionable, Atomic Cross-Window Notifications

**Files:**
- Create: `vscode-extension/src/notifications/notification-events.ts`
- Create: `vscode-extension/src/notifications/delivery-ledger.ts`
- Create: `vscode-extension/src/notifications/notification-coordinator.ts`
- Create: `vscode-extension/test/unit/notification-events.test.ts`
- Create: `vscode-extension/test/unit/delivery-ledger.test.ts`
- Create: `vscode-extension/test/unit/notification-coordinator.test.ts`

**Interfaces:**
- Consumes: previous/current `TaskWithDerived`, atomic lease primitive, global storage path, and notification category settings.
- Produces: `classifyTransitions(previous, current)`, `DeliveryLedger.claim(event)`, `NotificationCoordinator.prime(tasks)`, `NotificationCoordinator.apply(tasks)`, and bounded `NotificationEvent` values consumed by the VS Code adapter.

- [ ] **Step 1: Write failing pure transition tests**

Create table-driven cases for agent finished, CI failed, CI passed with `derived.gates.ci === true`, increased human/Copilot review counts, false-to-true approval, no event on task removal, no event on identical state, and a second fail after pass.

```ts
expect(classifyTransitions(previousRunning, currentStopped)).toEqual([
  expect.objectContaining({ kind: 'agentFinished', issue: 3060 }),
]);
expect(classifyTransitions(previousFailure, currentFailure)).toEqual([]);
expect(classifyTransitions(previousPass, nextFailure)).toEqual([
  expect.objectContaining({ kind: 'ciFailed', fingerprint: expect.stringContaining(nextFailure.lastReconciledAt!) }),
]);
```

- [ ] **Step 2: Implement explicit transition classification**

```ts
export type NotificationKind = 'agentFinished' | 'ciFailed' | 'ciPassed' | 'reviewComments' | 'approvalRequired';

export interface NotificationEvent {
  kind: NotificationKind;
  issue: number;
  title: string;
  message: string;
  fingerprint: string;
  prUrl: string | null;
}
```

Build fingerprints from `issue`, kind, current `lastReconciledAt`, and the relevant state/counter. Return no event when `lastReconciledAt` is null. Never inspect badge labels or `needsYouReason` to classify a transition.

- [ ] **Step 3: Write failing ledger concurrency and bound tests**

Run two `DeliveryLedger` instances against one temporary directory and claim the same fingerprint concurrently; assert exactly one returns true. Insert 510 unique fingerprints and assert the JSON ledger contains the newest 500.

- [ ] **Step 4: Implement the atomic bounded ledger**

Under a short `notifications.lock` lease, read `notifications.json` as `{ fingerprints: string[] }`, return false if present, otherwise prepend, slice to 500, write a temporary file, and atomically rename it. Release the lease in `finally`. If another window owns the lock, retry only for the current notification at `5, 10, 20, 40, 80` ms; after five misses, fail closed and do not notify.

```ts
export class DeliveryLedger {
  constructor(storagePath: string, delay: (ms: number) => Promise<void>);
  claim(event: NotificationEvent): Promise<boolean>;
  entriesForTests(): Promise<readonly string[]>;
}
```

- [ ] **Step 5: Write coordinator tests for baseline and settings**

Assert that `prime()` delivers nothing, `apply()` compares after priming, disabled categories remain in the attention tree but do not call the presenter, and two windows sharing the ledger produce one presenter call.

- [ ] **Step 6: Implement and verify the coordinator**

The coordinator owns the previous map and invokes an injected presenter only after `ledger.claim(event)` succeeds. Preserve current state even when a category is disabled so later re-enabling does not replay old transitions.

Run: `npm --prefix vscode-extension run test:unit -- test/unit/notification-events.test.ts test/unit/delivery-ledger.test.ts test/unit/notification-coordinator.test.ts && npm --prefix vscode-extension run typecheck`

Expected: all notification tests PASS.

```bash
git add vscode-extension/src/notifications vscode-extension/test/unit/notification-events.test.ts vscode-extension/test/unit/delivery-ledger.test.ts vscode-extension/test/unit/notification-coordinator.test.ts
git commit -m "feat: add deduplicated actionable notifications"
```

---

### Task 7: Build the Worktree-First Tree and Status Bar

**Files:**
- Create: `vscode-extension/src/tree-model.ts`
- Create: `vscode-extension/src/tree-provider.ts`
- Create: `vscode-extension/src/status-bar.ts`
- Create: `vscode-extension/test/unit/tree-model.test.ts`
- Create: `vscode-extension/test/unit/tree-provider.test.ts`
- Create: `vscode-extension/test/unit/status-bar.test.ts`

**Interfaces:**
- Consumes: `TaskStore`, `WorkspaceMatcher`, `StoreChange`, current workspace URI, and VS Code tree/status primitives.
- Produces: `buildRootNodes`, `MissionControlTreeProvider`, stable `TreeNode.id`/`contextValue`, `MissionControlStatusBar`, and targeted refresh behavior.

- [ ] **Step 1: Write failing pure tree-model tests**

Assert this exact root order:

```ts
expect(buildRootNodes(snapshot, currentUri).map((node) => node.id)).toEqual([
  'section:current',
  'section:attention',
  'section:all',
]);
```

Cover Current Worktree match/unrelated text, attention sorting by bad/warn then transition time then issue, All Tasks collapsed by default and grouped by configured pipeline order, stable task IDs `task:<issue>`, and filter matching issue/title/phase. Derive severity from structured state: CI failure and changes requested are `bad`; unresolved comments, approval required, and other `needsYou` states are `warn`; never parse prose.

- [ ] **Step 2: Implement the pure tree model**

Define discriminated `SectionNode`, `PhaseNode`, `TaskNode`, `ActionNode`, and `MessageNode`. Tree nodes carry presentation data and command arguments but no `vscode` values. Use the server's pipeline ordering and deterministic tie-breakers.

```ts
export type TreeNode =
  | { kind: 'section'; id: string; label: string; expanded: boolean }
  | { kind: 'phase'; id: string; phase: Phase; label: string }
  | { kind: 'task'; id: string; issue: number; label: string; description: string; severity: 'bad' | 'warn' | 'normal' }
  | { kind: 'action'; id: string; label: string; command: string; args: readonly unknown[] }
  | { kind: 'message'; id: string; label: string };
```

- [ ] **Step 3: Write failing provider refresh tests with a minimal VS Code fake**

Inject an adapter containing `TreeItem`, `ThemeIcon`, `EventEmitter`, and `Uri` factories. Assert a change to issue 3060 fires only cached `task:3060`, plus section nodes named in `StoreChange`; a full `undefined` refresh occurs only for config/filter replacement.

- [ ] **Step 4: Implement the native provider adapter**

Map model nodes to `vscode.TreeItem`, use `CollapsibleState.Expanded` for Current and Needs Attention, `Collapsed` for All Tasks and phase groups, set `contextValue` for manifest menus, cache nodes by ID, and use `onDidChangeTreeData.fire(item)` for targeted updates.

```ts
export class MissionControlTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined>;
  getTreeItem(node: TreeNode): vscode.TreeItem;
  getChildren(node?: TreeNode): TreeNode[];
  applyStoreChange(change: StoreChange): void;
  setFilter(value: string): void;
  dispose(): void;
}
```

- [ ] **Step 5: Write and implement status-bar tests**

Test connected current-task text, omission of null model/effort, disconnected warning, unrelated workspace, and command binding. Implement two status items: task context on the left and connection on the right. Update only when their computed strings change.

```ts
function taskStatus(task: TaskWithDerived): string {
  const agent = [task.pinned.agent, task.pinned.model, task.pinned.effort].filter(Boolean).join(' · ');
  return `#${task.issue} · ${phaseLabel(task.derived.displayPhase)}${agent ? ` | ${agent}` : ''}`;
}
```

- [ ] **Step 6: Run view tests and commit**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/tree-model.test.ts test/unit/tree-provider.test.ts test/unit/status-bar.test.ts && npm --prefix vscode-extension run typecheck`

Expected: tree/status tests PASS and targeted events are asserted.

```bash
git add vscode-extension/src/tree-model.ts vscode-extension/src/tree-provider.ts vscode-extension/src/status-bar.ts vscode-extension/test/unit/tree-model.test.ts vscode-extension/test/unit/tree-provider.test.ts vscode-extension/test/unit/status-bar.test.ts
git commit -m "feat: add worktree-first Mission Control view"
```

---

### Task 8: Add Shared Agent Selection, Launch Flow, and Commands

**Files:**
- Create: `src/shared/agent-selection.ts`
- Create: `test/agent-selection.test.ts`
- Create: `vscode-extension/src/launch-flow.ts`
- Create: `vscode-extension/src/commands.ts`
- Create: `vscode-extension/test/unit/launch-flow.test.ts`
- Create: `vscode-extension/test/unit/commands.test.ts`
- Modify: `src/web/components/AgentPicker.tsx`
- Modify: `test/agent-picker.test.ts`

**Interfaces:**
- Consumes: `BoardConfig`, `AgentInfo`, `TaskStore`, `MissionControlClient.spawn`, server URL, VS Code Quick Pick/command/terminal APIs, and current workspace.
- Produces: `selectionForAgent`, `runLaunchFlow`, and commands `openTask`, `runCurrentPhase`, `openDashboard`, `viewSession`, `restartServer`, and `showLogs`.

- [ ] **Step 1: Extract agent compatibility with failing shared tests**

```ts
// test/agent-selection.test.ts
expect(selectionForAgent(
  { agent: 'claude', model: 'opus', effort: 'low' },
  agents,
  'codex',
)).toEqual({ agent: 'codex', model: '', effort: '' });

expect(selectionForAgent(
  { agent: 'claude', model: 'default', effort: 'high' },
  agents,
  'codex',
)).toEqual({ agent: 'codex', model: 'default', effort: 'high' });
```

Implement `selectionForAgent(current, agents, nextAgent, inheritedAgent?)` in `src/shared/agent-selection.ts`. Update the web `AgentPicker` to call it and simplify `test/agent-picker.test.ts` to verify component wiring while `test/agent-selection.test.ts` owns the compatibility matrix.

```ts
export interface AgentSelection { agent: string; model: string; effort: string }

export function selectionForAgent(
  current: AgentSelection,
  agents: readonly AgentInfo[],
  nextAgent: string,
  inheritedAgent?: string | null,
): AgentSelection {
  const effective = nextAgent || inheritedAgent || agents[0]?.name;
  const capabilities = agents.find((agent) => agent.name === effective);
  return {
    agent: nextAgent,
    model: capabilities?.models.includes(current.model) ? current.model : '',
    effort: capabilities?.efforts.includes(current.effort) ? current.effort : '',
  };
}
```

Keep the component's public type import stable with `export type { AgentSelection } from '../../shared/agent-selection.ts';`.

- [ ] **Step 2: Run root selection tests**

Run: `npm test -- test/agent-selection.test.ts test/agent-picker.test.ts && npm run typecheck`

Expected: shared and web picker tests PASS.

- [ ] **Step 3: Write failing launch-flow tests**

Use a fake Quick Pick adapter with queued answers. Cover configured spawnable phases only, valid preselection, unsupported model/effort clearing on agent switch, effort-step omission when `hasEffort` is false, cancellation at every step, and exact confirmation text.

```ts
expect(await runLaunchFlow(task, config, picker)).toEqual({
  phase: 'implement',
  agent: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
});
```

- [ ] **Step 4: Implement sequential picks using the shared selector**

Return `null` on cancellation. Never free-type model or effort. Resolve initial values from `task.pinned` only when supported by the selected agent. Skip effort for agents with `hasEffort === false`.

```ts
export async function runLaunchFlow(
  task: TaskWithDerived,
  config: BoardConfig,
  picker: LaunchPicker,
): Promise<SpawnRequest | null>;
```

- [ ] **Step 5: Write failing command tests**

Assert:

```ts
await commands.openTask(task);
expect(executeCommand).toHaveBeenCalledWith(
  'vscode.openFolder',
  uriFile(task.integration.workspacePath),
  { forceNewWindow: true },
);
```

Also cover missing worktree refusal; dashboard opening through `env.openExternal`; spawn delegation; exact terminal reveal only when `terminal.shellIntegration.cwd.fsPath` matches the current worktree; no attachment to another window; restart ownership result messages; and output-channel reveal.

When `openTask` receives no task argument from the Command Palette, show one Quick Pick containing every task, with Needs Attention tasks first and then issue number. When `runCurrentPhase` receives no tree-item argument, resolve the task by exact current-workspace matching and show a clear message if this is not a Mission Control worktree.

- [ ] **Step 6: Implement command handlers and run verification**

Commands must read the latest task from `TaskStore` at execution time. `openTask` checks `worktreeExists`; `runCurrentPhase` runs the launch flow then calls `client.spawn`; `viewSession` calls `terminal.show()` only for an exact normalized shell-integration cwd match; `openDashboard` uses the configured origin; failures offer the precise approved actions.

Run: `npm test -- test/agent-selection.test.ts test/agent-picker.test.ts && npm --prefix vscode-extension run test:unit -- test/unit/launch-flow.test.ts test/unit/commands.test.ts && npm run typecheck && npm --prefix vscode-extension run typecheck`

Expected: root and extension command/selection tests PASS.

```bash
git add src/shared/agent-selection.ts src/web/components/AgentPicker.tsx test/agent-selection.test.ts test/agent-picker.test.ts vscode-extension/src/launch-flow.ts vscode-extension/src/commands.ts vscode-extension/test/unit/launch-flow.test.ts vscode-extension/test/unit/commands.test.ts
git commit -m "feat: add native Mission Control launch commands"
```

---

### Task 9: Wire Runtime, Contributions, Reconnect, and Extension-Host Tests

**Files:**
- Create: `vscode-extension/src/runtime.ts`
- Create: `vscode-extension/test/unit/runtime.test.ts`
- Create: `vscode-extension/test/extension/extension.test.ts`
- Modify: `vscode-extension/src/extension.ts`
- Modify: `vscode-extension/package.json`
- Modify: `vscode-extension/esbuild.mjs`
- Modify: `vscode-extension/.vscode-test.mjs`

**Interfaces:**
- Consumes: all extension services produced by Tasks 3–8 and VS Code `ExtensionContext`.
- Produces: complete activation/deactivation lifecycle, contributed view/container/settings/commands/menus, reconnect state machine, notification presentation, and test-only activation metrics.

- [ ] **Step 1: Write failing runtime state-machine tests**

Use fake client/server/store/notification dependencies. Cover:

- server readiness → parallel config/tasks baseline → SSE connection;
- baseline primes notifications without showing one;
- first SSE open triggers one REST reconcile before the runtime becomes connected, closing the baseline/subscription race;
- SSE task events update store then coordinator;
- disconnect marks stale and disables mutations;
- reconnect delays `1s, 2s, 4s, 8s, 16s, 30s` with ±20% injected jitter;
- abort cancels the next delay and stream;
- successful reconnect fetches REST before re-enabling commands;
- a reconnect compares the refreshed state with the pre-disconnect notification state, so actionable transitions that happened offline are delivered once;
- configuration URL changes abort the old runtime and create one new client;
- notification-only settings changes do not reconnect.

- [ ] **Step 2: Implement `MissionControlRuntime`**

```ts
export class MissionControlRuntime implements vscode.Disposable {
  constructor(deps: RuntimeDependencies);
  start(): void;
  reconfigure(changedKeys: ReadonlySet<string>): void;
  lastOpenFolderArgsForTests(): readonly unknown[] | null;
  dispose(): void;
}

export interface RuntimeSettings {
  serverUrl: string;
  installationPath: string | undefined;
  autoStart: boolean;
}

export interface RuntimeDependencies {
  readSettings(): RuntimeSettings;
  createClient(serverUrl: string): MissionControlClient;
  createServerManager(client: MissionControlClient, settings: RuntimeSettings): ServerManager;
  store: TaskStore;
  notifications: NotificationCoordinator;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  jitter(delayMs: number): number;
  presentConnectionFailure(result: EnsureReadyResult): Promise<'retry' | 'configure' | 'logs' | undefined>;
}
```

`start()` launches one asynchronous connect loop and returns immediately. A healthy connection creates no timer. Backoff timers exist only after disconnection. Every loop and request shares the runtime AbortSignal. The cold sequence is health → config/tasks baseline → prime notifications → SSE open → one REST reconcile → re-prime with the authoritative post-open state → connected. The reconnect sequence is the same except refreshed tasks go through `NotificationCoordinator.apply`, preserving the pre-disconnect comparison so missed actionable transitions are delivered once.

- [ ] **Step 3: Complete manifest contributions**

Add one Activity Bar view container `missionControl`, one tree view `missionControl.tasks`, the six approved palette commands, hidden view-title refresh/filter commands, task context actions, and `viewsWelcome` for missing installation configuration. Use `onStartupFinished`; commands and the contributed view receive implicit activation on VS Code ≥1.74. Hide `missionControl.refresh` and `missionControl.filter` from the Command Palette with a `menus.commandPalette` contribution whose `when` is `false`.

The six commands are:

```text
missionControl.openTask
missionControl.runCurrentPhase
missionControl.openDashboard
missionControl.restartServer
missionControl.showLogs
missionControl.viewSession
```

Contribute these exact settings:

```json
{
  "missionControl.serverUrl": { "type": "string", "default": "http://127.0.0.1:4317" },
  "missionControl.installationPath": { "type": "string", "default": "" },
  "missionControl.autoStart": { "type": "boolean", "default": true },
  "missionControl.notifications.enabled": { "type": "boolean", "default": true },
  "missionControl.notifications.agentFinished": { "type": "boolean", "default": true },
  "missionControl.notifications.ci": { "type": "boolean", "default": true },
  "missionControl.notifications.review": { "type": "boolean", "default": true }
}
```

Maintain `missionControl.connected`, `missionControl.configured`, and `missionControl.currentTask` context keys. Menu `when` clauses must disable mutating actions while disconnected, hide View Session without a current live task, and hide Open Worktree when `worktreeExists` is false.

Register `missionControl.refresh` to call `client.reconcile()` and apply its returned tasks. Register `missionControl.filter` to request one input string and replace the provider filter; clearing the input restores all tasks. Neither command creates a polling loop.

- [ ] **Step 4: Implement synchronous activation composition**

```ts
let syncActivationMs = 0;

export interface MissionControlTestApi {
  activationMetricsForTests(): { syncActivationMs: number };
  lastOpenFolderArgs(): readonly unknown[] | null;
}

export function activate(context: vscode.ExtensionContext): MissionControlTestApi | void {
  const started = performance.now();
  const runtime = createRuntime(context);
  context.subscriptions.push(runtime);
  runtime.start();
  syncActivationMs = performance.now() - started;
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return {
      activationMetricsForTests: () => ({ syncActivationMs }),
      lastOpenFolderArgs: () => runtime.lastOpenFolderArgsForTests(),
    };
  }
}

export function activationMetricsForTests(): { syncActivationMs: number } {
  return { syncActivationMs };
}

export function deactivate(): void {}
```

`createRuntime` synchronously creates lightweight adapters and registrations only. It creates one output channel, tree view, status items, command registrations, configuration listener, and workspace-folder listener, and pushes all disposables into the runtime/context. It does not await or read the filesystem during activation.

Map `EnsureReadyResult` to explicit recovery UI once per connection-state transition:

- `configuration-error`: **Configure Installation** opens Settings focused on `missionControl.installationPath`; **Show Logs** reveals the output channel.
- `unavailable`: **Retry**, **Configure Installation**, and **Show Logs**; Retry aborts the current loop and starts one fresh attempt.
- `incompatible`: show expected/actual API versions and offer **Show Logs**; keep task mutations disabled.

Retain the last in-memory tree while disconnected and mark it stale. Do not clear tasks on a transport failure.

- [ ] **Step 5: Add native notification presentation**

Map the coordinator's five event kinds to `showInformationMessage`, `showWarningMessage`, or `showErrorMessage`. Offer only relevant actions: Open Worktree, View PR, Run Phase, Open Dashboard. Dispatch a chosen action through `CommandController`; never include prompt/custom-instruction text.

- [ ] **Step 6: Write Extension Development Host tests**

```ts
// vscode-extension/test/extension/extension.test.ts
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { MissionControlTestApi } from '../../src/extension.ts';

suite('Mission Control extension', () => {
  test('activates within the synchronous budget and registers commands', async () => {
    const extension = vscode.extensions.getExtension('otapiero.mission-control');
    assert.ok(extension);
    const api = await extension.activate() as MissionControlTestApi;
    assert.ok(api.activationMetricsForTests().syncActivationMs <= 50);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('missionControl.openTask'));
    assert.ok(commands.includes('missionControl.runCurrentPhase'));
  });
});
```

Export the test API from `activate` only in `ExtensionMode.Test`; production activation returns no API. Add host tests for configuration contribution, tree view creation, status items, `{ forceNewWindow: true }` command arguments through an injected test seam, and disposal.

- [ ] **Step 7: Run runtime, host, and full type verification**

Run: `npm --prefix vscode-extension run test:unit -- test/unit/runtime.test.ts && npm --prefix vscode-extension run typecheck && npm --prefix vscode-extension run test:extension`

Expected: runtime unit tests and Extension Development Host suite PASS. If VS Code Stable is already running and the CLI refuses a second test instance, close Stable or set the test config to the installed Insiders executable, then rerun the same suite.

- [ ] **Step 8: Commit the integrated extension**

```bash
git add vscode-extension/src/runtime.ts vscode-extension/src/extension.ts vscode-extension/package.json vscode-extension/esbuild.mjs vscode-extension/test/unit/runtime.test.ts vscode-extension/test/extension/extension.test.ts
git commit -m "feat: wire Mission Control VS Code companion"
```

---

### Task 10: Enforce Performance Budgets, Package VSIX, and Document Operations

**Files:**
- Create: `vscode-extension/test/performance/run.ts`
- Create: `vscode-extension/scripts/check-vsix-size.mjs`
- Create: `vscode-extension/README.md`
- Create: `vscode-extension/CHANGELOG.md`
- Modify: `vscode-extension/package.json`
- Modify: `vscode-extension/esbuild.mjs`
- Modify: `vscode-extension/.vscodeignore`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: complete extension, deterministic fixtures, esbuild output, and `@vscode/vsce`.
- Produces: automated activation/store/latency/heap/cache/package gates, `dist/mission-control-0.1.0.vsix`, root convenience scripts, and installation/update/uninstall documentation.

- [ ] **Step 1: Add a failing deterministic performance runner**

Build `test/performance/run.ts` as a standalone Node bundle. It must:

1. Construct 500 realistic `TaskWithDerived` objects.
2. Force GC, record heap, load config/tasks into `TaskStore`, force GC, and assert retained delta ≤25 MiB.
3. Change 100 tasks in one payload, time `applyTasks` through the synchronous store event dispatch, and assert ≤100 ms.
4. Claim 510 notification fingerprints and assert exactly 500 remain.
5. Assert the connected runtime's injected timer registry is empty after settling.

```ts
function within(name: string, actual: number, limit: number): void {
  if (actual > limit) throw new Error(`${name}: ${actual.toFixed(2)} exceeded ${limit}`);
}

globalThis.gc?.();
const before = process.memoryUsage().heapUsed;
store.applyBaseline(config, makeTasks(500));
globalThis.gc?.();
within('retained heap MiB', (process.memoryUsage().heapUsed - before) / 1024 / 1024, 25);
```

- [ ] **Step 2: Add the performance build and command**

Extend `esbuild.mjs --performance` to bundle the runner to `dist/performance.cjs`. Add:

```json
{
  "scripts": {
    "build:performance": "node esbuild.mjs --performance",
    "test:performance": "npm run build:performance && node --expose-gc dist/performance.cjs"
  }
}
```

Run: `npm --prefix vscode-extension run test:performance`

Expected before final optimization: the runner executes and reports any exceeded budget by name. Optimize data copies, signatures, listener fan-out, or bundle imports until every assertion passes; do not relax a budget.

- [ ] **Step 3: Add packaging and hard VSIX size check**

Add package scripts:

```json
{
  "scripts": {
    "package": "npm run verify && vsce package --out dist/mission-control-0.1.0.vsix && npm run check:vsix-size",
    "check:vsix-size": "node scripts/check-vsix-size.mjs dist/mission-control-0.1.0.vsix",
    "verify": "npm run typecheck && npm run test:unit && npm run test:performance && npm run build"
  }
}
```

```js
// vscode-extension/scripts/check-vsix-size.mjs
import { stat } from 'node:fs/promises';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/check-vsix-size.mjs <vsix>');
const bytes = (await stat(file)).size;
const limit = 500 * 1024;
if (bytes > limit) throw new Error(`VSIX ${bytes} bytes exceeds ${limit}`);
console.log(`VSIX ${bytes} bytes / ${limit} byte budget`);
```

Run: `npm --prefix vscode-extension run package && npm --prefix vscode-extension run check:vsix-size`

Expected: VSIX is created and is ≤512,000 bytes. Keep only `dist/extension.cjs`, `resources/mission-control.svg`, `package.json`, `README.md`, and `CHANGELOG.md` in the package; exclude source maps, tests, sources, test downloads, and development configuration.

- [ ] **Step 4: Add root convenience scripts**

Add without changing the existing root `test`, `typecheck`, or `build` semantics:

```json
{
  "scripts": {
    "extension:install-deps": "npm --prefix vscode-extension ci",
    "extension:verify": "npm --prefix vscode-extension run verify",
    "extension:test-host": "npm --prefix vscode-extension run test:extension",
    "extension:package": "npm --prefix vscode-extension run package"
  }
}
```

- [ ] **Step 5: Document install, update, configuration, logs, and uninstall**

`vscode-extension/README.md` must contain these tested commands:

```powershell
npm --prefix vscode-extension ci
npm run extension:package
code --install-extension vscode-extension\dist\mission-control-0.1.0.vsix --force
code --uninstall-extension otapiero.mission-control
```

Document the default server URL, how to set `missionControl.installationPath`, auto-start ownership rules, all notification toggles, the six commands, output-channel diagnostics, and the fact that closing VS Code does not stop the server or agents. Add a concise pointer from the root README.

- [ ] **Step 6: Run complete automated verification**

Run in this order:

```powershell
npm test
npm run typecheck
npm run build
npm --prefix vscode-extension ci
npm --prefix vscode-extension run typecheck
npm --prefix vscode-extension run test:unit
npm --prefix vscode-extension run test:performance
npm --prefix vscode-extension run test:extension
npm --prefix vscode-extension run package
npm --prefix vscode-extension run check:vsix-size
```

Expected: every command PASS; root test count does not regress; performance output is within every budget; Extension Host tests pass; VSIX size is within 500 KiB.

- [ ] **Step 7: Perform Windows manual acceptance**

Install the VSIX and verify each case, recording observed activation time, idle CPU, and result in the commit message notes or PR description:

1. Server already running.
2. Cold auto-start with a valid installation path.
3. Two VS Code windows open simultaneously and only one server starts.
4. Select a task and confirm it opens in a new window while the current window remains.
5. Kill/restart the server and confirm stale state plus recovery.
6. Temporarily interrupt SSE and confirm bounded backoff/recovery.
7. Confirm missing worktree refusal.
8. Trigger each of the five notification kinds and confirm no replay after restart.
9. Launch Claude, Copilot, and Codex with valid model/effort combinations.
10. Switch from Claude/Opus to Codex and confirm the unsupported model clears.
11. Close VS Code while an agent is running and confirm the process survives.
12. Observe an idle connected Extension Host for five minutes and confirm effectively 0% added CPU.

- [ ] **Step 8: Commit packaging and documentation**

```bash
git add package.json README.md vscode-extension/package.json vscode-extension/esbuild.mjs vscode-extension/.vscodeignore vscode-extension/test/performance/run.ts vscode-extension/scripts/check-vsix-size.mjs vscode-extension/README.md vscode-extension/CHANGELOG.md
git commit -m "docs: package and verify VS Code companion"
```

---

## Final Review Gate

- [ ] Confirm `git status --short` shows only intended implementation files plus the preserved user-owned `assets/scripts/run-phase.ps1` change.
- [ ] Confirm `git diff --check` reports no whitespace errors.
- [ ] Confirm the server never performs extra GitHub requests to populate `integration`.
- [ ] Confirm the extension never parses badge labels/reason prose for transitions.
- [ ] Confirm no healthy-connection polling or client timer exists.
- [ ] Confirm all locks and notification ledgers are bounded and token checked.
- [ ] Confirm every listener, stream, timer, tree, status item, output channel, and command registration is disposed.
- [ ] Confirm no prompt, custom instructions, environment values, or secrets appear in logs.
- [ ] Confirm the `.vsix` can be installed with the documented command and stays within 500 KiB.
- [ ] Confirm the design spec's 12 acceptance criteria are each covered by a passing automated or recorded manual test.
