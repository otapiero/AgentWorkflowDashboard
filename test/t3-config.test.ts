import { describe, expect, test } from 'vitest';

import { parseConfig } from '../src/orchestrator/config.ts';
import { DEFAULT_T3_MODES, t3ModesForPhase } from '../src/shared/types.ts';
import type { PhaseConfig } from '../src/shared/types.ts';

const base = `
repo:
  path: 'C:\\repo'
  owner: 'acme'
  name: 'widgets'
  baseBranch: 'dev'
  branchPrefix: 'ouriel'
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
  test("accepts 't3' as a launcher", () => {
    const config = parseConfig(`${base}launcher: t3\n`);
    expect(config.launcher).toBe('t3');
  });

  test('still accepts the two existing launchers', () => {
    expect(parseConfig(`${base}launcher: wt\n`).launcher).toBe('wt');
    expect(parseConfig(`${base}launcher: vscode\n`).launcher).toBe('vscode');
  });

  test('rejects an unknown launcher by name', () => {
    expect(() => parseConfig(`${base}launcher: emacs\n`)).toThrow(/launcher/);
  });

  test('reads t3Instance off an agent profile', () => {
    expect(parseConfig(base).agents.claude?.t3Instance).toBe('claudeAgent');
  });

  test('t3Instance is optional — an agent without one is still valid config', () => {
    const without = base.replace("    t3Instance: 'claudeAgent'\n", '');
    expect(parseConfig(without).agents.claude?.t3Instance).toBeUndefined();
  });

  test('reads per-phase runtime and interaction modes', () => {
    const phase = parseConfig(base).pipeline[0]!;
    expect(phase.t3).toEqual({ runtimeMode: 'approval-required', interactionMode: 'plan' });
  });

  test('rejects an unknown runtime mode rather than passing it to T3', () => {
    const bad = base.replace('approval-required', 'yolo');
    expect(() => parseConfig(bad)).toThrow(/runtimeMode/);
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

  test('plan defaults to approval-required in plan mode', () => {
    expect(t3ModesForPhase(phase('plan'))).toEqual({
      runtimeMode: 'approval-required',
      interactionMode: 'plan',
    });
  });

  test('implement defaults to auto-accept-edits', () => {
    expect(t3ModesForPhase(phase('implement')).runtimeMode).toBe('auto-accept-edits');
  });

  test('publish defaults to approval-required', () => {
    expect(t3ModesForPhase(phase('publish')).runtimeMode).toBe('approval-required');
  });

  /**
   * The safety property. T3's own decoding default for runtimeMode is
   * `full-access` — an omitted field means "no restrictions", not "be
   * careful". Mission Control must never fall through to it.
   */
  test('an unlisted phase falls back to the most restrictive mode, never full-access', () => {
    const modes = t3ModesForPhase(phase('some_new_phase'));
    expect(modes.runtimeMode).toBe('approval-required');
    expect(modes.interactionMode).toBe('default');
  });

  test('no default is ever full-access', () => {
    for (const modes of Object.values(DEFAULT_T3_MODES)) {
      expect(modes.runtimeMode).not.toBe('full-access');
    }
  });
});
