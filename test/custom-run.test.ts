import { describe, expect, it } from 'vitest';

import {
  CUSTOM_RUN_ID,
  customPhase,
  isCustomRun,
  resolveRunPhase,
} from '../src/shared/custom-run.ts';
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

  it('is spawnable, repeatable, and renders from mc-custom', () => {
    const phase = customPhase(source);
    expect(phase.id).toBe(CUSTOM_RUN_ID);
    expect(phase.spawnable).toBe(true);
    expect(phase.repeatable).toBe(true);
    expect(phase.command).toBe('mc-custom');
  });

  it('starts T3 with full access like the other run types', () => {
    expect(customPhase(source).t3).toEqual({
      runtimeMode: 'full-access',
      interactionMode: 'default',
    });
  });

  it('never becomes part of the pipeline, so it can never become a lane or a gate', () => {
    customPhase(source);
    expect(pipeline.map((p) => p.id)).toEqual(['plan', 'implement']);
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

describe('isCustomRun', () => {
  it('recognises the synthetic phase', () => {
    expect(isCustomRun(customPhase(source))).toBe(true);
  });

  it('rejects every real pipeline phase', () => {
    expect(pipeline.some(isCustomRun)).toBe(false);
  });
});
