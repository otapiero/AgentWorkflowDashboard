import { appendFile, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface AtomicLease {
  token: string;
  release(): Promise<void>;
}

interface LeaseRecord { token: string; createdAt: number }

interface MutationTicket { ticket: string; pid?: number; host?: string; heartbeat?: number; released?: boolean }
const JOURNAL_RECORD_CAP = 1_000;
const JOURNAL_BYTE_CAP = 128 * 1024;

export interface AtomicLeaseTestHooks {
  token?: () => string;
  afterMutationOwnership?: () => Promise<void>;
}

/**
 * Serializes mutations by append order. The journal is never rewritten while
 * acquiring, so concurrent contenders cannot replace or reorder one another.
 */
async function withMutationLock<T>(
  file: string,
  staleMs: number,
  now: () => number,
  hooks: AtomicLeaseTestHooks | undefined,
  action: () => Promise<T>,
): Promise<T | null> {
  const journal = `${file}.mutation.journal`;
  const ticket = hooks?.token?.() ?? randomUUID();
  // Leading separator prevents a torn final record from consuming the next ticket.
  const append = async (entry: MutationTicket): Promise<void> => {
    const serialized = JSON.stringify(entry);
    for (;;) {
      await appendFile(journal, `\n${serialized}\n`);
      try {
        if ((await readFile(journal, 'utf8')).split('\n').some((line) => {
          try {
            const record = JSON.parse(line) as MutationTicket;
            return record.ticket === entry.ticket && record.released === entry.released && record.heartbeat === entry.heartbeat;
          } catch { return false; }
        })) return;
      } catch { /* A concurrent rotator moved this generation; append again. */ }
    }
  };
  await append({ ticket, pid: process.pid, host: hostname(), heartbeat: now() });
  const heartbeatInterval = setInterval(() => { void append({ ticket, heartbeat: now() }); }, Math.max(1, Math.floor(staleMs / 3)));
  try {
    await hooks?.afterMutationOwnership?.();
    const text = await readFile(journal, 'utf8');
    const tickets = new Map<string, MutationTicket>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as MutationTicket;
        if (entry.released) tickets.delete(entry.ticket);
        else if (typeof entry.ticket === 'string') {
          const prior = tickets.get(entry.ticket);
          tickets.set(entry.ticket, { ...prior, ...entry });
        }
      } catch { /* Ignore a torn final append; it cannot own the mutation. */ }
    }
    let owner: string | undefined;
    for (const entry of tickets.values()) {
      if (typeof entry.pid !== 'number' || typeof entry.host !== 'string' || typeof entry.heartbeat !== 'number') continue;
      if (now() - entry.heartbeat > staleMs) continue;
      if (entry.host !== hostname()) { owner = entry.ticket; break; }
      try { process.kill(entry.pid, 0); owner = entry.ticket; break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { owner = entry.ticket; break; }
      }
    }
    if (owner !== ticket) return null;
    return await action();
  } finally {
    clearInterval(heartbeatInterval);
    await append({ ticket, released: true });
    await rotateIfQuiescent(journal, staleMs, now);
  }
}

async function rotateIfQuiescent(journal: string, staleMs: number, now: () => number): Promise<void> {
  let text: string;
  try {
    const details = await stat(journal);
    text = await readFile(journal, 'utf8');
    if (details.size < JOURNAL_BYTE_CAP && text.split('\n').length < JOURNAL_RECORD_CAP) return;
  } catch { return; }
  const active = new Map<string, MutationTicket>();
  for (const line of text.split('\n')) {
    try {
      const entry = JSON.parse(line) as MutationTicket;
      if (entry.released) active.delete(entry.ticket);
      else if (entry.ticket) active.set(entry.ticket, { ...active.get(entry.ticket), ...entry });
    } catch { /* torn records are not active */ }
  }
  for (const entry of active.values()) {
    if (typeof entry.pid !== 'number' || typeof entry.host !== 'string' || typeof entry.heartbeat !== 'number') continue;
    if (now() - entry.heartbeat > staleMs) continue;
    if (entry.host !== hostname()) return;
    try { process.kill(entry.pid, 0); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
    }
  }
  const archive = `${journal}.${randomUUID()}.archive`;
  try {
    await rename(journal, archive);
    await writeFile(journal, '');
    await rm(archive, { force: true });
  } catch { /* A concurrent rotator won; the current generation remains valid. */ }
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
