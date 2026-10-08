import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { acquireAtomicLease } from '../storage/atomic-file.ts';
import type { NotificationEvent } from './notification-events.ts';

const RETRY_DELAYS = [5, 10, 20, 40, 80];
const ENTRY_CAP = 500;

export class DeliveryLedger {
  constructor(private readonly storagePath: string, private readonly delay: (ms: number) => Promise<void>) {}

  async claim(event: NotificationEvent): Promise<boolean> {
    const lock = join(this.storagePath, 'notifications.lock');
    for (let retry = -1; retry < RETRY_DELAYS.length; retry += 1) {
      if (retry >= 0) await this.delay(RETRY_DELAYS[retry]!);
      const lease = await acquireAtomicLease(lock, 1_000);
      if (lease === null) {
        continue;
      }
      try {
        const fingerprints = await this.readEntries();
        if (fingerprints === null) return false;
        if (fingerprints.includes(event.fingerprint)) return false;
        const next = [event.fingerprint, ...fingerprints].slice(0, ENTRY_CAP);
        const destination = join(this.storagePath, 'notifications.json');
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ fingerprints: next }), 'utf8');
          await rename(temporary, destination);
          return true;
        } catch {
          await rm(temporary, { force: true }).catch(() => {});
          return false;
        }
      } finally {
        await lease.release();
      }
    }
    return false;
  }

  private async readEntries(): Promise<readonly string[] | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.storagePath, 'notifications.json'), 'utf8'));
      const fingerprints = (parsed as { fingerprints?: unknown }).fingerprints;
      return Array.isArray(fingerprints) && fingerprints.every((value) => typeof value === 'string') ? fingerprints : null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
  }
}
