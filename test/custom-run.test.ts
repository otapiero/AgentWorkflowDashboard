import { describe, expect, it } from 'vitest';

import { customPhase, resolveRunPhase } from '../src/shared/custom-run.ts';
import type { PhaseConfig } from '../src/shared/types.ts';

const pipeline: PhaseConfig[] = [
  { id: 'plan', label: 'Plan', actor: 'codex', command: 'mc-planner', spawnable: true, gate: { type: 'manual' } },
  { id: 'implement', label: 'Implement', actor: 'claude', command: 'mc-implementer', spawnable: true, gate: { type: 'manual' } },
];

const source = { pipeline, agentNames: ['claude', 'codex'] };

describe('customPhase', () => {
  it('inherits the plan phase actor', () => {
    expect(customPhase(source).actor).toBe('codex');
  });

  it('falls back to the first configured agent when there is no plan phase', () => {
    const noPlan = { pipeline: [pipeline[1]!], agentNames: ['copilot'] };
    expect(customPhase(noPlan).actor).toBe('copilot');
  });
});

describe('resolveRunPhase', () => {
  it('returns the synthetic phase for the custom id', () => {
    expect(resolveRunPhase(source, 'custom')!.label).toBe('Custom run');
  });

  it('returns a real pipeline phase by id', () => {
    expect(resolveRunPhase(source, 'implement')!.command).toBe('mc-implementer');
  });

  it('returns null for an unknown id and for undefined', () => {
    expect(resolveRunPhase(source, 'nope')).toBeNull();
    expect(resolveRunPhase(source, undefined)).toBeNull();
  });
});
