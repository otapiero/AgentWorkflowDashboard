import { describe, expect, test } from 'vitest';

import { mergeOverrides } from '../src/orchestrator/overrides.ts';

describe('mergeOverrides', () => {
  test('an absent key leaves the existing value alone', () => {
    const result = mergeOverrides(
      { agent: 'claude', instructions: 'keep me' },
      { model: 'opus' },
    );
    expect(result).toEqual({ agent: 'claude', model: 'opus', instructions: 'keep me' });
  });

  test('this is the regression that would eat kept instructions', () => {
    // The Setup tab saves an agent pin; the Run tab's kept text must survive.
    const result = mergeOverrides(
      { instructions: 'do not touch the migrations' },
      { agent: 'claude', model: 'opus', effort: 'high' },
    );
    expect(result?.instructions).toBe('do not touch the migrations');
  });

  test('null clears exactly that field', () => {
    const result = mergeOverrides(
      { agent: 'claude', instructions: 'kept' },
      { instructions: null },
    );
    expect(result).toEqual({ agent: 'claude' });
  });

  test('a value replaces the existing one', () => {
    const result = mergeOverrides({ agent: 'claude' }, { agent: 'copilot' });
    expect(result).toEqual({ agent: 'copilot' });
  });

  test('an empty string clears, matching the old || undefined behaviour', () => {
    const result = mergeOverrides({ agent: 'claude', model: 'opus' }, { model: '' });
    expect(result).toEqual({ agent: 'claude' });
  });

  test('merging onto nothing works', () => {
    expect(mergeOverrides(undefined, { agent: 'claude' })).toEqual({ agent: 'claude' });
  });

  test('clearing the last field yields undefined, not an empty object', () => {
    expect(mergeOverrides({ agent: 'claude' }, { agent: null })).toBeUndefined();
  });

  test('an empty patch is a no-op', () => {
    expect(mergeOverrides({ agent: 'claude' }, {})).toEqual({ agent: 'claude' });
  });
});
