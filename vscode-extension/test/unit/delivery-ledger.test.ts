import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { DeliveryLedger } from '../../src/notifications/delivery-ledger.ts';
import type { NotificationEvent } from '../../src/notifications/notification-events.ts';

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

test('keeps only the newest 500 fingerprints', async () => {
  const storage = await directory();
  const ledger = new DeliveryLedger(storage, delay);
  for (let index = 0; index < 510; index += 1) await ledger.claim(event(`event-${index}`));
  expect(JSON.parse(await readFile(join(storage, 'notifications.json'), 'utf8')).fingerprints).toEqual(Array.from({ length: 500 }, (_, index) => `event-${509 - index}`));
}, 20_000);
