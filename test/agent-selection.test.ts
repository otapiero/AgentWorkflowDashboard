import { describe, expect, test } from 'vitest';

import { selectionForAgent } from '../src/shared/agent-selection.ts';
import type { AgentInfo } from '../src/shared/types.ts';

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
