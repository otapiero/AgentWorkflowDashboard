import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('release leaves a newer lock intact', async () => {
  const directory = await temporaryDirectory();
  const file = join(directory, 'start.lock');
  const lease = await acquireAtomicLease(file, 10_000, () => 100);
  await writeFile(file, JSON.stringify({ token: 'new-owner', createdAt: 101 }));

  await lease!.release();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: 'new-owner', createdAt: 101 });
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
