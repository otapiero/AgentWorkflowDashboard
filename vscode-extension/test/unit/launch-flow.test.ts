import { describe, expect, test } from 'vitest';

import { runLaunchFlow, type LaunchPicker } from '../../src/launch-flow.ts';
import { config, task } from './fixtures.ts';

function picker(answers: readonly (string | undefined)[]): LaunchPicker & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async pick(prompt, items) {
      prompts.push(prompt);
      const answer = answers[prompts.length - 1];
      return answer === undefined ? undefined : items.find((item) => item.value === answer);
    },
  };
}

describe('runLaunchFlow', () => {
  test('uses spawnable phases and valid pinned selections', async () => {
    const choices = picker(['implement', 'codex', 'gpt-5.6-sol', 'high', 'confirm']);
    const result = await runLaunchFlow(task({ phase: 'ci' }), config, choices);
    expect(result).toEqual({ phase: 'implement', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
    expect(choices.prompts).toEqual(['Phase', 'Agent', 'Model', 'Reasoning effort', 'Run implement with codex · gpt-5.6-sol · high?']);
  });

  test('clears unsupported pinned values when changing agent', async () => {
    const selected = structuredClone(config);
    selected.agents = [
      { name: 'claude', models: ['opus'], efforts: ['low'], hasEffort: true },
      { name: 'codex', models: ['gpt-5.6-sol'], efforts: ['high'], hasEffort: true },
    ];
    const candidate = task();
    candidate.pinned = { agent: 'claude', model: 'opus', effort: 'low' };
    expect(await runLaunchFlow(candidate, selected, picker(['implement', 'codex', 'gpt-5.6-sol', 'high', 'confirm'])))
      .toEqual({ phase: 'implement', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  });

  test('omits effort for agents without effort control', async () => {
    const selected = structuredClone(config);
    selected.agents = [{ name: 'simple', models: ['standard'], efforts: [], hasEffort: false }];
    const choices = picker(['implement', 'simple', 'standard', 'confirm']);
    expect(await runLaunchFlow(task(), selected, choices))
      .toEqual({ phase: 'implement', agent: 'simple', model: 'standard', effort: '' });
    expect(choices.prompts).toEqual(['Phase', 'Agent', 'Model', 'Run implement with simple · standard?']);
  });

  test.each([0, 1, 2, 3, 4])('returns null when cancelled at step %i', async (step) => {
    const answers = ['implement', 'codex', 'gpt-5.6-sol', 'high', 'confirm'];
    answers[step] = undefined as unknown as string;
    expect(await runLaunchFlow(task(), config, picker(answers))).toBeNull();
  });
});
