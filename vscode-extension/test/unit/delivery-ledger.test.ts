import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('atomically allows one window to claim an event', async () => {
  const storage = await directory();
  const [first, second] = await Promise.all([new DeliveryLedger(storage, delay).claim(event('same')), new DeliveryLedger(storage, delay).claim(event('same'))]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
});

test('uses every configured backoff then makes a final lease attempt', async () => {
  const storage = await directory();
  const held = await acquireAtomicLease(join(storage, 'notifications.lock'), 10_000);
  const delays: number[] = [];
  const ledger = new DeliveryLedger(storage, async (ms) => {
    delays.push(ms);
    if (ms === 80) await held!.release();
  });

  await expect(ledger.claim(event('after-final-retry'))).resolves.toBe(true);
  expect(delays).toEqual([5, 10, 20, 40, 80]);
});

test('fails closed without replacing malformed ledger contents', async () => {
  const storage = await directory();
  const ledgerPath = join(storage, 'notifications.json');
  await writeFile(ledgerPath, '{not-json', 'utf8');

  await expect(new DeliveryLedger(storage, delay).claim(event('malformed'))).resolves.toBe(false);
  await expect(readFile(ledgerPath, 'utf8')).resolves.toBe('{not-json');
});

test('fails closed when the ledger cannot be read', async () => {
  const storage = await directory();
  await mkdir(join(storage, 'notifications.json'));

  await expect(new DeliveryLedger(storage, delay).claim(event('unreadable'))).resolves.toBe(false);
});

test('keeps only the newest 500 fingerprints', async () => {
  const storage = await directory();
  const ledger = new DeliveryLedger(storage, delay);
  await writeFile(join(storage, 'notifications.json'), JSON.stringify({ fingerprints: Array.from({ length: 499 }, (_, index) => `event-${498 - index}`) }), 'utf8');
  await expect(ledger.claim(event('event-499'))).resolves.toBe(true);
  await expect(ledger.claim(event('event-500'))).resolves.toBe(true);
  expect(JSON.parse(await readFile(join(storage, 'notifications.json'), 'utf8')).fingerprints).toEqual(['event-500', 'event-499', ...Array.from({ length: 498 }, (_, index) => `event-${498 - index}`)]);
});
