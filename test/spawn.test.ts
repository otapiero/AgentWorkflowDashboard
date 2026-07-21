import { describe, expect, test } from 'vitest';
import {
  buildAgentArgs,
  buildWtArgs,
  PROMPT_TOKEN,
} from '../src/orchestrator/spawn.ts';
import type { AgentProfile } from '../src/shared/types.ts';

const claude: AgentProfile = {
  launch: 'claude',
  promptMode: 'positional',
  modelFlag: '--model',
  instructionMode: 'flag',
  instructionFlag: '--append-system-prompt',
};

const copilot: AgentProfile = {
  launch: 'copilot',
  promptMode: 'flag',
  promptFlag: '-i',
  modelFlag: '--model',
  instructionMode: 'inline',
};

const RULES = 'You are in a prepared worktree.';

describe('buildAgentArgs — claude', () => {
  test('passes the prompt positionally as the first argument', () => {
    // Verified: `claude` takes its prompt as a positional argument.
    const args = buildAgentArgs(claude, { instructions: RULES });
    expect(args[0]).toBe(PROMPT_TOKEN);
  });

  test('passes standing rules via the system-prompt flag', () => {
    const args = buildAgentArgs(claude, { instructions: RULES });
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(RULES);
  });

  test('includes the model when one is pinned', () => {
    const args = buildAgentArgs(claude, { instructions: RULES, model: 'opus' });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  test('omits the model flag entirely when no model is pinned', () => {
    expect(buildAgentArgs(claude, { instructions: RULES })).not.toContain('--model');
  });

  test("treats a model of 'default' as no pin", () => {
    const args = buildAgentArgs(claude, { instructions: RULES, model: 'default' });
    expect(args).not.toContain('--model');
  });
});

describe('buildAgentArgs — copilot', () => {
  test('passes the prompt behind its -i flag rather than positionally', () => {
    // Verified: `copilot` has no positional prompt; -i starts interactive.
    const args = buildAgentArgs(copilot, { instructions: RULES });
    expect(args[0]).toBe('-i');
    expect(args[1]).toBe(PROMPT_TOKEN);
  });

  test('never emits a system-prompt flag, because copilot has none', () => {
    const args = buildAgentArgs(copilot, { instructions: RULES });
    expect(args.join(' ')).not.toContain('--append-system-prompt');
    expect(args).not.toContain(RULES);
  });

  test('appends configured extra arguments', () => {
    const args = buildAgentArgs(
      { ...copilot, extraArgs: ['--allow-all-tools'] },
      { instructions: RULES },
    );
    expect(args).toContain('--allow-all-tools');
  });
});

describe('buildAgentArgs — general', () => {
  test('the prompt token appears exactly once so substitution is unambiguous', () => {
    const args = buildAgentArgs(claude, { instructions: RULES });
    expect(args.filter((a) => a === PROMPT_TOKEN)).toHaveLength(1);
  });

  test('arguments are kept as separate array entries, never a joined string', () => {
    // Splatting an array is what keeps spaces and quotes in the prompt safe.
    const args = buildAgentArgs(claude, { instructions: 'has spaces and "quotes"' });
    expect(args).toContain('has spaces and "quotes"');
  });
});

describe('buildWtArgs', () => {
  const opts = {
    issue: 3060,
    phase: 'plan',
    startDir: 'C:\\src\\widgets',
    script: 'C:\\Users\\ouriel\\.mc\\scripts\\run-phase.ps1',
    specFile: 'C:\\Users\\ouriel\\.mc\\tasks\\3060\\spawn.json',
  };

  test('titles the tab with the issue and phase so parallel tabs are identifiable', () => {
    const args = buildWtArgs(opts);
    expect(args[args.indexOf('--title') + 1]).toBe('#3060 plan');
  });

  test('opens a new tab', () => {
    expect(buildWtArgs(opts)[0]).toBe('new-tab');
  });

  test('starts in a directory that is guaranteed to exist', () => {
    // The worktree may not exist yet — the script creates it — so wt must not
    // be pointed at it or the tab fails to open.
    const args = buildWtArgs(opts);
    expect(args[args.indexOf('-d') + 1]).toBe(opts.startDir);
  });

  test('runs the phase script under pwsh with -NoExit so output stays readable', () => {
    const args = buildWtArgs(opts);
    expect(args).toContain('pwsh');
    expect(args).toContain('-NoExit');
    expect(args[args.indexOf('-File') + 1]).toBe(opts.script);
  });

  test('passes the spec file rather than the prompt itself', () => {
    // Everything variable lives in the spec, so nothing large or quoted has to
    // survive the wt -> pwsh -> agent argument chain.
    const args = buildWtArgs(opts);
    expect(args[args.indexOf('-SpecFile') + 1]).toBe(opts.specFile);
  });

  test('contains no semicolon argument, which wt would read as a tab separator', () => {
    for (const arg of buildWtArgs(opts)) {
      expect(arg).not.toBe(';');
    }
  });
});
