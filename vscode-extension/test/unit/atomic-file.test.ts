import { mkdir, mkdtemp, readFile, rmdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { acquireAtomicLease } from '../../src/storage/atomic-file.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mission-control-lease-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('acquires exclusively and releases its lock', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'nested', 'start.lock');
  const first = await acquireAtomicLease(file, 10_000, () => 100);

  expect(first).not.toBeNull();
  expect(await acquireAtomicLease(file, 10_000, () => 100)).toBeNull();
  await first!.release();
  expect(await acquireAtomicLease(file, 10_000, () => 100)).not.toBeNull();
});

test('replaces only a stale lock', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  await writeFile(file, JSON.stringify({ token: 'old', createdAt: 100 }));

  expect(await acquireAtomicLease(file, 1_000, () => 1_100)).toBeNull();
  const lease = await acquireAtomicLease(file, 1_000, () => 1_101);
  expect(lease).not.toBeNull();
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ token: lease!.token, createdAt: 1_101 });
});

test('renews a live lease so it cannot be reclaimed after staleMs', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  let now = 0;
  const lease = await acquireAtomicLease(file, 30, () => now);
  now = 100;
  await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).heartbeat).toBe(100);

  expect(await acquireAtomicLease(file, 30, () => now)).toBeNull();
  await lease!.release();
});

test('takes over after a stopped heartbeat becomes stale', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  await writeFile(file, JSON.stringify({ token: 'dead', createdAt: 0, heartbeat: 10 }));

  expect(await acquireAtomicLease(file, 30, () => 100)).not.toBeNull();
});

test('stops lease heartbeat writes after release', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const lease = await acquireAtomicLease(file, 30);
  await lease!.release();
  const journal = `${file}.mutation.journal`;
  const sizeAfterRelease = (await stat(journal)).size;

  await new Promise((resolve) => setTimeout(resolve, 60));

  expect((await stat(journal)).size).toBe(sizeAfterRelease);
});

test('release waits behind an earlier live mutation ticket then removes its own lock', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const lease = await acquireAtomicLease(file, 1_000);
  const blocker = { ticket: 'earlier', pid: process.pid, host: (await import('node:os')).hostname(), heartbeat: Date.now() };
  await writeFile(`${file}.mutation.journal`, `\n${JSON.stringify(blocker)}\n`);

  const releasing = lease!.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(`${file}.mutation.journal`, `\n${JSON.stringify(blocker)}\n${JSON.stringify({ ticket: 'earlier', released: true })}\n`);
  await releasing;

  expect(await acquireAtomicLease(file, 1_000)).not.toBeNull();
});

test('a timed-out release remains retryable and keeps renewing until removal succeeds', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  // staleMs must outlast the whole retry sweep below, or the blocker ages out mid-release
  // and the removal succeeds instead of timing out. Renewals stay blocked until it does
  // age out, which is what the heartbeat poll then observes. The sweep needs enough
  // attempts for the final release to step around a renewal holding the mutation lock,
  // while still summing to far less than staleMs so the first release fails.
  const staleMs = 600;
  const lease = await acquireAtomicLease(file, staleMs, Date.now, { releaseRetryDelays: [0, 1, 2, 4, 8, 16] });
  const blocker = { ticket: 'earlier', pid: process.pid, host: (await import('node:os')).hostname(), heartbeat: Date.now() };
  await writeFile(`${file}.mutation.journal`, `\n${JSON.stringify(blocker)}\n`);

  await expect(lease!.release()).rejects.toThrow('Timed out releasing atomic lease');
  const firstHeartbeat = JSON.parse(await readFile(file, 'utf8')).heartbeat as number;
  await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).heartbeat, { timeout: 2_000 }).not.toBe(firstHeartbeat);
  await writeFile(`${file}.mutation.journal`, `\n${JSON.stringify(blocker)}\n${JSON.stringify({ ticket: 'earlier', released: true })}\n`);

  await lease!.release();
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('serializes concurrent stale takeovers so exactly one contender owns the lock', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  await writeFile(file, JSON.stringify({ token: 'stale-owner', createdAt: 0 }));

  const contenders = await Promise.all(Array.from({ length: 20 }, () => acquireAtomicLease(file, 1, () => 10)));
  const owners = contenders.filter((lease): lease is NonNullable<typeof lease> => lease !== null);

  expect(owners).toHaveLength(1);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ token: owners[0]!.token });
  await Promise.all(owners.map((lease) => lease.release()));
});

test('recovers an orphaned mutation guard before safely taking over a stale lease', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const now = Date.now();
  await writeFile(file, JSON.stringify({ token: 'stale-owner', createdAt: now - 10_000 }));
  await mkdir(`${file}.mutation`);
  await utimes(`${file}.mutation`, new Date(now - 10_000), new Date(now - 10_000));

  const lease = await acquireAtomicLease(file, 1_000, () => now);

  expect(lease).not.toBeNull();
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ token: lease!.token });
});

test('two contenders safely elect one mutation owner after a stale guard generation', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const now = Date.now();
  await writeFile(file, JSON.stringify({ token: 'stale-owner', createdAt: now - 10_000 }));
  const guard = join(`${file}.mutation`, 'orphaned-owner');
  await mkdir(guard, { recursive: true });
  await utimes(guard, new Date(now - 10_000), new Date(now - 10_000));

  const contenders = await Promise.all([acquireAtomicLease(file, 1_000, () => now), acquireAtomicLease(file, 1_000, () => now)]);
  const owners = contenders.filter((lease): lease is NonNullable<typeof lease> => lease !== null);

  expect(owners).toHaveLength(1);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ token: owners[0]!.token });
});

test('an earlier live mutation owner wins even when a later contender has a lexically earlier token', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  await writeFile(file, JSON.stringify({ token: 'stale-owner', createdAt: 0 }));
  let owned!: () => void;
  let resume!: () => void;
  const firstOwned = new Promise<void>((resolve) => { owned = resolve; });
  const firstResume = new Promise<void>((resolve) => { resume = resolve; });
  const first = acquireAtomicLease(file, 1, () => 10, {
    token: () => 'z-first',
    afterMutationOwnership: async () => { owned(); await firstResume; },
  });

  await firstOwned;
  const later = await acquireAtomicLease(file, 1, () => 10, { token: () => 'a-later' });
  expect(later).toBeNull();
  resume();
  expect(await first).not.toBeNull();
});

test('skips a stale PID-reuse ticket and ignores a torn final journal record', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  await writeFile(file, JSON.stringify({ token: 'stale-owner', createdAt: 0 }));
  await writeFile(`${file}.mutation.journal`, `${JSON.stringify({ ticket: 'old', pid: process.pid, host: 'localhost', heartbeat: 0 })}\n{\"ticket\":`);

  const lease = await acquireAtomicLease(file, 10, () => 100);

  expect(lease).not.toBeNull();
});

test('compacts a large quiescent journal below the fixed cap', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  await writeFile(file, JSON.stringify({ token: 'stale-owner', createdAt: 0 }));
  await writeFile(`${file}.mutation.journal`, Array.from({ length: 1_100 }, (_, index) => JSON.stringify({ ticket: `old-${index}`, released: true })).join('\n'));

  const lease = await acquireAtomicLease(file, 1, () => 10);

  expect(lease).not.toBeNull();
  expect((await stat(`${file}.mutation.journal`)).size).toBeLessThan(128 * 1024);
});

test('release leaves a newer lock intact', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const lease = await acquireAtomicLease(file, 10_000, () => 100);
  await writeFile(file, JSON.stringify({ token: 'new-owner', createdAt: 101 }));

  await lease!.release();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: 'new-owner', createdAt: 101 });
});

test('release cannot remove a replacement while a serialized mutation is in progress', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const original = await acquireAtomicLease(file, 1, () => 0);
  const guard = join(`${file}.mutation`, '!active-owner');
  await mkdir(guard, { recursive: true });
  const release = original!.release();
  await writeFile(file, JSON.stringify({ token: 'replacement', createdAt: 10 }));
  await rmdir(guard);
  await release;

  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: 'replacement', createdAt: 10 });
});

test('releases after an action fails', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const lease = await acquireAtomicLease(file, 10_000);

  await expect((async () => {
    try {
      throw new Error('failed action');
    } finally {
      await lease!.release();
    }
  })()).rejects.toThrow('failed action');
  expect(await acquireAtomicLease(file, 10_000)).not.toBeNull();
});
