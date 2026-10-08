import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPlan, writePlan } from '../src/orchestrator/plan.ts';

beforeEach(() => { process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-plan-')); });
afterEach(() => {
  rmSync(process.env.MC_HOME!, { recursive: true, force: true });
  delete process.env.MC_HOME;
});

describe('plan read/write', () => {
  test('reading a plan that does not exist yields null', () => {
    expect(readPlan(1)).toBeNull();
  });

  test('writePlan creates the task dir and file, and round-trips', () => {
    writePlan(1, '# Plan\n- step one\n');
    expect(readPlan(1)).toBe('# Plan\n- step one\n');
  });
});
