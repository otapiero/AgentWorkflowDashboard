import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface AtomicLease {
  token: string;
  release(): Promise<void>;
}

interface LeaseRecord { token: string; createdAt: number }

interface MutationOwner { pid: number; host: string }

export interface AtomicLeaseTestHooks {
  token?: () => string;
  afterMutationOwnership?: () => Promise<void>;
}

/**
 * Serializes mutations with generation-named owner directories. Owners are
 * never replaced in-place: stale recovery removes only a dead/orphaned
 * generation. Live owners are never expired by age.
 */
async function withMutationLock<T>(
  file: string,
  staleMs: number,
  now: () => number,
  hooks: AtomicLeaseTestHooks | undefined,
  action: () => Promise<T>,
): Promise<T | null> {
  const guardRoot = `${file}.mutation`;
  await mkdir(guardRoot, { recursive: true });
  const ownerName = hooks?.token?.() ?? randomUUID();
  const owner = `${guardRoot}/${ownerName}`;
  await mkdir(owner);
  await writeFile(`${owner}/owner.json`, JSON.stringify({ pid: process.pid, host: hostname() } satisfies MutationOwner));

  const entries = await readdir(guardRoot, { withFileTypes: true });
  const liveOwners: Array<{ name: string; birthtimeNs: bigint }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = `${guardRoot}/${entry.name}`;
    const candidateStat = await stat(candidate, { bigint: true });
    let alive = entry.name === ownerName;
    try {
      const record = JSON.parse(await readFile(`${candidate}/owner.json`, 'utf8')) as Partial<MutationOwner>;
      if (typeof record.pid === 'number' && typeof record.host === 'string') {
        if (record.host !== hostname()) {
          alive = true;
        } else {
          try { process.kill(record.pid, 0); alive = true; } catch (error) {
            alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        }
      } else if (entry.name !== ownerName) {
        alive = now() - Number(candidateStat.mtimeMs) <= staleMs;
      }
    } catch {
      if (entry.name !== ownerName) alive = now() - Number(candidateStat.mtimeMs) <= staleMs;
    }
    if (alive) liveOwners.push({ name: entry.name, birthtimeNs: candidateStat.birthtimeNs });
    else await rm(candidate, { recursive: true, force: true });
  }
  liveOwners.sort((left, right) => left.birthtimeNs === right.birthtimeNs
    ? left.name.localeCompare(right.name)
    : left.birthtimeNs < right.birthtimeNs ? -1 : 1);
  if (ownerName !== liveOwners[0]?.name) {
    await rm(owner, { recursive: true, force: true });
    return null;
  }
  try {
    await hooks?.afterMutationOwnership?.();
    return await action();
  } finally {
    await rm(owner, { recursive: true, force: true });
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
  hooks?: AtomicLeaseTestHooks,
): Promise<AtomicLease | null> {
  await mkdir(dirname(file), { recursive: true });
  const token = hooks?.token?.() ?? randomUUID();
  const createdAt = now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ token, createdAt }));
      await handle.close();
      return {
        token,
        async release(): Promise<void> {
          await withMutationLock(file, staleMs, now, hooks, async () => {
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
      const removed = await withMutationLock(file, staleMs, now, hooks, async () => {
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
