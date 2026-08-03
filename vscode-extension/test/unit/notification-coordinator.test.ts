import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { DeliveryLedger } from '../../src/notifications/delivery-ledger.ts';
import { NotificationCoordinator } from '../../src/notifications/notification-coordinator.ts';
import type { NotificationEvent } from '../../src/notifications/notification-events.ts';
import { task } from './fixtures.ts';

const directories: string[] = [];
async function directory() { const value = await mkdtemp(join(tmpdir(), 'notification-coordinator-')); directories.push(value); return value; }
afterEach(async () => { await Promise.all(directories.splice(0).map((value) => rm(value, { recursive: true, force: true }))); });
const delay = async () => {};

test('baselines without delivery and delivers only subsequent enabled events', async () => {
  const calls: NotificationEvent[] = [];
  const coordinator = new NotificationCoordinator(new DeliveryLedger(await directory(), delay), (event) => { calls.push(event); }, { ciFailed: true, ciPassed: false, agentFinished: true, reviewComments: true, approvalRequired: true });
  const baseline = task({ checks: 'success', lastReconciledAt: '2026-08-03T10:00:00.000Z' });
  const failed = task({ checks: 'failure', lastReconciledAt: '2026-08-03T10:01:00.000Z' });
  coordinator.prime([baseline]);
  await coordinator.apply([failed]);
  expect(calls.map(({ kind }) => kind)).toEqual(['ciFailed']);
});

test('does not replay disabled transitions when re-enabled', async () => {
  const calls: NotificationEvent[] = [];
  const enabled = { ciFailed: false, ciPassed: true, agentFinished: true, reviewComments: true, approvalRequired: true };
  const coordinator = new NotificationCoordinator(new DeliveryLedger(await directory(), delay), (event) => { calls.push(event); }, enabled);
  coordinator.prime([task({ checks: 'success', lastReconciledAt: '2026-08-03T10:00:00.000Z' })]);
  await coordinator.apply([task({ checks: 'failure', lastReconciledAt: '2026-08-03T10:01:00.000Z' })]);
  enabled.ciFailed = true;
  await coordinator.apply([task({ checks: 'failure', lastReconciledAt: '2026-08-03T10:02:00.000Z' })]);
  expect(calls).toEqual([]);
});

test('two windows present one claimed event', async () => {
  const storage = await directory(); const first: NotificationEvent[] = []; const second: NotificationEvent[] = [];
  const settings = { ciFailed: true, ciPassed: true, agentFinished: true, reviewComments: true, approvalRequired: true };
  const one = new NotificationCoordinator(new DeliveryLedger(storage, delay), (event) => { first.push(event); }, settings);
  const two = new NotificationCoordinator(new DeliveryLedger(storage, delay), (event) => { second.push(event); }, settings);
  const baseline = task({ checks: 'success', lastReconciledAt: '2026-08-03T10:00:00.000Z' }); const failed = task({ checks: 'failure', lastReconciledAt: '2026-08-03T10:01:00.000Z' });
  one.prime([baseline]); two.prime([baseline]); await Promise.all([one.apply([failed]), two.apply([failed])]);
  expect(first.length + second.length).toBe(1);
});
