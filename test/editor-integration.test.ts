import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toEditorIntegration } from '../src/orchestrator/editor-integration.ts';
import type { Facts } from '../src/shared/types.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-editor-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    issue: 3060,
    worktreeExists: true,
    branchExists: true,
    markers: [],
    planMdExists: true,
    artifacts: [],
    hasPushedCommits: true,
    dirtyFileCount: 0,
    unpushedCommits: 0,
    liveSpawn: {
      phase: 'implement',
      pid: 42,
      startedAt: '2026-08-03T09:00:00.000Z',
      source: 'marker',
    },
    pr: { exists: true, number: 99, url: 'https://github.test/pr/99', state: 'OPEN' },
    checks: 'success',
    review: { decision: 'REVIEW_REQUIRED', unresolvedThreads: 2, copilotUnresolved: 1 },
    ...overrides,
  };
}

describe('toEditorIntegration', () => {
  test('requests approval only when a PR is awaiting review', () => {
    expect(toEditorIntegration(facts()).approvalRequired).toBe(true);
    expect(toEditorIntegration(facts({
      pr: { exists: false, number: null, url: null, state: null },
    })).approvalRequired).toBe(false);
    expect(toEditorIntegration(facts({
      review: { decision: 'APPROVED', unresolvedThreads: 0, copilotUnresolved: 0 },
    })).approvalRequired).toBe(false);
  });
});
