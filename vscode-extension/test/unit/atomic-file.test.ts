import { mkdir, mkdtemp, readFile, rmdir, rm, utimes, writeFile } from 'node:fs/promises';
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
