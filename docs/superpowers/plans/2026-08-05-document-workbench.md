# Document Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plan-only editor with one workbench that reads and edits plan.md plus every captured artifact, at a usable width and a user-controlled font size.

**Architecture:** A pure orchestrator module (`documents.ts`) owns classification and write-target resolution; two Fastify routes expose it; a pure web module (`doc-model.ts`) owns list-building, clamping and dirty-tracking; three React files render it. Every decision that can be tested without a DOM lives in a `.ts` module, because this repo has no DOM test environment.

**Tech Stack:** TypeScript (ESM, `.ts` extensions in imports), Fastify 5, React 19, Vite 7, Vitest 3 (node environment), `marked` 18.

**Spec:** `docs/superpowers/specs/2026-08-05-document-workbench-design.md`

## Global Constraints

- **Import specifier extensions are mandatory.** This repo runs `.ts` sources directly via `tsx`; every relative import ends in `.ts` or `.tsx` (e.g. `import { readArtifacts } from './artifacts.ts';`). Omitting it breaks the server at runtime, not at typecheck.
- **Test environment is `node`, include glob is `test/**/*.test.ts`** (`vite.config.ts:22-27`). There is no `@testing-library/react` and no jsdom. **Do not add one.** React components are verified by `npm run typecheck` and manual smoke; all logic worth asserting goes in plain `.ts` modules under `src/web/`.
- **Tests isolate via `process.env.MC_HOME`** pointed at a `mkdtempSync` directory, deleted in `afterEach`. All MC paths derive from it (`paths.ts:14-16`).
- **Size cap is exactly `2 * 1024 * 1024` bytes.** Binary sniff window is exactly the first `8192` bytes.
- **Font scale bounds are exactly 11–24px, default 13px.** Split ratio bounds are exactly 0.2–0.8, default 0.5.
- **Modal geometry:** `width: 96vw; max-width: 1600px; height: 94vh`. Preview prose measure: `78ch`.
- **localStorage keys are exactly** `mc.doc.fontPx`, `mc.doc.mode`, `mc.doc.split`.
- **CSS uses existing custom properties only** — `--bg`, `--bg-soft`, `--card`, `--card-hi`, `--line`, `--line-soft`, `--ink`, `--ink-strong`, `--dim`, `--dimmer`, `--live`, `--attention`, `--mono`, `--sans`, `--radius`, `--radius-sm`. Do not introduce new colours.
- **Commit after every task.** Run `npm test && npm run typecheck` before each commit.

---

### Task 1: Document classification and write-target resolution (pure)

The decision core, with no filesystem access, so it can be tested exhaustively.

**Files:**
- Create: `src/orchestrator/documents.ts`
- Test: `test/documents.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef` from `src/shared/types.ts` (`{ name, storedPath, origin: 'taskdir'|'repo', originalPath }`)
- Produces:
  - `type ContentClass = 'markdown' | 'text' | 'binary'`
  - `type WriteTarget = 'original' | 'snapshot'`
  - `const MAX_DOCUMENT_BYTES: number`
  - `function extensionOf(name: string): string`
  - `function classify(name: string, bytes: Buffer): ContentClass`
  - `function resolveWriteTarget(ref: ArtifactRef, fileExists: (path: string) => boolean): WriteTarget`

- [ ] **Step 1: Write the failing test**

Create `test/documents.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import {
  classify,
  extensionOf,
  resolveWriteTarget,
  MAX_DOCUMENT_BYTES,
} from '../src/orchestrator/documents.ts';
import type { ArtifactRef } from '../src/shared/types.ts';

describe('extensionOf', () => {
  test('lowercases and includes the dot', () => {
    expect(extensionOf('DESIGN.MD')).toBe('.md');
  });
  test('is empty for a name with no dot', () => {
    expect(extensionOf('NOTES')).toBe('');
  });
  test('treats a leading-dot name as its own extension, not as markdown', () => {
    expect(extensionOf('.gitignore')).toBe('.gitignore');
  });
  test('uses the basename, so a dotted directory does not leak in', () => {
    expect(extensionOf('docs.v2/plan')).toBe('');
  });
});

describe('classify', () => {
  const text = (s: string) => Buffer.from(s, 'utf8');

  test('markdown by extension', () => {
    expect(classify('design.md', text('# hi'))).toBe('markdown');
    expect(classify('design.markdown', text('# hi'))).toBe('markdown');
  });
  test('markdown when there is no extension at all', () => {
    expect(classify('NOTES', text('# hi'))).toBe('markdown');
  });
  test('other text extensions are text, not markdown', () => {
    expect(classify('data.json', text('{}'))).toBe('text');
    expect(classify('helper.ts', text('export {}'))).toBe('text');
  });
  test('a NUL byte anywhere in the sniff window means binary', () => {
    expect(classify('notes.md', Buffer.from([0x23, 0x00, 0x41]))).toBe('binary');
  });
  test('a NUL past the sniff window is not consulted', () => {
    const bytes = Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]);
    expect(classify('big.txt', bytes)).toBe('text');
  });
  test('the cap is two megabytes', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('resolveWriteTarget', () => {
  const ref = (origin: 'taskdir' | 'repo'): ArtifactRef => ({
    name: 'design.md',
    storedPath: 'artifacts/design.md',
    origin,
    originalPath: 'C:\\wt\\docs\\design.md',
  });

  test('writes the original when it still resolves', () => {
    expect(resolveWriteTarget(ref('repo'), () => true)).toBe('original');
  });
  test('falls back to the snapshot when the original is gone', () => {
    expect(resolveWriteTarget(ref('repo'), () => false)).toBe('snapshot');
  });
  test('origin does not enter the decision', () => {
    expect(resolveWriteTarget(ref('taskdir'), () => true)).toBe('original');
    expect(resolveWriteTarget(ref('taskdir'), () => false)).toBe('snapshot');
  });
  test('probes exactly the recorded original path', () => {
    const seen: string[] = [];
    resolveWriteTarget(ref('repo'), (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual(['C:\\wt\\docs\\design.md']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/documents.test.ts`
Expected: FAIL — `Failed to load ../src/orchestrator/documents.ts` (the module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/orchestrator/documents.ts`:

```ts
import type { ArtifactRef } from '../shared/types.ts';

/**
 * What a captured document is, and which copy of it is the truth.
 *
 * Artifact names are whatever the planning agent happened to write, so nothing
 * here may assume `.md` — classification is by extension plus a byte sniff, and
 * the write target is decided by which path still resolves, never by `origin`.
 */

export type ContentClass = 'markdown' | 'text' | 'binary';
export type WriteTarget = 'original' | 'snapshot';

/** Refuse to ship more than this into a textarea. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** How many leading bytes the binary sniff looks at. */
const SNIFF_BYTES = 8192;

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * The lowercased extension of `name`, dot included, or '' when it has none.
 * A leading-dot name (`.gitignore`) is its own extension, which keeps such
 * files out of the "no extension, assume markdown" bucket.
 */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

/** Binary beats everything; then markdown by extension or by having none. */
export function classify(name: string, bytes: Buffer): ContentClass {
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return 'binary';
  const ext = extensionOf(name);
  return ext === '' || MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'text';
}

/**
 * Which copy a read or write should address.
 *
 * `origin` is deliberately ignored: a 'taskdir' artifact's original and its
 * stored snapshot are two distinct files too, so the only question that matters
 * is whether the recorded original still exists.
 */
export function resolveWriteTarget(
  ref: ArtifactRef,
  fileExists: (path: string) => boolean,
): WriteTarget {
  return fileExists(ref.originalPath) ? 'original' : 'snapshot';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/documents.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/documents.ts test/documents.test.ts
git commit -m "feat: classify captured documents and resolve their write target"
```

---

### Task 2: Filesystem read and write with snapshot resync

Wraps the Task 1 core in the actual disk work, returning a result union rather than throwing, so the route layer maps errors to statuses without a try/catch.

**Files:**
- Modify: `src/orchestrator/documents.ts` (append)
- Test: `test/documents.test.ts` (append)

**Interfaces:**
- Consumes: `readArtifacts`, `resolveArtifactStoredPath` from `src/orchestrator/artifacts.ts`; `classify`, `resolveWriteTarget`, `MAX_DOCUMENT_BYTES` from Task 1
- Produces:
  - `type DocumentError = 'not-found' | 'gone' | 'too-large' | 'binary'`
  - `type DocumentResult<T> = { ok: true; value: T } | { ok: false; error: DocumentError }`
  - `interface DocumentRead { content: string; class: 'markdown' | 'text'; writeTarget: WriteTarget; originalPath: string }`
  - `function readArtifactDocument(issue: number, name: string): DocumentResult<DocumentRead>`
  - `function writeArtifactDocument(issue: number, name: string, content: string): DocumentResult<WriteTarget>`

- [ ] **Step 1: Write the failing test**

Append to `test/documents.test.ts`:

```ts
import { afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readArtifactDocument, writeArtifactDocument } from '../src/orchestrator/documents.ts';
import { artifactsDir, artifactsManifestPath, taskDir } from '../src/orchestrator/paths.ts';

describe('readArtifactDocument / writeArtifactDocument', () => {
  const ISSUE = 77;
  let home: string;
  let originalDir: string;

  /** Seed a manifest plus the two copies an artifact normally has. */
  function seed(name: string, body: Buffer | string, opts: { original: boolean }) {
    mkdirSync(artifactsDir(ISSUE), { recursive: true });
    writeFileSync(join(artifactsDir(ISSUE), name), body);
    const originalPath = join(originalDir, name);
    if (opts.original) {
      mkdirSync(originalDir, { recursive: true });
      writeFileSync(originalPath, body);
    }
    writeFileSync(
      artifactsManifestPath(ISSUE),
      JSON.stringify({
        collectedAt: '2026-08-05T00:00:00.000Z',
        trigger: 'auto',
        artifacts: [
          { name, storedPath: `artifacts/${name}`, origin: 'repo', originalPath },
        ],
      }),
      'utf8',
    );
    return originalPath;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mc-docs-'));
    process.env.MC_HOME = home;
    originalDir = join(home, 'checkout', 'docs');
    mkdirSync(taskDir(ISSUE), { recursive: true });
  });

  afterEach(() => {
    delete process.env.MC_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('reads the original in preference to a stale snapshot', () => {
    const original = seed('design.md', '# stale\n', { original: true });
    writeFileSync(original, '# fresh\n');

    const result = readArtifactDocument(ISSUE, 'design.md');
    expect(result).toMatchObject({
      ok: true,
      value: { content: '# fresh\n', class: 'markdown', writeTarget: 'original' },
    });
  });

  test('falls back to the snapshot when the original is gone', () => {
    seed('design.md', '# snap\n', { original: false });

    const result = readArtifactDocument(ISSUE, 'design.md');
    expect(result).toMatchObject({
      ok: true,
      value: { content: '# snap\n', writeTarget: 'snapshot' },
    });
  });

  test('a name absent from the manifest is not-found, never a path probe', () => {
    seed('design.md', 'x', { original: true });
    expect(readArtifactDocument(ISSUE, '../../secret')).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  test('a manifest entry whose files have all vanished is gone', () => {
    seed('design.md', 'x', { original: false });
    rmSync(join(artifactsDir(ISSUE), 'design.md'));
    expect(readArtifactDocument(ISSUE, 'design.md')).toEqual({ ok: false, error: 'gone' });
  });

  test('a NUL-bearing artifact is binary', () => {
    seed('shot.png', Buffer.from([0x89, 0x50, 0x00, 0x0d]), { original: true });
    expect(readArtifactDocument(ISSUE, 'shot.png')).toEqual({ ok: false, error: 'binary' });
  });

  test('an oversized artifact is refused before it is read', () => {
    seed('huge.md', Buffer.alloc(2 * 1024 * 1024 + 1, 0x41), { original: true });
    expect(readArtifactDocument(ISSUE, 'huge.md')).toEqual({ ok: false, error: 'too-large' });
  });

  test('writing with a live original updates BOTH copies', () => {
    const original = seed('design.md', 'old\n', { original: true });

    expect(writeArtifactDocument(ISSUE, 'design.md', 'new\n')).toEqual({
      ok: true,
      value: 'original',
    });
    expect(readFileSync(original, 'utf8')).toBe('new\n');
    expect(readFileSync(join(artifactsDir(ISSUE), 'design.md'), 'utf8')).toBe('new\n');
  });

  test('writing with the original gone updates the snapshot and says so', () => {
    seed('design.md', 'old\n', { original: false });

    expect(writeArtifactDocument(ISSUE, 'design.md', 'new\n')).toEqual({
      ok: true,
      value: 'snapshot',
    });
    expect(readFileSync(join(artifactsDir(ISSUE), 'design.md'), 'utf8')).toBe('new\n');
  });

  test('writing an unknown name is not-found and touches nothing', () => {
    seed('design.md', 'old\n', { original: true });
    expect(writeArtifactDocument(ISSUE, 'nope.md', 'x')).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(readFileSync(join(artifactsDir(ISSUE), 'design.md'), 'utf8')).toBe('old\n');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/documents.test.ts`
Expected: FAIL — `readArtifactDocument is not a function` (or an import error naming it).

- [ ] **Step 3: Write the minimal implementation**

Append to `src/orchestrator/documents.ts` (and extend the top import line to `import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';` plus `import { dirname } from 'node:path';`):

```ts
import { readArtifacts, resolveArtifactStoredPath } from './artifacts.ts';

export type DocumentError = 'not-found' | 'gone' | 'too-large' | 'binary';

export type DocumentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DocumentError };

export interface DocumentRead {
  content: string;
  class: 'markdown' | 'text';
  writeTarget: WriteTarget;
  originalPath: string;
}

/** The manifest entry plus both candidate paths, or null when unknown. */
function locate(issue: number, name: string) {
  const refs = readArtifacts(issue);
  const ref = refs.find((r) => r.name === name);
  if (!ref) return null;
  const stored = resolveArtifactStoredPath(issue, name, refs);
  if (!stored) return null;
  const target = resolveWriteTarget(ref, existsSync);
  return { ref, stored, target, active: target === 'original' ? ref.originalPath : stored };
}

/**
 * Read the copy that is the truth. Reading the snapshot unconditionally would
 * show stale text whenever the file had been edited outside the board, and the
 * next save would then overwrite that edit.
 */
export function readArtifactDocument(
  issue: number,
  name: string,
): DocumentResult<DocumentRead> {
  const found = locate(issue, name);
  if (!found) return { ok: false, error: 'not-found' };
  if (!existsSync(found.active)) return { ok: false, error: 'gone' };
  if (statSync(found.active).size > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: 'too-large' };
  }

  const bytes = readFileSync(found.active);
  const contentClass = classify(name, bytes);
  if (contentClass === 'binary') return { ok: false, error: 'binary' };

  return {
    ok: true,
    value: {
      content: bytes.toString('utf8'),
      class: contentClass,
      writeTarget: found.target,
      originalPath: found.ref.originalPath,
    },
  };
}

/**
 * Write the truth, then resync the snapshot so the two never disagree. The
 * caller is told which happened so the UI can say "snapshot only" rather than
 * implying an edit reached a checkout it did not reach.
 */
export function writeArtifactDocument(
  issue: number,
  name: string,
  content: string,
): DocumentResult<WriteTarget> {
  const found = locate(issue, name);
  if (!found) return { ok: false, error: 'not-found' };

  if (found.target === 'original') {
    mkdirSync(dirname(found.ref.originalPath), { recursive: true });
    writeFileSync(found.ref.originalPath, content, 'utf8');
  }
  mkdirSync(dirname(found.stored), { recursive: true });
  writeFileSync(found.stored, content, 'utf8');

  return { ok: true, value: found.target };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/documents.test.ts && npm run typecheck`
Expected: PASS, 23 tests; typecheck clean.

- [ ] **Step 5: Confirm capture is untouched**

Run: `npx vitest run test/artifacts.test.ts test/plan.test.ts`
Expected: PASS. This plan adds surfaces; if either file goes red, something in `documents.ts` reached into capture and must be reverted.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/documents.ts test/documents.test.ts
git commit -m "feat: read and write captured documents with snapshot resync"
```

---

### Task 3: Artifact content routes

**Files:**
- Modify: `src/server/routes.ts` (imports at :1-24; new routes immediately after the existing artifact-open route at :299-313)
- Test: `test/server-documents.test.ts`

**Interfaces:**
- Consumes: `readArtifactDocument`, `writeArtifactDocument`, `DocumentError` from Task 2; `getTask` from `src/orchestrator/state.ts`
- Produces: `GET|PUT /api/tasks/:issue/artifacts/:name`

**Note on route collision:** the existing `POST /api/tasks/:issue/artifacts/:name/open` is a different method *and* a longer path. Adding `GET`/`PUT` at `/api/tasks/:issue/artifacts/:name` does not shadow it.

- [ ] **Step 1: Write the failing test**

Create `test/server-documents.test.ts`:

```ts
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHealthResponse } from '../src/server/health.ts';
import { registerRoutes } from '../src/server/routes.ts';
import { Broadcaster } from '../src/server/sse.ts';
import { artifactsDir, artifactsManifestPath, taskDir } from '../src/orchestrator/paths.ts';
import { saveState } from '../src/orchestrator/state.ts';
import type { Config } from '../src/shared/types.ts';

const config = {
  repo: { path: 'C:\\repo', owner: 'o', name: 'r', baseBranch: 'main', branchPrefix: 'ouriel/' },
  github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
  agents: {},
  pipeline: [],
  server: { port: 4317 },
} satisfies Config;

const ISSUE = 91;
let home: string;
let originalPath: string;

function app() {
  const instance = Fastify();
  registerRoutes(instance, {
    config,
    broadcaster: new Broadcaster(),
    refresh: async () => [],
    health: createHealthResponse('0.1.0', '2026-08-05T00:00:00.000Z'),
  });
  return instance;
}

function seedArtifact(name: string, body: Buffer | string, opts: { original: boolean }) {
  mkdirSync(artifactsDir(ISSUE), { recursive: true });
  writeFileSync(join(artifactsDir(ISSUE), name), body);
  originalPath = join(home, 'checkout', name);
  if (opts.original) {
    mkdirSync(join(home, 'checkout'), { recursive: true });
    writeFileSync(originalPath, body);
  }
  writeFileSync(
    artifactsManifestPath(ISSUE),
    JSON.stringify({
      collectedAt: '2026-08-05T00:00:00.000Z',
      trigger: 'auto',
      artifacts: [{ name, storedPath: `artifacts/${name}`, origin: 'repo', originalPath }],
    }),
    'utf8',
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-routes-'));
  process.env.MC_HOME = home;
  mkdirSync(taskDir(ISSUE), { recursive: true });
  // The routes gate on board membership before touching disk. Every required
  // TaskRecord field is present, so this needs no cast.
  saveState({
    version: 1,
    tasks: [
      {
        issue: ISSUE,
        title: 'doc workbench',
        slug: 'doc-workbench',
        branch: 'ouriel/91-doc-workbench',
        worktreePath: null,
        prNumber: null,
        prUrl: null,
        manualPhase: null,
        spawnHistory: [],
        lastReconciledAt: null,
      },
    ],
  });
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('GET /api/tasks/:issue/artifacts/:name', () => {
  test('returns content, class and write target', async () => {
    seedArtifact('design.md', '# design\n', { original: true });
    const server = app();
    const res = await server.inject({ url: `/api/tasks/${ISSUE}/artifacts/design.md` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      content: '# design\n',
      class: 'markdown',
      writeTarget: 'original',
    });
    await server.close();
  });

  test('404s a name that is not in the manifest', async () => {
    seedArtifact('design.md', 'x', { original: true });
    const server = app();
    const res = await server.inject({ url: `/api/tasks/${ISSUE}/artifacts/nope.md` });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  test('404s an issue that is not on the board', async () => {
    const server = app();
    const res = await server.inject({ url: '/api/tasks/4040/artifacts/design.md' });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  test('415s a binary artifact and names the reason', async () => {
    seedArtifact('shot.png', Buffer.from([0x89, 0x00, 0x41]), { original: true });
    const server = app();
    const res = await server.inject({ url: `/api/tasks/${ISSUE}/artifacts/shot.png` });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ reason: 'binary' });
    await server.close();
  });

  test('413s an artifact over the size cap', async () => {
    seedArtifact('huge.md', Buffer.alloc(2 * 1024 * 1024 + 1, 0x41), { original: true });
    const server = app();
    const res = await server.inject({ url: `/api/tasks/${ISSUE}/artifacts/huge.md` });
    expect(res.statusCode).toBe(413);
    await server.close();
  });

  test('410s when no copy remains on disk', async () => {
    seedArtifact('design.md', 'x', { original: false });
    rmSync(join(artifactsDir(ISSUE), 'design.md'));
    const server = app();
    const res = await server.inject({ url: `/api/tasks/${ISSUE}/artifacts/design.md` });
    expect(res.statusCode).toBe(410);
    await server.close();
  });
});

describe('PUT /api/tasks/:issue/artifacts/:name', () => {
  test('writes through to the original and resyncs the snapshot', async () => {
    seedArtifact('design.md', 'old\n', { original: true });
    const server = app();
    const res = await server.inject({
      method: 'PUT',
      url: `/api/tasks/${ISSUE}/artifacts/design.md`,
      payload: { content: 'new\n' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, writeTarget: 'original' });
    expect(readFileSync(originalPath, 'utf8')).toBe('new\n');
    expect(readFileSync(join(artifactsDir(ISSUE), 'design.md'), 'utf8')).toBe('new\n');
    await server.close();
  });

  test('reports snapshot-only when the original is gone', async () => {
    seedArtifact('design.md', 'old\n', { original: false });
    const server = app();
    const res = await server.inject({
      method: 'PUT',
      url: `/api/tasks/${ISSUE}/artifacts/design.md`,
      payload: { content: 'new\n' },
    });
    expect(res.json()).toEqual({ ok: true, writeTarget: 'snapshot' });
    await server.close();
  });

  test('400s a non-string body', async () => {
    seedArtifact('design.md', 'old\n', { original: true });
    const server = app();
    const res = await server.inject({
      method: 'PUT',
      url: `/api/tasks/${ISSUE}/artifacts/design.md`,
      payload: { content: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(readFileSync(originalPath, 'utf8')).toBe('old\n');
    await server.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server-documents.test.ts`
Expected: FAIL — the GET returns 404 from Fastify's default not-found handler because the route is unregistered.

- [ ] **Step 3: Write the minimal implementation**

In `src/server/routes.ts`, add to the imports:

```ts
import {
  readArtifactDocument,
  writeArtifactDocument,
  type DocumentError,
} from '../orchestrator/documents.ts';
```

Add above `export function registerRoutes`:

```ts
/** How a document failure surfaces over HTTP. */
const DOCUMENT_FAILURE: Record<DocumentError, { status: number; error: string }> = {
  'not-found': { status: 404, error: 'no such artifact for this task' },
  gone: { status: 410, error: 'the artifact is no longer on disk' },
  'too-large': { status: 413, error: 'artifact is larger than the 2 MB editing limit' },
  binary: { status: 415, error: 'artifact is not text' },
};
```

Add inside `registerRoutes`, immediately after the existing `/artifacts/:name/open` route:

```ts
  app.get<{ Params: { issue: string; name: string } }>(
    '/api/tasks/:issue/artifacts/:name',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });

      const result = readArtifactDocument(issue, decodeURIComponent(req.params.name));
      if (!result.ok) {
        const failure = DOCUMENT_FAILURE[result.error];
        return reply.code(failure.status).send({ error: failure.error, reason: result.error });
      }
      return result.value;
    },
  );

  app.put<{ Params: { issue: string; name: string }; Body: { content?: unknown } }>(
    '/api/tasks/:issue/artifacts/:name',
    async (req, reply) => {
      const issue = Number(req.params.issue);
      if (!getTask(issue)) return reply.code(404).send({ error: 'task not on the board' });
      if (typeof req.body?.content !== 'string') {
        return reply.code(400).send({ error: 'content must be a string' });
      }

      const result = writeArtifactDocument(
        issue,
        decodeURIComponent(req.params.name),
        req.body.content,
      );
      if (!result.ok) {
        const failure = DOCUMENT_FAILURE[result.error];
        return reply.code(failure.status).send({ error: failure.error, reason: result.error });
      }
      return { ok: true, writeTarget: result.value };
    },
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/server-documents.test.ts && npm run typecheck`
Expected: PASS, 9 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.ts test/server-documents.test.ts
git commit -m "feat: serve artifact content over GET and PUT"
```

---

### Task 4: Web document model (pure)

Everything the workbench decides that does not need a DOM.

**Files:**
- Create: `src/web/doc-model.ts`
- Test: `test/doc-model.test.ts`

**Interfaces:**
- Consumes: `ArtifactRef` from `src/shared/types.ts`
- Produces:
  - `type DocId = { kind: 'plan' } | { kind: 'artifact'; name: string }`
  - `type DocMode = 'edit' | 'split' | 'preview'`
  - `interface DocEntry { id: DocId; key: string; label: string; inCheckout: boolean }`
  - `interface DocBuffer { text: string; loaded: string }`
  - `function docKey(id: DocId): string`
  - `function buildDocList(artifacts: ArtifactRef[]): DocEntry[]`
  - `function clampFontPx(px: number): number`
  - `function clampSplit(ratio: number): number`
  - `function dirtyKeys(buffers: Record<string, DocBuffer>): string[]`
  - `function availableModes(contentClass: 'markdown' | 'text'): DocMode[]`
  - `function effectiveMode(preferred: DocMode, contentClass: 'markdown' | 'text'): DocMode`
  - `const FONT_MIN, FONT_MAX, FONT_DEFAULT, SPLIT_MIN, SPLIT_MAX, SPLIT_DEFAULT`

- [ ] **Step 1: Write the failing test**

Create `test/doc-model.test.ts`:

```ts
import { describe, expect, test } from 'vitest';

import {
  availableModes,
  buildDocList,
  clampFontPx,
  clampSplit,
  dirtyKeys,
  docKey,
  effectiveMode,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  SPLIT_DEFAULT,
} from '../src/web/doc-model.ts';
import type { ArtifactRef } from '../src/shared/types.ts';

const ref = (name: string, origin: 'taskdir' | 'repo'): ArtifactRef => ({
  name,
  storedPath: `artifacts/${name}`,
  origin,
  originalPath: `C:\\wt\\${name}`,
});

describe('docKey', () => {
  test('namespaces artifacts so a file named "plan" cannot collide', () => {
    expect(docKey({ kind: 'plan' })).toBe('plan');
    expect(docKey({ kind: 'artifact', name: 'plan' })).toBe('artifact:plan');
  });
});

describe('buildDocList', () => {
  test('puts the plan first and keeps manifest order after it', () => {
    const list = buildDocList([ref('spec.md', 'repo'), ref('notes.txt', 'taskdir')]);
    expect(list.map((d) => d.label)).toEqual(['plan.md', 'spec.md', 'notes.txt']);
  });

  test('flags only repo-origin artifacts as in-checkout', () => {
    const list = buildDocList([ref('spec.md', 'repo'), ref('notes.txt', 'taskdir')]);
    expect(list.map((d) => d.inCheckout)).toEqual([false, true, false]);
  });

  test('handles a task with no artifacts at all', () => {
    expect(buildDocList([])).toHaveLength(1);
  });

  test('carries arbitrary names through untouched', () => {
    const list = buildDocList([ref('2026-08-05-whatever-the-agent-chose.md', 'repo')]);
    expect(list[1]!.label).toBe('2026-08-05-whatever-the-agent-chose.md');
    expect(list[1]!.id).toEqual({ kind: 'artifact', name: '2026-08-05-whatever-the-agent-chose.md' });
  });
});

describe('clampFontPx', () => {
  test('holds the documented bounds', () => {
    expect(FONT_MIN).toBe(11);
    expect(FONT_MAX).toBe(24);
    expect(FONT_DEFAULT).toBe(13);
  });
  test('clamps below and above', () => {
    expect(clampFontPx(2)).toBe(11);
    expect(clampFontPx(99)).toBe(24);
  });
  test('rounds and passes through the middle', () => {
    expect(clampFontPx(15.4)).toBe(15);
  });
  test('a corrupt stored value falls back to the default', () => {
    expect(clampFontPx(Number.NaN)).toBe(13);
  });
});

describe('clampSplit', () => {
  test('clamps to 0.2 .. 0.8 and defaults on garbage', () => {
    expect(clampSplit(0.05)).toBe(0.2);
    expect(clampSplit(0.95)).toBe(0.8);
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
  });
});

describe('dirtyKeys', () => {
  test('reports every edited buffer, not just the visible one', () => {
    const keys = dirtyKeys({
      plan: { text: 'a', loaded: 'a' },
      'artifact:spec.md': { text: 'changed', loaded: 'original' },
      'artifact:notes.txt': { text: 'also changed', loaded: '' },
    });
    expect(keys.sort()).toEqual(['artifact:notes.txt', 'artifact:spec.md']);
  });
  test('is empty when nothing has been touched', () => {
    expect(dirtyKeys({ plan: { text: 'a', loaded: 'a' } })).toEqual([]);
  });
});

describe('availableModes / effectiveMode', () => {
  test('markdown offers all three modes', () => {
    expect(availableModes('markdown')).toEqual(['edit', 'split', 'preview']);
  });
  test('plain text offers editing only', () => {
    expect(availableModes('text')).toEqual(['edit']);
  });
  test('a preferred mode a text document cannot honour degrades to edit', () => {
    expect(effectiveMode('preview', 'text')).toBe('edit');
    expect(effectiveMode('split', 'text')).toBe('edit');
  });
  test('a preferred mode markdown can honour is kept', () => {
    expect(effectiveMode('split', 'markdown')).toBe('split');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/doc-model.test.ts`
Expected: FAIL — cannot resolve `../src/web/doc-model.ts`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/web/doc-model.ts`:

```ts
import type { ArtifactRef } from '../shared/types.ts';

/**
 * What the workbench decides without a DOM.
 *
 * This repo's test environment is node with no jsdom, so every rule worth
 * asserting — ordering, clamping, dirty tracking, mode availability — lives
 * here rather than inside the React components that consume it.
 */

export type DocId = { kind: 'plan' } | { kind: 'artifact'; name: string };
export type DocMode = 'edit' | 'split' | 'preview';

export interface DocEntry {
  id: DocId;
  /** Stable identity for maps and React keys. */
  key: string;
  label: string;
  /** True for artifacts the run wrote into the checkout. */
  inCheckout: boolean;
}

export interface DocBuffer {
  text: string;
  /** What the server last handed us; the dirty comparison baseline. */
  loaded: string;
}

/** Namespaced so an artifact literally named "plan" cannot shadow the plan. */
export function docKey(id: DocId): string {
  return id.kind === 'plan' ? 'plan' : `artifact:${id.name}`;
}

/** The plan first, then artifacts in manifest order. Names are never parsed. */
export function buildDocList(artifacts: ArtifactRef[]): DocEntry[] {
  return [
    { id: { kind: 'plan' }, key: 'plan', label: 'plan.md', inCheckout: false },
    ...artifacts.map((a): DocEntry => {
      const id: DocId = { kind: 'artifact', name: a.name };
      return { id, key: docKey(id), label: a.name, inCheckout: a.origin === 'repo' };
    }),
  ];
}

export const FONT_MIN = 11;
export const FONT_MAX = 24;
export const FONT_DEFAULT = 13;

export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;
export const SPLIT_DEFAULT = 0.5;

/** Whole pixels inside the bounds; a corrupt stored value yields the default. */
export function clampFontPx(px: number): number {
  if (!Number.isFinite(px)) return FONT_DEFAULT;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

export function clampSplit(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio));
}

/**
 * Every buffer whose text has drifted from what was loaded. Closing consults
 * all of them, not just the visible document — otherwise switching away from an
 * edited file and closing would discard it silently.
 */
export function dirtyKeys(buffers: Record<string, DocBuffer>): string[] {
  return Object.entries(buffers)
    .filter(([, buffer]) => buffer.text !== buffer.loaded)
    .map(([key]) => key);
}

/** Preview only makes sense for markdown; other text is editable, not rendered. */
export function availableModes(contentClass: 'markdown' | 'text'): DocMode[] {
  return contentClass === 'markdown' ? ['edit', 'split', 'preview'] : ['edit'];
}

/** The remembered mode, degraded to one this document can actually honour. */
export function effectiveMode(preferred: DocMode, contentClass: 'markdown' | 'text'): DocMode {
  return availableModes(contentClass).includes(preferred) ? preferred : 'edit';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/doc-model.test.ts && npm run typecheck`
Expected: PASS, 17 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/doc-model.ts test/doc-model.test.ts
git commit -m "feat: add the pure document model for the workbench"
```

---

### Task 5: Client transport for documents

One adapter so the plan/artifact route asymmetry lives in exactly one place and the components never see it.

**Files:**
- Modify: `src/web/api.ts` (add to the `api` object at :43-99)
- Create: `src/web/doc-io.ts`
- Test: `test/doc-io.test.ts`

**Interfaces:**
- Consumes: `api.plan`, `api.savePlan` (existing, `api.ts:48,51`); `DocId` from Task 4
- Produces:
  - `interface DocumentPayload { content: string; class: 'markdown' | 'text'; writeTarget: 'original' | 'snapshot'; originalPath: string }`
  - `api.readArtifact(issue: number, name: string): Promise<DocumentPayload>`
  - `api.saveArtifact(issue: number, name: string, content: string): Promise<{ ok: true; writeTarget: 'original' | 'snapshot' }>`
  - `function loadDocument(issue: number, id: DocId): Promise<DocumentPayload>`
  - `function saveDocument(issue: number, id: DocId, content: string): Promise<'original' | 'snapshot'>`

**Why the plan reports `writeTarget: 'original'`:** `plan.md` has no checkout counterpart — it *is* the real file. Reporting `'snapshot'` would make the UI show a "snapshot only" warning that means nothing for the plan.

- [ ] **Step 1: Write the failing test**

Create `test/doc-io.test.ts`:

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';

import { loadDocument, saveDocument } from '../src/web/doc-io.ts';

/** Record every request and reply with a canned JSON body. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadDocument', () => {
  test('reads the plan through the plan route and reports it as the real file', async () => {
    const calls = stubFetch({ content: '# plan\n' });
    const doc = await loadDocument(12, { kind: 'plan' });

    expect(calls[0]!.url).toBe('/api/tasks/12/plan');
    expect(doc).toEqual({
      content: '# plan\n',
      class: 'markdown',
      writeTarget: 'original',
      originalPath: '',
    });
  });

  test('reads an artifact through the artifact route, encoding the name', async () => {
    const calls = stubFetch({
      content: '# spec\n',
      class: 'markdown',
      writeTarget: 'original',
      originalPath: 'C:\\wt\\spec one.md',
    });
    const doc = await loadDocument(12, { kind: 'artifact', name: 'spec one.md' });

    expect(calls[0]!.url).toBe('/api/tasks/12/artifacts/spec%20one.md');
    expect(doc.writeTarget).toBe('original');
  });

  test('surfaces the server error message on failure', async () => {
    stubFetch({ error: 'artifact is not text', reason: 'binary' }, 415);
    await expect(loadDocument(12, { kind: 'artifact', name: 'shot.png' })).rejects.toThrow(
      'artifact is not text',
    );
  });
});

describe('saveDocument', () => {
  test('PUTs the plan and reports the real file', async () => {
    const calls = stubFetch({ ok: true });
    const target = await saveDocument(12, { kind: 'plan' }, 'new\n');

    expect(calls[0]).toMatchObject({ url: '/api/tasks/12/plan', method: 'PUT' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ content: 'new\n' });
    expect(target).toBe('original');
  });

  test('PUTs an artifact and returns the target the server chose', async () => {
    const calls = stubFetch({ ok: true, writeTarget: 'snapshot' });
    const target = await saveDocument(12, { kind: 'artifact', name: 'spec.md' }, 'new\n');

    expect(calls[0]).toMatchObject({
      url: '/api/tasks/12/artifacts/spec.md',
      method: 'PUT',
    });
    expect(target).toBe('snapshot');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/doc-io.test.ts`
Expected: FAIL — cannot resolve `../src/web/doc-io.ts`.

- [ ] **Step 3: Extend the API client**

In `src/web/api.ts`, add above `export const api = {`:

```ts
export interface DocumentPayload {
  content: string;
  class: 'markdown' | 'text';
  writeTarget: 'original' | 'snapshot';
  /** Where the file really lives; '' for the plan, which has no counterpart. */
  originalPath: string;
}
```

and inside the `api` object, directly after the existing `openArtifact` entry:

```ts
  readArtifact: (issue: number, name: string) =>
    request<DocumentPayload>(`/api/tasks/${issue}/artifacts/${encodeURIComponent(name)}`),
  saveArtifact: (issue: number, name: string, content: string) =>
    request<{ ok: true; writeTarget: 'original' | 'snapshot' }>(
      `/api/tasks/${issue}/artifacts/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify({ content }) },
    ),
```

- [ ] **Step 4: Write the adapter**

Create `src/web/doc-io.ts`:

```ts
import { api, type DocumentPayload } from './api.ts';
import type { DocId } from './doc-model.ts';

/**
 * The one place that knows the plan and the artifacts sit behind different
 * routes. Components address documents purely by `DocId`.
 */

export async function loadDocument(issue: number, id: DocId): Promise<DocumentPayload> {
  if (id.kind === 'artifact') return api.readArtifact(issue, id.name);

  const { content } = await api.plan(issue);
  // plan.md has no checkout counterpart — it *is* the real file, so there is
  // never a "snapshot only" caveat to show for it.
  return { content, class: 'markdown', writeTarget: 'original', originalPath: '' };
}

export async function saveDocument(
  issue: number,
  id: DocId,
  content: string,
): Promise<'original' | 'snapshot'> {
  if (id.kind === 'artifact') {
    const { writeTarget } = await api.saveArtifact(issue, id.name, content);
    return writeTarget;
  }
  await api.savePlan(issue, content);
  return 'original';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/doc-io.test.ts && npm run typecheck`
Expected: PASS, 5 tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/web/api.ts src/web/doc-io.ts test/doc-io.test.ts
git commit -m "feat: address plan and artifacts through one document transport"
```

---

### Task 6: Rail and panes components

Two presentational files, split out from the start so the workbench shell stays small.

**Files:**
- Create: `src/web/components/docs/DocRail.tsx`
- Create: `src/web/components/docs/DocPanes.tsx`
- Modify: `src/web/styles.css` (append at end of file)

**Interfaces:**
- Consumes: `DocEntry`, `DocMode` from `src/web/doc-model.ts`
- Produces:
  - `function DocRail(props: { entries: DocEntry[]; activeKey: string; dirty: string[]; onSelect: (entry: DocEntry) => void; onOpenExternal: (name: string) => void }): JSX.Element`
  - `function DocPanes(props: { mode: DocMode; text: string; split: number; onTextChange: (text: string) => void; onSplitChange: (ratio: number) => void; readOnly: boolean }): JSX.Element`

- [ ] **Step 1: Write the rail**

Create `src/web/components/docs/DocRail.tsx`:

```tsx
import type { DocEntry } from '../../doc-model.ts';

interface DocRailProps {
  entries: DocEntry[];
  activeKey: string;
  /** Keys with unsaved edits, from `dirtyKeys`. */
  dirty: string[];
  onSelect: (entry: DocEntry) => void;
  /** Hand an artifact to VS Code. The plan row has no such route. */
  onOpenExternal: (name: string) => void;
}

export function DocRail({ entries, activeKey, dirty, onSelect, onOpenExternal }: DocRailProps) {
  return (
    <nav className="doc-rail" aria-label="Documents">
      {entries.map((entry) => (
        <div key={entry.key} className={`doc-row${entry.key === activeKey ? ' is-on' : ''}`}>
          <button
            className="doc-row-name"
            onClick={() => onSelect(entry)}
            aria-current={entry.key === activeKey}
          >
            <span className="doc-row-label">{entry.label}</span>
            {dirty.includes(entry.key) && (
              <span className="doc-dot" aria-label="unsaved changes" />
            )}
          </button>
          {entry.inCheckout && <span className="badge tone-warn">in checkout</span>}
          {entry.id.kind === 'artifact' && (
            <button
              className="doc-row-open"
              title="Open in VS Code"
              onClick={() => onOpenExternal(entry.label)}
            >
              ↗
            </button>
          )}
        </div>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Write the panes**

Create `src/web/components/docs/DocPanes.tsx`:

```tsx
import { useRef } from 'react';
import { marked } from 'marked';

import type { DocMode } from '../../doc-model.ts';
import { clampSplit } from '../../doc-model.ts';

interface DocPanesProps {
  mode: DocMode;
  text: string;
  /** Editor share of the width in split mode, 0.2 .. 0.8. */
  split: number;
  onTextChange: (text: string) => void;
  onSplitChange: (ratio: number) => void;
  readOnly: boolean;
}

/**
 * Editor, preview, or both.
 *
 * Rendered Markdown is injected directly: content is locally authored in a
 * single-user local tool, the same trust model the plan editor has always used.
 */
export function DocPanes({
  mode,
  text,
  split,
  onTextChange,
  onSplitChange,
  readOnly,
}: DocPanesProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  /** Drag the divider; the ratio is clamped so neither pane can vanish. */
  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const box = bodyRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      onSplitChange(clampSplit((e.clientX - box.left) / box.width));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  /** Proportional scroll sync, guarded so the echo does not fight the user. */
  function syncScroll(from: HTMLElement, to: HTMLElement | null) {
    if (!to || syncing.current) return;
    const fromRange = from.scrollHeight - from.clientHeight;
    const toRange = to.scrollHeight - to.clientHeight;
    if (fromRange <= 0 || toRange <= 0) return;
    syncing.current = true;
    to.scrollTop = (from.scrollTop / fromRange) * toRange;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  const showEditor = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  return (
    <div className="doc-body" ref={bodyRef}>
      {showEditor && (
        <textarea
          ref={editorRef}
          className="doc-text"
          style={mode === 'split' ? { flex: `0 0 ${split * 100}%` } : undefined}
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => onTextChange(e.target.value)}
          onScroll={(e) => mode === 'split' && syncScroll(e.currentTarget, previewRef.current)}
        />
      )}

      {mode === 'split' && (
        <div
          className="doc-divider"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag}
        />
      )}

      {showPreview && (
        <div
          ref={previewRef}
          className="doc-preview"
          onScroll={(e) => mode === 'split' && syncScroll(e.currentTarget, editorRef.current)}
        >
          <div
            className="doc-prose"
            dangerouslySetInnerHTML={{ __html: marked.parse(text) as string }}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the styles**

Append to `src/web/styles.css`:

```css
/* ---------- document workbench ---------- */

.doc-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
}

.doc-workbench {
  /* Wide enough for a real split; the prose measure below keeps it readable. */
  width: 96vw;
  max-width: 1600px;
  height: 94vh;
  background: var(--card);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.doc-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}

.doc-target {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--attention);
}

.doc-zoom {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--dim);
}

.doc-main {
  flex: 1;
  min-height: 0;
  display: flex;
}

.doc-rail {
  flex: 0 0 220px;
  overflow: auto;
  padding: 8px;
  border-right: 1px solid var(--line);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.doc-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border-radius: var(--radius-sm);
}

.doc-row:hover {
  background: var(--card-hi);
}

.doc-row.is-on {
  background: var(--card-hi);
  box-shadow: inset 2px 0 0 var(--live);
}

.doc-row-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  font-family: var(--mono);
  font-size: 11.5px;
}

.doc-row-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--attention);
}

.doc-row-open {
  flex: none;
  color: var(--dimmer);
  font-size: 12px;
}

.doc-row-open:hover {
  color: var(--ink);
}

.doc-body {
  flex: 1;
  min-width: 0;
  display: flex;
}

.doc-text {
  flex: 1;
  min-width: 0;
  resize: none;
  border: none;
  outline: none;
  padding: 16px;
  background: transparent;
  color: var(--ink);
  font-family: var(--mono);
  font-size: var(--doc-font);
  line-height: 1.55;
}

.doc-divider {
  flex: none;
  width: 6px;
  cursor: col-resize;
  background: var(--line-soft);
}

.doc-divider:hover {
  background: var(--live);
}

.doc-preview {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 16px 24px;
  border-left: 1px solid var(--line-soft);
}

/*
  Width buys the split, not the line length: prose past ~78 characters is
  harder to read at 1600px than it was at 1000px.
*/
.doc-prose {
  max-width: 78ch;
  margin: 0 auto;
  font-size: var(--doc-font);
  line-height: 1.65;
}

.doc-prose h1,
.doc-prose h2,
.doc-prose h3,
.doc-prose h4 {
  color: var(--ink-strong);
  line-height: 1.3;
  margin: 1.4em 0 0.5em;
}

.doc-prose h1 { font-size: 1.9em; }
.doc-prose h2 { font-size: 1.5em; }
.doc-prose h3 { font-size: 1.22em; }
.doc-prose h4 { font-size: 1.05em; }

.doc-prose p,
.doc-prose ul,
.doc-prose ol {
  margin: 0.7em 0;
}

.doc-prose li {
  margin: 0.25em 0;
}

.doc-prose a {
  color: var(--live);
}

.doc-prose code {
  font-family: var(--mono);
  font-size: 0.9em;
  background: var(--bg-soft);
  padding: 1px 4px;
  border-radius: 4px;
}

.doc-prose pre {
  background: var(--bg-soft);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  overflow: auto;
}

.doc-prose pre code {
  background: none;
  padding: 0;
}

.doc-prose blockquote {
  margin: 0.8em 0;
  padding-left: 12px;
  border-left: 2px solid var(--line);
  color: var(--dim);
}

.doc-prose hr {
  border: none;
  border-top: 1px solid var(--line);
  margin: 1.6em 0;
}

.doc-prose table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.9em 0;
}

.doc-prose th,
.doc-prose td {
  border: 1px solid var(--line-soft);
  padding: 5px 9px;
  text-align: left;
}

.doc-prose th {
  background: var(--bg-soft);
  color: var(--ink-strong);
}

.doc-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--dim);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}

.doc-placeholder code {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--dimmer);
  word-break: break-all;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run typecheck`
Expected: clean. (No unit test — these are presentational and this repo has no DOM test environment; the assertions live in `doc-model.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add src/web/components/docs/DocRail.tsx src/web/components/docs/DocPanes.tsx src/web/styles.css
git commit -m "feat: add the document rail and split panes"
```

---

### Task 7: The workbench shell

Owns per-document buffers, mode, zoom, persistence, and save/close.

**Files:**
- Create: `src/web/components/DocumentWorkbench.tsx`

**Interfaces:**
- Consumes: `buildDocList`, `clampFontPx`, `clampSplit`, `dirtyKeys`, `docKey`, `effectiveMode`, `FONT_DEFAULT`, `FONT_MAX`, `FONT_MIN`, `SPLIT_DEFAULT`, and the `DocBuffer`/`DocEntry`/`DocId`/`DocMode` types (Task 4); `loadDocument`, `saveDocument` (Task 5); `DocRail`, `DocPanes` (Task 6); `api.openArtifact` (existing, `api.ts:94`)
- Produces: `function DocumentWorkbench(props: { issue: number; artifacts: ArtifactRef[]; initial: DocId; onClose: () => void; onPlanSaved: (content: string) => void }): JSX.Element`

- [ ] **Step 1: Write the component**

Create `src/web/components/DocumentWorkbench.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.ts';
import { loadDocument, saveDocument } from '../doc-io.ts';
import {
  buildDocList,
  clampFontPx,
  clampSplit,
  dirtyKeys,
  docKey,
  effectiveMode,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  SPLIT_DEFAULT,
  type DocBuffer,
  type DocEntry,
  type DocId,
  type DocMode,
} from '../doc-model.ts';
import { DocPanes } from './docs/DocPanes.tsx';
import { DocRail } from './docs/DocRail.tsx';
import type { ArtifactRef } from '../../shared/types.ts';

interface DocumentWorkbenchProps {
  issue: number;
  artifacts: ArtifactRef[];
  initial: DocId;
  onClose: () => void;
  /** Lets the drawer refresh its inline plan glance after a plan save. */
  onPlanSaved: (content: string) => void;
}

interface DocState extends DocBuffer {
  class: 'markdown' | 'text';
  writeTarget: 'original' | 'snapshot';
  originalPath: string;
}

const FONT_KEY = 'mc.doc.fontPx';
const MODE_KEY = 'mc.doc.mode';
const SPLIT_KEY = 'mc.doc.split';

function readStored(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : Number(raw);
}

export function DocumentWorkbench({
  issue,
  artifacts,
  initial,
  onClose,
  onPlanSaved,
}: DocumentWorkbenchProps) {
  const entries = buildDocList(artifacts);
  const [activeId, setActiveId] = useState<DocId>(initial);
  const [docs, setDocs] = useState<Record<string, DocState>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<DocMode>(
    () => (window.localStorage.getItem(MODE_KEY) as DocMode | null) ?? 'split',
  );
  const [fontPx, setFontPx] = useState(() => clampFontPx(readStored(FONT_KEY, FONT_DEFAULT)));
  const [split, setSplit] = useState(() => clampSplit(readStored(SPLIT_KEY, SPLIT_DEFAULT)));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const activeKey = docKey(activeId);
  const active = docs[activeKey];
  const dirty = dirtyKeys(docs);

  useEffect(() => window.localStorage.setItem(FONT_KEY, String(fontPx)), [fontPx]);
  useEffect(() => window.localStorage.setItem(MODE_KEY, mode), [mode]);
  useEffect(() => window.localStorage.setItem(SPLIT_KEY, String(split)), [split]);

  // Lazy load: the rail renders instantly from board state, each document is
  // fetched the first time it is selected.
  useEffect(() => {
    if (docs[activeKey] || failures[activeKey]) return;
    let cancelled = false;
    loadDocument(issue, activeId)
      .then((payload) => {
        if (cancelled) return;
        setDocs((prev) => ({
          ...prev,
          [activeKey]: {
            text: payload.content,
            loaded: payload.content,
            class: payload.class,
            writeTarget: payload.writeTarget,
            originalPath: payload.originalPath,
          },
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setFailures((prev) => ({ ...prev, [activeKey]: message }));
      });
    return () => {
      cancelled = true;
    };
  }, [issue, activeId, activeKey, docs, failures]);

  const attemptClose = useCallback(() => {
    if (dirty.length > 0) {
      const names = entries
        .filter((e) => dirty.includes(e.key))
        .map((e) => e.label)
        .join(', ');
      if (!window.confirm(`Discard unsaved changes to ${names}?`)) return;
    }
    onClose();
  }, [dirty, entries, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        attemptClose();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setFontPx((px) => clampFontPx(px + 1));
      } else if (e.key === '-') {
        e.preventDefault();
        setFontPx((px) => clampFontPx(px - 1));
      } else if (e.key === '0') {
        e.preventDefault();
        setFontPx(FONT_DEFAULT);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attemptClose]);

  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setFontPx((px) => clampFontPx(px + (e.deltaY < 0 ? 1 : -1)));
  }

  async function save() {
    if (!active) return;
    setSaving(true);
    setSaveError(null);
    try {
      const target = await saveDocument(issue, activeId, active.text);
      setDocs((prev) => ({
        ...prev,
        [activeKey]: { ...prev[activeKey]!, loaded: active.text, writeTarget: target },
      }));
      if (activeId.kind === 'plan') onPlanSaved(active.text);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const shownMode = active ? effectiveMode(mode, active.class) : mode;
  const isDirty = active ? active.text !== active.loaded : false;

  return (
    <div
      className="doc-scrim"
      role="dialog"
      aria-label={`Documents for #${issue}`}
      onWheel={onWheel}
    >
      <div className="doc-workbench" style={{ ['--doc-font' as string]: `${fontPx}px` }}>
        <header className="doc-head">
          <strong>Docs · #{issue}</strong>

          <div className="plan-editor-tabs">
            {(['edit', 'split', 'preview'] as const).map((m) => (
              <button
                key={m}
                className={`btn is-sm${shownMode === m ? ' is-primary' : ''}`}
                disabled={active !== undefined && active.class === 'text' && m !== 'edit'}
                title={
                  active?.class === 'text' && m !== 'edit'
                    ? 'Preview is markdown only'
                    : undefined
                }
                onClick={() => setMode(m)}
              >
                {m[0]!.toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>

          {active?.writeTarget === 'snapshot' && (
            <span className="doc-target" title={active.originalPath}>
              snapshot only — the original is gone
            </span>
          )}

          <span className="doc-zoom">
            <button className="btn is-sm" disabled={fontPx <= FONT_MIN} onClick={() => setFontPx(clampFontPx(fontPx - 1))}>
              A−
            </button>
            <span>{fontPx}px</span>
            <button className="btn is-sm" disabled={fontPx >= FONT_MAX} onClick={() => setFontPx(clampFontPx(fontPx + 1))}>
              A+
            </button>
          </span>

          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              className="btn is-sm is-primary"
              disabled={saving || !isDirty}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="btn is-sm is-ghost" onClick={attemptClose}>
              Close
            </button>
          </span>
        </header>

        {saveError && <p className="error" style={{ margin: '8px 16px' }}>{saveError}</p>}

        <div className="doc-main">
          <DocRail
            entries={entries}
            activeKey={activeKey}
            dirty={dirty}
            onSelect={(entry: DocEntry) => setActiveId(entry.id)}
            onOpenExternal={(name) => void api.openArtifact(issue, name)}
          />

          {failures[activeKey] ? (
            <div className="doc-placeholder">
              <p>{failures[activeKey]}</p>
              {activeId.kind === 'artifact' && (
                <button className="btn is-sm" onClick={() => void api.openArtifact(issue, activeId.name)}>
                  Open in VS Code
                </button>
              )}
            </div>
          ) : !active ? (
            <div className="doc-placeholder">Loading…</div>
          ) : (
            <DocPanes
              mode={shownMode}
              text={active.text}
              split={split}
              readOnly={false}
              onTextChange={(text) =>
                setDocs((prev) => ({ ...prev, [activeKey]: { ...prev[activeKey]!, text } }))
              }
              onSplitChange={(ratio) => setSplit(clampSplit(ratio))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/DocumentWorkbench.tsx
git commit -m "feat: add the document workbench shell"
```

---

### Task 8: Wire the drawer and retire the plan editor

**Files:**
- Modify: `src/web/components/drawer/PlanTab.tsx` (replace whole file)
- Delete: `src/web/components/PlanEditor.tsx`
- Modify: `src/web/styles.css` (delete the `.plan-editor-scrim`, `.plan-editor`, `.plan-editor-head`, `.plan-editor-body`, `.plan-editor-text`, `.plan-editor-preview*` rules at :934-1012; **keep `.plan-editor-tabs` at :965-968** — `DocumentWorkbench` reuses it for the mode buttons)

**Interfaces:**
- Consumes: `DocumentWorkbench` (Task 7), `DocId` (Task 4), `TabProps` from `src/web/components/drawer/types.ts`
- Produces: nothing new; `PlanTab`'s signature is unchanged.

- [ ] **Step 1: Rewrite the tab**

Replace `src/web/components/drawer/PlanTab.tsx` with:

```tsx
import { useEffect, useState } from 'react';

import { api } from '../../api.ts';
import { DocumentWorkbench } from '../DocumentWorkbench.tsx';
import type { DocId } from '../../doc-model.ts';
import type { TabProps } from './types.ts';

export function PlanTab({ task, busy, run, onChanged }: TabProps) {
  const [plan, setPlan] = useState<string | null>(null);
  const [open, setOpen] = useState<DocId | null>(null);

  useEffect(() => {
    setPlan(null);
    setOpen(null);
    api
      .plan(task.issue)
      .then((r) => setPlan(r.content))
      .catch(() => setPlan(null));
  }, [task.issue]);

  return (
    <>
      <section className="section">
        <div className="section-label">
          Documents
          <button
            className="disclose"
            style={{ marginLeft: 8 }}
            onClick={() => setOpen({ kind: 'plan' })}
          >
            {plan ? 'Open documents' : 'Write a plan'}
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

      {task.derived.artifacts.length > 0 && (
        <section className="section">
          <div className="section-label">Artifacts</div>
          <div className="stack">
            {task.derived.artifacts.map((a) => (
              <div
                key={a.name}
                className="actions"
                style={{ justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span>
                  {a.name}
                  {a.origin === 'repo' && (
                    <span className="badge tone-warn" style={{ marginLeft: 8 }}>
                      in checkout
                    </span>
                  )}
                </span>
                <span className="actions" style={{ gap: 6 }}>
                  <button
                    className="btn is-sm is-primary"
                    onClick={() => setOpen({ kind: 'artifact', name: a.name })}
                  >
                    View
                  </button>
                  <button
                    className="btn is-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      run(`artifact-${a.name}`, () => api.openArtifact(task.issue, a.name))
                    }
                  >
                    {busy === `artifact-${a.name}` ? 'Opening…' : 'VS Code'}
                  </button>
                </span>
              </div>
            ))}
          </div>
          <p className="hint">
            Collected from the plan run. Files marked “in checkout” were written into the
            repo; they were copied here, not moved.
          </p>
        </section>
      )}

      {open && (
        <DocumentWorkbench
          issue={task.issue}
          artifacts={task.derived.artifacts}
          initial={open}
          onClose={() => setOpen(null)}
          onPlanSaved={(content) => {
            setPlan(content);
            onChanged();
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Delete the old editor and its dead styles**

```bash
git rm src/web/components/PlanEditor.tsx
```

Then in `src/web/styles.css`, delete the `.plan-editor-scrim`, `.plan-editor`, `.plan-editor-head`, `.plan-editor-body`, `.plan-editor-text`, `.plan-editor-preview`, `.plan-editor-preview h1/h2/h3`, `.plan-editor-preview pre` and `.plan-editor-preview code` rules. **Leave `.plan-editor-tabs` in place** — the workbench header reuses it.

- [ ] **Step 3: Verify nothing still references the deleted module**

Run: `npx tsc --noEmit && node -e "process.exit(0)"` then grep:

```bash
git grep -n "PlanEditor" -- src || echo "no references remain"
```
Expected: `no references remain`.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all suites PASS; typecheck clean.

- [ ] **Step 5: Smoke-test in the real app**

```bash
npm run dev
```

Open the board, pick a task that has collected artifacts, open the drawer's Plan tab, and confirm each of:
1. "Open documents" opens a near-full-screen modal with plan.md selected.
2. The rail lists every artifact under its real captured name.
3. `A+`/`A−`, `Ctrl` `+`/`-`/`0`, and `Ctrl`+wheel all change the text size in both panes; the size survives a page reload.
4. Dragging the divider resizes the panes and the ratio survives a reload.
5. Editing an artifact, switching to another document, and switching back preserves the edit; Close warns and names it.
6. Saving an artifact whose original still exists updates the file in the worktree (`git status` in `%USERPROFILE%\.mc\worktrees\issue-<n>` shows it modified).
7. A non-markdown artifact offers Edit only; a binary one shows the placeholder with an Open in VS Code button.

- [ ] **Step 6: Commit**

```bash
git add -A src/web docs
git commit -m "feat: open every captured document from the drawer"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Document identity, no list route | 4 (`buildDocList` from board state) |
| §2 Write-through + GET resolution | 1 (`resolveWriteTarget`), 2 (`readArtifactDocument`/`writeArtifactDocument`) |
| §3 Classification, 8 KB sniff, 2 MB cap | 1, 2 |
| §4 Routes and status codes | 3 |
| §5 Layout, rail, divider, 78ch measure | 6 (CSS + `DocPanes`), 7 (shell) |
| §6 Zoom, shortcuts, persistence | 4 (`clampFontPx`), 7 (controls + `localStorage`) |
| §7 Buffer map, save active only, close warns on any | 4 (`dirtyKeys`), 7 |
| §8 PlanTab becomes Documents | 8 |
| Error-handling table | 2 (result union), 3 (statuses), 7 (per-document failure state) |
| Testing section | 1, 2, 3, 4, 5 |
| Risk: component size | 6 splits rail/panes out before the shell exists |

**Placeholder scan:** no TBD/TODO; every code step carries the actual code; no "similar to Task N".

**Type consistency:** `WriteTarget` is `'original' | 'snapshot'` in Tasks 1, 2, 3, 5, 7. `ContentClass` narrows to `'markdown' | 'text'` at the API boundary (`DocumentRead.class`, `DocumentPayload.class`) because `'binary'` is an error, never a payload. `docKey` produces `'plan'` / `` `artifact:${name}` `` and is the key type in Tasks 4, 6, 7. `DocMode` is `'edit' | 'split' | 'preview'` in Tasks 4, 6, 7.

**One deviation from the spec, deliberate:** the spec's §5 sketch put an open-in-VS-Code affordance only in the rail. Task 8 keeps the artifact list's existing button too (relabelled "VS Code", with "View" added beside it), because removing a working affordance the user already relies on is not something this change needs to do.
