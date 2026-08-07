  # T3 Code Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `t3` as a third Mission Control launcher, so a phase can run as a T3 Code thread bound to Mission Control's own worktree, with T3 supplying real session liveness and approval-blocked detection — and with zero lines of T3 Code changed.

**Architecture:** A new `src/orchestrator/t3/` module talks to the T3 server the desktop app already runs, over its published REST API only. Discovery reads T3's own `server-runtime.json`; authentication exchanges a hand-minted pairing credential for a scoped bearer token. `spawnPhase` gains a third launch branch that creates a thread and starts a turn in one dispatch. `facts.ts` fetches one orchestration snapshot per reconcile interval and indexes it by recorded thread ids. Every T3 response is validated at the boundary and degrades to `undefined` on failure, so an upstream change costs liveness, never correctness.

**Tech Stack:** TypeScript on Node 24 via `tsx` (ESM, `.ts` import specifiers), zod v4 for boundary validation, `fetch` with `AbortSignal.timeout`, Fastify + SSE server, React + Vite board, vitest.

**Spec:** [2026-08-07-t3code-integration-design.md](../specs/2026-08-07-t3code-integration-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Zero changes to T3 Code.** No fork, no patch, no vendored source, no dependency on `@t3tools/*` (those packages are `"private": true` and unpublished). T3 is consumed like `gh`: an external tool behind a version pin.
- **Zero footprint in the Acme checkout.** Nothing is written into `config.repo.path` or into a worktree. All Mission Control state stays under `%USERPROFILE%\.mc\` (`MC_HOME` in tests).
- **Pinned T3 version: `0.0.31`.** Every schema and payload in this plan was read from that build's `resources/app.asar` and confirmed by request against a running instance.
- **`reconcile.ts` stays pure.** No filesystem, no network, no clock. All I/O belongs in `facts.ts` / `poller.ts`.
- **Boundary validation never throws.** Every T3 response goes through `safeParse`. A failure logs at most once per interval and yields `undefined`. The board must keep working with T3 absent, broken, or upgraded.
- **Every T3 request is bounded.** Use `AbortSignal.timeout(T3_TIMEOUT_MS)` on every `fetch`, for the same reason `SUBPROCESS_TIMEOUT_MS` exists in [exec.ts](../../../src/orchestrator/exec.ts): the poller runs reconciles behind a single serialized promise, so one unbounded call wedges the board permanently.
- **`runtimeMode` and `interactionMode` are always sent explicitly.** T3's own decoding default for `runtimeMode` is `full-access`. An omitted field does not mean "be careful", it means "no restrictions".
- **Import style:** relative specifiers include the `.ts` extension (`import { x } from './paths.ts'`). Match the surrounding files.
- **zod is 4.4.3.** `z.object({…}).loose()` (passthrough), `z.array(…).default([])` and `z.record(k, v).default({})` were all confirmed working at that version. Do not substitute the v3 spellings.
- **Tests** live in `test/*.test.ts`, run with `npm test` (vitest), and set `process.env.MC_HOME` to a `mkdtempSync` directory in `beforeEach`, deleting it in `afterEach`. Follow the shape of [test/markers.test.ts](../../../test/markers.test.ts).
- **Commit after every task.** Run `npm test` and `npm run typecheck` before each commit.

### Verified T3 facts this plan depends on

| Fact | Value |
| --- | --- |
| Runtime discovery file | `~/.t3/userdata/server-runtime.json` |
| Its shape | `{ version, pid, host, port, origin, startedAt }` |
| Origin observed | `http://127.0.0.1:3773` |
| Unauthenticated endpoints | `GET /.well-known/t3/environment`, `GET /api/auth/session` |
| Auth policy reported | `desktop-managed-local`, `bootstrapMethods: ["desktop-bootstrap"]` |
| Token exchange | `POST /oauth/token`, form-urlencoded |
| Orchestration endpoints | `GET /api/orchestration/snapshot`, `POST /api/orchestration/dispatch` (both bearer-only; return `401` bare) |
| Dispatch success body | `{ "sequence": <number> }` |
| Provider readiness files | `~/.t3/caches/<instanceId>.json` |
| Instances ready on this machine | `claudeAgent` (claude 2.1.224), `codex` (0.146.0) |
| Instances not usable | `opencode` (`installed: false`), `cursor`/`grok` (disabled) |
| Entity ids (`threadId`, `projectId`, …) | any non-empty trimmed string; use `crypto.randomUUID()` |

---

## Task 1: Confirm the board renders in T3's preview panel

The spec's §5.1 marks this the one unverified claim and requires implementation to begin here. It is cheap, and it gates §5 alone — Tasks 2–13 stand regardless of the outcome. Doing it first prevents building a panel integration on an assumption.

**Files:**
- Create: `docs/superpowers/notes/2026-08-07-t3-preview-panel-finding.md`

- [ ] **Step 1: Start the Mission Control board**

```powershell
npm start
```

Confirm `http://127.0.0.1:4317` loads in a normal browser first. If it does not, fix that before continuing — a failure here is Mission Control's, not T3's.

- [ ] **Step 2: Open T3 Code and add a project pointing at the Acme checkout**

Launch `T3 Code (Alpha)` from the Start menu. (Start-menu launches inherit the login environment, which is how T3 finds the `claude` and `codex` CLIs on PATH.) Add a project whose workspace root is the value of `repo.path` in `~/.mc/config.yaml`.

- [ ] **Step 3: Add a project script with a `previewUrl` pointing at the board**

In the project's script settings, add:

- Name: `Mission Control`
- Icon: `configure`
- Command: `curl -sf http://127.0.0.1:4317/health || echo "Mission Control is not running"`
- Preview URL: `http://127.0.0.1:4317`
- Auto-open preview: on
- Run on worktree create: off

The command is deliberately a health probe, not a launcher. T3 runs scripts in a worktree-scoped terminal, so starting the board there would tie the board's lifetime to a thread.

- [ ] **Step 4: Run the script and record what happens**

Answer these four questions by observation, not inference:

1. Does the board render in the preview panel at all?
2. Does the SSE stream stay connected? (Watch a card update after `npm run mc -- reconcile <issue>` in another terminal. Cards updating live means SSE survives.)
3. Do clicks and the drawer work, or is the webview read-only in practice?
4. Does the panel survive switching threads and coming back?

- [ ] **Step 5: Write the finding**

Create `docs/superpowers/notes/2026-08-07-t3-preview-panel-finding.md`:

```markdown
# Does the Mission Control board render inside T3 Code's preview panel?

Tested against T3 Code 0.0.31 on 2026-08-07.

## Result

<one of: WORKS / WORKS WITH LIMITS / DOES NOT WORK>

## Observations

- Renders: <yes/no, with what you actually saw>
- SSE stays connected: <yes/no — evidence: did a card update live?>
- Interaction works: <yes/no>
- Survives thread switching: <yes/no>

## Consequence for the plan

<If WORKS: Task 12's "Open board in T3" affordance is worth building.
If DOES NOT WORK: §5 of the spec is dead; say why, and note that
Tasks 2-11 and 13 are unaffected. Task 12 then ships only the launcher
selector and the thread link, not the preview script.>
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/notes/2026-08-07-t3-preview-panel-finding.md
git commit -m "docs: record whether the board renders in T3's preview panel"
```

---

## Task 2: T3 paths and response schemas

The foundation both later tasks build on: where T3's files live, and the zod schemas that every response must survive. Schemas cover only the fields this design consumes — a narrow schema is what makes an upstream addition harmless.

**Files:**
- Create: `src/orchestrator/t3/paths.ts`
- Create: `src/orchestrator/t3/schemas.ts`
- Test: `test/t3-schemas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `t3Home(): string`, `t3ServerRuntimePath(): string`, `t3ProviderCachePath(instanceId: string): string`
  - `T3_TIMEOUT_MS: number`
  - `serverRuntimeSchema`, `environmentDescriptorSchema`, `authSessionSchema`, `accessTokenSchema`, `providerCacheSchema`, `snapshotSchema`, `dispatchResultSchema` (all `z.ZodType`)
  - Types `ServerRuntime`, `EnvironmentDescriptor`, `AuthSession`, `AccessToken`, `ProviderCache`, `T3Snapshot`, `T3SnapshotThread`
  - `safeParseT3<T>(schema: z.ZodType<T>, value: unknown): T | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/t3-schemas.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  t3Home,
  t3ServerRuntimePath,
  t3ProviderCachePath,
} from '../src/orchestrator/t3/paths.ts';
import {
  serverRuntimeSchema,
  environmentDescriptorSchema,
  authSessionSchema,
  accessTokenSchema,
  providerCacheSchema,
  snapshotSchema,
  dispatchResultSchema,
  safeParseT3,
} from '../src/orchestrator/t3/schemas.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.T3_HOME = home;
});

afterEach(() => {
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('t3 paths', () => {
  test('T3_HOME overrides the location so tests never touch the real ~/.t3', () => {
    expect(t3Home()).toBe(home);
  });

  test('the runtime file sits under userdata, where T3 writes it', () => {
    expect(t3ServerRuntimePath()).toBe(join(home, 'userdata', 'server-runtime.json'));
  });

  test('provider readiness is one file per instance under caches', () => {
    expect(t3ProviderCachePath('codex')).toBe(join(home, 'caches', 'codex.json'));
  });
});

describe('serverRuntimeSchema', () => {
  // Captured verbatim from a running T3 Code 0.0.31 desktop instance.
  const real = {
    version: 1,
    pid: 5132,
    host: '127.0.0.1',
    port: 3773,
    origin: 'http://127.0.0.1:3773',
    startedAt: '2026-08-07T09:09:13.504Z',
  };

  test('accepts the real recorded shape', () => {
    expect(safeParseT3(serverRuntimeSchema, real)).toEqual(real);
  });

  test('tolerates fields we do not consume being added upstream', () => {
    const parsed = safeParseT3(serverRuntimeSchema, { ...real, devUrl: 'http://x' });
    expect(parsed?.origin).toBe('http://127.0.0.1:3773');
  });

  test('rejects a runtime file with no origin, rather than guessing one', () => {
    const { origin, ...withoutOrigin } = real;
    expect(safeParseT3(serverRuntimeSchema, withoutOrigin)).toBeUndefined();
  });

  test('rejects a non-numeric pid, since liveness depends on it', () => {
    expect(safeParseT3(serverRuntimeSchema, { ...real, pid: 'nope' })).toBeUndefined();
  });
});

describe('environmentDescriptorSchema', () => {
  const real = {
    environmentId: '9e975bfc-a60a-48f1-8544-a3541aa16287',
    label: 'DESKTOP-BU3FRL8',
    platform: { os: 'windows', arch: 'x64' },
    serverVersion: '0.0.31',
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
      threadSettlement: true,
      threadSnooze: true,
      serverSelfUpdate: 'desktop-managed',
    },
  };

  test('accepts the real recorded shape and exposes the version pin', () => {
    expect(safeParseT3(environmentDescriptorSchema, real)?.serverVersion).toBe('0.0.31');
  });

  test('keeps capabilities as an opaque record so new ones do not break it', () => {
    const parsed = safeParseT3(environmentDescriptorSchema, {
      ...real,
      capabilities: { ...real.capabilities, somethingNew: 42 },
    });
    expect(parsed?.capabilities.somethingNew).toBe(42);
  });
});

describe('authSessionSchema', () => {
  const real = {
    authenticated: false,
    auth: {
      policy: 'desktop-managed-local',
      bootstrapMethods: ['desktop-bootstrap'],
      sessionMethods: ['browser-session-cookie', 'bearer-access-token', 'dpop-access-token'],
      sessionCookieName: 't3_session_3773',
    },
  };

  test('accepts the real recorded shape', () => {
    expect(safeParseT3(authSessionSchema, real)?.auth.policy).toBe('desktop-managed-local');
  });

  test('accepts an authenticated session too', () => {
    expect(safeParseT3(authSessionSchema, { ...real, authenticated: true })?.authenticated).toBe(true);
  });
});

describe('accessTokenSchema', () => {
  test('accepts the OAuth token-exchange reply', () => {
    const parsed = safeParseT3(accessTokenSchema, {
      access_token: 'abc123',
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'orchestration:read orchestration:operate',
    });
    expect(parsed?.access_token).toBe('abc123');
    expect(parsed?.expires_in).toBe(3600);
  });

  test('rejects a reply with no access token', () => {
    expect(safeParseT3(accessTokenSchema, { token_type: 'Bearer', expires_in: 60 })).toBeUndefined();
  });
});

describe('providerCacheSchema', () => {
  // Captured verbatim from ~/.t3/caches/codex.json.
  const codex = {
    displayName: 'Codex',
    enabled: true,
    installed: true,
    status: 'ready',
    version: '0.146.0',
    auth: { status: 'authenticated', type: 'chatgpt' },
    models: [{ slug: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
  };

  test('accepts a ready, authenticated instance', () => {
    expect(safeParseT3(providerCacheSchema, codex)?.status).toBe('ready');
  });

  test('accepts an errored instance — not-installed is data, not a parse failure', () => {
    const parsed = safeParseT3(providerCacheSchema, {
      displayName: 'OpenCode',
      enabled: true,
      installed: false,
      status: 'error',
      version: null,
      auth: { status: 'unknown' },
      models: [],
    });
    expect(parsed?.installed).toBe(false);
    expect(parsed?.status).toBe('error');
  });

  test('defaults a missing models array to empty rather than failing', () => {
    const { models, ...withoutModels } = codex;
    expect(safeParseT3(providerCacheSchema, withoutModels)?.models).toEqual([]);
  });
});

describe('snapshotSchema', () => {
  const thread = {
    id: 'thread-1',
    projectId: 'project-1',
    title: '#3060 plan',
    branch: 'ouriel/3060-thing',
    worktreePath: 'C:\\Users\\ouriel\\.mc\\worktrees\\issue-3060',
    activities: [{ id: 'e1', tone: 'info', kind: 'turn.started', summary: 'started' }],
    session: {
      threadId: 'thread-1',
      status: 'running',
      activeTurnId: 'turn-1',
      lastError: null,
    },
  };

  test('accepts a snapshot and exposes threads', () => {
    const parsed = safeParseT3(snapshotSchema, {
      snapshotSequence: 7,
      projects: [],
      threads: [thread],
      updatedAt: '2026-08-07T09:00:00.000Z',
    });
    expect(parsed?.threads).toHaveLength(1);
    expect(parsed?.threads[0].session?.status).toBe('running');
  });

  test('accepts a thread with no session — a thread that never ran is normal', () => {
    const parsed = safeParseT3(snapshotSchema, {
      snapshotSequence: 1,
      projects: [],
      threads: [{ ...thread, session: null }],
      updatedAt: '2026-08-07T09:00:00.000Z',
    });
    expect(parsed?.threads[0].session).toBeNull();
  });

  test('rejects an unknown session status rather than inventing liveness', () => {
    // If upstream adds a status we do not know, we must degrade, not guess
    // whether it means running.
    expect(
      safeParseT3(snapshotSchema, {
        snapshotSequence: 1,
        projects: [],
        threads: [{ ...thread, session: { ...thread.session, status: 'hibernating' } }],
        updatedAt: '2026-08-07T09:00:00.000Z',
      }),
    ).toBeUndefined();
  });

  test('rejects a body that is not a snapshot at all', () => {
    expect(safeParseT3(snapshotSchema, { error: 'unauthorized' })).toBeUndefined();
  });

  test('rejects null and undefined without throwing', () => {
    expect(safeParseT3(snapshotSchema, null)).toBeUndefined();
    expect(safeParseT3(snapshotSchema, undefined)).toBeUndefined();
  });
});

describe('dispatchResultSchema', () => {
  test('accepts the sequence T3 returns on a successful dispatch', () => {
    expect(safeParseT3(dispatchResultSchema, { sequence: 12 })?.sequence).toBe(12);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-schemas.test.ts`
Expected: FAIL — `Cannot find module '../src/orchestrator/t3/paths.ts'`

- [ ] **Step 3: Write `src/orchestrator/t3/paths.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where T3 Code keeps the files Mission Control reads.
 *
 * Two directories exist and only one matters. Electron's Chromium profile
 * lives under %APPDATA%\t3code; everything this integration reads — the
 * server's runtime descriptor and the per-provider readiness caches — lives
 * under ~/.t3. Confusing them wastes an afternoon, which is why the split is
 * recorded here rather than at the call sites.
 *
 * T3_HOME overrides the location, which is what lets tests run against a temp
 * directory instead of the real one, mirroring MC_HOME in ./paths.ts.
 */
export function t3Home(): string {
  return process.env.T3_HOME ?? join(homedir(), '.t3');
}

/** T3's own record of the server it is currently running. */
export function t3ServerRuntimePath(): string {
  return join(t3Home(), 'userdata', 'server-runtime.json');
}

/**
 * Per-provider readiness, refreshed by T3 itself.
 *
 * This is the only source for whether an instance can actually run: the REST
 * surface carries projects and threads but no provider list, and provider
 * state lives on the WebSocket, which this integration does not use.
 */
export function t3ProviderCachePath(instanceId: string): string {
  return join(t3Home(), 'caches', `${instanceId}.json`);
}

/**
 * The ceiling on any request to T3.
 *
 * Same reasoning as SUBPROCESS_TIMEOUT_MS in ../exec.ts: reconciles run behind
 * the poller's single serialized promise, so one request that never returns
 * wedges the board permanently rather than losing one cycle. T3 is on loopback,
 * so this can be much tighter than the `gh` budget.
 */
export const T3_TIMEOUT_MS = 10_000;
```

- [ ] **Step 4: Write `src/orchestrator/t3/schemas.ts`**

```ts
import { z } from 'zod';

/**
 * What Mission Control is willing to believe from T3 Code.
 *
 * Every schema here covers only the fields this integration consumes, and
 * every object is non-strict, so an upstream release that *adds* a field is a
 * no-op. A release that *changes* one we depend on fails the parse, and
 * safeParseT3 turns that into `undefined` rather than a throw. That is the
 * whole degradation guarantee: an upstream change costs liveness, never
 * correctness.
 *
 * Recorded against T3 Code 0.0.31.
 */

export const serverRuntimeSchema = z.object({
  version: z.number(),
  pid: z.number(),
  host: z.string().optional(),
  port: z.number(),
  origin: z.string().min(1),
  startedAt: z.string().optional(),
});
export type ServerRuntime = z.infer<typeof serverRuntimeSchema>;

export const environmentDescriptorSchema = z.object({
  environmentId: z.string(),
  label: z.string().optional(),
  serverVersion: z.string(),
  // Deliberately opaque: this is upstream's own statement of what the server
  // can do, it will grow, and doctor prints it verbatim.
  capabilities: z.record(z.string(), z.unknown()).default({}),
});
export type EnvironmentDescriptor = z.infer<typeof environmentDescriptorSchema>;

export const authSessionSchema = z.object({
  authenticated: z.boolean(),
  auth: z.object({
    policy: z.enum([
      'desktop-managed-local',
      'loopback-browser',
      'remote-reachable',
      'unsafe-no-auth',
    ]),
    bootstrapMethods: z.array(z.string()).default([]),
    sessionMethods: z.array(z.string()).default([]),
    sessionCookieName: z.string().optional(),
  }),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const accessTokenSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
});
export type AccessToken = z.infer<typeof accessTokenSchema>;

export const providerCacheSchema = z.object({
  displayName: z.string(),
  enabled: z.boolean(),
  installed: z.boolean(),
  status: z.string(),
  version: z.string().nullable().optional(),
  auth: z.object({ status: z.string() }).loose().optional(),
  message: z.string().optional(),
  models: z.array(z.object({ slug: z.string() }).loose()).default([]),
});
export type ProviderCache = z.infer<typeof providerCacheSchema>;

/**
 * Session status is a closed set on purpose.
 *
 * Liveness is derived from it, so an unrecognised value must fail the parse and
 * drop us back to PID liveness. Silently treating an unknown status as "not
 * running" would show a working agent as dead.
 */
export const sessionStatusSchema = z.enum([
  'idle',
  'starting',
  'running',
  'ready',
  'interrupted',
  'stopped',
  'error',
]);
export type T3SessionStatus = z.infer<typeof sessionStatusSchema>;

const activitySchema = z.object({
  id: z.string(),
  tone: z.enum(['info', 'tool', 'approval', 'error']),
  kind: z.string().optional(),
  summary: z.string().optional(),
});

const sessionSchema = z.object({
  threadId: z.string(),
  status: sessionStatusSchema,
  activeTurnId: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
});

const threadSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  branch: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  activities: z.array(activitySchema).default([]),
  session: sessionSchema.nullable().default(null),
});
export type T3SnapshotThread = z.infer<typeof threadSchema>;

export const snapshotSchema = z.object({
  snapshotSequence: z.number().optional(),
  projects: z
    .array(z.object({ id: z.string(), title: z.string(), workspaceRoot: z.string() }).loose())
    .default([]),
  threads: z.array(threadSchema).default([]),
});
export type T3Snapshot = z.infer<typeof snapshotSchema>;

export const dispatchResultSchema = z.object({ sequence: z.number() });

/**
 * Parse a T3 response, or give up quietly.
 *
 * Returning undefined rather than throwing is the load-bearing decision: every
 * caller is on the reconcile path, where a throw would take out the whole
 * board to report that one optional badge is unavailable.
 */
export function safeParseT3<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/t3-schemas.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/t3/paths.ts src/orchestrator/t3/schemas.ts test/t3-schemas.test.ts
git commit -m "feat(t3): paths and boundary schemas for the T3 Code surface"
```

---

## Task 3: Discovery — is T3 running, and where?

Turns "T3 might be running" into a definite answer with a reason attached. Every failure is a first-class state, never an error, because "T3 is not running" is a completely normal condition for this board.

**Files:**
- Create: `src/orchestrator/t3/discovery.ts`
- Test: `test/t3-discovery.test.ts`

**Interfaces:**
- Consumes: `t3ServerRuntimePath()`, `T3_TIMEOUT_MS` from `./paths.ts`; `serverRuntimeSchema`, `environmentDescriptorSchema`, `safeParseT3` from `./schemas.ts`.
- Produces:
  ```ts
  export type T3Unavailable =
    | { reason: 'no-runtime-file'; detail: string }
    | { reason: 'unreadable-runtime-file'; detail: string }
    | { reason: 'dead-server'; detail: string }
    | { reason: 'unreachable'; detail: string };

  export type T3Discovery =
    | { ok: true; origin: string; pid: number; serverVersion: string; capabilities: Record<string, unknown> }
    | ({ ok: false } & T3Unavailable);

  export function readServerRuntime(): ServerRuntime | undefined;
  export function discoverT3(fetchImpl?: typeof fetch): Promise<T3Discovery>;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/t3-discovery.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t3ServerRuntimePath } from '../src/orchestrator/t3/paths.ts';
import { discoverT3, readServerRuntime } from '../src/orchestrator/t3/discovery.ts';

let home: string;

function writeRuntime(body: unknown): void {
  const file = t3ServerRuntimePath();
  mkdirSync(join(home, 'userdata'), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}

/** A live runtime file: our own pid is by definition alive. */
function liveRuntime(origin = 'http://127.0.0.1:3773') {
  return {
    version: 1,
    pid: process.pid,
    host: '127.0.0.1',
    port: 3773,
    origin,
    startedAt: '2026-08-07T09:09:13.504Z',
  };
}

const descriptor = {
  environmentId: 'env-1',
  label: 'DESKTOP-TEST',
  serverVersion: '0.0.31',
  capabilities: { serverSelfUpdate: 'desktop-managed' },
};

function fakeFetch(response: { status?: number; body?: unknown }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response.body ?? descriptor), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.T3_HOME = home;
});

afterEach(() => {
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('readServerRuntime', () => {
  test('reads a well-formed runtime file', () => {
    writeRuntime(liveRuntime());
    expect(readServerRuntime()?.origin).toBe('http://127.0.0.1:3773');
  });

  test('a missing file is undefined, not a throw', () => {
    expect(readServerRuntime()).toBeUndefined();
  });

  test('a truncated file is undefined, not a throw', () => {
    writeRuntime('{ not json');
    expect(readServerRuntime()).toBeUndefined();
  });
});

describe('discoverT3', () => {
  test('reports the origin, version and capabilities when everything is up', async () => {
    writeRuntime(liveRuntime());
    const result = await discoverT3(fakeFetch({}));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.origin).toBe('http://127.0.0.1:3773');
    expect(result.serverVersion).toBe('0.0.31');
    expect(result.capabilities.serverSelfUpdate).toBe('desktop-managed');
  });

  test('no runtime file means T3 is simply not running', async () => {
    const result = await discoverT3(fakeFetch({}));
    expect(result).toMatchObject({ ok: false, reason: 'no-runtime-file' });
  });

  test('a corrupt runtime file is distinguished from an absent one', async () => {
    writeRuntime('{ not json');
    expect(await discoverT3(fakeFetch({}))).toMatchObject({
      ok: false,
      reason: 'unreadable-runtime-file',
    });
  });

  test('a runtime file naming a dead process does not count as running', async () => {
    // T3 crashed without cleaning up. The same liveness discipline the phase
    // markers already use applies here.
    writeRuntime({ ...liveRuntime(), pid: 0x7ffffff });
    expect(await discoverT3(fakeFetch({}))).toMatchObject({ ok: false, reason: 'dead-server' });
  });

  test('a live pid whose server does not answer is unreachable, not running', async () => {
    writeRuntime(liveRuntime());
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await discoverT3(failing)).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  test('a non-200 descriptor is unreachable rather than a crash', async () => {
    writeRuntime(liveRuntime());
    expect(await discoverT3(fakeFetch({ status: 500 }))).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  test('a descriptor that fails validation is unreachable, never a throw', async () => {
    writeRuntime(liveRuntime());
    const result = await discoverT3(fakeFetch({ body: { nope: true } }));
    expect(result.ok).toBe(false);
  });

  test('a trailing slash on the origin does not produce a double slash', async () => {
    writeRuntime(liveRuntime('http://127.0.0.1:3773/'));
    let seen = '';
    const capturing = (async (url: string) => {
      seen = String(url);
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;
    await discoverT3(capturing);
    expect(seen).toBe('http://127.0.0.1:3773/.well-known/t3/environment');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-discovery.test.ts`
Expected: FAIL — `Cannot find module '../src/orchestrator/t3/discovery.ts'`

- [ ] **Step 3: Write `src/orchestrator/t3/discovery.ts`**

```ts
import { readFileSync } from 'node:fs';

import { T3_TIMEOUT_MS, t3ServerRuntimePath } from './paths.ts';
import {
  environmentDescriptorSchema,
  safeParseT3,
  serverRuntimeSchema,
  type ServerRuntime,
} from './schemas.ts';

/**
 * Finding T3 Code, or establishing that it is not there.
 *
 * Mission Control never spawns T3's server — the desktop application owns its
 * own lifecycle, which is what preserves the principle that the app is never
 * the parent of a run. So discovery is pure observation, and "not available"
 * is a first-class answer rather than an error.
 *
 * Each failure carries its own reason because the three cases need different
 * fixes: no file means start T3, a dead pid means T3 crashed, unreachable
 * means something is wrong with the server itself.
 */

export type T3Unavailable =
  | { reason: 'no-runtime-file'; detail: string }
  | { reason: 'unreadable-runtime-file'; detail: string }
  | { reason: 'dead-server'; detail: string }
  | { reason: 'unreachable'; detail: string };

export type T3Discovery =
  | {
      ok: true;
      origin: string;
      pid: number;
      serverVersion: string;
      capabilities: Record<string, unknown>;
    }
  | ({ ok: false } & T3Unavailable);

export function readServerRuntime(): ServerRuntime | undefined {
  try {
    return safeParseT3(serverRuntimeSchema, JSON.parse(readFileSync(t3ServerRuntimePath(), 'utf8')));
  } catch {
    // Missing, truncated, or unreadable — all mean the same thing to a caller.
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Join an origin to a path without producing a double slash. */
export function t3Url(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}

export async function discoverT3(fetchImpl: typeof fetch = fetch): Promise<T3Discovery> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(t3ServerRuntimePath(), 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { ok: false, reason: 'no-runtime-file', detail: t3ServerRuntimePath() }
      : { ok: false, reason: 'unreadable-runtime-file', detail: String(err) };
  }

  const runtime = safeParseT3(serverRuntimeSchema, raw);
  if (!runtime) {
    return { ok: false, reason: 'unreadable-runtime-file', detail: 'failed schema validation' };
  }

  if (!isProcessAlive(runtime.pid)) {
    return { ok: false, reason: 'dead-server', detail: `pid ${runtime.pid} is gone` };
  }

  // The descriptor is unauthenticated, which is what makes it usable as a
  // reachability probe and as the version pin even when pairing is broken.
  try {
    const res = await fetchImpl(t3Url(runtime.origin, '/.well-known/t3/environment'), {
      signal: AbortSignal.timeout(T3_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: 'unreachable', detail: `descriptor returned ${res.status}` };
    }
    const descriptor = safeParseT3(environmentDescriptorSchema, await res.json());
    if (!descriptor) {
      return { ok: false, reason: 'unreachable', detail: 'descriptor failed validation' };
    }
    return {
      ok: true,
      origin: runtime.origin,
      pid: runtime.pid,
      serverVersion: descriptor.serverVersion,
      capabilities: descriptor.capabilities,
    };
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: String(err) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/t3-discovery.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/t3/discovery.ts test/t3-discovery.test.ts
git commit -m "feat(t3): discover the running T3 server, or say why not"
```

---

## Task 4: Provider instance readiness

Decides whether a configured `t3Instance` can actually run a turn, before a dispatch is sent. This is what turns "dispatch rejected for an unhelpful reason" into "OpenCode is not installed".

**Files:**
- Create: `src/orchestrator/t3/instances.ts`
- Test: `test/t3-instances.test.ts`

**Interfaces:**
- Consumes: `t3ProviderCachePath()` from `./paths.ts`; `providerCacheSchema`, `safeParseT3` from `./schemas.ts`.
- Produces:
  ```ts
  export interface InstanceReadiness {
    instanceId: string;
    ready: boolean;
    /** Present when ready is false — a sentence fit to show on a card. */
    reason: string | null;
    models: string[];
  }
  export function readInstanceReadiness(instanceId: string): InstanceReadiness;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/t3-instances.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { t3ProviderCachePath } from '../src/orchestrator/t3/paths.ts';
import { readInstanceReadiness } from '../src/orchestrator/t3/instances.ts';

let home: string;

function writeCache(instanceId: string, body: unknown): void {
  mkdirSync(join(home, 'caches'), { recursive: true });
  writeFileSync(
    t3ProviderCachePath(instanceId),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8',
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.T3_HOME = home;
});

afterEach(() => {
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('readInstanceReadiness', () => {
  test('a ready, installed, enabled instance is launchable', () => {
    // Recorded from ~/.t3/caches/codex.json.
    writeCache('codex', {
      displayName: 'Codex',
      enabled: true,
      installed: true,
      status: 'ready',
      version: '0.146.0',
      auth: { status: 'authenticated' },
      models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }],
    });
    const readiness = readInstanceReadiness('codex');
    expect(readiness.ready).toBe(true);
    expect(readiness.reason).toBeNull();
    expect(readiness.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  test('an instance whose CLI is not installed is not launchable, and says so', () => {
    // Recorded from ~/.t3/caches/opencode.json on 2026-08-07.
    writeCache('opencode', {
      displayName: 'OpenCode',
      enabled: true,
      installed: false,
      status: 'error',
      version: null,
      auth: { status: 'unknown' },
      models: [],
    });
    const readiness = readInstanceReadiness('opencode');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('OpenCode');
    expect(readiness.reason).toContain('not installed');
  });

  test('a disabled instance is not launchable', () => {
    writeCache('grok', {
      displayName: 'Grok',
      enabled: false,
      installed: false,
      status: 'disabled',
      version: null,
      models: [],
    });
    const readiness = readInstanceReadiness('grok');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('disabled');
  });

  test('an installed but unauthenticated instance is not launchable', () => {
    writeCache('claudeAgent', {
      displayName: 'Claude',
      enabled: true,
      installed: true,
      status: 'unauthenticated',
      version: '2.1.224',
      auth: { status: 'unauthenticated' },
      models: [{ slug: 'claude-opus-5' }],
    });
    const readiness = readInstanceReadiness('claudeAgent');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('unauthenticated');
  });

  test('an unknown instance id is not launchable and names the file it looked for', () => {
    const readiness = readInstanceReadiness('nonexistent');
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('nonexistent');
  });

  test('a corrupt cache file is not launchable rather than a crash', () => {
    writeCache('codex', '{ not json');
    expect(() => readInstanceReadiness('codex')).not.toThrow();
    expect(readInstanceReadiness('codex').ready).toBe(false);
  });

  test('a path-traversing instance id cannot escape the caches directory', () => {
    // Instance ids come from config.yaml, which is hand-edited; a typo must
    // not turn into a read of an arbitrary file.
    const readiness = readInstanceReadiness('../../userdata/server-runtime');
    expect(readiness.ready).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-instances.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/orchestrator/t3/instances.ts`**

```ts
import { readFileSync } from 'node:fs';

import { t3ProviderCachePath } from './paths.ts';
import { providerCacheSchema, safeParseT3 } from './schemas.ts';

/**
 * Can this T3 provider instance actually run a turn?
 *
 * T3 exposes no provider list over REST — the snapshot carries projects and
 * threads only, and provider state lives on the WebSocket this integration
 * deliberately does not use. What T3 does publish is one readiness file per
 * instance under ~/.t3/caches, which it refreshes itself. Reading it is the
 * same discipline as reading server-runtime.json.
 *
 * Checking before dispatch is what turns an opaque server rejection into a
 * sentence the operator can act on.
 */

export interface InstanceReadiness {
  instanceId: string;
  ready: boolean;
  /** Present when ready is false — a sentence fit to show on a card. */
  reason: string | null;
  models: string[];
}

/** Instance ids are slugs in T3; anything else cannot name a cache file. */
const INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;

export function readInstanceReadiness(instanceId: string): InstanceReadiness {
  const notReady = (reason: string): InstanceReadiness => ({
    instanceId,
    ready: false,
    reason,
    models: [],
  });

  // config.yaml is hand-edited, so a typo must not become a read of an
  // arbitrary path.
  if (!INSTANCE_ID.test(instanceId)) {
    return notReady(`'${instanceId}' is not a valid T3 provider instance id.`);
  }

  let cache;
  try {
    cache = safeParseT3(providerCacheSchema, JSON.parse(readFileSync(t3ProviderCachePath(instanceId), 'utf8')));
  } catch {
    return notReady(
      `T3 has no provider instance '${instanceId}' (looked for ${t3ProviderCachePath(instanceId)}).`,
    );
  }
  if (!cache) {
    return notReady(`T3's readiness file for '${instanceId}' could not be understood.`);
  }

  const name = cache.displayName || instanceId;
  const models = cache.models.map((m) => m.slug);

  if (!cache.enabled) return notReady(`${name} is disabled in T3.`);
  if (!cache.installed) {
    return notReady(cache.message ?? `${name}'s CLI is not installed or not on PATH.`);
  }
  if (cache.status !== 'ready') {
    return notReady(cache.message ?? `${name} reports status '${cache.status}'.`);
  }

  return { instanceId, ready: true, reason: null, models };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/t3-instances.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/t3/instances.ts test/t3-instances.test.ts
git commit -m "feat(t3): report whether a provider instance can run a turn"
```

---

## Task 5: Authentication — pairing credential to bearer token

The step the spec originally got wrong. Loopback buys nothing: the snapshot returns `401` from `127.0.0.1` with no credential, and Mission Control cannot bootstrap itself because the only advertised bootstrap method is `desktop-bootstrap`. So the credential is minted once by hand from T3's own "Create pairing link" UI, and this module exchanges it for a short-lived bearer token.

**Files:**
- Create: `src/orchestrator/t3/auth.ts`
- Test: `test/t3-auth.test.ts`

**Interfaces:**
- Consumes: `T3_TIMEOUT_MS` from `./paths.ts`; `accessTokenSchema`, `safeParseT3` from `./schemas.ts`; `t3Url` from `./discovery.ts`; `mcHome` from `../paths.ts`.
- Produces:
  ```ts
  export const T3_SCOPES = 'orchestration:read orchestration:operate';
  export function t3CredentialPath(): string;
  export function readPairingCredential(): string | null;
  export class T3TokenStore {
    constructor(origin: string, credential: string, fetchImpl?: typeof fetch);
    /** Cached token, exchanging first if absent or near expiry. Null on failure. */
    getToken(now?: number): Promise<string | null>;
    /** Drop the cached token so the next getToken re-exchanges. */
    invalidate(): void;
    /** Why the last exchange failed, for doctor. Null when it succeeded. */
    lastError: string | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `test/t3-auth.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mcHome } from '../src/orchestrator/paths.ts';
import {
  T3TokenStore,
  T3_SCOPES,
  readPairingCredential,
  t3CredentialPath,
} from '../src/orchestrator/t3/auth.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-t3-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

function writeCredential(value: string): void {
  mkdirSync(mcHome(), { recursive: true });
  writeFileSync(t3CredentialPath(), value, 'utf8');
}

/** Records every request so the exchange payload can be asserted. */
function recordingFetch(replies: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const goodToken = {
  access_token: 'tok-1',
  issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: T3_SCOPES,
};

describe('pairing credential on disk', () => {
  test('the credential lives under MC_HOME, never in the project repo', () => {
    expect(t3CredentialPath().startsWith(mcHome())).toBe(true);
  });

  test('a written credential is read back with surrounding whitespace stripped', () => {
    writeCredential('  pair-abc123\n');
    expect(readPairingCredential()).toBe('pair-abc123');
  });

  test('no credential file reads as null, not a throw', () => {
    expect(readPairingCredential()).toBeNull();
  });

  test('an empty credential file reads as null rather than an empty token', () => {
    writeCredential('   \n');
    expect(readPairingCredential()).toBeNull();
  });
});

describe('T3TokenStore', () => {
  test('exchanges the credential for a bearer token', async () => {
    const { impl, calls } = recordingFetch([{ status: 200, body: goodToken }]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    expect(await store.getToken()).toBe('tok-1');
    expect(calls[0].url).toBe('http://127.0.0.1:3773/oauth/token');
  });

  test('sends the OAuth token-exchange grant form T3 expects', async () => {
    const { impl, calls } = recordingFetch([{ status: 200, body: goodToken }]);
    await new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl).getToken();

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token')).toBe('pair-abc');
    expect(body.get('subject_token_type')).toBe(
      'urn:t3:params:oauth:token-type:environment-bootstrap',
    );
    expect(body.get('requested_token_type')).toBe(
      'urn:ietf:params:oauth:token-type:access_token',
    );
    expect(body.get('scope')).toBe(T3_SCOPES);
    expect(body.get('client_label')).toBe('Mission Control');
  });

  test('caches the token instead of exchanging on every call', async () => {
    const { impl, calls } = recordingFetch([{ status: 200, body: goodToken }]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    await store.getToken();
    await store.getToken();
    await store.getToken();
    expect(calls).toHaveLength(1);
  });

  test('re-exchanges once the token is within a minute of expiring', async () => {
    const { impl, calls } = recordingFetch([
      { status: 200, body: { ...goodToken, expires_in: 120 } },
      { status: 200, body: { ...goodToken, access_token: 'tok-2' } },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    const t0 = Date.parse('2026-08-07T09:00:00.000Z');
    expect(await store.getToken(t0)).toBe('tok-1');
    // 70s later the 120s token has under a minute left.
    expect(await store.getToken(t0 + 70_000)).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  test('invalidate forces the next call to exchange again', async () => {
    const { impl, calls } = recordingFetch([
      { status: 200, body: goodToken },
      { status: 200, body: { ...goodToken, access_token: 'tok-2' } },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    await store.getToken();
    store.invalidate();
    expect(await store.getToken()).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  test('a rejected credential yields null and records why, rather than throwing', async () => {
    const { impl } = recordingFetch([
      { status: 401, body: { error: 'invalid_grant' } },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'revoked', impl);
    expect(await store.getToken()).toBeNull();
    expect(store.lastError).toContain('401');
  });

  test('a network failure yields null rather than throwing', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', failing);
    expect(await store.getToken()).toBeNull();
    expect(store.lastError).toContain('ECONNREFUSED');
  });

  test('a malformed token reply yields null rather than a bad Authorization header', async () => {
    const { impl } = recordingFetch([{ status: 200, body: { token_type: 'Bearer' } }]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    expect(await store.getToken()).toBeNull();
  });

  test('a successful exchange clears a previous error', async () => {
    const { impl } = recordingFetch([
      { status: 401, body: {} },
      { status: 200, body: goodToken },
    ]);
    const store = new T3TokenStore('http://127.0.0.1:3773', 'pair-abc', impl);
    await store.getToken();
    expect(store.lastError).not.toBeNull();
    store.invalidate();
    await store.getToken();
    expect(store.lastError).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-auth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/orchestrator/t3/auth.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome } from '../paths.ts';
import { T3_TIMEOUT_MS } from './paths.ts';
import { t3Url } from './discovery.ts';
import { accessTokenSchema, safeParseT3 } from './schemas.ts';

/**
 * Getting authorized to talk to T3 Code.
 *
 * Being on loopback buys nothing: the orchestration endpoints return 401 from
 * 127.0.0.1 with no credential. And Mission Control cannot bootstrap itself —
 * the desktop server advertises `desktop-bootstrap` as its only bootstrap
 * method (a handoff reserved for T3's own renderer), and the endpoint that
 * mints credentials for other clients sits behind the authenticated middleware.
 *
 * So the pairing credential is minted once, by hand, from T3's own
 * "Create pairing link" UI, and stored at ~/.mc/t3-credential. This
 * module exchanges it for a short-lived scoped bearer token.
 *
 * The access token is cached in memory only and never written to disk: it
 * expires on its own, and a file would outlive the process that earned it.
 */

export const T3_SCOPES = 'orchestration:read orchestration:operate';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const SUBJECT_TOKEN_TYPE = 'urn:t3:params:oauth:token-type:environment-bootstrap';
const REQUESTED_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Re-exchange this far before expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 60_000;

export function t3CredentialPath(): string {
  return join(mcHome(), 't3-credential');
}

export function readPairingCredential(): string | null {
  try {
    const value = readFileSync(t3CredentialPath(), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export class T3TokenStore {
  lastError: string | null = null;

  private token: string | null = null;
  private expiresAtMs = 0;

  constructor(
    private readonly origin: string,
    private readonly credential: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }

  async getToken(now: number = Date.now()): Promise<string | null> {
    if (this.token && now < this.expiresAtMs - REFRESH_MARGIN_MS) return this.token;

    const body = new URLSearchParams({
      grant_type: GRANT_TYPE,
      subject_token: this.credential,
      subject_token_type: SUBJECT_TOKEN_TYPE,
      requested_token_type: REQUESTED_TOKEN_TYPE,
      scope: T3_SCOPES,
      client_label: 'Mission Control',
      client_device_type: 'bot',
      client_os: 'windows',
    });

    try {
      const res = await this.fetchImpl(t3Url(this.origin, '/oauth/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(T3_TIMEOUT_MS),
      });

      if (!res.ok) {
        this.invalidate();
        this.lastError = `token exchange returned ${res.status}. The pairing credential may be expired or revoked — mint a new pairing link in T3's settings.`;
        return null;
      }

      const parsed = safeParseT3(accessTokenSchema, await res.json());
      if (!parsed) {
        this.invalidate();
        this.lastError = 'token exchange returned a body Mission Control could not understand.';
        return null;
      }

      this.token = parsed.access_token;
      this.expiresAtMs = now + parsed.expires_in * 1000;
      this.lastError = null;
      return this.token;
    } catch (err) {
      this.invalidate();
      this.lastError = String(err);
      return null;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/t3-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/t3/auth.ts test/t3-auth.test.ts
git commit -m "feat(t3): exchange a pairing credential for a scoped bearer token"
```

---

## Task 6: The HTTP client — snapshot and dispatch

Composes discovery, auth and schemas into the two calls the rest of Mission Control makes. **The degradation test in this task is the one that must never be deleted** — it is what proves an upstream change costs liveness rather than the board.

**Files:**
- Create: `src/orchestrator/t3/client.ts`
- Test: `test/t3-client.test.ts`

**Interfaces:**
- Consumes: `discoverT3`, `t3Url`, `T3Discovery` from `./discovery.ts`; `T3TokenStore`, `readPairingCredential` from `./auth.ts`; `snapshotSchema`, `dispatchResultSchema`, `safeParseT3` from `./schemas.ts`; `T3_TIMEOUT_MS` from `./paths.ts`.
- Produces:
  ```ts
  export interface T3ClientOptions { fetchImpl?: typeof fetch; credential?: string | null }
  export class T3Client {
    constructor(options?: T3ClientOptions);
    /** Discovery + auth state, for doctor and for the spawn precheck. */
    status(): Promise<{ ok: true; origin: string; serverVersion: string; capabilities: Record<string, unknown> } | { ok: false; reason: string; detail: string }>;
    /** The orchestration snapshot, or undefined when unavailable for any reason. */
    fetchSnapshot(): Promise<T3Snapshot | undefined>;
    /** Send a command. Resolves { ok: true } or { ok: false, error } — never throws. */
    dispatch(command: unknown): Promise<{ ok: true; sequence: number } | { ok: false; error: string }>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `test/t3-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { T3Client } from '../src/orchestrator/t3/client.ts';

let home: string;
let t3home: string;

const descriptor = {
  environmentId: 'env-1',
  serverVersion: '0.0.31',
  capabilities: { serverSelfUpdate: 'desktop-managed' },
};

const tokenReply = {
  access_token: 'tok-1',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'orchestration:read orchestration:operate',
};

const snapshot = {
  snapshotSequence: 3,
  projects: [{ id: 'p1', title: 'Acme', workspaceRoot: 'C:\\repo' }],
  threads: [
    {
      id: 'thread-1',
      projectId: 'p1',
      title: '#3060 plan',
      branch: 'ouriel/3060-thing',
      worktreePath: 'C:\\Users\\ouriel\\.mc\\worktrees\\issue-3060',
      activities: [{ id: 'e1', tone: 'info' }],
      session: { threadId: 'thread-1', status: 'running', activeTurnId: 'turn-1', lastError: null },
    },
  ],
};

/**
 * A fake T3 server. Routes by path, so a test only states what it cares about.
 */
function fakeServer(overrides: Record<string, { status?: number; body?: unknown }> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(overrides).find((k) => u.includes(k));
    if (key) {
      const o = overrides[key];
      return new Response(JSON.stringify(o.body ?? {}), { status: o.status ?? 200 });
    }
    if (u.includes('/.well-known/t3/environment')) {
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }
    if (u.includes('/oauth/token')) return new Response(JSON.stringify(tokenReply), { status: 200 });
    if (u.includes('/api/orchestration/snapshot')) {
      return new Response(JSON.stringify(snapshot), { status: 200 });
    }
    if (u.includes('/api/orchestration/dispatch')) {
      return new Response(JSON.stringify({ sequence: 9 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function writeRuntime(): void {
  mkdirSync(join(t3home, 'userdata'), { recursive: true });
  writeFileSync(
    join(t3home, 'userdata', 'server-runtime.json'),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: 3773,
      origin: 'http://127.0.0.1:3773',
    }),
    'utf8',
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-'));
  t3home = mkdtempSync(join(tmpdir(), 't3-'));
  process.env.MC_HOME = home;
  process.env.T3_HOME = t3home;
  writeRuntime();
});

afterEach(() => {
  delete process.env.MC_HOME;
  delete process.env.T3_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(t3home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('status', () => {
  test('reports the server version when everything is up', async () => {
    const { impl } = fakeServer();
    const status = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).status();
    expect(status).toMatchObject({ ok: true, serverVersion: '0.0.31' });
  });

  test('reports T3 as down when there is no runtime file', async () => {
    rmSync(join(t3home, 'userdata', 'server-runtime.json'));
    const { impl } = fakeServer();
    const status = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).status();
    expect(status).toMatchObject({ ok: false, reason: 'no-runtime-file' });
  });

  test('a running server with no credential is distinguished from a down server', async () => {
    const { impl } = fakeServer();
    const status = await new T3Client({ fetchImpl: impl, credential: null }).status();
    expect(status).toMatchObject({ ok: false, reason: 'no-credential' });
  });

  test('a rejected credential is distinguished from a missing one', async () => {
    const { impl } = fakeServer({ '/oauth/token': { status: 401, body: {} } });
    const status = await new T3Client({ fetchImpl: impl, credential: 'revoked' }).status();
    expect(status).toMatchObject({ ok: false, reason: 'credential-rejected' });
  });
});

describe('fetchSnapshot', () => {
  test('returns the parsed snapshot', async () => {
    const { impl } = fakeServer();
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
    expect(result?.threads[0].session?.status).toBe('running');
  });

  test('sends the bearer token', async () => {
    const { impl, calls } = fakeServer();
    await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
    const snapshotCall = calls.find((c) => c.url.includes('/api/orchestration/snapshot'));
    const headers = snapshotCall?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
  });

  test('T3 not running yields undefined, not a throw', async () => {
    rmSync(join(t3home, 'userdata', 'server-runtime.json'));
    const { impl } = fakeServer();
    expect(
      await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot(),
    ).toBeUndefined();
  });

  test('no credential yields undefined, not a throw', async () => {
    const { impl } = fakeServer();
    expect(await new T3Client({ fetchImpl: impl, credential: null }).fetchSnapshot()).toBeUndefined();
  });

  /**
   * THE DEGRADATION TEST. Do not delete this.
   *
   * It is the mechanism that turns an upstream breaking change into lost
   * liveness rather than a broken board. If T3 renames a field this code
   * depends on, fetchSnapshot must return undefined and nothing may throw.
   */
  test('a malformed snapshot yields undefined and never throws', async () => {
    const { impl } = fakeServer({
      '/api/orchestration/snapshot': {
        status: 200,
        body: { threads: [{ id: 't1', projectId: 'p1', title: 'x', session: { threadId: 't1', status: 'teleporting' } }] },
      },
    });
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    await expect(client.fetchSnapshot()).resolves.toBeUndefined();
  });

  test('a snapshot that is not JSON at all yields undefined and never throws', async () => {
    const impl = (async (url: string) => {
      if (String(url).includes('/api/orchestration/snapshot')) {
        return new Response('<html>gateway error</html>', { status: 200 });
      }
      if (String(url).includes('/oauth/token')) return new Response(JSON.stringify(tokenReply), { status: 200 });
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    await expect(client.fetchSnapshot()).resolves.toBeUndefined();
  });

  test('logs a validation failure at most once per client, not once per task', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeServer({
      '/api/orchestration/snapshot': { status: 200, body: { threads: 'nope' } },
    });
    const client = new T3Client({ fetchImpl: impl, credential: 'pair-abc' });
    await client.fetchSnapshot();
    await client.fetchSnapshot();
    await client.fetchSnapshot();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a 401 triggers exactly one token re-exchange and one retry', async () => {
    let snapshotHits = 0;
    let tokenHits = 0;
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth/token')) {
        tokenHits += 1;
        return new Response(JSON.stringify(tokenReply), { status: 200 });
      }
      if (u.includes('/api/orchestration/snapshot')) {
        snapshotHits += 1;
        // First call 401s (token went stale); the retry succeeds.
        return snapshotHits === 1
          ? new Response('{}', { status: 401 })
          : new Response(JSON.stringify(snapshot), { status: 200 });
      }
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot();
    expect(result?.threads).toHaveLength(1);
    expect(snapshotHits).toBe(2);
    expect(tokenHits).toBe(2);
  });

  test('a second 401 gives up rather than looping', async () => {
    let snapshotHits = 0;
    const impl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth/token')) return new Response(JSON.stringify(tokenReply), { status: 200 });
      if (u.includes('/api/orchestration/snapshot')) {
        snapshotHits += 1;
        return new Response('{}', { status: 401 });
      }
      return new Response(JSON.stringify(descriptor), { status: 200 });
    }) as unknown as typeof fetch;

    expect(
      await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).fetchSnapshot(),
    ).toBeUndefined();
    expect(snapshotHits).toBe(2);
  });
});

describe('dispatch', () => {
  test('posts the command and returns the sequence', async () => {
    const { impl, calls } = fakeServer();
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).dispatch({
      type: 'thread.turn.start',
    });
    expect(result).toEqual({ ok: true, sequence: 9 });

    const call = calls.find((c) => c.url.includes('/api/orchestration/dispatch'));
    expect(call?.init?.method).toBe('POST');
    expect(JSON.parse(String(call?.init?.body)).type).toBe('thread.turn.start');
  });

  test('a rejected dispatch surfaces T3s message verbatim rather than throwing', async () => {
    const { impl } = fakeServer({
      '/api/orchestration/dispatch': {
        status: 422,
        body: { message: "provider instance 'opencode' is not configured" },
      },
    });
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).dispatch({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('opencode');
  });

  test('dispatching while T3 is down fails with a reason instead of throwing', async () => {
    rmSync(join(t3home, 'userdata', 'server-runtime.json'));
    const { impl } = fakeServer();
    const result = await new T3Client({ fetchImpl: impl, credential: 'pair-abc' }).dispatch({});
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/orchestrator/t3/client.ts`**

```ts
import { T3_TIMEOUT_MS } from './paths.ts';
import { discoverT3, t3Url } from './discovery.ts';
import { T3TokenStore, readPairingCredential } from './auth.ts';
import {
  dispatchResultSchema,
  safeParseT3,
  snapshotSchema,
  type T3Snapshot,
} from './schemas.ts';

/**
 * Everything Mission Control asks of T3 Code, over REST only.
 *
 * Two calls carry the whole integration: one snapshot per reconcile interval
 * for liveness, and one dispatch per spawn. Neither ever throws — both are on
 * paths where a throw would take out the board to report that an optional
 * signal is unavailable.
 *
 * The 401 policy is deliberately not a loop: one re-exchange and one retry,
 * then give up until the next interval. A credential that has been revoked
 * cannot be fixed by trying harder.
 */

export type T3Status =
  | { ok: true; origin: string; serverVersion: string; capabilities: Record<string, unknown> }
  | { ok: false; reason: string; detail: string };

export interface T3ClientOptions {
  fetchImpl?: typeof fetch;
  /** Overrides the on-disk credential; tests pass it explicitly. */
  credential?: string | null;
}

export class T3Client {
  private readonly fetchImpl: typeof fetch;
  private readonly credential: string | null;
  private tokens: T3TokenStore | null = null;
  private tokensOrigin: string | null = null;
  private loggedValidationFailure = false;

  constructor(options: T3ClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credential =
      options.credential !== undefined ? options.credential : readPairingCredential();
  }

  private tokenStore(origin: string): T3TokenStore | null {
    if (!this.credential) return null;
    // Rebuild if T3 restarted on a different port; a token is origin-scoped.
    if (!this.tokens || this.tokensOrigin !== origin) {
      this.tokens = new T3TokenStore(origin, this.credential, this.fetchImpl);
      this.tokensOrigin = origin;
    }
    return this.tokens;
  }

  async status(): Promise<T3Status> {
    const discovery = await discoverT3(this.fetchImpl);
    if (!discovery.ok) {
      return { ok: false, reason: discovery.reason, detail: discovery.detail };
    }
    if (!this.credential) {
      return {
        ok: false,
        reason: 'no-credential',
        detail:
          "T3 is running but Mission Control has no pairing credential. Create a pairing link in T3's settings and save it to ~/.mc/t3-credential.",
      };
    }
    const tokens = this.tokenStore(discovery.origin)!;
    if (!(await tokens.getToken())) {
      return {
        ok: false,
        reason: 'credential-rejected',
        detail: tokens.lastError ?? 'the pairing credential was not accepted',
      };
    }
    return {
      ok: true,
      origin: discovery.origin,
      serverVersion: discovery.serverVersion,
      capabilities: discovery.capabilities,
    };
  }

  /**
   * One authenticated request, with a single 401 re-exchange and retry.
   * Returns the Response, or null when T3 is unavailable for any reason.
   */
  private async request(path: string, init: RequestInit = {}): Promise<Response | null> {
    const discovery = await discoverT3(this.fetchImpl);
    if (!discovery.ok) return null;

    const tokens = this.tokenStore(discovery.origin);
    if (!tokens) return null;

    const send = async (token: string): Promise<Response> =>
      this.fetchImpl(t3Url(discovery.origin, path), {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(T3_TIMEOUT_MS),
      });

    try {
      const token = await tokens.getToken();
      if (!token) return null;

      let res = await send(token);
      if (res.status === 401) {
        // The token went stale. Exchange once more and retry once. A second
        // 401 means the credential itself is bad, which retrying cannot fix.
        tokens.invalidate();
        const fresh = await tokens.getToken();
        if (!fresh) return null;
        res = await send(fresh);
      }
      return res;
    } catch {
      return null;
    }
  }

  async fetchSnapshot(): Promise<T3Snapshot | undefined> {
    const res = await this.request('/api/orchestration/snapshot');
    if (!res || !res.ok) return undefined;

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return undefined;
    }

    const parsed = safeParseT3(snapshotSchema, body);
    if (!parsed && !this.loggedValidationFailure) {
      // Once per client, not once per task: a schema drift would otherwise
      // print a line for every card on every poll.
      this.loggedValidationFailure = true;
      console.error(
        "[mc] T3's orchestration snapshot did not match the expected shape; session liveness is unavailable until this is fixed. Check the pinned T3 version.",
      );
    }
    return parsed;
  }

  async dispatch(
    command: unknown,
  ): Promise<{ ok: true; sequence: number } | { ok: false; error: string }> {
    const res = await this.request('/api/orchestration/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });

    if (!res) {
      const status = await this.status();
      return {
        ok: false,
        error: status.ok ? 'T3 Code could not be reached.' : status.detail,
      };
    }

    const text = await res.text();
    if (!res.ok) {
      // Surface T3's own message verbatim — it names the real problem far
      // better than anything this layer could infer from a status code.
      let message = text;
      try {
        const parsed = JSON.parse(text);
        message = parsed.message ?? parsed.error ?? text;
      } catch {
        // Not JSON; the raw text is the best available message.
      }
      return { ok: false, error: `T3 rejected the command (${res.status}): ${message}` };
    }

    let parsed;
    try {
      parsed = safeParseT3(dispatchResultSchema, JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    // A 2xx with an unrecognised body still means the command was accepted.
    return { ok: true, sequence: parsed?.sequence ?? 0 };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/t3-client.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all green

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/t3/client.ts test/t3-client.test.ts
git commit -m "feat(t3): snapshot and dispatch client that degrades instead of throwing"
```

---

## Task 7: Types and config for the `t3` launcher

Adds the vocabulary the remaining tasks need: a third launcher, per-agent instance mapping, per-phase runtime modes, and the thread id on a spawn record. Config validation is where a hand-edited mistake gets a message that names the field.

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/orchestrator/config.ts:15-113`
- Modify: `assets/config.example.yaml`
- Test: `test/config.test.ts` (extend), `test/t3-config.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type LauncherKind = 'wt' | 'vscode' | 't3';
  export type T3RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
  export type T3InteractionMode = 'default' | 'plan';
  // AgentProfile gains: t3Instance?: string
  // PhaseConfig gains: t3?: { runtimeMode: T3RuntimeMode; interactionMode: T3InteractionMode }
  // SpawnRecord gains: threadId?: string
  // Config gains: t3?: { projectTitle?: string }
  // StateFile gains: t3ProjectId?: string
  export const DEFAULT_T3_MODES: Record<string, { runtimeMode: T3RuntimeMode; interactionMode: T3InteractionMode }>;
  export function t3ModesForPhase(phase: PhaseConfig): { runtimeMode: T3RuntimeMode; interactionMode: T3InteractionMode };
  ```

- [ ] **Step 1: Write the failing test**

Create `test/t3-config.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { parseConfig } from '../src/orchestrator/config.ts';
import { DEFAULT_T3_MODES, t3ModesForPhase } from '../src/shared/types.ts';
import type { PhaseConfig } from '../src/shared/types.ts';

const base = `
repo:
  path: 'C:\\repo'
  owner: 'acme'
  name: 'widgets'
  baseBranch: 'dev'
  branchPrefix: 'ouriel'
github:
  auth: gh-cli
  pollIntervalSeconds: 30
  copilotReviewerLogin: 'copilot-pull-request-reviewer'
server:
  port: 4317
agents:
  claude:
    launch: 'claude'
    promptMode: positional
    instructionMode: flag
    instructionFlag: '--append-system-prompt'
    t3Instance: 'claudeAgent'
pipeline:
  - id: plan
    label: Plan
    actor: claude
    gate: { type: manual }
    t3:
      runtimeMode: approval-required
      interactionMode: plan
`;

describe('t3 config', () => {
  test("accepts 't3' as a launcher", () => {
    const config = parseConfig(`${base}launcher: t3\n`);
    expect(config.launcher).toBe('t3');
  });

  test('still accepts the two existing launchers', () => {
    expect(parseConfig(`${base}launcher: wt\n`).launcher).toBe('wt');
    expect(parseConfig(`${base}launcher: vscode\n`).launcher).toBe('vscode');
  });

  test('rejects an unknown launcher by name', () => {
    expect(() => parseConfig(`${base}launcher: emacs\n`)).toThrow(/launcher/);
  });

  test('reads t3Instance off an agent profile', () => {
    expect(parseConfig(base).agents.claude.t3Instance).toBe('claudeAgent');
  });

  test('t3Instance is optional — an agent without one is still valid config', () => {
    const without = base.replace("    t3Instance: 'claudeAgent'\n", '');
    expect(parseConfig(without).agents.claude.t3Instance).toBeUndefined();
  });

  test('reads per-phase runtime and interaction modes', () => {
    const phase = parseConfig(base).pipeline[0];
    expect(phase.t3).toEqual({ runtimeMode: 'approval-required', interactionMode: 'plan' });
  });

  test('rejects an unknown runtime mode rather than passing it to T3', () => {
    const bad = base.replace('approval-required', 'yolo');
    expect(() => parseConfig(bad)).toThrow(/runtimeMode/);
  });

  test('a phase block with only one of the two modes is rejected', () => {
    // Half a mode pair is exactly the mistake that would silently inherit
    // T3's full-access default.
    const bad = base.replace('      interactionMode: plan\n', '');
    expect(() => parseConfig(bad)).toThrow(/interactionMode/);
  });
});

describe('t3ModesForPhase', () => {
  const phase = (id: string, t3?: PhaseConfig['t3']): PhaseConfig =>
    ({ id, label: id, actor: 'claude', gate: { type: 'manual' }, t3 }) as PhaseConfig;

  test('a configured phase uses its own modes', () => {
    expect(
      t3ModesForPhase(phase('plan', { runtimeMode: 'auto', interactionMode: 'default' })),
    ).toEqual({ runtimeMode: 'auto', interactionMode: 'default' });
  });

  test('plan defaults to approval-required in plan mode', () => {
    expect(t3ModesForPhase(phase('plan'))).toEqual({
      runtimeMode: 'approval-required',
      interactionMode: 'plan',
    });
  });

  test('implement defaults to auto-accept-edits', () => {
    expect(t3ModesForPhase(phase('implement')).runtimeMode).toBe('auto-accept-edits');
  });

  test('publish defaults to approval-required', () => {
    expect(t3ModesForPhase(phase('publish')).runtimeMode).toBe('approval-required');
  });

  /**
   * The safety property. T3's own decoding default for runtimeMode is
   * `full-access` — an omitted field means "no restrictions", not "be
   * careful". Mission Control must never fall through to it.
   */
  test('an unlisted phase falls back to the most restrictive mode, never full-access', () => {
    const modes = t3ModesForPhase(phase('some_new_phase'));
    expect(modes.runtimeMode).toBe('approval-required');
    expect(modes.interactionMode).toBe('default');
  });

  test('no default is ever full-access', () => {
    for (const modes of Object.values(DEFAULT_T3_MODES)) {
      expect(modes.runtimeMode).not.toBe('full-access');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-config.test.ts`
Expected: FAIL — `t3ModesForPhase` is not exported

- [ ] **Step 3: Extend `src/shared/types.ts`**

Replace the `LauncherKind` line (currently `src/shared/types.ts:253`):

```ts
export type LauncherKind = 'wt' | 'vscode' | 't3';

/** T3's per-thread permission level. */
export type T3RuntimeMode =
  | 'approval-required'
  | 'auto-accept-edits'
  | 'auto'
  | 'full-access';

/** T3's per-thread interaction style. 'plan' is its native planning mode. */
export type T3InteractionMode = 'default' | 'plan';

export interface T3PhaseModes {
  runtimeMode: T3RuntimeMode;
  interactionMode: T3InteractionMode;
}

/**
 * Per-phase modes used when config.yaml does not set them.
 *
 * Chosen to match each phase's intent, not validated by use — which is exactly
 * why they are configuration. Note that none of them is 'full-access': T3's own
 * decoding default is, so falling through to T3 would silently grant more than
 * any phase here asks for.
 */
export const DEFAULT_T3_MODES: Record<string, T3PhaseModes> = {
  plan: { runtimeMode: 'approval-required', interactionMode: 'plan' },
  implement: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
  publish: { runtimeMode: 'approval-required', interactionMode: 'default' },
  copilot_review: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
  dev_review: { runtimeMode: 'auto-accept-edits', interactionMode: 'default' },
};

/** The safe floor for a phase nobody configured. Never 'full-access'. */
const T3_MODE_FLOOR: T3PhaseModes = {
  runtimeMode: 'approval-required',
  interactionMode: 'default',
};

export function t3ModesForPhase(phase: PhaseConfig): T3PhaseModes {
  return phase.t3 ?? DEFAULT_T3_MODES[phase.id] ?? T3_MODE_FLOOR;
}
```

`t3ModesForPhase` references `PhaseConfig`, which is declared further down the file. That is fine — TypeScript type references hoist, and `DEFAULT_T3_MODES` is a value that does not touch `PhaseConfig` at runtime.

Then make these edits elsewhere in the same file:

`LiveSpawn` (currently at `src/shared/types.ts:45`) becomes:

```ts
/** A spawn believed to be running, from a pwsh PID or from a T3 session. */
export interface LiveSpawn {
  phase: Phase;
  /** The pwsh PID for wt/vscode launches; null when T3 supplies liveness. */
  pid: number | null;
  startedAt: string;
  /** Which signal established this. 't3' means a live orchestration session. */
  source: 'marker' | 't3';
}
```

`Facts` gains one optional field, after `liveSpawn`:

```ts
  /**
   * Live session state from T3 Code, when the task has a recorded thread and
   * T3 is reachable. Absent means "no information", never "not running" —
   * which is why every consumer must fall back rather than conclude.
   */
  t3?: {
    threadId: string;
    sessionStatus:
      | 'idle'
      | 'starting'
      | 'running'
      | 'ready'
      | 'interrupted'
      | 'stopped'
      | 'error';
    activeTurnId: string | null;
    awaitingApproval: boolean;
    lastError: string | null;
  };
```

`SpawnRecord` gains:

```ts
  /** The T3 thread this spawn created, when the launcher was 't3'. */
  threadId?: string;
```

`AgentProfile` gains, after `extraArgs`:

```ts
  /**
   * The T3 provider instance that runs this agent on the 't3' launcher, e.g.
   * 'claudeAgent'. An agent without one is not launchable through T3.
   */
  t3Instance?: string;
```

`PhaseConfig` gains, after `onFail`:

```ts
  /** Per-phase T3 modes. Both fields required together; see t3ModesForPhase. */
  t3?: T3PhaseModes;
```

`Config` gains, after `launcher`:

```ts
  /** T3 Code integration settings. Absent means the 't3' launcher is unconfigured. */
  t3?: {
    /** Title of the T3 project Mission Control creates. Default 'Acme'. */
    projectTitle?: string;
    /** T3 version the recorded fixtures were captured against. */
    pinnedVersion?: string;
  };
```

`StateFile` gains:

```ts
  /** The T3 project id, created once lazily and reused by later spawns. */
  t3ProjectId?: string;
```

- [ ] **Step 4: Extend `src/orchestrator/config.ts`**

In `agentProfileSchema` (after `extraArgs`, `src/orchestrator/config.ts:30`):

```ts
    t3Instance: z.string().min(1).optional(),
```

Add above `phaseSchema`:

```ts
const t3ModesSchema = z.object({
  runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'auto', 'full-access']),
  interactionMode: z.enum(['default', 'plan']),
});
```

In `phaseSchema` (after `onFail`, `src/orchestrator/config.ts:70`):

```ts
  t3: t3ModesSchema.optional(),
```

In `configSchema`, replace the `launcher` line (`src/orchestrator/config.ts:90`):

```ts
    launcher: z.enum(['wt', 'vscode', 't3']).optional(),
    t3: z
      .object({
        projectTitle: z.string().min(1).optional(),
        pinnedVersion: z.string().min(1).optional(),
      })
      .optional(),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/t3-config.test.ts test/config.test.ts`
Expected: PASS. If `test/config.test.ts` fails on the launcher enum message, update that assertion — the set of valid launchers genuinely changed.

- [ ] **Step 6: Fix the `LiveSpawn` fallout**

`markers.ts:89-93` must now set `source` and keep `pid`:

```ts
      return {
        phase: (parsed.phase ?? name.replace(/\.running$/, '')) as Phase,
        pid: parsed.pid,
        startedAt: parsed.startedAt ?? new Date(0).toISOString(),
        source: 'marker',
      };
```

Run: `npm run typecheck` and fix any other site the compiler names.

- [ ] **Step 7: Update `assets/config.example.yaml`**

Change the launcher comment and add the `t3` block. Replace lines 23-26:

```yaml
# How a spawn opens its terminal:
#   'wt'     Windows Terminal (default) — one titled tab per task.
#   'vscode' opens the worktree in VS Code, agent in the integrated terminal.
#   't3'     runs the phase as a T3 Code thread bound to the same worktree.
# Also switchable live from the Agents settings panel.
launcher: wt

# T3 Code integration, used only by the 't3' launcher.
#
# Requires a pairing credential at %USERPROFILE%\.mc\t3-credential.
# Mint one in T3: Settings -> Create pairing link, with the scopes
# orchestration:read and orchestration:operate. Mission Control cannot mint
# it for you — T3's desktop server only bootstraps its own renderer.
t3:
  projectTitle: 'Acme'
  # The T3 version this integration was verified against. `mc doctor` warns
  # when the running server differs; it never blocks.
  pinnedVersion: '0.0.31'
```

Add `t3Instance` to each agent. Under `claude`:

```yaml
    # T3 provider instance that runs this agent on the 't3' launcher.
    t3Instance: 'claudeAgent'
```

Under `copilot`:

```yaml
    # T3 has no GitHub Copilot CLI driver. The 't3' launcher therefore routes
    # copilot through OpenCode, which GitHub supports against a Copilot
    # subscription (Pro, Pro+, Business or Enterprise — Free will not work).
    # This is a substitution, not a passthrough: it is OpenCode's agent loop
    # using Copilot's models, not the Copilot CLI harness the 'wt' launcher
    # drives. Requires the `opencode` CLI installed and authenticated.
    t3Instance: 'opencode'
```

Under `codex`:

```yaml
    t3Instance: 'codex'
```

Add the per-phase modes to the `plan`, `implement` and `publish` entries in `pipeline:`, for example:

```yaml
  - id: plan
    # ... existing keys unchanged ...
    # T3-only: how much the agent may do without asking, and whether it
    # starts in T3's native plan mode. Ignored by the wt and vscode launchers.
    t3:
      runtimeMode: approval-required
      interactionMode: plan
```

- [ ] **Step 8: Run the whole suite and commit**

```bash
npm test && npm run typecheck
git add src/shared/types.ts src/orchestrator/config.ts src/orchestrator/markers.ts assets/config.example.yaml test/t3-config.test.ts test/config.test.ts
git commit -m "feat(t3): launcher, instance mapping and per-phase modes in config"
```

---

## Task 8: Pure command builders

Everything Mission Control sends to T3, built as plain data with no I/O. Keeping these pure is what makes the payloads testable against the schemas read from T3's shipped bundle, without a running server.

**Files:**
- Create: `src/orchestrator/t3/commands.ts`
- Test: `test/t3-commands.test.ts`

**Interfaces:**
- Consumes: `AgentProfile`, `T3PhaseModes` from `../../shared/types.ts`.
- Produces:
  ```ts
  export interface ModelSelection { instanceId: string; model: string; options?: Array<{ id: string; value: string }> }
  export function buildModelSelection(profile: AgentProfile, opts: { model?: string | null; effort?: string | null }): ModelSelection | null;
  export function buildProjectCreateCommand(input: { projectId: string; title: string; workspaceRoot: string; createdAt: string; commandId: string }): unknown;
  export function buildTurnStartCommand(input: TurnStartInput): unknown;
  export function buildMissionControlScript(boardUrl: string): unknown;
  export function buildProjectScriptsUpdateCommand(input: { commandId: string; projectId: string; scripts: unknown[] }): unknown;
  export interface TurnStartInput {
    commandId: string; threadId: string; messageId: string; projectId: string;
    title: string; prompt: string; worktreePath: string; branch: string;
    modelSelection: ModelSelection; modes: T3PhaseModes; createdAt: string;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `test/t3-commands.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import {
  buildModelSelection,
  buildMissionControlScript,
  buildProjectCreateCommand,
  buildTurnStartCommand,
} from '../src/orchestrator/t3/commands.ts';
import type { AgentProfile } from '../src/shared/types.ts';

const claude: AgentProfile = {
  launch: 'claude',
  promptMode: 'positional',
  instructionMode: 'flag',
  instructionFlag: '--append-system-prompt',
  t3Instance: 'claudeAgent',
  model: 'default',
};

const codex: AgentProfile = {
  launch: 'codex',
  promptMode: 'positional',
  instructionMode: 'inline',
  t3Instance: 'codex',
};

describe('buildModelSelection', () => {
  test('maps an agent to its T3 provider instance', () => {
    const selection = buildModelSelection(codex, { model: 'gpt-5.6-sol', effort: null });
    expect(selection).toEqual({ instanceId: 'codex', model: 'gpt-5.6-sol' });
  });

  test('renders effort as the canonical options array, not a CLI flag', () => {
    // The per-CLI flag divergence buildAgentArgs exists to absorb is not this
    // path's concern; T3's provider drivers handle invocation.
    const selection = buildModelSelection(codex, { model: 'gpt-5.6-sol', effort: 'high' });
    expect(selection?.options).toEqual([{ id: 'effort', value: 'high' }]);
  });

  test('omits options entirely when there is no effort', () => {
    expect(buildModelSelection(codex, { model: 'gpt-5.6-sol', effort: null })).not.toHaveProperty(
      'options',
    );
  });

  test('an agent with no t3Instance is not launchable through T3', () => {
    const { t3Instance, ...noInstance } = claude;
    expect(buildModelSelection(noInstance as AgentProfile, { model: 'x', effort: null })).toBeNull();
  });

  test("the sentinel model 'default' is not sent as a literal model name", () => {
    // 'default' is Mission Control's own "let the CLI decide" marker, not a
    // model T3 knows about.
    expect(buildModelSelection(claude, { model: 'default', effort: null })).toBeNull();
  });

  test('falls back to the profile model when no override is given', () => {
    const selection = buildModelSelection(
      { ...codex, model: 'gpt-5.6-terra' },
      { model: null, effort: null },
    );
    expect(selection?.model).toBe('gpt-5.6-terra');
  });

  test('no model at all is not launchable — T3 requires one', () => {
    expect(buildModelSelection(codex, { model: null, effort: null })).toBeNull();
  });
});

describe('buildProjectCreateCommand', () => {
  test('creates a project rooted at the repo Mission Control was configured with', () => {
    const command = buildProjectCreateCommand({
      commandId: 'cmd-1',
      projectId: 'proj-1',
      title: 'Acme',
      workspaceRoot: 'C:\\repo',
      createdAt: '2026-08-07T09:00:00.000Z',
    }) as Record<string, unknown>;

    expect(command.type).toBe('project.create');
    expect(command.projectId).toBe('proj-1');
    expect(command.workspaceRoot).toBe('C:\\repo');
    expect(command.createdAt).toBe('2026-08-07T09:00:00.000Z');
  });
});

describe('buildTurnStartCommand', () => {
  const input = {
    commandId: 'cmd-1',
    threadId: 'thread-1',
    messageId: 'msg-1',
    projectId: 'proj-1',
    title: '#3060 plan',
    prompt: 'Plan issue 3060.',
    worktreePath: 'C:\\Users\\ouriel\\.mc\\worktrees\\issue-3060',
    branch: 'ouriel/3060-thing',
    modelSelection: { instanceId: 'codex', model: 'gpt-5.6-sol' },
    modes: { runtimeMode: 'approval-required' as const, interactionMode: 'plan' as const },
    createdAt: '2026-08-07T09:00:00.000Z',
  };

  test('is a thread.turn.start carrying the rendered prompt verbatim', () => {
    const command = buildTurnStartCommand(input) as any;
    expect(command.type).toBe('thread.turn.start');
    expect(command.message.role).toBe('user');
    expect(command.message.text).toBe('Plan issue 3060.');
    expect(command.message.attachments).toEqual([]);
  });

  test('binds the thread to Mission Controls worktree, not one T3 chose', () => {
    // This is what lets worktreePath(issue) stay a pure function of the issue
    // number, so markers, artifacts and badges keep working unchanged.
    const command = buildTurnStartCommand(input) as any;
    expect(command.bootstrap.createThread.worktreePath).toBe(
      'C:\\Users\\ouriel\\.mc\\worktrees\\issue-3060',
    );
    expect(command.bootstrap.createThread.branch).toBe('ouriel/3060-thing');
  });

  test('never asks T3 to prepare a worktree', () => {
    // prepareWorktree hard-codes path: null and picks its own directory, which
    // would make the checkout location a lookup rather than a derivation.
    const command = buildTurnStartCommand(input) as any;
    expect(command.bootstrap.prepareWorktree).toBeUndefined();
  });

  test('sends both modes explicitly at the top level and in the bootstrap', () => {
    // T3's decoding default for runtimeMode is full-access. Omitting either
    // field anywhere would silently grant more than the phase asks for.
    const command = buildTurnStartCommand(input) as any;
    expect(command.runtimeMode).toBe('approval-required');
    expect(command.interactionMode).toBe('plan');
    expect(command.bootstrap.createThread.runtimeMode).toBe('approval-required');
    expect(command.bootstrap.createThread.interactionMode).toBe('plan');
  });

  test('titles the thread so T3s sidebar groups phases legibly', () => {
    const command = buildTurnStartCommand(input) as any;
    expect(command.bootstrap.createThread.title).toBe('#3060 plan');
  });

  test('carries the model selection into the new thread', () => {
    const command = buildTurnStartCommand(input) as any;
    expect(command.bootstrap.createThread.modelSelection).toEqual({
      instanceId: 'codex',
      model: 'gpt-5.6-sol',
    });
  });
});

describe('buildMissionControlScript', () => {
  test('points T3s preview panel at the board', () => {
    const script = buildMissionControlScript('http://127.0.0.1:4317') as any;
    expect(script.previewUrl).toBe('http://127.0.0.1:4317');
    expect(script.autoOpenPreview).toBe(true);
  });

  test('uses an icon from T3s closed set', () => {
    const script = buildMissionControlScript('http://127.0.0.1:4317') as any;
    expect(['play', 'test', 'lint', 'configure', 'build', 'debug']).toContain(script.icon);
  });

  test('does not run on worktree creation', () => {
    // The board is a singleton; a per-worktree copy makes no sense.
    expect((buildMissionControlScript('http://127.0.0.1:4317') as any).runOnWorktreeCreate).toBe(
      false,
    );
  });

  test('its command is a probe, not a launcher', () => {
    // T3 runs scripts in a worktree-scoped terminal, so starting the board
    // there would tie its lifetime to a thread.
    const script = buildMissionControlScript('http://127.0.0.1:4317') as any;
    expect(script.command).toContain('4317');
    expect(script.command).not.toContain('npm start');
  });
});

describe('buildProjectScriptsUpdateCommand', () => {
  test('updates only the scripts, leaving title and workspace root alone', () => {
    // Every other field on project.meta.update is optional, and sending one we
    // did not mean to change would overwrite whatever the operator set in T3.
    const command = buildProjectScriptsUpdateCommand({
      commandId: 'cmd-1',
      projectId: 'proj-1',
      scripts: [buildMissionControlScript('http://127.0.0.1:4317')],
    }) as any;

    expect(command.type).toBe('project.meta.update');
    expect(command.projectId).toBe('proj-1');
    expect(command.scripts).toHaveLength(1);
    expect(command).not.toHaveProperty('title');
    expect(command).not.toHaveProperty('workspaceRoot');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-commands.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/orchestrator/t3/commands.ts`**

```ts
import type { AgentProfile, T3PhaseModes } from '../../shared/types.ts';

/**
 * The commands Mission Control sends to T3 Code, as plain data.
 *
 * Pure by design: every payload here was checked against the schemas in T3
 * 0.0.31's shipped bundle, and keeping them free of I/O is what lets that
 * check be a unit test rather than an integration one.
 *
 * All ids are caller-supplied. T3 treats them as opaque non-empty strings, so
 * crypto.randomUUID() is the natural choice and command ids stay idempotency
 * keys the caller controls.
 */

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string }>;
}

/**
 * Render the resolved agent/model/effort as a T3 ModelSelection.
 *
 * The sibling of buildAgentArgs: the same three-tier resolution feeds both,
 * and only the output format differs. Returns null when the choice cannot be
 * expressed — an agent with no t3Instance, or no concrete model — so the
 * caller can say why instead of sending a dispatch that will be rejected.
 */
export function buildModelSelection(
  profile: AgentProfile,
  opts: { model?: string | null; effort?: string | null },
): ModelSelection | null {
  const instanceId = profile.t3Instance;
  if (!instanceId) return null;

  const model = opts.model ?? profile.model ?? null;
  // 'default' is Mission Control's own "let the CLI decide" sentinel. T3
  // requires a real model name, so there is nothing to send.
  if (!model || model === 'default') return null;

  const selection: ModelSelection = { instanceId, model };
  if (opts.effort) selection.options = [{ id: 'effort', value: opts.effort }];
  return selection;
}

export function buildProjectCreateCommand(input: {
  commandId: string;
  projectId: string;
  title: string;
  workspaceRoot: string;
  createdAt: string;
}): unknown {
  return {
    type: 'project.create',
    commandId: input.commandId,
    projectId: input.projectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    createdAt: input.createdAt,
  };
}

export interface TurnStartInput {
  commandId: string;
  threadId: string;
  messageId: string;
  projectId: string;
  title: string;
  prompt: string;
  worktreePath: string;
  branch: string;
  modelSelection: ModelSelection;
  modes: T3PhaseModes;
  createdAt: string;
}

/**
 * One call that creates the thread and starts the turn.
 *
 * The worktree already exists — Mission Control created it — so bootstrap
 * carries only createThread. prepareWorktree is deliberately unused: it
 * hard-codes path: null and picks its own directory under ~/.t3/worktrees,
 * which would turn the checkout location into a lookup instead of a
 * derivation from the issue number.
 *
 * Both modes appear twice, on the command and on the thread being created.
 * That is not redundancy worth trimming: T3's decoding default for runtimeMode
 * is `full-access`, so an omission anywhere grants more than the phase asked
 * for.
 */
export function buildTurnStartCommand(input: TurnStartInput): unknown {
  return {
    type: 'thread.turn.start',
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: 'user',
      text: input.prompt,
      attachments: [],
    },
    runtimeMode: input.modes.runtimeMode,
    interactionMode: input.modes.interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.modes.runtimeMode,
        interactionMode: input.modes.interactionMode,
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt: input.createdAt,
      },
    },
    createdAt: input.createdAt,
  };
}

/**
 * The project script that surfaces the board inside T3.
 *
 * Pushed through project.meta.update rather than written as a t3.json into the
 * Acme checkout — that is the zero-footprint principle applied to a file T3
 * would otherwise expect to find in the repo.
 *
 * The command is a health probe, not a launcher, because T3 runs scripts in a
 * worktree-scoped terminal: starting the board there would tie its lifetime to
 * a single thread.
 */
export function buildMissionControlScript(boardUrl: string): unknown {
  return {
    id: 'mission-control',
    name: 'Mission Control',
    icon: 'configure',
    command: `curl -sf ${boardUrl}/health || echo "Mission Control is not running"`,
    runOnWorktreeCreate: false,
    previewUrl: boardUrl,
    autoOpenPreview: true,
  };
}

/**
 * Push project scripts without touching anything else.
 *
 * Every other field on project.meta.update is optional, and T3 applies exactly
 * what it receives — so sending `title` or `workspaceRoot` here would overwrite
 * whatever the operator has since set inside T3.
 */
export function buildProjectScriptsUpdateCommand(input: {
  commandId: string;
  projectId: string;
  scripts: unknown[];
}): unknown {
  return {
    type: 'project.meta.update',
    commandId: input.commandId,
    projectId: input.projectId,
    scripts: input.scripts,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/t3-commands.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/t3/commands.ts test/t3-commands.test.ts
git commit -m "feat(t3): pure builders for the dispatch payloads"
```

---

## Task 9: Facts and reconciliation

Where T3's session state becomes board behaviour: real liveness instead of a PID guess, and approval-blocked as a new attention trigger. `reconcile.ts` stays pure — the snapshot is fetched in `poller.ts` (Task 10) and passed in.

**Files:**
- Create: `src/orchestrator/t3/facts.ts`
- Modify: `src/orchestrator/facts.ts:20-44`
- Modify: `src/orchestrator/reconcile.ts:99-115`, `:185-229`
- Test: `test/t3-facts.test.ts`, `test/reconcile.test.ts` (extend)

**Interfaces:**
- Consumes: `T3Snapshot`, `T3SnapshotThread` from `./schemas.ts`; `Facts`, `TaskRecord` from `../../shared/types.ts`.
- Produces:
  ```ts
  export function latestThreadId(task: TaskRecord): string | null;
  export function toT3Fact(snapshot: T3Snapshot | undefined, threadId: string | null): Facts['t3'];
  ```
- `gatherFacts` gains a fifth parameter: `t3Snapshot?: T3Snapshot`.

- [ ] **Step 1: Write the failing test**

Create `test/t3-facts.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { latestThreadId, toT3Fact } from '../src/orchestrator/t3/facts.ts';
import type { T3Snapshot } from '../src/orchestrator/t3/schemas.ts';
import type { TaskRecord } from '../src/shared/types.ts';

function task(spawnHistory: TaskRecord['spawnHistory']): TaskRecord {
  return {
    issue: 3060,
    title: 'thing',
    slug: 'thing',
    branch: 'ouriel/3060-thing',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory,
    lastReconciledAt: null,
  };
}

function snapshotWith(thread: Partial<T3Snapshot['threads'][number]>): T3Snapshot {
  return {
    projects: [],
    threads: [
      {
        id: 'thread-1',
        projectId: 'p1',
        title: '#3060 plan',
        activities: [],
        session: {
          threadId: 'thread-1',
          status: 'running',
          activeTurnId: 'turn-1',
          lastError: null,
        },
        ...thread,
      } as T3Snapshot['threads'][number],
    ],
  } as T3Snapshot;
}

describe('latestThreadId', () => {
  test('finds the thread id of the most recent T3 spawn', () => {
    const id = latestThreadId(
      task([
        { phase: 'plan', agent: 'codex', startedAt: '2026-08-07T09:00:00Z', command: 't3', threadId: 'thread-a' },
        { phase: 'implement', agent: 'codex', startedAt: '2026-08-07T10:00:00Z', command: 't3', threadId: 'thread-b' },
      ]),
    );
    expect(id).toBe('thread-b');
  });

  test('ignores wt and vscode spawns, which have no thread', () => {
    const id = latestThreadId(
      task([
        { phase: 'plan', agent: 'codex', startedAt: '2026-08-07T09:00:00Z', command: 't3', threadId: 'thread-a' },
        { phase: 'implement', agent: 'claude', startedAt: '2026-08-07T10:00:00Z', command: 'wt ...' },
      ]),
    );
    expect(id).toBe('thread-a');
  });

  test('a task that never used T3 has no thread', () => {
    expect(latestThreadId(task([]))).toBeNull();
  });
});

describe('toT3Fact', () => {
  test('reports a running session', () => {
    const fact = toT3Fact(snapshotWith({}), 'thread-1');
    expect(fact).toMatchObject({
      threadId: 'thread-1',
      sessionStatus: 'running',
      activeTurnId: 'turn-1',
      awaitingApproval: false,
      lastError: null,
    });
  });

  test('no snapshot means no information at all, not "not running"', () => {
    // The distinction matters: undefined makes reconcile fall back to PID
    // liveness, whereas a fabricated 'stopped' would show a live agent as dead.
    expect(toT3Fact(undefined, 'thread-1')).toBeUndefined();
  });

  test('a task with no recorded thread has no T3 fact', () => {
    expect(toT3Fact(snapshotWith({}), null)).toBeUndefined();
  });

  test('a thread that is not in the snapshot has no T3 fact', () => {
    // Deleted inside T3. Markers still hold the history; only liveness is lost.
    expect(toT3Fact(snapshotWith({}), 'thread-gone')).toBeUndefined();
  });

  test('a thread with no session reports idle rather than vanishing', () => {
    const fact = toT3Fact(snapshotWith({ session: null }), 'thread-1');
    expect(fact?.sessionStatus).toBe('idle');
    expect(fact?.activeTurnId).toBeNull();
  });

  test('an approval-toned latest activity means the thread is blocked on you', () => {
    const fact = toT3Fact(
      snapshotWith({
        activities: [
          { id: 'e1', tone: 'info' },
          { id: 'e2', tone: 'approval' },
        ],
      }),
      'thread-1',
    );
    expect(fact?.awaitingApproval).toBe(true);
  });

  test('an approval that is no longer the latest activity is not still blocking', () => {
    const fact = toT3Fact(
      snapshotWith({
        activities: [
          { id: 'e1', tone: 'approval' },
          { id: 'e2', tone: 'tool' },
        ],
      }),
      'thread-1',
    );
    expect(fact?.awaitingApproval).toBe(false);
  });

  test('a session error is carried through for the card to show', () => {
    const fact = toT3Fact(
      snapshotWith({
        session: { threadId: 'thread-1', status: 'error', activeTurnId: null, lastError: 'provider exited 1' },
      }),
      'thread-1',
    );
    expect(fact?.sessionStatus).toBe('error');
    expect(fact?.lastError).toBe('provider exited 1');
  });
});
```

Then append to `test/reconcile.test.ts` (reuse the file's existing `facts(...)` helper if it has one; otherwise build a full `Facts` literal in the same style as the surrounding tests):

```ts
describe('T3 session liveness', () => {
  test('a running T3 session makes the card live even with no PID marker', () => {
    const derived = reconcile(
      makeFacts({
        liveSpawn: null,
        t3: {
          threadId: 'thread-1',
          sessionStatus: 'running',
          activeTurnId: 'turn-1',
          awaitingApproval: false,
          lastError: null,
        },
      }),
    );
    expect(derived.badges.some((b) => b.kind === 'live')).toBe(true);
  });

  test('a starting T3 session counts as live', () => {
    const derived = reconcile(
      makeFacts({
        liveSpawn: null,
        t3: { threadId: 't', sessionStatus: 'starting', activeTurnId: null, awaitingApproval: false, lastError: null },
      }),
    );
    expect(derived.badges.some((b) => b.kind === 'live')).toBe(true);
  });

  test('an idle session with an active turn still counts as live', () => {
    const derived = reconcile(
      makeFacts({
        liveSpawn: null,
        t3: { threadId: 't', sessionStatus: 'idle', activeTurnId: 'turn-9', awaitingApproval: false, lastError: null },
      }),
    );
    expect(derived.badges.some((b) => b.kind === 'live')).toBe(true);
  });

  test('a stopped session with no active turn is not live', () => {
    const derived = reconcile(
      makeFacts({
        liveSpawn: null,
        t3: { threadId: 't', sessionStatus: 'stopped', activeTurnId: null, awaitingApproval: false, lastError: null },
      }),
    );
    expect(derived.badges.some((b) => b.kind === 'live')).toBe(false);
  });

  test('with no T3 fact the PID marker still decides liveness', () => {
    // The fallback is not vestigial: it covers wt and vscode launches, and it
    // covers the board running while T3 is down.
    const derived = reconcile(
      makeFacts({ liveSpawn: { phase: 'plan', pid: 1234, startedAt: '2026-08-07T09:00:00Z', source: 'marker' } }),
    );
    expect(derived.badges.some((b) => b.kind === 'live')).toBe(true);
  });

  test('a thread awaiting approval needs you', () => {
    // Exactly what the attention rail exists for, and something Mission
    // Control has no way to detect without T3.
    const derived = reconcile(
      makeFacts({
        liveSpawn: null,
        t3: { threadId: 't', sessionStatus: 'running', activeTurnId: 'turn-1', awaitingApproval: true, lastError: null },
      }),
    );
    expect(derived.needsYou).toBe(true);
    expect(derived.needsYouReason).toMatch(/approval/i);
  });

  test('awaiting approval outranks being live, so the card does not go quiet', () => {
    const derived = reconcile(
      makeFacts({
        liveSpawn: { phase: 'plan', pid: 1234, startedAt: '2026-08-07T09:00:00Z', source: 'marker' },
        t3: { threadId: 't', sessionStatus: 'running', activeTurnId: 'turn-1', awaitingApproval: true, lastError: null },
      }),
    );
    expect(derived.needsYou).toBe(true);
  });

  test('a session error shows as a badge', () => {
    const derived = reconcile(
      makeFacts({
        liveSpawn: null,
        t3: { threadId: 't', sessionStatus: 'error', activeTurnId: null, awaitingApproval: false, lastError: 'provider exited 1' },
      }),
    );
    expect(derived.badges.some((b) => b.kind === 't3-error')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/t3-facts.test.ts test/reconcile.test.ts`
Expected: FAIL — module not found, and unknown badge kind

- [ ] **Step 3: Write `src/orchestrator/t3/facts.ts`**

```ts
import type { Facts, TaskRecord } from '../../shared/types.ts';
import type { T3Snapshot } from './schemas.ts';

/**
 * Turning T3's snapshot into the one optional fact the reconciler consumes.
 *
 * The load-bearing distinction throughout: `undefined` means "no information",
 * never "not running". Only that reading makes the fallback to PID liveness
 * correct — inventing a 'stopped' status when T3 is unreachable would show a
 * working agent as dead.
 */

/** The thread id of the most recent T3-launched spawn, if any. */
export function latestThreadId(task: TaskRecord): string | null {
  for (let i = task.spawnHistory.length - 1; i >= 0; i -= 1) {
    const threadId = task.spawnHistory[i].threadId;
    if (threadId) return threadId;
  }
  return null;
}

export function toT3Fact(
  snapshot: T3Snapshot | undefined,
  threadId: string | null,
): Facts['t3'] {
  if (!snapshot || !threadId) return undefined;

  const thread = snapshot.threads.find((t) => t.id === threadId);
  // Deleted inside T3, or belonging to another environment. Markers still hold
  // the history; only liveness is lost.
  if (!thread) return undefined;

  // Only the latest activity matters: an approval that has been answered is
  // followed by further activity, so a historical one must not keep the card
  // in the attention rail forever.
  const latest = thread.activities.at(-1);

  return {
    threadId,
    sessionStatus: thread.session?.status ?? 'idle',
    activeTurnId: thread.session?.activeTurnId ?? null,
    awaitingApproval: latest?.tone === 'approval',
    lastError: thread.session?.lastError ?? null,
  };
}
```

- [ ] **Step 4: Thread the snapshot through `src/orchestrator/facts.ts`**

Change the signature and the returned object:

```ts
import { latestThreadId, toT3Fact } from './t3/facts.ts';
import type { T3Snapshot } from './t3/schemas.ts';

export async function gatherFacts(
  config: Config,
  task: TaskRecord,
  branches: Set<string>,
  batch: BatchedBranchPrs,
  /**
   * The orchestration snapshot for this cycle, fetched once by the poller.
   * Absent means T3 is unavailable, which is a normal state.
   */
  t3Snapshot?: T3Snapshot,
): Promise<Facts> {
```

Add to the `facts` literal, after `liveSpawn`:

```ts
    t3: toT3Fact(t3Snapshot, latestThreadId(task)),
```

- [ ] **Step 5: Teach `src/orchestrator/reconcile.ts` about it**

Add a helper near `planReady`:

```ts
/**
 * Is something actively working this task?
 *
 * T3 answers directly when it can. The PID fallback is not vestigial: it
 * covers wt- and vscode-launched phases, and it covers the board running while
 * T3 is down.
 */
function isLive(facts: Facts): boolean {
  if (facts.t3) {
    const { sessionStatus, activeTurnId } = facts.t3;
    return sessionStatus === 'starting' || sessionStatus === 'running' || activeTurnId !== null;
  }
  return facts.liveSpawn !== null;
}
```

In `computeBadges`, replace the `if (facts.liveSpawn)` block at `src/orchestrator/reconcile.ts:102`:

```ts
  if (isLive(facts)) {
    // A T3-only run has no marker to name the phase; the badge still has to
    // say something, and "session running" is honest about what we know.
    const what = facts.liveSpawn?.phase ?? 'session';
    badges.push({ kind: 'live', label: `${what} running`, tone: 'busy' });
  } else if (facts.markers.some((m) => m.endsWith('.running'))) {
    // A running marker with no live process means a terminal died mid-run.
    badges.push({ kind: 'stale-spawn', label: 'spawn ended', tone: 'warn' });
  }

  if (facts.t3?.lastError) {
    badges.push({ kind: 't3-error', label: 'T3 session error', tone: 'bad' });
  }
```

In `computeNeedsYou`, replace `if (facts.liveSpawn) return no;` at `src/orchestrator/reconcile.ts:192` with:

```ts
  // A thread blocked on an approval request is precisely what the attention
  // rail exists to surface, so it is checked before the "something is working
  // on it, wait" short-circuit.
  if (facts.t3?.awaitingApproval) {
    return { needsYou: true, needsYouReason: 'T3 session is waiting for your approval' };
  }

  // Something is actively working the task; wait for it.
  if (isLive(facts)) return no;
```

Add `'t3-error'` to `BadgeKind` in `src/shared/types.ts`:

```ts
export type BadgeKind =
  | 'live'
  | 'stale-spawn'
  | 't3-error'
  | 'plan-ready'
  // ... rest unchanged
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/t3-facts.test.ts test/reconcile.test.ts`
Expected: PASS

- [ ] **Step 7: Run the whole suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add src/orchestrator/t3/facts.ts src/orchestrator/facts.ts src/orchestrator/reconcile.ts src/shared/types.ts test/t3-facts.test.ts test/reconcile.test.ts
git commit -m "feat(t3): session liveness and approval-blocked in the reconciler"
```

---

## Task 10: Poller wiring — one snapshot per cycle

Fetches the snapshot once per reconcile, regardless of task count, matching the existing GitHub polling budget.

**Files:**
- Modify: `src/orchestrator/poller.ts:62-90`
- Test: `test/t3-poller.test.ts`

**Interfaces:**
- Consumes: `T3Client` from `./t3/client.ts`; `gatherFacts` with its new fifth parameter.
- Produces: `reconcileAll` unchanged in signature; a module-level `T3Client` reused across cycles so the token cache survives.

- [ ] **Step 1: Write the failing test**

Create `test/t3-poller.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';

import { shouldFetchT3Snapshot } from '../src/orchestrator/poller.ts';
import type { TaskRecord } from '../src/shared/types.ts';

function task(threadId?: string): TaskRecord {
  return {
    issue: 3060,
    title: 't',
    slug: 't',
    branch: 'b',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: threadId
      ? [{ phase: 'plan', agent: 'codex', startedAt: '2026-08-07T09:00:00Z', command: 't3', threadId }]
      : [],
    lastReconciledAt: null,
  };
}

describe('shouldFetchT3Snapshot', () => {
  test('fetches when at least one task has a T3 thread', () => {
    expect(shouldFetchT3Snapshot([task(), task('thread-1')])).toBe(true);
  });

  test('does not spend a request when no task has ever used T3', () => {
    // A board that never touched T3 must not pay for it every poll.
    expect(shouldFetchT3Snapshot([task(), task()])).toBe(false);
  });

  test('an empty board does not fetch', () => {
    expect(shouldFetchT3Snapshot([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-poller.test.ts`
Expected: FAIL — `shouldFetchT3Snapshot` is not exported

- [ ] **Step 3: Modify `src/orchestrator/poller.ts`**

Add near the top, after the existing imports:

```ts
import { T3Client } from './t3/client.ts';
import { latestThreadId } from './t3/facts.ts';

/**
 * One client for the process, so the bearer token is exchanged once rather
 * than per cycle. Discovery still runs on every request, which is what lets a
 * T3 restart on a new port be picked up without restarting the board.
 */
const t3 = new T3Client();

/**
 * Only spend a request when some task could actually use the answer. A board
 * that has never launched through T3 must not pay for it on every poll.
 */
export function shouldFetchT3Snapshot(tasks: TaskRecord[]): boolean {
  return tasks.some((task) => latestThreadId(task) !== null);
}
```

Inside `reconcileAll`, after `const batch = await fetchBranchPrs(config, activeBranches);`:

```ts
  // One snapshot covers every task, so the cost does not scale with board size.
  const t3Snapshot = shouldFetchT3Snapshot(state.tasks) ? await t3.fetchSnapshot() : undefined;
```

And pass it through at the `gatherFacts` call:

```ts
        let facts = await gatherFacts(config, task, branches, batch, t3Snapshot);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/t3-poller.test.ts && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/poller.ts test/t3-poller.test.ts
git commit -m "feat(t3): fetch one orchestration snapshot per reconcile cycle"
```

---

## Task 11: The `t3` spawn branch

The launch tail. Everything before it — `resolveSpawnPlan`, prompt rendering, `writePromptFile`, `writePlanSnapshot` — is untouched.

**Files:**
- Modify: `src/orchestrator/spawn.ts:285-343`
- Modify: `src/orchestrator/state.ts` (project id persistence)
- Test: `test/t3-spawn.test.ts`

**Interfaces:**
- Consumes: `T3Client` from `./t3/client.ts`; `buildModelSelection`, `buildProjectCreateCommand`, `buildTurnStartCommand` from `./t3/commands.ts`; `readInstanceReadiness` from `./t3/instances.ts`; `t3ModesForPhase` from `../shared/types.ts`; `ensureWorktree` from `./worktree.ts`.
- Produces:
  ```ts
  export function getT3ProjectId(): string | null;   // state.ts
  export function setT3ProjectId(id: string): void;  // state.ts
  export async function launchT3(config, task, phase, options): Promise<{ command: string; threadId: string }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/t3-spawn.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getT3ProjectId, setT3ProjectId } from '../src/orchestrator/state.ts';
import { resolveT3Launch } from '../src/orchestrator/spawn.ts';
import type { AgentProfile, PhaseConfig } from '../src/shared/types.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('T3 project id persistence', () => {
  test('a board that has never spawned through T3 has no project', () => {
    expect(getT3ProjectId()).toBeNull();
  });

  test('the project id survives a round trip so later spawns reuse it', () => {
    setT3ProjectId('proj-1');
    expect(getT3ProjectId()).toBe('proj-1');
  });
});

describe('resolveT3Launch', () => {
  const codex: AgentProfile = {
    launch: 'codex',
    promptMode: 'positional',
    instructionMode: 'inline',
    t3Instance: 'codex',
  };
  const plan = {
    id: 'plan',
    label: 'Plan',
    actor: 'codex',
    gate: { type: 'manual' },
  } as PhaseConfig;

  test('refuses an agent that has no T3 instance, naming the agent', () => {
    const { t3Instance, ...noInstance } = codex;
    const result = resolveT3Launch({
      agent: 'codex',
      profile: noInstance as AgentProfile,
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('codex');
    expect(result.error).toContain('t3Instance');
  });

  test('refuses when the provider instance is not ready, quoting T3s reason', () => {
    const result = resolveT3Launch({
      agent: 'copilot',
      profile: { ...codex, t3Instance: 'opencode' },
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({
        instanceId: 'opencode',
        ready: false,
        reason: "OpenCode CLI (`opencode`) is not installed or not on PATH",
        models: [],
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('not installed');
  });

  test('refuses when no concrete model is resolvable', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: plan,
      model: 'default',
      effort: null,
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    expect(result.ok).toBe(false);
  });

  test('resolves the model selection and the phase modes when everything is ready', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: 'high',
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.modelSelection).toEqual({
      instanceId: 'codex',
      model: 'gpt-5.6-sol',
      options: [{ id: 'effort', value: 'high' }],
    });
    expect(result.modes).toEqual({ runtimeMode: 'approval-required', interactionMode: 'plan' });
  });

  test('a phase with no configured modes still never gets full-access', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: { ...plan, id: 'merge' } as PhaseConfig,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.modes.runtimeMode).not.toBe('full-access');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-spawn.test.ts`
Expected: FAIL — `resolveT3Launch` and `getT3ProjectId` are not exported

- [ ] **Step 3: Add project id persistence to `src/orchestrator/state.ts`**

```ts
/**
 * The T3 project Mission Control created, if any.
 *
 * Created once lazily on the first 't3' spawn and reused thereafter, so every
 * task's threads live under one project in T3's sidebar. Losing this id costs
 * one extra project, never any work.
 */
export function getT3ProjectId(): string | null {
  return loadState().t3ProjectId ?? null;
}

export function setT3ProjectId(id: string): void {
  const state = loadState();
  saveState({ ...state, t3ProjectId: id });
}
```

- [ ] **Step 4: Add the launch branch to `src/orchestrator/spawn.ts`**

Add imports:

```ts
import { randomUUID } from 'node:crypto';

import { T3Client } from './t3/client.ts';
import {
  buildModelSelection,
  buildProjectCreateCommand,
  buildTurnStartCommand,
  type ModelSelection,
} from './t3/commands.ts';
import { readInstanceReadiness, type InstanceReadiness } from './t3/instances.ts';
import { getT3ProjectId, setT3ProjectId } from './state.ts';
import { t3ModesForPhase } from '../shared/types.ts';
import type { T3PhaseModes } from '../shared/types.ts';
```

Add the pure precheck, so every refusal is testable without a server:

```ts
export type T3LaunchPlan =
  | { ok: true; modelSelection: ModelSelection; modes: T3PhaseModes }
  | { ok: false; error: string };

/**
 * Can this phase run through T3, and with what?
 *
 * Pure, and separate from the launch itself, because every one of these
 * refusals should reach the card as a sentence rather than as a rejected
 * dispatch with a server-side message about an id the operator never typed.
 */
export function resolveT3Launch(input: {
  agent: string;
  profile: AgentProfile;
  phase: PhaseConfig;
  model: string | null;
  effort: string | null;
  readiness?: (instanceId: string) => InstanceReadiness;
}): T3LaunchPlan {
  const readiness = input.readiness ?? readInstanceReadiness;

  if (!input.profile.t3Instance) {
    return {
      ok: false,
      error: `Agent '${input.agent}' has no t3Instance in config.yaml, so it cannot run through T3 Code. Add one (for example t3Instance: 'codex') or pick a different launcher.`,
    };
  }

  const instance = readiness(input.profile.t3Instance);
  if (!instance.ready) {
    return {
      ok: false,
      error: `T3 cannot run '${input.agent}': ${instance.reason}`,
    };
  }

  const modelSelection = buildModelSelection(input.profile, {
    model: input.model,
    effort: input.effort,
  });
  if (!modelSelection) {
    return {
      ok: false,
      error: `T3 needs a specific model for '${input.agent}', but the resolved choice was '${input.model ?? 'none'}'. Pick a model in the drawer, or set one on the agent in config.yaml.`,
    };
  }

  return { ok: true, modelSelection, modes: t3ModesForPhase(input.phase) };
}
```

Add the launcher:

```ts
/**
 * T3 path: the worktree must exist before the thread binds to it, so it is
 * created here exactly as the vscode path does. T3 is never asked to create
 * one — it needs the worktree's path, not its authorship.
 *
 * Unlike wt and vscode this does not detach a terminal, so the dispatch is
 * awaited: an agent that could not start should fail the spawn loudly rather
 * than leaving a card that claims a run began.
 */
async function launchT3(
  config: Config,
  task: TaskRecord,
  phase: PhaseConfig,
  plan: { modelSelection: ModelSelection; modes: T3PhaseModes; prompt: string },
  client: T3Client = new T3Client(),
): Promise<{ command: string; threadId: string }> {
  await ensureWorktree(config, task.issue, task.branch);

  const createdAt = new Date().toISOString();

  // The project is created once, lazily, and reused so every task's threads
  // group under one entry in T3's sidebar.
  let projectId = getT3ProjectId();
  if (!projectId) {
    projectId = randomUUID();
    const created = await client.dispatch(
      buildProjectCreateCommand({
        commandId: randomUUID(),
        projectId,
        title: config.t3?.projectTitle ?? 'Acme',
        workspaceRoot: config.repo.path,
        createdAt,
      }),
    );
    if (!created.ok) throw new Error(`Could not create the T3 project: ${created.error}`);
    setT3ProjectId(projectId);
  }

  const threadId = randomUUID();
  const result = await client.dispatch(
    buildTurnStartCommand({
      commandId: randomUUID(),
      threadId,
      messageId: randomUUID(),
      projectId,
      title: `#${task.issue} ${phase.id}`,
      // The same rendered text writePromptFile just persisted. Passing it
      // through rather than re-reading keeps the prompt file exactly what it
      // is for the other launchers: a record, not a channel.
      prompt: plan.prompt,
      worktreePath: worktreePath(task.issue),
      branch: task.branch,
      modelSelection: plan.modelSelection,
      modes: plan.modes,
      createdAt,
    }),
  );
  if (!result.ok) throw new Error(`T3 did not start the phase: ${result.error}`);

  return {
    command: `t3 dispatch thread.turn.start (thread ${threadId})`,
    threadId,
  };
}
```

Rewrite the tail of `spawnPhase` (`src/orchestrator/spawn.ts:331-343`). `promptText` is already in scope from `resolveSpawnPlan` at the top of the function:

```ts
  const launcher = getSettings().launcher ?? config.launcher ?? 'wt';

  let command: string;
  let threadId: string | undefined;

  if (launcher === 't3') {
    const plan = resolveT3Launch({ agent, profile, phase, model, effort });
    if (!plan.ok) throw new Error(plan.error);
    const launched = await launchT3(config, task, phase, { ...plan, prompt: promptText });
    command = launched.command;
    threadId = launched.threadId;
  } else if (launcher === 'vscode') {
    command = await launchVscode(config, task, phase, specFile);
  } else {
    command = launchWt(task, phase, config, specFile);
  }

  return {
    phase: phase.id,
    agent: describeAgent(agent, model, effort),
    startedAt: new Date().toISOString(),
    command,
    ...(threadId ? { threadId } : {}),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/t3-spawn.test.ts test/spawn.test.ts`
Expected: PASS

- [ ] **Step 6: Run the whole suite, typecheck, commit**

```bash
npm test && npm run typecheck
git add src/orchestrator/spawn.ts src/orchestrator/state.ts test/t3-spawn.test.ts
git commit -m "feat(t3): run a phase as a T3 thread bound to MC's worktree"
```

---

## Task 12: Server route, launcher selector, and the thread link

Makes `t3` reachable from the board. The preview-panel affordance in Step 5 is conditional on Task 1's finding.

**Files:**
- Modify: `src/server/routes.ts:99-105`
- Modify: `src/web/components/Settings.tsx:78-98`
- Modify: `src/web/components/` — the card drawer's run tab (locate with `grep -rn "spawnHistory" src/web`)
- Test: `test/t3-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/t3-routes.test.ts`, following the shape of `test/server-health.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { isValidLauncher } from '../src/server/routes.ts';

describe('launcher validation', () => {
  test('accepts every launcher the board offers', () => {
    expect(isValidLauncher('wt')).toBe(true);
    expect(isValidLauncher('vscode')).toBe(true);
    expect(isValidLauncher('t3')).toBe(true);
  });

  test('rejects anything else', () => {
    expect(isValidLauncher('emacs')).toBe(false);
    expect(isValidLauncher('')).toBe(false);
    expect(isValidLauncher(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-routes.test.ts`
Expected: FAIL — `isValidLauncher` is not exported

- [ ] **Step 3: Modify `src/server/routes.ts`**

Add above the route definitions:

```ts
const LAUNCHERS: LauncherKind[] = ['wt', 'vscode', 't3'];

export function isValidLauncher(value: unknown): value is LauncherKind {
  return typeof value === 'string' && (LAUNCHERS as string[]).includes(value);
}
```

Replace the validation at `src/server/routes.ts:101-103`:

```ts
    if (!isValidLauncher(launcher)) {
      return reply.code(400).send({ error: `launcher must be one of ${LAUNCHERS.join(', ')}` });
    }
```

Import `LauncherKind` from `../shared/types.ts` if it is not already imported.

- [ ] **Step 4: Add the third button in `src/web/components/Settings.tsx`**

Replace the launcher array and label at `src/web/components/Settings.tsx:80` and `:88`:

```tsx
            {(['wt', 'vscode', 't3'] as LauncherKind[]).map((kind) => (
              <button
                key={kind}
                className={`btn is-sm${config.launcher === kind ? ' is-on' : ''}`}
                disabled={busy !== null}
                onClick={() => act('launcher', () => api.setLauncher(kind))}
              >
                {kind === 'wt' ? 'Windows Terminal' : kind === 'vscode' ? 'VS Code' : 'T3 Code'}
              </button>
            ))}
```

Add a hint block after the existing `vscode` one:

```tsx
          {config.launcher === 't3' && (
            <p className="hint">
              Runs each phase as a T3 Code thread bound to the same worktree, so T3
              reports whether a session is really running and when it is blocked on an
              approval. Needs T3 Code running, an agent with a <code>t3Instance</code> in
              config.yaml, and a pairing credential at{' '}
              <code>~/.mc/t3-credential</code> — create one in T3 under Settings →
              Create pairing link.
            </p>
          )}
```

- [ ] **Step 5: Add the thread affordance to the drawer's run tab**

Find the component that renders `spawnHistory` (`grep -rn "spawnHistory" src/web`). For each record that has a `threadId`, render the id as a monospace label with a copy button:

```tsx
{record.threadId && (
  <button
    className="btn is-sm"
    title="Copy this run's T3 thread id"
    onClick={() => navigator.clipboard.writeText(record.threadId!)}
  >
    T3 thread
  </button>
)}
```

A copy button rather than a link: T3 Code is a desktop application with no documented URL scheme for opening a thread, so a deep link would be a guess.

**Conditional on Task 1's finding.** If it was `WORKS` or `WORKS WITH LIMITS`, also push the Mission Control project script. In `launchT3` (Task 11), immediately after `setT3ProjectId(projectId)` — that is, only on the run that creates the project:

```ts
    // Surface the board inside T3 without writing a t3.json into the Acme
    // checkout. Best-effort: a failure here costs a convenience panel, never
    // the spawn, so it is not allowed to throw.
    const scripts = await client.dispatch(
      buildProjectScriptsUpdateCommand({
        commandId: randomUUID(),
        projectId,
        scripts: [buildMissionControlScript(`http://127.0.0.1:${config.server.port}`)],
      }),
    );
    if (!scripts.ok) {
      console.error(`[mc] could not install the Mission Control panel in T3: ${scripts.error}`);
    }
```

This adds `buildMissionControlScript` and `buildProjectScriptsUpdateCommand` to the `./t3/commands.ts` import already present in `spawn.ts` from Task 11.

If Task 1's finding was `DOES NOT WORK`, skip this block entirely, leave `buildMissionControlScript` unused (its test still documents the intended shape), and say so in the commit message.

- [ ] **Step 6: Run the tests, typecheck, build, commit**

```bash
npm test && npm run typecheck && npm run build
git add src/server/routes.ts src/web/components/Settings.tsx test/t3-routes.test.ts
git commit -m "feat(t3): select the T3 launcher and surface thread ids on cards"
```

---

## Task 13: `doctor`, install checks, and documentation

Makes every failure diagnosable without reading source. The three auth failures need different fixes, so `doctor` must tell them apart.

**Files:**
- Modify: `src/orchestrator/cli.ts` (the `doctor` command)
- Modify: `scripts/install.ps1`
- Modify: `README.md`
- Test: `test/t3-doctor.test.ts`

**Interfaces:**
- Consumes: `T3Client.status()`, `readInstanceReadiness`, `readPairingCredential`.
- Produces: `export function formatT3Doctor(input: T3DoctorInput): string[];`

- [ ] **Step 1: Write the failing test**

Create `test/t3-doctor.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import { formatT3Doctor } from '../src/orchestrator/t3/doctor.ts';

describe('formatT3Doctor', () => {
  test('reports a healthy integration with the version and capabilities', () => {
    const lines = formatT3Doctor({
      status: {
        ok: true,
        origin: 'http://127.0.0.1:3773',
        serverVersion: '0.0.31',
        capabilities: { serverSelfUpdate: 'desktop-managed' },
      },
      pinnedVersion: '0.0.31',
      instances: [{ agent: 'codex', instanceId: 'codex', ready: true, reason: null, models: [] }],
    }).join('\n');

    expect(lines).toContain('0.0.31');
    expect(lines).toContain('serverSelfUpdate');
    expect(lines).toMatch(/ok|✓/i);
  });

  test('warns on a version drift without failing', () => {
    // The desktop build updates itself without asking, so drift is expected
    // and must not block a spawn.
    const lines = formatT3Doctor({
      status: { ok: true, origin: 'http://x', serverVersion: '0.0.44', capabilities: {} },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');
    expect(lines).toMatch(/warn/i);
    expect(lines).toContain('0.0.44');
    expect(lines).toContain('0.0.31');
  });

  test('a missing credential and a rejected one get different remedies', () => {
    const missing = formatT3Doctor({
      status: { ok: false, reason: 'no-credential', detail: 'no credential' },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');
    const rejected = formatT3Doctor({
      status: { ok: false, reason: 'credential-rejected', detail: 'token exchange returned 401' },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');

    expect(missing).toContain('Create pairing link');
    expect(rejected).toContain('401');
    expect(missing).not.toBe(rejected);
  });

  test('T3 not running is reported as a normal state, not an error', () => {
    const lines = formatT3Doctor({
      status: { ok: false, reason: 'no-runtime-file', detail: 'C:\\Users\\x\\.t3\\...' },
      pinnedVersion: '0.0.31',
      instances: [],
    }).join('\n');
    expect(lines).toMatch(/not running/i);
  });

  test('names each unusable agent instance and why', () => {
    const lines = formatT3Doctor({
      status: { ok: true, origin: 'http://x', serverVersion: '0.0.31', capabilities: {} },
      pinnedVersion: '0.0.31',
      instances: [
        { agent: 'codex', instanceId: 'codex', ready: true, reason: null, models: ['gpt-5.6-sol'] },
        { agent: 'copilot', instanceId: 'opencode', ready: false, reason: 'not installed', models: [] },
      ],
    }).join('\n');
    expect(lines).toContain('copilot');
    expect(lines).toContain('opencode');
    expect(lines).toContain('not installed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/t3-doctor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/orchestrator/t3/doctor.ts`**

```ts
import type { T3Status } from './client.ts';

/**
 * The T3 section of `mc doctor`, as lines.
 *
 * Pure so the wording is testable. The three authentication failures are kept
 * distinct on purpose: "T3 is not running", "no credential" and "credential
 * rejected" need three different actions, and collapsing them into one
 * "T3 unavailable" line would send the operator looking in the wrong place.
 */

export interface T3DoctorInstance {
  agent: string;
  instanceId: string;
  ready: boolean;
  reason: string | null;
  models: string[];
}

export interface T3DoctorInput {
  status: T3Status;
  pinnedVersion: string | undefined;
  instances: T3DoctorInstance[];
}

export function formatT3Doctor(input: T3DoctorInput): string[] {
  const lines: string[] = ['T3 Code'];
  const { status } = input;

  if (!status.ok) {
    switch (status.reason) {
      case 'no-runtime-file':
      case 'dead-server':
        lines.push(`  - T3 Code is not running. The t3 launcher is unavailable; wt and vscode are unaffected.`);
        lines.push(`    ${status.detail}`);
        break;
      case 'no-credential':
        lines.push('  - T3 is running but has no pairing credential.');
        lines.push('    Fix: in T3, Settings -> Create pairing link (scopes orchestration:read and');
        lines.push('    orchestration:operate), then save it to ~/.mc/t3-credential.');
        break;
      case 'credential-rejected':
        lines.push('  - T3 rejected the pairing credential.');
        lines.push(`    ${status.detail}`);
        lines.push('    Fix: mint a fresh pairing link in T3 and replace ~/.mc/t3-credential.');
        break;
      default:
        lines.push(`  - T3 is unreachable: ${status.detail}`);
    }
    return lines;
  }

  lines.push(`  - ok: reachable at ${status.origin}, server version ${status.serverVersion}`);

  if (input.pinnedVersion && input.pinnedVersion !== status.serverVersion) {
    // A warning, never a block: the desktop build self-updates, so drift is
    // the normal case rather than a fault.
    lines.push(
      `  - warn: running ${status.serverVersion} but fixtures were recorded against ${input.pinnedVersion}.`,
    );
    lines.push('    Re-record the T3 fixtures, run the suite, then bump t3.pinnedVersion.');
  }

  lines.push(`  - capabilities: ${JSON.stringify(status.capabilities)}`);

  for (const instance of input.instances) {
    lines.push(
      instance.ready
        ? `  - ok: agent '${instance.agent}' -> instance '${instance.instanceId}' (${instance.models.length} models)`
        : `  - warn: agent '${instance.agent}' -> instance '${instance.instanceId}' is not usable: ${instance.reason}`,
    );
  }

  return lines;
}
```

- [ ] **Step 4: Call it from `doctor` in `src/orchestrator/cli.ts`**

In the `doctor` command, after the existing checks:

```ts
  const client = new T3Client();
  const t3Instances = Object.entries(config.agents)
    .filter(([, profile]) => profile.t3Instance)
    .map(([agent, profile]) => {
      const readiness = readInstanceReadiness(profile.t3Instance!);
      return {
        agent,
        instanceId: readiness.instanceId,
        ready: readiness.ready,
        reason: readiness.reason,
        models: readiness.models,
      };
    });

  for (const line of formatT3Doctor({
    status: await client.status(),
    pinnedVersion: config.t3?.pinnedVersion,
    instances: t3Instances,
  })) {
    console.log(line);
  }
```

Import `T3Client`, `readInstanceReadiness` and `formatT3Doctor` at the top of `cli.ts`.

- [ ] **Step 5: Add the install sanity check to `scripts/install.ps1`**

Alongside the existing tool checks:

```powershell
# T3 Code is optional: the t3 launcher needs it, wt and vscode do not.
$t3Runtime = Join-Path $env:USERPROFILE '.t3\userdata\server-runtime.json'
if (Test-Path $t3Runtime) {
  Write-Host "  ok: T3 Code state found at $t3Runtime"
  $t3Credential = Join-Path $env:USERPROFILE '.mc\t3-credential'
  if (-not (Test-Path $t3Credential)) {
    Write-Host "  note: no T3 pairing credential yet. The 't3' launcher needs one."
    Write-Host "        In T3: Settings -> Create pairing link (scopes orchestration:read"
    Write-Host "        and orchestration:operate), then save it to $t3Credential"
  }
} else {
  Write-Host "  note: T3 Code not detected. The 'wt' and 'vscode' launchers work without it."
}
```

- [ ] **Step 6: Document it in `README.md`**

Extend the "Where agents open" section with a third bullet:

```markdown
- **T3 Code** — runs the phase as a thread in [T3 Code](https://github.com/pingdotgg/t3code),
  bound to the same worktree Mission Control already creates. T3 then reports whether a
  session is genuinely running and when it is blocked on an approval, which retires the
  PID guess for those phases. Mission Control never starts T3's server and never modifies
  T3 itself; it attaches to the one the desktop application already runs.

  One-time setup:

  1. Install T3 Code: `winget install T3Tools.T3Code`
  2. Start it, and create a pairing link under Settings with the scopes
     `orchestration:read` and `orchestration:operate`.
  3. Save the credential to `%USERPROFILE%\.mc\t3-credential`.
  4. Give each agent a `t3Instance` in `config.yaml` (`claude` → `claudeAgent`,
     `codex` → `codex`, `copilot` → `opencode`).
  5. `npm run mc -- doctor` reports whether each instance can actually run.

  `copilot` through T3 is a substitution, not a passthrough: it runs OpenCode's agent
  loop using Copilot's models, and needs the `opencode` CLI installed and authenticated
  against a Copilot Pro, Pro+, Business or Enterprise subscription.
```

Add to the requirements line: `T3 Code is optional and needed only for the t3 launcher.`

- [ ] **Step 7: Run everything and commit**

```bash
npm test && npm run typecheck && npm run build
git add src/orchestrator/t3/doctor.ts src/orchestrator/cli.ts scripts/install.ps1 README.md test/t3-doctor.test.ts
git commit -m "feat(t3): diagnose the integration from doctor, install and README"
```

---

## Manual end-to-end verification

Not a task — the check to run once the plan is done, because nothing above proves a real agent starts.

- [ ] T3 Code is running; `npm run mc -- doctor` shows T3 ok and at least one ready instance.
- [ ] Switch the launcher to T3 Code in the Agents panel.
- [ ] `npm run mc -- spawn <issue> plan` — a thread titled `#<issue> plan` appears in T3, its working directory is `~/.mc/worktrees/issue-<n>`, and it starts in plan mode with approvals required.
- [ ] While the agent runs, the card shows a live badge. Close nothing; wait for it to finish. The badge clears without a poll of the PID marker.
- [ ] Trigger an approval prompt in T3. The card moves into the attention rail with an approval reason.
- [ ] Quit T3 Code entirely. The board still reconciles every task to the correct phase — only liveness is lost.
- [ ] Restart T3. Liveness returns without restarting Mission Control.
- [ ] Corrupt `~/.mc/t3-credential`. `doctor` says the credential was rejected and names the fix; the board keeps working.

---

## Self-review notes

**Spec coverage.** §1.1 → Tasks 3, 5, 6. §1.2 (WebSocket, deliberately unused) → recorded in Task 6's module docs. §1.3 → Task 8's `buildMissionControlScript`. §2.1 → Task 3. §2.2 → Task 5. §2.3 → Task 2 and Task 6. §3.1 → Task 7 (`LauncherKind`) and Task 11 (front half untouched). §3.2 → Task 11 (`ensureWorktree`) and Task 8 (no `prepareWorktree`). §3.3 → Task 8. §3.4 → Tasks 4, 7, 8. §3.5 → Task 7 (`t3ModesForPhase`, plus the never-full-access floor). §3.6 → Task 8 (thread title), Task 7 (`SpawnRecord.threadId`). §4.1 → Task 9. §4.2 → Task 9. §4.3 → unchanged by construction; Task 11 leaves `writeSpec` and the marker path intact for `wt`/`vscode` and Task 9's fallback test covers the T3-down case. §5 → Task 1 (gate) and Task 12. §6 → Tasks 3, 5, 6, 13. §7 → the test in every task; the degradation test is Task 6. §8 → Tasks 7 and 13.

**Deviation from the spec's file layout.** The spec estimated `t3-auth.ts` plus `t3.ts`. This plan uses a `src/orchestrator/t3/` directory of seven focused modules instead. Same total surface, smaller units, and each one testable on its own — `commands.ts` in particular is pure, which is what lets the payloads be checked against T3's schemas without a running server.

**Known gap, deliberately left.** `§5`'s project script is only pushed if Task 1 finds the preview panel works. Task 12 Step 5 states both branches explicitly rather than assuming the happy one.
