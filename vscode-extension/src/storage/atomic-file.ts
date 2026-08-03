import { mkdir, open, readdir, readFile, rmdir, rm, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicLease {
  token: string;
  release(): Promise<void>;
}

interface LeaseRecord { token: string; createdAt: number }

/**
 * Serializes mutations with generation-named owner directories. Owners are
 * never replaced in-place: stale recovery removes only a specific generation.
 */
async function withMutationLock<T>(
  file: string,
  staleMs: number,
  now: () => number,
  action: () => Promise<T>,
): Promise<T | null> {
  const guardRoot = `${file}.mutation`;
  await mkdir(guardRoot, { recursive: true });
  const ownerName = randomUUID();
  const owner = `${guardRoot}/${ownerName}`;
  await mkdir(owner);

  const entries = await readdir(guardRoot, { withFileTypes: true });
  const liveOwners: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = `${guardRoot}/${entry.name}`;
    if (entry.name === ownerName) {
      liveOwners.push(entry.name);
      continue;
    }
    try {
      if (now() - (await stat(candidate)).mtimeMs > staleMs) {
        await rm(candidate, { recursive: true, force: true });
      } else {
        liveOwners.push(entry.name);
      }
    } catch {
      // A concurrent owner may have finished; a fresh contender will decide.
    }
  }
  if (ownerName !== liveOwners.sort()[0]) {
    await rmdir(owner);
    return null;
  }
  try {
    return await action();
  } finally {
    await rmdir(owner);
  }
}

async function readRecord(file: string): Promise<LeaseRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (typeof value === 'object' && value !== null
      && typeof (value as { token?: unknown }).token === 'string'
      && typeof (value as { createdAt?: unknown }).createdAt === 'number') {
      return value as LeaseRecord;
    }
  } catch {
    // A lock being removed concurrently is indistinguishable from an unusable lock.
  }
  return null;
}

export async function acquireAtomicLease(
  file: string,
  staleMs: number,
  now: () => number = Date.now,
): Promise<AtomicLease | null> {
  await mkdir(dirname(file), { recursive: true });
  const token = randomUUID();
  const createdAt = now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ token, createdAt }));
      await handle.close();
      return {
        token,
        async release(): Promise<void> {
          await withMutationLock(file, staleMs, now, async () => {
            const current = await readRecord(file);
            if (current?.token === token) {
              try { await unlink(file); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
          });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const removed = await withMutationLock(file, staleMs, now, async () => {
        const existing = await readRecord(file);
        if (!existing || now() - existing.createdAt <= staleMs) return false;
        try { await unlink(file); return true; } catch (unlinkError) {
          return (unlinkError as NodeJS.ErrnoException).code === 'ENOENT';
        }
      });
      if (!removed || attempt === 1) return null;
    }
  }
  return null;
}
