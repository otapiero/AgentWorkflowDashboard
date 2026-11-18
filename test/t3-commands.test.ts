import { expect, test } from 'vitest';

import { buildThreadLaunchInput } from '../src/orchestrator/t3/commands.ts';

test('rejects oversized prompts without truncating instructions', () => {
  const input = {
    commandId: 'cmd-1',
    threadId: 'thread-1',
    projectId: 'project-1',
    title: 'Plan',
    worktreePath: 'C:\\src\\widgets',
    branch: 'alice/feature',
    modelSelection: { instanceId: 'codex', model: 'gpt-5.6-sol' },
    modes: { runtimeMode: 'approval-required' as const, interactionMode: 'plan' as const },
    messageId: 'message-1',
    prompt: 'x'.repeat(120_000),
  };

  expect(buildThreadLaunchInput(input).initialMessage.text).toBe(input.prompt);
  expect(() => buildThreadLaunchInput({ ...input, prompt: `${input.prompt}x` })).toThrow(/120,000/);
});
