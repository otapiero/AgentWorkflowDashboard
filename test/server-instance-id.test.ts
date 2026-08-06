import { afterEach, describe, expect, test } from 'vitest';

import { createHealthResponse } from '../src/server/health.ts';

const original = process.env.MC_INSTANCE_ID;

afterEach(() => {
  if (original === undefined) delete process.env.MC_INSTANCE_ID;
  else process.env.MC_INSTANCE_ID = original;
});

/**
 * The spawner cannot identify the server it started by PID: it launches
 * `npm.cmd start`, which forks cmd -> tsx -> node, so the PID it holds is the
 * npm wrapper's while the server reports its own. The instance id is the only
 * identity that survives that chain.
 */
describe('health instance id', () => {
  test('echoes MC_INSTANCE_ID so a spawner can recognise its own server', () => {
    process.env.MC_INSTANCE_ID = 'abc-123';
    expect(createHealthResponse('0.1.0').instanceId).toBe('abc-123');
  });

  test('is null for a server nobody claimed, such as a manual npm start', () => {
    delete process.env.MC_INSTANCE_ID;
    expect(createHealthResponse('0.1.0').instanceId).toBeNull();
  });

  test('an explicit id overrides the environment', () => {
    process.env.MC_INSTANCE_ID = 'from-env';
    expect(createHealthResponse('0.1.0', undefined, 'explicit').instanceId).toBe('explicit');
  });

  test('treats a blank id as unclaimed rather than matchable', () => {
    process.env.MC_INSTANCE_ID = '';
    expect(createHealthResponse('0.1.0').instanceId).toBeNull();
  });
});
