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
    expect(result.modes).toEqual({ runtimeMode: 'full-access', interactionMode: 'plan' });
  });

  // Every provider names the reasoning scale differently, and T3 ignores an
  // option id its driver does not know rather than rejecting it — so sending
  // claudeAgent's 'effort' to codex ran every launch at the model's default.
  test("sends the effort under the id the instance's own descriptors use", () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      readiness: () => ({
        instanceId: 'codex',
        ready: true,
        reason: null,
        models: ['gpt-5.6-sol'],
        options: {
          'gpt-5.6-sol': [
            { id: 'reasoningEffort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { id: 'serviceTier', values: ['default', 'priority'] },
          ],
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.modelSelection.options).toEqual([{ id: 'reasoningEffort', value: 'xhigh' }]);
  });

  test('refuses an effort the model does not offer, listing the ones it does', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      readiness: () => ({
        instanceId: 'codex',
        ready: true,
        reason: null,
        models: ['gpt-5.6-sol'],
        options: {
          'gpt-5.6-sol': [
            { id: 'reasoningEffort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
          ],
        },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('ultra');
    expect(result.error).toContain('low, medium, high, xhigh, max');
  });

  // The descriptors belong to the slug T3 will run, not to the alias the
  // agent's config named, so they are looked up after the alias is resolved.
  test('reads the descriptors of the resolved slug, not the alias', () => {
    const result = resolveT3Launch({
      agent: 'claude',
      profile: { ...codex, t3Instance: 'claudeAgent' },
      phase: plan,
      model: 'opus',
      effort: 'ultrathink',
      readiness: () => ({
        instanceId: 'claudeAgent',
        ready: true,
        reason: null,
        models: ['claude-opus-5', 'claude-opus-4-8'],
        options: {
          'claude-opus-5': [{ id: 'effort', values: ['low', 'high', 'ultrathink'] }],
        },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.modelSelection).toMatchObject({
      model: 'claude-opus-5',
      options: [{ id: 'effort', value: 'ultrathink' }],
    });
  });

  // The copilot agent's models list is written for the copilot CLI, but its
  // t3Instance is OpenCode, whose adapter rejects anything that is not
  // 'provider/model'. Sending the bare name failed inside T3 with
  // "OpenCode model selection must use the 'provider/model' format".
  const opencodeModels = [
    'github-copilot/claude-sonnet-5',
    'github-copilot/gpt-5.6-sol',
    'opencode/big-pickle',
  ];

  test('qualifies a bare model name against the instances own slugs', () => {
    const result = resolveT3Launch({
      agent: 'copilot',
      profile: { ...codex, t3Instance: 'opencode' },
      phase: plan,
      model: 'claude-sonnet-5',
      effort: null,
      readiness: () => ({
        instanceId: 'opencode',
        ready: true,
        reason: null,
        models: opencodeModels,
      }),
    });
    if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
    expect(result.modelSelection.model).toBe('github-copilot/claude-sonnet-5');
  });

  test('leaves a model the instance already offers exactly as written', () => {
    const result = resolveT3Launch({
      agent: 'copilot',
      profile: { ...codex, t3Instance: 'opencode' },
      phase: plan,
      model: 'opencode/big-pickle',
      effort: null,
      readiness: () => ({
        instanceId: 'opencode',
        ready: true,
        reason: null,
        models: opencodeModels,
      }),
    });
    if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
    expect(result.modelSelection.model).toBe('opencode/big-pickle');
  });

  test('refuses a model the instance does not offer, listing the ones it does', () => {
    // 'auto' is a copilot CLI concept with no OpenCode equivalent.
    const result = resolveT3Launch({
      agent: 'copilot',
      profile: { ...codex, t3Instance: 'opencode' },
      phase: plan,
      model: 'auto',
      effort: null,
      readiness: () => ({
        instanceId: 'opencode',
        ready: true,
        reason: null,
        models: opencodeModels,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain("'auto'");
    expect(result.error).toContain('github-copilot/claude-sonnet-5');
  });

  test('refuses rather than guessing when a bare name matches two providers', () => {
    const result = resolveT3Launch({
      agent: 'copilot',
      profile: { ...codex, t3Instance: 'opencode' },
      phase: plan,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({
        instanceId: 'opencode',
        ready: true,
        reason: null,
        models: ['github-copilot/gpt-5.6-sol', 'openai/gpt-5.6-sol'],
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('openai/gpt-5.6-sol');
  });

  // The claude agent's models are the CLI's family aliases, but claudeAgent
  // advertises released slugs, so 'opus' was refused with "it does not offer
  // 'opus'" even though the family was right there.
  const claudeAgentModels = [
    'claude-fable-5',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ];

  function launchClaude(model: string, models = claudeAgentModels) {
    return resolveT3Launch({
      agent: 'claude',
      profile: { ...codex, t3Instance: 'claudeAgent' },
      phase: plan,
      model,
      effort: null,
      readiness: () => ({ instanceId: 'claudeAgent', ready: true, reason: null, models }),
    });
  }

  test('reads a family alias as the newest release in that family', () => {
    const result = launchClaude('opus');
    if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
    expect(result.modelSelection.model).toBe('claude-opus-5');
  });

  test('picks the newest by version, not by where the instance listed it', () => {
    const result = launchClaude('sonnet', ['claude-sonnet-4-6', 'claude-sonnet-5']);
    if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
    expect(result.modelSelection.model).toBe('claude-sonnet-5');
  });

  test('an alias with a single release resolves to it', () => {
    const result = launchClaude('haiku');
    if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
    expect(result.modelSelection.model).toBe('claude-haiku-4-5');
  });

  test('refuses a family two providers both serve rather than pick a payer', () => {
    const result = launchClaude('sonnet', [
      'github-copilot/claude-sonnet-5',
      'anthropic/claude-sonnet-5',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain('anthropic/claude-sonnet-5');
  });

  test('a family no release matches is still refused', () => {
    const result = launchClaude('gemini');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toContain("'gemini'");
    expect(result.error).toContain('claude-opus-5');
  });

  test('a phase with no configured modes gets full-access', () => {
    const result = resolveT3Launch({
      agent: 'codex',
      profile: codex,
      phase: { ...plan, id: 'merge' } as PhaseConfig,
      model: 'gpt-5.6-sol',
      effort: null,
      readiness: () => ({ instanceId: 'codex', ready: true, reason: null, models: [] }),
    });
    if (!result.ok) throw new Error('expected success');
    expect(result.modes.runtimeMode).toBe('full-access');
  });
});
