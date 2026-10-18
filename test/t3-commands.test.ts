import { describe, expect, test } from 'vitest';

import {
  buildModelSelection,
  validateT3Prompt,
} from '../src/orchestrator/t3/commands.ts';
import type { AgentProfile } from '../src/shared/types.ts';

const claude: AgentProfile = {
  launch: 'claude',
  promptMode: 'positional',
  instructionMode: 'flag',
  instructionFlag: '--append-system-prompt',
  t3Instance: 'claudeAgent',
  model: 'default',
};

const codex: AgentProfile = {
  launch: 'codex',
  promptMode: 'positional',
  instructionMode: 'inline',
  t3Instance: 'codex',
};

describe('buildModelSelection', () => {
  test('omits options entirely when there is no effort', () => {
    expect(buildModelSelection(codex, { model: 'gpt-5.6-sol', effort: null })).not.toHaveProperty(
      'options',
    );
  });

  test('an agent with no t3Instance is not launchable through T3', () => {
    const { t3Instance, ...noInstance } = claude;
    expect(buildModelSelection(noInstance as AgentProfile, { model: 'x', effort: null })).toBeNull();
  });

  test("the sentinel model 'default' is not sent as a literal model name", () => {
    // 'default' is Mission Control's own "let the CLI decide" marker, not a
    // model T3 knows about.
    expect(buildModelSelection(claude, { model: 'default', effort: null })).toBeNull();
  });

  test('falls back to the profile model when no override is given', () => {
    const selection = buildModelSelection(
      { ...codex, model: 'gpt-5.6-terra' },
      { model: null, effort: null },
    );
    expect(selection?.model).toBe('gpt-5.6-terra');
  });

  test('no model at all is not launchable — T3 requires one', () => {
    expect(buildModelSelection(codex, { model: null, effort: null })).toBeNull();
  });
});

test('rejects oversized prompts without truncating instructions', () => {
  expect(() => validateT3Prompt('x'.repeat(120_000))).not.toThrow();
  expect(() => validateT3Prompt('x'.repeat(120_001))).toThrow(/120,000/);
});
