import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { DeliveryLedger } from '../../src/notifications/delivery-ledger.ts';
import type { NotificationEvent } from '../../src/notifications/notification-events.ts';
import { acquireAtomicLease } from '../../src/storage/atomic-file.ts';

const directories: string[] = [];
const delay = async () => {};
async function directory() { const value = await mkdtemp(join(tmpdir(), 'notification-ledger-')); directories.push(value); return value; }
function event(fingerprint: string): NotificationEvent { return { kind: 'ciFailed', issue: 1, title: 'CI failed', message: 'CI failed', fingerprint, prUrl: null }; }
afterEach(async () => { await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });

test('claims an event when contention clears at the end of the retry window', async () => {
  const storage = await directory();
  // The holder must heartbeat faster than the 1 s window DeliveryLedger acquires with,
  // or it reads as stale between beats and gets taken over before the last backoff.
  const held = await acquireAtomicLease(join(storage, 'notifications.lock'), 600);
  let elapsed = 0;
  const ledger = new DeliveryLedger(storage, async (ms) => {
    elapsed += ms;
    if (elapsed === 155) await held!.release();
  });

  try {
    await expect(ledger.claim(event('after-final-retry'))).resolves.toBe(true);
  } finally {
    await held!.release();
  }
});

test('fails closed without replacing malformed ledger contents', async () => {
  const storage = await directory();
  const ledgerPath = join(storage, 'notifications.json');
  await writeFile(ledgerPath, '{not-json', 'utf8');

  await expect(new DeliveryLedger(storage, delay).claim(event('malformed'))).resolves.toBe(false);
  await expect(readFile(ledgerPath, 'utf8')).resolves.toBe('{not-json');
});

test('keeps only the newest 500 fingerprints', async () => {
  const storage = await directory();
  const ledger = new DeliveryLedger(storage, delay);
  const persisted = Array.from({ length: 500 }, (_, index) => `event-${index}`);
  await writeFile(join(storage, 'notifications.json'), JSON.stringify({ fingerprints: persisted }), 'utf8');
  await expect(ledger.claim(event('new'))).resolves.toBe(true);
  await expect(ledger.claim(event('new'))).resolves.toBe(false);
  await expect(ledger.claim(event('event-498'))).resolves.toBe(false);
  await expect(ledger.claim(event('event-499'))).resolves.toBe(true);
});
