import { mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface AtomicLease {
  token: string;
  release(): Promise<void>;
}

interface LeaseRecord { token: string; createdAt: number }

/** Serializes check-and-remove mutations without ever deleting a replacement. */
async function withMutationLock<T>(file: string, action: () => Promise<T>): Promise<T | null> {
  const guard = `${file}.mutation`;
  try {
    await mkdir(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  try {
    return await action();
  } finally {
    await rmdir(guard);
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
          await withMutationLock(file, async () => {
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
      const removed = await withMutationLock(file, async () => {
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
