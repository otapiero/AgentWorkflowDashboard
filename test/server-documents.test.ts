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
  repo: { path: 'C:\\repo', owner: 'o', name: 'r', baseBranch: 'main', branchPrefix: 'alice/' },
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
        branch: 'alice/91-doc-workbench',
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
