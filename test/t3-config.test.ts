import { describe, expect, test } from 'vitest';

import { parseConfig } from '../src/orchestrator/config.ts';
import { t3ModesForPhase } from '../src/shared/types.ts';
import type { PhaseConfig } from '../src/shared/types.ts';

const base = `
repo:
  path: 'C:\\src\\widgets'
  owner: 'acme'
  name: 'widgets'
  baseBranch: 'dev'
  branchPrefix: 'alice'
github:
  auth: gh-cli
  pollIntervalSeconds: 30
  copilotReviewerLogin: 'copilot-pull-request-reviewer'
server:
  port: 4317
agents:
  claude:
    launch: 'claude'
    promptMode: positional
    instructionMode: flag
    instructionFlag: '--append-system-prompt'
    t3Instance: 'claudeAgent'
pipeline:
  - id: plan
    label: Plan
    actor: claude
    gate: { type: manual }
    t3:
      runtimeMode: approval-required
      interactionMode: plan
`;

describe('t3 config', () => {
  test('accepts settings needed to run a phase through T3', () => {
    const config = parseConfig(`${base}launcher: t3\n`);
    expect(config.launcher).toBe('t3');
    expect(config.agents.claude?.t3Instance).toBe('claudeAgent');
    expect(config.pipeline[0]?.t3).toEqual({ runtimeMode: 'approval-required', interactionMode: 'plan' });
  });

  test('a phase block with only one of the two modes is rejected', () => {
    // Half a mode pair is exactly the mistake that would silently inherit
    // T3's full-access default.
    const bad = base.replace('      interactionMode: plan\n', '');
    expect(() => parseConfig(bad)).toThrow(/interactionMode/);
  });
});

describe('t3ModesForPhase', () => {
  const phase = (id: string, t3?: PhaseConfig['t3']): PhaseConfig =>
    ({ id, label: id, actor: 'claude', gate: { type: 'manual' }, t3 }) as PhaseConfig;

  test('a configured phase uses its own modes', () => {
    expect(
      t3ModesForPhase(phase('plan', { runtimeMode: 'auto', interactionMode: 'default' })),
    ).toEqual({ runtimeMode: 'auto', interactionMode: 'default' });
  });

  /**
   * Every agent phase should get the operator's requested unrestricted mode,
   * including a new phase that has no explicit configuration yet.
   */
  test('an unlisted phase falls back to full access', () => {
    const modes = t3ModesForPhase(phase('some_new_phase'));
    expect(modes.runtimeMode).toBe('full-access');
    expect(modes.interactionMode).toBe('default');
  });
});
