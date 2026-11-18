import { describe, expect, it } from 'vitest';

import { resolveRunPhase } from '../src/shared/custom-run.ts';
import type { PhaseConfig } from '../src/shared/types.ts';

const pipeline: PhaseConfig[] = [
  { id: 'plan', label: 'Plan', actor: 'codex', command: 'mc-planner', spawnable: true, gate: { type: 'manual' } },
  { id: 'implement', label: 'Implement', actor: 'claude', command: 'mc-implementer', spawnable: true, gate: { type: 'manual' } },
];

const source = { pipeline, agentNames: ['claude', 'codex'] };

describe('resolveRunPhase', () => {
  it('inherits the plan phase actor', () => {
    expect(resolveRunPhase(source, 'custom')?.actor).toBe('codex');
  });

  it('falls back to the first configured agent when there is no plan phase', () => {
    const noPlan = { pipeline: [pipeline[1]!], agentNames: ['copilot'] };
    expect(resolveRunPhase(noPlan, 'custom')?.actor).toBe('copilot');
  });

  it('returns null for an unknown id and for undefined', () => {
    expect(resolveRunPhase(source, 'nope')).toBeNull();
    expect(resolveRunPhase(source, undefined)).toBeNull();
  });
});
