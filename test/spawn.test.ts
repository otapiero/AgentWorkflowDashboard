import { describe, expect, test } from 'vitest';
import {
  buildAgentArgs,
  summarisePrompt,
  PROMPT_TOKEN,
} from '../src/orchestrator/spawn/build.ts';
import type { AgentProfile } from '../src/shared/types.ts';

const claude: AgentProfile = {
  launch: 'claude',
  promptMode: 'positional',
  modelFlag: '--model',
  effortFlag: '--effort',
  instructionMode: 'flag',
  instructionFlag: '--append-system-prompt',
};

const copilot: AgentProfile = {
  launch: 'copilot',
  promptMode: 'flag',
  promptFlag: '-i',
  modelFlag: '--model',
  effortFlag: '--effort',
  instructionMode: 'inline',
};

const codex: AgentProfile = {
  launch: 'codex',
  promptMode: 'positional',
  promptPosition: 'last',
  modelFlag: '--model',
  effortFlag: '-c',
  effortValueTemplate: 'model_reasoning_effort="{{effort}}"',
  instructionMode: 'inline',
  extraArgs: [
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'on-request',
    '--add-dir',
    '{{taskDir}}',
  ],
};

const RULES = 'You are in a prepared worktree.';

describe('buildAgentArgs — claude', () => {
  test('passes the prompt positionally as the first argument', () => {
    // Verified: `claude` takes its prompt as a positional argument.
    const args = buildAgentArgs('claude', claude, { instructions: RULES });
    expect(args[0]).toBe(PROMPT_TOKEN);
  });

  test('passes standing rules via the system-prompt flag', () => {
    const args = buildAgentArgs('claude', claude, { instructions: RULES });
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(RULES);
  });

  test('includes the model when one is pinned', () => {
    const args = buildAgentArgs('claude', claude, { instructions: RULES, model: 'opus' });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  test('omits the model flag entirely when no model is pinned', () => {
    expect(buildAgentArgs('claude', claude, { instructions: RULES })).not.toContain('--model');
  });

  test("treats a model of 'default' as no pin", () => {
    const args = buildAgentArgs('claude', claude, { instructions: RULES, model: 'default' });
    expect(args).not.toContain('--model');
  });

  test('includes the reasoning effort when one is set', () => {
    const args = buildAgentArgs('claude', claude, { instructions: RULES, effort: 'high' });
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  test('omits the effort flag when none is set', () => {
    expect(buildAgentArgs('claude', claude, { instructions: RULES })).not.toContain('--effort');
  });

  test('does not emit an effort flag for an agent that lacks one', () => {
    // A custom agent that is neither built-in nor declares an effort flag, so
    // there is no flag to fall back to.
    const noEffort = { ...claude, effortFlag: undefined };
    expect(
      buildAgentArgs('custom', noEffort, { instructions: RULES, effort: 'high' }),
    ).not.toContain('--effort');
  });

  test('falls back to the built-in effort flag when the profile omits it', () => {
    // Regression: a claude profile with no effortFlag must still emit --effort
    // (via the built-in fallback), otherwise the CLI uses its own default.
    const noFlag = { ...claude, effortFlag: undefined };
    const args = buildAgentArgs('claude', noFlag, { instructions: RULES, effort: 'high' });
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });
});

describe('buildAgentArgs — copilot', () => {
  test('passes the prompt behind its -i flag rather than positionally', () => {
    // Verified: `copilot` has no positional prompt; -i starts interactive.
    const args = buildAgentArgs('copilot', copilot, { instructions: RULES });
    expect(args[0]).toBe('-i');
    expect(args[1]).toBe(PROMPT_TOKEN);
  });

  test('never emits a system-prompt flag, because copilot has none', () => {
    const args = buildAgentArgs('copilot', copilot, { instructions: RULES });
    expect(args.join(' ')).not.toContain('--append-system-prompt');
    expect(args).not.toContain(RULES);
  });
});

describe('buildAgentArgs — codex', () => {
  test('places global options before the positional prompt', () => {
    const args = buildAgentArgs('codex', codex, {
      instructions: RULES,
      model: 'gpt-5.6-sol',
      variables: { taskDir: 'C:\\mc\\tasks\\3060' },
    });
    expect(args.at(-1)).toBe(PROMPT_TOKEN);
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf(PROMPT_TOKEN));
  });

  test('passes reasoning effort through a Codex config override', () => {
    const args = buildAgentArgs('codex', codex, {
      instructions: RULES,
      effort: 'high',
    });
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
  });

  test('uses a scoped writable task directory without broad sandbox access', () => {
    const taskDir = 'C:\\Users\\alice\\.mission-control\\projects\\acme__widgets\\tasks\\3060';
    const args = buildAgentArgs('codex', codex, {
      instructions: RULES,
      variables: { taskDir },
    });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args[args.indexOf('--ask-for-approval') + 1]).toBe('on-request');
    expect(args[args.indexOf('--add-dir') + 1]).toBe(taskDir);
    expect(args).not.toContain('danger-full-access');
  });
});

describe('summarisePrompt', () => {
  test('flattens whitespace', () => {
    expect(summarisePrompt('  research   the\nauth flow  ')).toBe('research the auth flow');
  });

  test('truncates long prompts with an ellipsis', () => {
    const summary = summarisePrompt('x'.repeat(400));
    expect(summary).toHaveLength(100);
    expect(summary.endsWith('…')).toBe(true);
  });
});
