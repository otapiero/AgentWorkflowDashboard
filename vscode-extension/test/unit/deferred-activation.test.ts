import { expect, test } from 'vitest';

import { DeferredActivation } from '../../src/deferred-activation.ts';

test('cancels a deferred activation before its callback can start resources', async () => {
  let run: (() => void) | undefined;
  let started = 0;
  const activation = new DeferredActivation((callback) => { run = callback; return 1 as never; }, () => {}, async () => { started += 1; });

  activation.schedule();
  activation.dispose();
  run!();

  await expect(activation.ready).rejects.toThrow('activation cancelled');
  expect(started).toBe(0);
});

test('runs once and settles readiness during normal activation', async () => {
  let run: (() => void) | undefined;
  let started = 0;
  const activation = new DeferredActivation((callback) => { run = callback; return 1 as never; }, () => {}, async () => { started += 1; });

  activation.schedule();
  run!();
  await expect(activation.ready).resolves.toBeUndefined();
  activation.dispose();

  expect(started).toBe(1);
});
