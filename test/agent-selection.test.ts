import { describe, expect, test } from 'vitest';

import { resolveAgentValues, selectionForAgent, selectionForPhase } from '../src/shared/agent-selection.ts';
import type { AgentInfo, BoardConfig, TaskRecord } from '../src/shared/types.ts';

const agents: AgentInfo[] = [
  { name: 'claude', models: ['default', 'opus'], efforts: ['low', 'high'], hasEffort: true },
  { name: 'codex', models: ['default', 'gpt-5.6-sol'], efforts: ['medium', 'high'], hasEffort: true },
];

describe('selectionForAgent', () => {
  test('clears values unsupported by the newly selected agent', () => {
    expect(selectionForAgent({ agent: 'claude', model: 'opus', effort: 'low' }, agents, 'codex'))
      .toEqual({ agent: 'codex', model: '', effort: '' });
  });

  test('preserves values supported by both agents', () => {
    expect(selectionForAgent({ agent: 'claude', model: 'default', effort: 'high' }, agents, 'codex'))
      .toEqual({ agent: 'codex', model: 'default', effort: 'high' });
  });

  test('uses the inherited agent when selecting inherit', () => {
    expect(selectionForAgent({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }, agents, '', 'claude'))
      .toEqual({ agent: '', model: '', effort: 'high' });
  });
});

describe('shared agent resolution', () => {
  const config: BoardConfig = {
    repo: { path: 'C:\\repo', owner: 'o', name: 'r', baseBranch: 'main', branchPrefix: 'x/' },
    pipeline: [
      { id: 'plan', label: 'Plan', actor: 'claude', spawnable: true, gate: { type: 'manual' } },
      { id: 'implement', label: 'Implement', actor: 'codex', spawnable: true, gate: { type: 'manual' } },
    ],
    agents: [
      { name: 'claude', models: ['default', 'opus'], efforts: ['low', 'high'], hasEffort: true, defaultModel: 'opus', defaultEffort: 'low' },
      { name: 'codex', models: ['default', 'gpt-5.6-sol'], efforts: ['medium', 'high'], hasEffort: true, defaultModel: 'gpt-5.6-sol', defaultEffort: 'medium' },
    ],
    phaseDefaults: { plan: { agent: 'claude', model: 'default', effort: 'high' } },
    launcher: 'vscode',
  };
  const task = { overrides: undefined } as TaskRecord;

  test('uses task, phase, actor, and agent-default precedence', () => {
    expect(resolveAgentValues(config, task, 'plan')).toEqual({ agent: 'claude', model: null, effort: 'high' });
    expect(resolveAgentValues(config, { ...task, overrides: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } }, 'plan'))
      .toEqual({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' });
  });

  test('turns the resolved values into a capability-safe picker selection', () => {
    expect(selectionForPhase(config, task, 'implement')).toEqual({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'medium' });
    expect(selectionForPhase(config, { ...task, overrides: { agent: 'codex', model: 'opus', effort: 'low' } }, 'implement'))
      .toEqual({ agent: 'codex', model: '', effort: '' });
  });
});
