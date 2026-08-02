import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSpawnPlan } from '../src/orchestrator/spawn-plan.ts';
import type {
  AgentProfile,
  Config,
  PhaseConfig,
  TaskRecord,
} from '../src/shared/types.ts';

let home: string;
let commands: string;

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

function implementPhase(): PhaseConfig {
  return {
    id: 'implement',
    label: 'Implement',
    actor: 'claude',
    command: 'mc-implementer',
    spawnable: true,
    gate: { type: 'manual' },
  } as PhaseConfig;
}

function config(pipeline: PhaseConfig[] = [implementPhase()]): Config {
  return {
    repo: {
      path: 'C:\\repo',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'dev',
      branchPrefix: 'ouriel',
    },
    github: { auth: 'gh-cli', pollIntervalSeconds: 30, copilotReviewerLogin: 'bot' },
    agents: { claude, copilot },
    pipeline,
    server: { port: 4317 },
  } as unknown as Config;
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    issue: 3060,
    title: 'Add progress bar',
    slug: 'add-progress-bar',
    branch: 'ouriel/3060-Add-progress-bar',
    worktreePath: null,
    prNumber: null,
    prUrl: null,
    manualPhase: null,
    spawnHistory: [],
    ...overrides,
  } as TaskRecord;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-spawn-plan-'));
  commands = join(home, 'commands');
  mkdirSync(commands, { recursive: true });
  process.env.MC_HOME = home;
  process.env.MC_CLAUDE_COMMANDS = commands;
  writeFileSync(
    join(commands, 'mc-implementer.md'),
    '---\ndescription: x\n---\nImplement #$ARGUMENTS on `{{branch}}`.\n\n{{customInstructions}}\n',
    'utf8',
  );
});

afterEach(() => {
  delete process.env.MC_HOME;
  delete process.env.MC_CLAUDE_COMMANDS;
  rmSync(home, { recursive: true, force: true });
});

describe('resolveSpawnPlan', () => {
  test('renders the command with the task context', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {});
    expect(plan.command).toBe('mc-implementer');
    expect(plan.agent).toBe('claude');
    expect(plan.promptText).toContain('Implement #3060');
    expect(plan.promptText).toContain('ouriel/3060-Add-progress-bar');
  });

  test('one-off instructions win over the task-level saved ones', () => {
    const plan = resolveSpawnPlan(
      config(),
      task({ overrides: { instructions: 'saved text' } }),
      implementPhase(),
      {},
      { customInstructions: 'one-off text' },
    );
    expect(plan.promptText).toContain('one-off text');
    expect(plan.promptText).not.toContain('saved text');
  });

  test('falls back to the saved task instructions when none are passed', () => {
    const plan = resolveSpawnPlan(
      config(),
      task({ overrides: { instructions: 'saved text' } }),
      implementPhase(),
      {},
      {},
    );
    expect(plan.promptText).toContain('saved text');
  });

  test('an inline-mode agent carries the standing rules in the prompt body', () => {
    const plan = resolveSpawnPlan(
      config(),
      task(),
      implementPhase(),
      {},
      { agent: 'copilot' },
    );
    expect(plan.agent).toBe('copilot');
    expect(plan.promptText).toContain('worktree that Mission Control already prepared');
  });

  test('a flag-mode agent does not', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {});
    expect(plan.promptText).not.toContain('worktree that Mission Control already prepared');
  });

  test('throws when the phase has no command', () => {
    const phase = { ...implementPhase(), command: undefined } as PhaseConfig;
    expect(() => resolveSpawnPlan(config(), task(), phase, {}, {})).toThrow(
      /no command/,
    );
  });

  test('throws when no agent can be resolved', () => {
    // The phase must be the one in the pipeline too: resolveAgent looks the
    // actor up by id, so a locally-modified copy would not change resolution.
    const phase = { ...implementPhase(), actor: 'none' } as PhaseConfig;
    expect(() => resolveSpawnPlan(config([phase]), task(), phase, {}, {})).toThrow(
      /no agent/,
    );
  });
});
