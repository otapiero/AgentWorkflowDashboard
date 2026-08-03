import { describe, expect, test } from 'vitest';

import { launchPickerFrom, runLaunchFlow, type LaunchPicker } from '../../src/launch-flow.ts';
import { config, task } from './fixtures.ts';

function picker(answers: readonly (string | undefined)[]): LaunchPicker & { prompts: string[]; offered: Array<readonly { value: string; picked?: boolean }[]> } {
  const prompts: string[] = [];
  const offered: Array<readonly { value: string; picked?: boolean }[]> = [];
  return {
    prompts,
    offered,
    async pick(prompt, items) {
      prompts.push(prompt);
      offered.push(items);
      const answer = answers[prompts.length - 1];
      return answer === undefined ? undefined : items.find((item) => item.value === answer);
    },
  };
}

describe('runLaunchFlow', () => {
  test('adapts the picked value into the initially active first Quick Pick item', async () => {
    let received: readonly { value: string }[] = [];
    const adapted = launchPickerFrom(async (items) => { received = items; return items[0]; });
    expect((await adapted.pick('Agent', [{ label: 'Claude', value: 'claude' }, { label: 'Codex', value: 'codex', picked: true }]))?.value).toBe('codex');
    expect(received.map((item) => item.value)).toEqual(['codex', 'claude']);
  });

  test('uses spawnable phases and valid pinned selections', async () => {
    const choices = picker(['implement', 'codex', 'gpt-5.6-sol', 'high', 'confirm']);
    const result = await runLaunchFlow(task({ phase: 'ci' }), config, choices);
    expect(result).toEqual({ phase: 'implement', agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
    expect(choices.prompts).toEqual(['Phase', 'Agent', 'Model', 'Reasoning effort', 'Run #3060 · implement with codex · gpt-5.6-sol · high?']);
  });

  test('initializes from the selected phase instead of the current-phase pin', async () => {
    const selected = structuredClone(config);
    selected.pipeline[0]!.actor = 'claude';
    selected.agents = [
      { name: 'claude', models: ['opus'], efforts: ['low'], hasEffort: true, defaultModel: 'opus', defaultEffort: 'low' },
      ...selected.agents,
    ];
    selected.phaseDefaults.plan = { agent: 'claude', model: 'opus', effort: 'low' };
    const choices = picker(['plan', 'claude', 'opus', 'low', 'confirm']);
    await runLaunchFlow(task({ phase: 'implement' }), selected, choices);
    expect(choices.offered[1]).toContainEqual(expect.objectContaining({ value: 'claude', picked: true }));
    expect(choices.offered[2]).toContainEqual(expect.objectContaining({ value: 'opus', picked: true }));
    expect(choices.offered[3]).toContainEqual(expect.objectContaining({ value: 'low', picked: true }));
  });

  test('task overrides take precedence for the selected phase', async () => {
    const selected = structuredClone(config);
    selected.agents.unshift({ name: 'claude', models: ['opus'], efforts: ['low'], hasEffort: true });
    selected.phaseDefaults.plan = { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' };
    const candidate = task();
    candidate.overrides = { agent: 'claude', model: 'opus', effort: 'low' };
    const choices = picker(['plan', 'claude', 'opus', 'low', 'confirm']);
    await runLaunchFlow(candidate, selected, choices);
    expect(choices.offered[1]).toContainEqual(expect.objectContaining({ value: 'claude', picked: true }));
    expect(choices.offered[2]).toContainEqual(expect.objectContaining({ value: 'opus', picked: true }));
    expect(choices.offered[3]).toContainEqual(expect.objectContaining({ value: 'low', picked: true }));
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
    expect(choices.prompts).toEqual(['Phase', 'Agent', 'Model', 'Run #3060 · implement with simple · standard?']);
  });

  test.each([0, 1, 2, 3, 4])('returns null when cancelled at step %i', async (step) => {
    const answers = ['implement', 'codex', 'gpt-5.6-sol', 'high', 'confirm'];
    answers[step] = undefined as unknown as string;
    expect(await runLaunchFlow(task(), config, picker(answers))).toBeNull();
  });
});
