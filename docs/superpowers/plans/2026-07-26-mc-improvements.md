# MC Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop polling merged missions, add a per-mission token usage tracker from Claude Code transcripts, and give the plan a full-screen edit/preview editor.

**Architecture:** Feature 1 persists the observed PR state on the task record and short-circuits `gatherFacts` for merged tasks (zero git/GraphQL I/O). Feature 2 adds a pure `usage` module that reads Claude Code's session transcripts, attributes tokens to a mission by exact (normalized) worktree-path match, and exposes them via a lazy route the drawer calls on open. Feature 3 adds a plan read/write module behind a `PUT` route and a full-screen editor overlay in the drawer.

**Tech Stack:** TypeScript (tsx/ESM, `.ts` import specifiers), Fastify, React 19 + Vite, Vitest (node environment), zod. Runtime state under `%USERPROFILE%\.mc\`. Markdown rendering via `marked`.

## Global Constraints

- Zero footprint in the Acme checkout: everything MC writes lives under `mcHome()` (`~/.mc`) or reads from `~/.claude`. Never write into the target repo.
- ESM with explicit `.ts` import specifiers (match existing imports, e.g. `from './paths.ts'`).
- Tests run under Vitest with `environment: 'node'` — no DOM. Test pure logic and fs/module behavior; verify UI manually. Follow the temp-`MC_HOME` pattern from `test/state.test.ts`.
- Reconcile must stay pure (no I/O); all I/O stays in `gatherFacts` / dedicated modules.
- Path overrides for tests use env vars mirroring `MC_HOME` (`paths.ts`).
- Every commit message ends with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- Run `npm run typecheck` and `npm test` before each commit; both must pass.

---

## Task 1: Persist observed PR state on the task record

**Files:**
- Modify: `src/shared/types.ts` (add fields to `TaskRecord`)
- Modify: `src/orchestrator/poller.ts` (pure helper + persist in `reconcileAll`)
- Test: `test/poller-merge.test.ts` (create)

**Interfaces:**
- Consumes: `PrState` from `src/shared/types.ts` (`'OPEN' | 'MERGED' | 'CLOSED'`).
- Produces: `TaskRecord.prState: PrState | null`, `TaskRecord.mergedAt: string | null`; pure helper `mergedFields(task: TaskRecord, observed: PrState | null, now: string): { prState: PrState | null; mergedAt: string | null }`.

- [ ] **Step 1: Write the failing test**

Create `test/poller-merge.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { mergedFields } from '../src/orchestrator/poller.ts';
import type { TaskRecord } from '../src/shared/types.ts';

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    issue: 3130, title: 't', slug: 's', branch: 'b', worktreePath: null,
    prNumber: 1, prUrl: 'u', manualPhase: null, spawnHistory: [],
    lastReconciledAt: null, prState: null, mergedAt: null, ...overrides,
  };
}

describe('mergedFields', () => {
  test('records the observed state', () => {
    const r = mergedFields(task(), 'OPEN', '2026-07-26T00:00:00Z');
    expect(r.prState).toBe('OPEN');
    expect(r.mergedAt).toBeNull();
  });

  test('stamps mergedAt the first time MERGED is seen', () => {
    const r = mergedFields(task(), 'MERGED', '2026-07-26T00:00:00Z');
    expect(r.prState).toBe('MERGED');
    expect(r.mergedAt).toBe('2026-07-26T00:00:00Z');
  });

  test('does not overwrite an existing mergedAt', () => {
    const r = mergedFields(
      task({ prState: 'MERGED', mergedAt: '2026-07-01T00:00:00Z' }),
      'MERGED', '2026-07-26T00:00:00Z',
    );
    expect(r.mergedAt).toBe('2026-07-01T00:00:00Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/poller-merge.test.ts`
Expected: FAIL — `mergedFields` is not exported / `prState` not on `TaskRecord`.

- [ ] **Step 3: Add the type fields**

In `src/shared/types.ts`, add to `TaskRecord` (after `prUrl`):

```ts
  /** Last observed PR state; persisted so merged tasks can be frozen. */
  prState?: PrState | null;
  /** ISO time merge was first observed; enables the done-freeze. */
  mergedAt?: string | null;
```

(Optional on the interface so existing state.json records without them still load.)

- [ ] **Step 4: Implement the helper and wire persistence**

In `src/orchestrator/poller.ts`, add near the top (after imports):

```ts
/**
 * The prState/mergedAt to persist given a freshly observed PR state. mergedAt is
 * stamped once, on the first MERGED observation, and never overwritten — merge
 * is terminal, so the first sighting is the truth we freeze on.
 */
export function mergedFields(
  task: TaskRecord,
  observed: PrState | null,
  now: string,
): { prState: PrState | null; mergedAt: string | null } {
  const mergedAt =
    observed === 'MERGED' ? (task.mergedAt ?? now) : (task.mergedAt ?? null);
  return { prState: observed, mergedAt };
}
```

Add `PrState` to the type import from `../shared/types.ts`.

In `reconcileAll`, extend the `updated` object and the dirty check. Replace the `const updated = {...}` block and the `if (...)` dirty check with:

```ts
        const now = new Date().toISOString();
        const merged = mergedFields(task, facts.pr.state, now);
        const updated = {
          ...task,
          prNumber: facts.pr.number,
          prUrl: facts.pr.url,
          prState: merged.prState,
          mergedAt: merged.mergedAt,
          lastReconciledAt: now,
        };
        if (
          task.prNumber !== updated.prNumber ||
          task.prUrl !== updated.prUrl ||
          task.prState !== updated.prState ||
          task.mergedAt !== updated.mergedAt ||
          task.lastReconciledAt === null
        ) {
          const index = state.tasks.findIndex((t) => t.issue === task.issue);
          if (index !== -1) state.tasks[index] = updated;
          dirty = true;
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/poller-merge.test.ts` → PASS
Run: `npm run typecheck` → no errors

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/orchestrator/poller.ts test/poller-merge.test.ts
git commit -m "Persist observed PR state on the task record"
```

---

## Task 2: Freeze merged missions — short-circuit gatherFacts

**Files:**
- Modify: `src/orchestrator/facts.ts` (early return for merged records)
- Test: `test/facts-frozen.test.ts` (create)

**Interfaces:**
- Consumes: `TaskRecord.prState` (Task 1); existing `gatherFacts(config, task, branches)` signature is unchanged.
- Produces: no new exports — behavioral change only. A merged task yields `Facts` with `pr.state === 'MERGED'` and triggers no git/GraphQL calls.

- [ ] **Step 1: Write the failing test**

Create `test/facts-frozen.test.ts`. It mocks the two I/O modules and asserts neither is touched for a merged task:

```ts
import { describe, expect, test, vi, beforeEach } from 'vitest';

const fetchBranchPr = vi.fn();
const gatherGitFacts = vi.fn();

vi.mock('../src/orchestrator/github.ts', () => ({
  fetchBranchPr: (...a: unknown[]) => fetchBranchPr(...a),
}));
vi.mock('../src/orchestrator/worktree.ts', () => ({
  gatherGitFacts: (...a: unknown[]) => gatherGitFacts(...a),
  worktreeExists: () => true,
}));

import { gatherFacts } from '../src/orchestrator/facts.ts';
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

beforeEach(() => {
  fetchBranchPr.mockReset();
  gatherGitFacts.mockReset();
});

describe('gatherFacts — merged freeze', () => {
  test('a merged task makes no git or GraphQL calls', async () => {
    const facts = await gatherFacts(config, task(), new Set(['b']));
    expect(fetchBranchPr).not.toHaveBeenCalled();
    expect(gatherGitFacts).not.toHaveBeenCalled();
    expect(facts.pr.state).toBe('MERGED');
    expect(facts.pr.number).toBe(42);
    expect(facts.pr.exists).toBe(true);
  });

  test('a non-merged task still queries', async () => {
    fetchBranchPr.mockResolvedValue({
      pr: { exists: true, number: 42, url: 'u', state: 'OPEN' },
      checks: 'success',
      review: { decision: 'NONE', unresolvedThreads: 0, copilotUnresolved: 0 },
    });
    gatherGitFacts.mockResolvedValue({
      dirtyFileCount: 0, unpushedCommits: 0, hasPushedCommits: true,
    });
    await gatherFacts(config, task({ prState: 'OPEN', mergedAt: null }), new Set(['b']));
    expect(fetchBranchPr).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/facts-frozen.test.ts`
Expected: FAIL — merged task still calls the fetchers (they get called / assertions fail).

- [ ] **Step 3: Implement the short-circuit**

In `src/orchestrator/facts.ts`, add this block immediately after building the base `facts` object (after the `const facts: Facts = {...}` literal, before `const hasBranch = ...`):

```ts
  // A merged PR is terminal: freeze the mission from the cached record and spend
  // no git or GraphQL calls re-learning a fact that can never change.
  if (task.prState === 'MERGED') {
    facts.branchExists = branches.has(task.branch);
    facts.pr = {
      exists: true,
      number: task.prNumber,
      url: task.prUrl,
      state: 'MERGED',
    };
    return facts;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/facts-frozen.test.ts` → PASS
Run: `npx vitest run test/reconcile.test.ts` → still PASS (merged→done already covered)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/facts.ts test/facts-frozen.test.ts
git commit -m "Freeze merged missions: skip all I/O in gatherFacts"
```

---

## Task 3: Token usage module (pure parser + fs reader)

**Files:**
- Modify: `src/orchestrator/paths.ts` (add `claudeProjectsDir()`)
- Create: `src/orchestrator/usage.ts`
- Test: `test/usage.test.ts` (create)

**Interfaces:**
- Consumes: `worktreePath(issue)` from `paths.ts`.
- Produces:
  - `claudeProjectsDir(): string` (paths.ts)
  - `samePath(a: string, b: string): boolean`
  - `parseSessionFile(content: string, sessionId: string, targetCwd: string): SessionUsage | null`
  - `missionUsage(issue: number): MissionUsage`
  - Types `TokenTotals`, `SessionUsage`, `MissionUsage` (exported).

```ts
export interface TokenTotals { input: number; output: number; cacheCreate: number; cacheRead: number; total: number; }
export interface SessionUsage { sessionId: string; tokens: TokenTotals; models: string[]; startedAt: string; endedAt: string; }
export interface MissionUsage { total: TokenTotals; sessions: SessionUsage[]; tracked: boolean; }
```

- [ ] **Step 1: Add the paths helper**

In `src/orchestrator/paths.ts`, add:

```ts
/** Where Claude Code writes per-session transcripts. */
export function claudeProjectsDir(): string {
  return process.env.MC_CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects');
}
```

- [ ] **Step 2: Write the failing test**

Create `test/usage.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { samePath, parseSessionFile, missionUsage } from '../src/orchestrator/usage.ts';
import { worktreePath } from '../src/orchestrator/paths.ts';

function line(obj: unknown): string { return JSON.stringify(obj); }
function asst(cwd: string, usage: Record<string, number>, ts: string, model = 'claude-opus-4-8') {
  return line({ type: 'assistant', cwd, timestamp: ts, sessionId: 'sess', message: { model, usage } });
}

describe('samePath', () => {
  test('ignores drive-letter case and separator style', () => {
    expect(samePath('C:\\Users\\o\\wt', 'c:/users/o/wt')).toBe(true);
    expect(samePath('C:\\a', 'C:\\b')).toBe(false);
  });
});

describe('parseSessionFile', () => {
  const cwd = 'c:\\Users\\o\\.mc\\worktrees\\issue-1';
  test('sums the four usage fields for matching-cwd assistant lines', () => {
    const content = [
      asst(cwd, { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }, '2026-07-26T00:00:00Z'),
      asst(cwd, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T00:05:00Z'),
    ].join('\n');
    const s = parseSessionFile(content, 'sess', cwd)!;
    expect(s.tokens).toEqual({ input: 3, output: 6, cacheCreate: 10, cacheRead: 20, total: 39 });
    expect(s.startedAt).toBe('2026-07-26T00:00:00Z');
    expect(s.endedAt).toBe('2026-07-26T00:05:00Z');
    expect(s.models).toEqual(['claude-opus-4-8']);
  });

  test('excludes lines whose cwd differs', () => {
    const content = [
      asst(cwd, { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T00:00:00Z'),
      asst('c:\\somewhere\\else', { input_tokens: 99, output_tokens: 99, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T00:01:00Z'),
    ].join('\n');
    const s = parseSessionFile(content, 'sess', cwd)!;
    expect(s.tokens.total).toBe(10);
  });

  test('returns null when no line matches', () => {
    expect(parseSessionFile(asst('c:\\other', {}, 't'), 'sess', cwd)).toBeNull();
  });
});

describe('missionUsage', () => {
  let projects: string;
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'mc-proj-'));
    process.env.MC_CLAUDE_PROJECTS = projects;
    process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-home-'));
  });
  afterEach(() => {
    delete process.env.MC_CLAUDE_PROJECTS;
    delete process.env.MC_HOME;
    rmSync(projects, { recursive: true, force: true });
  });

  test('rolls all sessions for a worktree into a mission total', () => {
    const cwd = worktreePath(1); // uses MC_HOME
    const folder = join(projects, 'issue-1-folder');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'a.jsonl'), asst(cwd, { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, '2026-07-26T00:00:00Z'));
    writeFileSync(join(folder, 'b.jsonl'), asst(cwd, { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T01:00:00Z'));
    const u = missionUsage(1);
    expect(u.tracked).toBe(true);
    expect(u.sessions).toHaveLength(2);
    expect(u.total.total).toBe(20);
  });

  test('reports untracked when nothing matches', () => {
    expect(missionUsage(999).tracked).toBe(false);
    expect(missionUsage(999).total.total).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/usage.test.ts`
Expected: FAIL — `usage.ts` does not exist.

- [ ] **Step 4: Implement `src/orchestrator/usage.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeProjectsDir, worktreePath } from './paths.ts';

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
}
export interface SessionUsage {
  sessionId: string;
  tokens: TokenTotals;
  models: string[];
  startedAt: string;
  endedAt: string;
}
export interface MissionUsage {
  total: TokenTotals;
  sessions: SessionUsage[];
  tracked: boolean;
}

const ZERO: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };

/** Case- and separator-insensitive path equality (Windows transcript cwd). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function addUsage(acc: TokenTotals, u: Record<string, unknown>): TokenTotals {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const input = acc.input + n(u.input_tokens);
  const output = acc.output + n(u.output_tokens);
  const cacheCreate = acc.cacheCreate + n(u.cache_creation_input_tokens);
  const cacheRead = acc.cacheRead + n(u.cache_read_input_tokens);
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead };
}

/**
 * Sum the usage of one transcript file, counting only assistant lines whose cwd
 * matches the mission's worktree. Returns null if nothing matched.
 */
export function parseSessionFile(
  content: string,
  sessionId: string,
  targetCwd: string,
): SessionUsage | null {
  let tokens = { ...ZERO };
  const models = new Set<string>();
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let matched = false;

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // a truncated tail line is not a reason to lose the session
    }
    if (line?.type !== 'assistant') continue;
    if (typeof line.cwd !== 'string' || !samePath(line.cwd, targetCwd)) continue;
    const usage = line.message?.usage;
    if (!usage) continue;

    matched = true;
    tokens = addUsage(tokens, usage);
    if (typeof line.message?.model === 'string') models.add(line.message.model);
    const ts = typeof line.timestamp === 'string' ? line.timestamp : null;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }
  }

  if (!matched) return null;
  return {
    sessionId,
    tokens,
    models: [...models],
    startedAt: startedAt ?? '',
    endedAt: endedAt ?? '',
  };
}

/** All Claude Code sessions attributable to a mission's worktree. */
export function missionUsage(issue: number): MissionUsage {
  const targetCwd = worktreePath(issue);
  const root = claudeProjectsDir();
  const sessions: SessionUsage[] = [];

  if (existsSync(root)) {
    // Prefilter by folder name for speed; the per-line cwd check is what makes
    // attribution correct, so a false-positive folder is harmless.
    const wanted = `issue-${issue}`;
    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || !folder.name.includes(wanted)) continue;
      const dir = join(root, folder.name);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace(/\.jsonl$/, '');
        const parsed = parseSessionFile(readFileSync(join(dir, file), 'utf8'), sessionId, targetCwd);
        if (parsed) sessions.push(parsed);
      }
    }
  }

  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const total = sessions.reduce<TokenTotals>((acc, s) => addUsage(acc, {
    input_tokens: s.tokens.input,
    output_tokens: s.tokens.output,
    cache_creation_input_tokens: s.tokens.cacheCreate,
    cache_read_input_tokens: s.tokens.cacheRead,
  }), { ...ZERO });

  return { total, sessions, tracked: sessions.length > 0 };
}
```

Note: the plan's spec mentioned an mtime cache; it is omitted here because `missionUsage` runs lazily per drawer-open (not per poll), and a personal board's transcript volume is small. If a drawer-open ever feels slow, add a `(path, mtime, size)` memo around `parseSessionFile` — the interface does not change.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/usage.test.ts` → PASS
Run: `npm run typecheck` → no errors

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/paths.ts src/orchestrator/usage.ts test/usage.test.ts
git commit -m "Add token usage module reading Claude Code transcripts"
```

---

## Task 4: Usage route, API client, and drawer UI

**Files:**
- Modify: `src/server/routes.ts` (add `GET /api/tasks/:issue/usage`)
- Modify: `src/web/api.ts` (add `usage` client + exported types)
- Modify: `src/web/components/Drawer.tsx` (usage-aware Sessions section)
- Modify: `src/web/styles.css` (usage rows — optional, reuse existing classes if adequate)

**Interfaces:**
- Consumes: `missionUsage(issue)` and `MissionUsage` from `usage.ts` (Task 3); `getTask` from `state.ts`.
- Produces: `api.usage(issue: number): Promise<MissionUsage>` and re-exported `MissionUsage`, `SessionUsage`, `TokenTotals` types on the client.

- [ ] **Step 1: Add the route**

In `src/server/routes.ts`, import at top:

```ts
import { missionUsage } from '../orchestrator/usage.ts';
```

Add near the plan route:

```ts
  app.get<{ Params: { issue: string } }>('/api/tasks/:issue/usage', async (req, reply) => {
    const issue = Number(req.params.issue);
    if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
    return missionUsage(issue);
  });
```

- [ ] **Step 2: Add the API client method**

In `src/web/api.ts`, add the type re-export near the existing one (line ~10):

```ts
export type { MissionUsage, SessionUsage, TokenTotals } from '../orchestrator/usage.ts';
```

Add to the `api` object (after `plan`):

```ts
  usage: (issue: number) =>
    request<import('../orchestrator/usage.ts').MissionUsage>(`/api/tasks/${issue}/usage`),
```

- [ ] **Step 3: Wire usage into the Drawer**

In `src/web/components/Drawer.tsx`:

Add state near the other `useState` calls:

```ts
  const [usage, setUsage] = useState<import('../api.ts').MissionUsage | null>(null);
```

In the task-switch `useEffect` (the one keyed on `[task.issue]`), add alongside the `api.plan(...)` fetch:

```ts
    setUsage(null);
    api
      .usage(task.issue)
      .then(setUsage)
      .catch(() => setUsage(null));
```

Replace the existing Sessions `<section>` (the `task.spawnHistory.length > 0` block) with a usage-aware version:

```tsx
        <section className="section">
          <div className="section-label">Sessions &amp; usage</div>
          {usage && usage.tracked ? (
            <>
              <div className="usage-total">
                <strong>{fmtTokens(usage.total.total)}</strong> tokens
                <span className="usage-breakdown">
                  {' '}· in {fmtTokens(usage.total.input)} · out {fmtTokens(usage.total.output)} ·
                  cache {fmtTokens(usage.total.cacheCreate + usage.total.cacheRead)}
                </span>
              </div>
              <div className="history">
                {usage.sessions.map((s) => (
                  <div key={s.sessionId}>
                    {s.startedAt ? new Date(s.startedAt).toLocaleString() : 'session'} ·{' '}
                    {s.models.join(', ') || 'claude'} · {fmtTokens(s.tokens.total)} tok
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="note">
              {usage
                ? 'Usage not tracked for this agent (only Claude Code sessions are counted).'
                : 'Loading usage…'}
            </p>
          )}
          {task.spawnHistory.length > 0 && (
            <div className="history" style={{ marginTop: 8 }}>
              {[...task.spawnHistory].reverse().map((s, i) => (
                <div key={`${s.startedAt}-${i}`}>
                  spawn: {new Date(s.startedAt).toLocaleString()} · {s.phase} · {s.agent}
                </div>
              ))}
            </div>
          )}
        </section>
```

Add a `fmtTokens` helper at module scope (below `EMPTY`):

```ts
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 4: Optional styles**

If the total needs emphasis, add to `src/web/styles.css`:

```css
.usage-total { font-size: 13px; margin-bottom: 8px; }
.usage-breakdown { color: var(--muted, #888); font-size: 12px; }
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → no errors
Run: `npm test` → all PASS (no test regressions)
Manual: `npm run dev`, open a mission that has run Claude sessions, confirm the drawer shows total + per-session token lines; open a never-run mission → "Loading…" then untracked/empty note.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes.ts src/web/api.ts src/web/components/Drawer.tsx src/web/styles.css
git commit -m "Surface per-mission token usage in the drawer"
```

---

## Task 5: Plan read/write module and PUT route

**Files:**
- Create: `src/orchestrator/plan.ts` (readPlan/writePlan)
- Modify: `src/server/routes.ts` (add `PUT /api/tasks/:issue/plan`; reuse module for the GET too)
- Modify: `src/web/api.ts` (add `savePlan`)
- Test: `test/plan.test.ts` (create)

**Interfaces:**
- Consumes: `planPath(issue)`, `taskDir(issue)` from `paths.ts`.
- Produces:
  - `readPlan(issue: number): string | null`
  - `writePlan(issue: number, content: string): void`
  - `api.savePlan(issue: number, content: string): Promise<{ ok: true }>`

- [ ] **Step 1: Write the failing test**

Create `test/plan.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPlan, writePlan } from '../src/orchestrator/plan.ts';

beforeEach(() => { process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-plan-')); });
afterEach(() => {
  rmSync(process.env.MC_HOME!, { recursive: true, force: true });
  delete process.env.MC_HOME;
});

describe('plan read/write', () => {
  test('reading a plan that does not exist yields null', () => {
    expect(readPlan(1)).toBeNull();
  });

  test('writePlan creates the task dir and file, and round-trips', () => {
    writePlan(1, '# Plan\n- step one\n');
    expect(readPlan(1)).toBe('# Plan\n- step one\n');
  });

  test('writePlan overwrites existing content', () => {
    writePlan(1, 'first');
    writePlan(1, 'second');
    expect(readPlan(1)).toBe('second');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/plan.test.ts`
Expected: FAIL — `plan.ts` does not exist.

- [ ] **Step 3: Implement `src/orchestrator/plan.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { planPath, taskDir } from './paths.ts';

/** The plan.md a mission carries, or null if none has been written yet. */
export function readPlan(issue: number): string | null {
  const file = planPath(issue);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Write the plan, creating the task directory if this mission has none yet. */
export function writePlan(issue: number, content: string): void {
  mkdirSync(taskDir(issue), { recursive: true });
  writeFileSync(planPath(issue), content, 'utf8');
}
```

- [ ] **Step 4: Wire the routes**

In `src/server/routes.ts`, import:

```ts
import { readPlan, writePlan } from '../orchestrator/plan.ts';
```

Replace the existing GET `/api/tasks/:issue/plan` handler body to use `readPlan` (keeps behavior, removes the direct fs import usage):

```ts
  app.get<{ Params: { issue: string } }>('/api/tasks/:issue/plan', async (req, reply) => {
    const content = readPlan(Number(req.params.issue));
    if (content === null) return reply.code(404).send({ error: 'no plan attached yet' });
    return { content };
  });
```

Add the PUT handler right after it:

```ts
  app.put<{ Params: { issue: string }; Body: { content?: string } }>(
    '/api/tasks/:issue/plan',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      if (typeof req.body?.content !== 'string') {
        return reply.code(400).send({ error: 'content must be a string' });
      }
      writePlan(issue, req.body.content);
      return { ok: true };
    },
  );
```

If `existsSync`/`readFileSync`/`planPath` are now unused in `routes.ts`, remove those imports to keep typecheck clean.

- [ ] **Step 5: Add the API client method**

In `src/web/api.ts`, add to the `api` object (after `plan`):

```ts
  savePlan: (issue: number, content: string) =>
    request<{ ok: true }>(`/api/tasks/${issue}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/plan.test.ts` → PASS
Run: `npm run typecheck` → no errors
Run: `npm test` → all PASS

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/plan.ts src/server/routes.ts src/web/api.ts test/plan.test.ts
git commit -m "Add plan write route and read/write module"
```

---

## Task 6: Full-screen plan editor overlay

**Files:**
- Modify: `package.json` (add `marked` dependency)
- Create: `src/web/components/PlanEditor.tsx`
- Modify: `src/web/components/Drawer.tsx` (Expand button + mount editor, refresh plan on save)
- Modify: `src/web/styles.css` (overlay styles)

**Interfaces:**
- Consumes: `api.savePlan`, `api.plan` (Task 5); `marked` for rendering.
- Produces: `PlanEditor` component:

```ts
interface PlanEditorProps {
  issue: number;
  initial: string;
  onClose: () => void;
  onSaved: (content: string) => void;
}
```

- [ ] **Step 1: Add the dependency**

Run: `npm install marked`
Confirm `marked` appears under `dependencies` in `package.json`. (marked ships its own types; no `@types` needed.)

- [ ] **Step 2: Create `src/web/components/PlanEditor.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { marked } from 'marked';

import { api } from '../api.ts';

interface PlanEditorProps {
  issue: number;
  initial: string;
  onClose: () => void;
  onSaved: (content: string) => void;
}

/**
 * Full-screen plan editor with an edit/preview toggle.
 *
 * Content is locally-authored and trusted (single-user local tool), so the
 * rendered Markdown is injected directly into the preview pane.
 */
export function PlanEditor({ issue, initial, onClose, onSaved }: PlanEditorProps) {
  const [text, setText] = useState(initial);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = text !== initial;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') attemptClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  function attemptClose() {
    if (dirty && !window.confirm('Discard unsaved plan changes?')) return;
    onClose();
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.savePlan(issue, text);
      onSaved(text);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="plan-editor-scrim" role="dialog" aria-label={`Edit plan for #${issue}`}>
      <div className="plan-editor">
        <header className="plan-editor-head">
          <strong>Plan · #{issue}</strong>
          <div className="plan-editor-tabs">
            <button
              className={`btn is-sm${mode === 'edit' ? ' is-primary' : ''}`}
              onClick={() => setMode('edit')}
            >
              Edit
            </button>
            <button
              className={`btn is-sm${mode === 'preview' ? ' is-primary' : ''}`}
              onClick={() => setMode('preview')}
            >
              Preview
            </button>
          </div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn is-sm is-primary" disabled={saving || !dirty} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn is-sm is-ghost" onClick={attemptClose}>
              Close
            </button>
          </span>
        </header>
        {error && <p className="error" style={{ margin: '8px 16px' }}>{error}</p>}
        <div className="plan-editor-body">
          {mode === 'edit' ? (
            <textarea
              className="plan-editor-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          ) : (
            <div
              className="plan-editor-preview"
              dangerouslySetInnerHTML={{ __html: marked.parse(text) as string }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount it from the Drawer**

In `src/web/components/Drawer.tsx`:

Add import:

```ts
import { PlanEditor } from './PlanEditor.tsx';
```

Add state near the others:

```ts
  const [editingPlan, setEditingPlan] = useState(false);
```

Replace the existing Plan `<section>` with one that has an Expand affordance:

```tsx
        <section className="section">
          <div className="section-label">
            Plan
            <button
              className="disclose"
              style={{ marginLeft: 8 }}
              onClick={() => setEditingPlan(true)}
            >
              {plan ? 'Expand / edit' : 'Write a plan'}
            </button>
          </div>
          {plan ? (
            <pre className="plan">{plan}</pre>
          ) : (
            <p className="note">
              No plan attached. Run Plan to have an agent write one, or write one yourself.
            </p>
          )}
        </section>
```

Mount the editor before the closing `</aside>`'s sibling `</>` (i.e. after the last `</section>`, still inside the fragment):

```tsx
      {editingPlan && (
        <PlanEditor
          issue={task.issue}
          initial={plan ?? ''}
          onClose={() => setEditingPlan(false)}
          onSaved={(content) => {
            setPlan(content);
            onChanged();
          }}
        />
      )}
```

Reset it on task switch — in the `[task.issue]` effect add `setEditingPlan(false);`.

- [ ] **Step 4: Add overlay styles**

In `src/web/styles.css`:

```css
.plan-editor-scrim {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: stretch; justify-content: center;
  padding: 3vh 3vw;
}
.plan-editor {
  background: var(--panel, #1e1e1e); color: inherit;
  border-radius: 10px; width: 100%; max-width: 1000px;
  display: flex; flex-direction: column; overflow: hidden;
}
.plan-editor-head {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--border, #333);
}
.plan-editor-tabs { display: flex; gap: 6px; }
.plan-editor-body { flex: 1; min-height: 0; display: flex; }
.plan-editor-text {
  flex: 1; resize: none; border: none; outline: none;
  padding: 16px; font-family: ui-monospace, monospace; font-size: 13px;
  line-height: 1.5; background: transparent; color: inherit;
}
.plan-editor-preview { flex: 1; padding: 16px 24px; overflow: auto; }
.plan-editor-preview h1, .plan-editor-preview h2, .plan-editor-preview h3 { margin: 0.6em 0 0.3em; }
.plan-editor-preview pre { background: rgba(127,127,127,0.15); padding: 10px; border-radius: 6px; overflow: auto; }
.plan-editor-preview code { font-family: ui-monospace, monospace; }
```

Match the actual CSS variable names already used in `styles.css`; adjust `--panel`/`--border`/`--muted` to whatever the file defines.

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → no errors
Run: `npm test` → all PASS
Run: `npm run build` → succeeds (marked bundles cleanly)
Manual: `npm run dev`, open a mission, click Expand/edit → overlay opens; toggle Edit/Preview renders Markdown; edit + Save persists (reopen shows new content, `plan-ready` badge appears if it was empty before); Close with unsaved changes prompts.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/web/components/PlanEditor.tsx src/web/components/Drawer.tsx src/web/styles.css
git commit -m "Add full-screen plan editor with edit/preview"
```

---

## Final verification

- [ ] `npm run typecheck` clean
- [ ] `npm test` — all pass (existing + `poller-merge`, `facts-frozen`, `usage`, `plan`)
- [ ] `npm run build` succeeds
- [ ] Manual smoke: merged mission stops polling (watch rate-limit chip / logs); usage shows on a Claude-run mission; plan editor round-trips.
- [ ] Update memory notes if any environment facts changed.

## Self-review notes

- Spec coverage: Feature 1 → Tasks 1–2; Feature 2 → Tasks 3–4; Feature 3 → Tasks 5–6. All spec sections covered.
- Deviation from spec: the usage `(path, mtime, size)` cache is deferred (documented in Task 3, Step 4) because usage is computed lazily on drawer-open, not per poll — the performance concern the cache addressed does not arise. No interface impact.
- Board-wide usage total and dollar cost remain non-goals, per spec.
