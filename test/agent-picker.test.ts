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
  test('wires agent changes through the shared selection helper', () => {
    expect(
      switchAgent(
        { agent: 'claude', model: 'opus', effort: 'low' },
        'codex',
      ),
    ).toEqual({ agent: 'codex', model: '', effort: '' });
  });
});
