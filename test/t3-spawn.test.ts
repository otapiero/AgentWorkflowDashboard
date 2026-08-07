import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getT3ProjectId, setT3ProjectId } from '../src/orchestrator/state.ts';
import { resolveT3Launch } from '../src/orchestrator/spawn.ts';
import type { AgentProfile, PhaseConfig } from '../src/shared/types.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('T3 project id persistence', () => {
  test('a board that has never spawned through T3 has no project', () => {
    expect(getT3ProjectId()).toBeNull();
  });

  test('the project id survives a round trip so later spawns reuse it', () => {
    setT3ProjectId('proj-1');
    expect(getT3ProjectId()).toBe('proj-1');
  });
});

describe('resolveT3Launch', () => {
  const codex: AgentProfile = {
    launch: 'codex',
    promptMode: 'positional',
    instructionMode: 'inline',
    t3Instance: 'codex',
  };
  const plan = {
    id: 'plan',
    label: 'Plan',
    actor: 'codex',
    gate: { type: 'manual' },
  } as PhaseConfig;

  test('refuses an agent that has no T3 instance, naming the agent', () => {
    const { t3Instance, ...noInstance } = codex;
    const result = resolveT3Launch({
      agent: 'codex',
      profile: noInstance as AgentProfile,
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('codex');
    expect(result.error).toContain('t3Instance');
  });

  test('refuses when the provider instance is not ready, quoting T3s reason', () => {
    const result = resolveT3Launch({
      agent: 'copilot',
      profile: { ...codex, t3Instance: 'opencode' },
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({
        instanceId: 'opencode',
        ready: false,
        reason: 'OpenCode CLI (`opencode`) is not installed or not on PATH',
        models: [],
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('not installed');
  });

  test('refuses when no concrete model is resolvable', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: plan,
      model: 'default',
      effort: null,
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    expect(result.ok).toBe(false);
  });

  test('resolves the model selection and the phase modes when everything is ready', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: 'high',
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.modelSelection).toEqual({
      instanceId: 'codex',
      model: 'gpt-5.6-sol',
      options: [{ id: 'effort', value: 'high' }],
    });
    expect(result.modes).toEqual({ runtimeMode: 'approval-required', interactionMode: 'plan' });
  });

  test('a phase with no configured modes still never gets full-access', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: { ...plan, id: 'merge' } as PhaseConfig,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.modes.runtimeMode).not.toBe('full-access');
  });
});
