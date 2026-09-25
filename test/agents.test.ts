import { describe, expect, test } from 'vitest';
import {
  resolveAgent,
  agentCapabilities,
} from '../src/orchestrator/agents.ts';
import type { AgentProfile, Config, TaskRecord } from '../src/shared/types.ts';

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
    codex: {
      launch: 'codex',
      promptMode: 'positional',
      promptPosition: 'last',
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
    branch: 'alice/3060-x',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    overrides,
    spawnHistory: [],
    lastReconciledAt: null,
  };
}

describe('resolveAgent — agent precedence', () => {
  test('falls back to the phase actor when nothing is pinned', () => {
    expect(resolveAgent(config, task(), 'plan', {}).agent).toBe('claude');
  });

  test('a phase default overrides the phase actor', () => {
    expect(resolveAgent(config, task(), 'plan', { plan: { agent: 'copilot' } }).agent).toBe(
      'copilot',
    );
  });

  test('a per-task pin overrides the phase default', () => {
    expect(
      resolveAgent(config, task({ agent: 'claude' }), 'plan', { plan: { agent: 'copilot' } })
        .agent,
    ).toBe('claude');
  });

  test('a one-time choice overrides everything', () => {
    expect(
      resolveAgent(config, task({ agent: 'claude' }), 'plan', { plan: { agent: 'claude' } }, {
        agent: 'copilot',
      }).agent,
    ).toBe('copilot');
  });

  test('a non-agent phase resolves to no agent', () => {
    expect(resolveAgent(config, task(), 'ci', {}).agent).toBeNull();
  });

  test('a pin naming an unconfigured agent is ignored', () => {
    expect(resolveAgent(config, task({ agent: 'gemini' }), 'plan', {}).agent).toBe('claude');
  });
});

describe('resolveAgent — model', () => {
  test("normalises a model of 'default' to null", () => {
    expect(resolveAgent(config, task(), 'plan', {}).model).toBeNull();
  });

  test('resolves through the same precedence', () => {
    expect(resolveAgent(config, task({ model: 'opus' }), 'plan', {}).model).toBe('opus');
    expect(
      resolveAgent(config, task(), 'plan', { plan: { model: 'haiku' } }).model,
    ).toBe('haiku');
    expect(
      resolveAgent(config, task({ model: 'opus' }), 'plan', {}, { model: 'sonnet' }).model,
    ).toBe('sonnet');
  });

  test('a non-agent phase has no model', () => {
    expect(resolveAgent(config, task(), 'ci', {}).model).toBeNull();
  });
});

describe('resolveAgent — effort', () => {
  test('is null when nothing sets it', () => {
    expect(resolveAgent(config, task(), 'plan', {}).effort).toBeNull();
  });

  test('resolves through the same precedence as model', () => {
    expect(resolveAgent(config, task({ effort: 'high' }), 'plan', {}).effort).toBe('high');
    expect(
      resolveAgent(config, task(), 'plan', { plan: { effort: 'low' } }).effort,
    ).toBe('low');
    expect(
      resolveAgent(config, task({ effort: 'high' }), 'plan', {}, { effort: 'max' }).effort,
    ).toBe('max');
  });

  test('agent, model and effort can all be pinned together', () => {
    const r = resolveAgent(config, task(), 'plan', {
      plan: { agent: 'copilot', model: 'gpt-6-sol', effort: 'high' },
    });
    expect(r).toEqual({ agent: 'copilot', model: 'gpt-6-sol', effort: 'high' });
  });

  test('a saved model the agent no longer offers falls back to the CLI default', () => {
    // An org admin withdrew it, or it was mistyped: sending it fails the launch.
    const r = resolveAgent(config, task(), 'plan', {
      plan: { agent: 'copilot', model: 'luna-5.6', effort: 'max' },
    });
    expect(r).toEqual({ agent: 'copilot', model: null, effort: 'max' });
  });
});

describe('agentCapabilities', () => {
  test('supplies built-in models and efforts when the profile omits them', () => {
    const caps = agentCapabilities('claude', config.agents.claude as AgentProfile);
    expect(caps.models.length).toBeGreaterThan(0);
    expect(caps.efforts).toContain('high');
    expect(caps.effortFlag).toBe('--effort');
  });

  test("agentCapabilities > uses Copilot's dotted model identifiers", () => {
    const caps = agentCapabilities('copilot', config.agents.copilot as AgentProfile);
    expect(caps.models[0]).toBe('auto');
    expect(caps.models).toContain('claude-opus-5.5');
    expect(caps.models).toContain('gpt-6-sol');
    expect(caps.models).not.toContain('gpt-5.6-terra');
  });

  test("copilot's built-in effort list includes its extra levels", () => {
    const caps = agentCapabilities('copilot', config.agents.copilot as AgentProfile);
    expect(caps.efforts).toContain('minimal');
    expect(caps.hasEffort).toBe(true);
  });

  test('supplies Codex models and config-based effort support', () => {
    const caps = agentCapabilities('codex', config.agents.codex as AgentProfile);
    expect(caps.models).toContain('gpt-5.6-sol');
    expect(caps.models).toContain('gpt-5.6-luna');
    expect(caps.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(caps.effortFlag).toBe('-c');
    expect(caps.hasEffort).toBe(true);
  });

  test('a profile-provided list overrides the built-in one', () => {
    const caps = agentCapabilities('claude', {
      ...(config.agents.claude as AgentProfile),
      models: ['only-this'],
    });
    expect(caps.models).toEqual(['only-this']);
  });

  test('an unknown agent with no lists reports no effort support', () => {
    const caps = agentCapabilities('mystery', {
      launch: 'mystery',
      promptMode: 'positional',
      instructionMode: 'flag',
    } as AgentProfile);
    expect(caps.hasEffort).toBe(false);
    expect(caps.models).toEqual([]);
  });
});
