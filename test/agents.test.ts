import { describe, expect, test } from 'vitest';
import { resolveAgentModel } from '../src/orchestrator/agents.ts';
import type { Config, TaskRecord } from '../src/shared/types.ts';

const config = {
  agents: {
    claude: {
      launch: 'claude',
      promptMode: 'positional',
      instructionMode: 'flag',
      model: 'default',
    },
    copilot: {
      launch: 'copilot',
      promptMode: 'flag',
      promptFlag: '-i',
      instructionMode: 'inline',
      model: 'default',
    },
  },
  pipeline: [
    { id: 'plan', label: 'Plan', actor: 'claude', command: 'mc-planner', gate: { type: 'manual' } },
    { id: 'ci', label: 'CI', actor: 'none', gate: { type: 'auto', signal: 'checks_green' } },
    { id: 'merge', label: 'Merge', actor: 'you', gate: { type: 'manual' } },
  ],
} as unknown as Config;

function task(overrides?: TaskRecord['overrides']): TaskRecord {
  return {
    issue: 3060,
    title: 'x',
    slug: 'x',
    branch: 'ouriel/3060-x',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    overrides,
    spawnHistory: [],
    lastReconciledAt: null,
  };
}

describe('resolveAgentModel', () => {
  test('falls back to the phase actor when nothing is pinned', () => {
    const r = resolveAgentModel(config, task(), 'plan', {});
    expect(r.agent).toBe('claude');
  });

  test("normalises a model of 'default' to null", () => {
    expect(resolveAgentModel(config, task(), 'plan', {}).model).toBeNull();
  });

  test('a phase default overrides the phase actor', () => {
    const r = resolveAgentModel(config, task(), 'plan', {
      plan: { agent: 'copilot' },
    });
    expect(r.agent).toBe('copilot');
  });

  test('a per-task pin overrides the phase default', () => {
    const r = resolveAgentModel(config, task({ agent: 'claude' }), 'plan', {
      plan: { agent: 'copilot' },
    });
    expect(r.agent).toBe('claude');
  });

  test('a one-time choice overrides everything', () => {
    const r = resolveAgentModel(
      config,
      task({ agent: 'claude' }),
      'plan',
      { plan: { agent: 'claude' } },
      { agent: 'copilot' },
    );
    expect(r.agent).toBe('copilot');
  });

  test('the model resolves through the same precedence', () => {
    expect(
      resolveAgentModel(config, task({ model: 'opus' }), 'plan', {}).model,
    ).toBe('opus');
    expect(
      resolveAgentModel(config, task(), 'plan', { plan: { model: 'haiku' } }).model,
    ).toBe('haiku');
    expect(
      resolveAgentModel(config, task({ model: 'opus' }), 'plan', {}, { model: 'sonnet' })
        .model,
    ).toBe('sonnet');
  });

  test('a model pin can accompany a different agent pin', () => {
    const r = resolveAgentModel(config, task(), 'plan', {
      plan: { agent: 'copilot', model: 'gpt-5' },
    });
    expect(r).toEqual({ agent: 'copilot', model: 'gpt-5' });
  });

  test('a non-agent phase resolves to no agent and no model', () => {
    // CI has no actor to spawn, so there is nothing to pin.
    expect(resolveAgentModel(config, task(), 'ci', {})).toEqual({
      agent: null,
      model: null,
    });
  });

  test('an unknown phase id resolves to no agent', () => {
    expect(resolveAgentModel(config, task(), 'inbox', {}).agent).toBeNull();
  });

  test('a pin naming an unconfigured agent is ignored in favour of the actor', () => {
    // Defensive: stale state must not select an agent that no longer exists.
    const r = resolveAgentModel(config, task({ agent: 'gemini' }), 'plan', {});
    expect(r.agent).toBe('claude');
  });

  test('a task pinned to an agent still resolves that agent at a you-phase', () => {
    // The pin is explicit intent and should surface even where the phase
    // itself has no default agent.
    expect(resolveAgentModel(config, task({ agent: 'copilot' }), 'merge', {}).agent).toBe(
      'copilot',
    );
  });
});
