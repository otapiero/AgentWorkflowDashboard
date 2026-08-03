import { describe, expect, test } from 'vitest';

import {
  AgentPicker,
  type AgentSelection,
} from '../src/web/components/AgentPicker.tsx';
import type { AgentInfo } from '../src/web/api.ts';

const agents: AgentInfo[] = [
  {
    name: 'claude',
    models: ['default', 'opus', 'sonnet'],
    efforts: ['low', 'high'],
    hasEffort: true,
  },
  {
    name: 'codex',
    models: ['default', 'gpt-5.6-sol'],
    efforts: ['medium', 'high'],
    hasEffort: true,
  },
];

function switchAgent(value: AgentSelection, nextAgent: string): AgentSelection {
  let changed: AgentSelection | null = null;
  const picker = AgentPicker({
    agents,
    value,
    onChange: (next) => {
      changed = next;
    },
  }) as React.ReactElement<{ children: React.ReactElement[] }>;
  const agentSelect = picker.props.children[0]! as React.ReactElement<{
    onChange: (event: { target: { value: string } }) => void;
  }>;
  agentSelect.props.onChange({ target: { value: nextAgent } });
  return changed!;
}

describe('AgentPicker agent changes', () => {
  test('clears model and effort values unsupported by the newly selected agent', () => {
    expect(
      switchAgent(
        { agent: 'claude', model: 'opus', effort: 'low' },
        'codex',
      ),
    ).toEqual({ agent: 'codex', model: '', effort: '' });
  });

  test('preserves model and effort values supported by both agents', () => {
    expect(
      switchAgent(
        { agent: 'claude', model: 'default', effort: 'high' },
        'codex',
      ),
    ).toEqual({ agent: 'codex', model: 'default', effort: 'high' });
  });
});
