import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { join } from 'node:path';

const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa, execaSync: vi.fn(() => ({ stdout: '' })) }));

import { fetchReviewRequests } from '../src/orchestrator/github.ts';
import { createReviewRequestsReader } from '../src/orchestrator/review-requests.ts';
import { SUBPROCESS_TIMEOUT_MS } from '../src/orchestrator/exec.ts';
import { registerRoutes } from '../src/server/routes.ts';
import { Broadcaster } from '../src/server/sse.ts';
import { createHealthResponse } from '../src/server/health.ts';
import type { Config } from '../src/shared/types.ts';

const config = {
  repo: { path: 'C:\\repo', owner: 'acme', name: 'widgets', baseBranch: 'main', branchPrefix: 'alice/' },
  github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
  agents: {}, pipeline: [], server: { port: 4317 },
} satisfies Config;

const rawPr = {
  number: 42, title: 'Fix sign-in', url: 'https://github.com/acme/widgets/pull/42',
  author: { login: 'bob' }, updatedAt: '2026-10-07T08:00:00Z',
};
const pr = { ...rawPr, author: 'bob' };

beforeEach(() => { execa.mockReset(); process.env.MC_HOME = join(process.env.MC_ROOT!, 'project'); });
afterEach(() => { delete process.env.MC_HOME; });

test('fetches outstanding reviews for the signed-in user in the configured repository', async () => {
  execa.mockResolvedValue({ stdout: JSON.stringify([rawPr]) });
  expect(await fetchReviewRequests(config)).toEqual([pr]);
  expect(execa).toHaveBeenCalledWith('gh', expect.arrayContaining([
    'pr', 'list', '--repo', 'acme/widgets', '--state', 'open', '--search',
    'review-requested:@me draft:false sort:updated-desc',
  ]), expect.objectContaining({ cwd: config.repo.path, timeout: SUBPROCESS_TIMEOUT_MS }));
});

test('handles deleted PR authors', async () => {
  execa.mockResolvedValue({ stdout: JSON.stringify([{ ...rawPr, author: null }]) });
  expect(await fetchReviewRequests(config)).toEqual([{ ...pr, author: 'ghost' }]);
});

test('GitHub failures propagate instead of appearing as an empty review queue', async () => {
  execa.mockRejectedValue(new Error('Sign-in required'));
  await expect(fetchReviewRequests(config)).rejects.toThrow('Sign-in required');
});

test('malformed GitHub results fail instead of clearing the count', async () => {
  execa.mockResolvedValue({ stdout: '[{"number":42}]' });
  await expect(fetchReviewRequests(config)).rejects.toThrow();
});

test('caches successful results for one minute and refreshes after expiry', async () => {
  let now = Date.parse('2026-10-07T08:00:00Z');
  const fetch = vi.fn(async () => [pr]);
  const read = createReviewRequestsReader(config, { fetch, now: () => now });
  expect(await read()).toMatchObject({ pullRequests: [pr], error: null });
  await read();
  expect(fetch).toHaveBeenCalledTimes(1);
  now += 60_000;
  await read();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('deduplicates simultaneous reads including forced refreshes', async () => {
  let resolve!: (value: typeof pr[]) => void;
  const fetch = vi.fn(() => new Promise<typeof pr[]>(done => { resolve = done; }));
  const read = createReviewRequestsReader(config, { fetch });
  const first = read();
  const second = read(true);
  resolve([pr]);
  expect(await first).toEqual(await second);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a forced refresh removes reviews that have been completed', async () => {
  const fetch = vi.fn().mockResolvedValueOnce([pr]).mockResolvedValueOnce([]);
  const read = createReviewRequestsReader(config, { fetch });
  await read();
  expect(await read(true)).toMatchObject({ pullRequests: [], error: null });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('retains the last successful queue and timestamp when GitHub fails', async () => {
  const fetch = vi.fn().mockResolvedValueOnce([pr]).mockRejectedValueOnce(new Error('Offline'));
  const read = createReviewRequestsReader(config, { fetch });
  const good = await read();
  expect(await read(true)).toMatchObject({ pullRequests: [pr], checkedAt: good.checkedAt, error: expect.any(String) });
});

test('an initial failure is distinguishable from no reviews and retry can recover', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce([pr]);
  const read = createReviewRequestsReader(config, { fetch });
  expect(await read()).toMatchObject({ pullRequests: [], checkedAt: null, error: expect.any(String) });
  expect(await read(true)).toMatchObject({ pullRequests: [pr], error: null });
});

test('the API exposes the review queue and supports explicit refresh', async () => {
  execa.mockResolvedValueOnce({ stdout: JSON.stringify([rawPr]) }).mockResolvedValueOnce({ stdout: '[]' });
  const app = Fastify();
  registerRoutes(app, { config, broadcaster: new Broadcaster(), refresh: async () => [], health: createHealthResponse('test') });
  try {
    const first = await app.inject('/api/review-requests');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ pullRequests: [pr], error: null });
    await app.inject('/api/review-requests');
    expect(execa).toHaveBeenCalledTimes(1);
    const refreshed = await app.inject('/api/review-requests?refresh=true');
    expect(refreshed.json()).toMatchObject({ pullRequests: [], error: null });
    expect(execa).toHaveBeenCalledTimes(2);
  } finally { await app.close(); }
});

test('opening a review resolves trusted PR metadata from the queue and rejects PRs outside it', async () => {
  execa.mockResolvedValue({ stdout: JSON.stringify([rawPr]) });
  const open = vi.fn(async () => ({ ...pr, openedAt: pr.updatedAt, workspacePath: 'C:\\src\\widgets', worktreeExists: true }));
  const app = Fastify();
  registerRoutes(app, {
    config, broadcaster: new Broadcaster(), refresh: async () => [], health: createHealthResponse('test'),
    reviewWorktrees: { list: () => [], open, finish: vi.fn() },
  });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/review-requests/42/open', payload: { title: 'Untrusted client title', workspacePath: 'C:\\unrelated' } });
    expect(result.statusCode).toBe(200);
    expect(open).toHaveBeenCalledWith(pr);
    const missing = await app.inject({ method: 'POST', url: '/api/review-requests/99/open' });
    expect(missing.statusCode).toBe(404);
    expect(open).toHaveBeenCalledTimes(1);
    const invalid = await app.inject({ method: 'POST', url: '/api/review-requests/0/open' });
    expect(invalid.statusCode).toBe(400);
    expect(open).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

test('local review actions survive an empty or unavailable queue and failed cleanup remains retryable', async () => {
  const local = { ...pr, openedAt: pr.updatedAt, workspacePath: 'C:\\src\\widgets', worktreeExists: true };
  let active = [local];
  const open = vi.fn(async () => local);
  let heldOpen = true;
  const finish = vi.fn(async () => {
    if (heldOpen) throw new Error('Close the editor and retry');
    active = [];
    return { rescued: ['notes.txt'], rescuePath: 'C:\\src\\widgets\\rescued' };
  });
  const app = Fastify();
  registerRoutes(app, {
    config, broadcaster: new Broadcaster(), refresh: async () => [], health: createHealthResponse('test'),
    reviewWorktrees: { list: () => active, open, finish },
  });
  try {
    execa.mockResolvedValueOnce({ stdout: '[]' });
    expect((await app.inject('/api/review-requests')).json()).toMatchObject({ pullRequests: [], worktrees: [local] });
    execa.mockRejectedValue(new Error('Offline'));
    expect((await app.inject({ method: 'POST', url: '/api/review-requests/42/open' })).statusCode).toBe(200);
    expect(open).toHaveBeenCalledWith(local);
    expect((await app.inject({ method: 'POST', url: '/api/review-requests/42/finish' })).statusCode).toBe(409);
    expect((await app.inject('/api/review-requests?refresh=true')).json()).toMatchObject({ error: expect.any(String), worktrees: [local] });
    heldOpen = false;
    const finished = await app.inject({ method: 'POST', url: '/api/review-requests/42/finish' });
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({ rescued: ['notes.txt'] });
    expect((await app.inject('/api/review-requests')).json()).toMatchObject({ worktrees: [] });
  } finally { await app.close(); }
});
