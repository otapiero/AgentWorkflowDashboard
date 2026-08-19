import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveSpawnPlan } from '../src/orchestrator/spawn-plan.ts';
import { customPhase } from '../src/shared/custom-run.ts';
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
      branchPrefix: 'alice',
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
    branch: 'alice/3060-Add-progress-bar',
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
    expect(plan.promptText).toContain('alice/3060-Add-progress-bar');
  });

  test('the prompt is rendered with the configured repository, not a baked-in one', () => {
    // Stand in for what an installed mc-fix-ci.md looks like.
    writeFileSync(
      join(commands, 'mc-implementer.md'),
      'gh pr checks --repo {{owner}}/{{repo}} --base {{baseBranch}} in {{repoPath}}',
      'utf8',
    );
    const cfg = config();
    const plan = resolveSpawnPlan(cfg, task(), implementPhase(), {}, {});
    expect(plan.promptText).toBe(
      `gh pr checks --repo ${cfg.repo.owner}/${cfg.repo.name} --base ${cfg.repo.baseBranch} in ${cfg.repo.path}`,
    );
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

describe('resolveSpawnPlan with rawPrompt', () => {
  test('uses the raw text as the whole prompt, with no command file', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {
      rawPrompt: '  Investigate the auth flow.  ',
    });
    expect(plan.promptText).toBe('Investigate the auth flow.');
    expect(plan.command).toBe('raw');
  });

  test('still prepends standing rules for an agent with no system-prompt flag', () => {
    const plan = resolveSpawnPlan(config(), task(), implementPhase(), {}, {
      rawPrompt: 'Investigate the auth flow.',
      agent: 'copilot',
    });
    expect(plan.agent).toBe('copilot');
    expect(plan.promptText.startsWith('You are running inside a git worktree')).toBe(true);
    expect(plan.promptText).toContain('Investigate the auth flow.');
  });

  test('does not need a command on the phase at all', () => {
    const commandless = { ...implementPhase(), command: undefined };
    expect(() =>
      resolveSpawnPlan(config(), task(), commandless, {}, { rawPrompt: 'go' }),
    ).not.toThrow();
  });
});

describe('resolveSpawnPlan for the synthetic custom phase', () => {
  test('resolves an agent even though the phase is not in the pipeline', () => {
    // Regression: agent resolution finds a phase's actor by looking its id up
    // in config.pipeline, so an actor set on a synthetic phase object alone is
    // never consulted and the spawn dies with "no agent to spawn".
    const custom = customPhase({
      pipeline: config().pipeline,
      agentNames: Object.keys(config().agents),
    });
    const plan = resolveSpawnPlan(config(), task(), custom, {}, { rawPrompt: 'go' });
    expect(plan.agent).toBe('claude');
  });

  test('inherits the plan phase actor rather than the first configured agent', () => {
    const pipeline = [
      { id: 'plan', label: 'Plan', actor: 'copilot', command: 'mc-planner', gate: { type: 'manual' } } as PhaseConfig,
      implementPhase(),
    ];
    const custom = customPhase({ pipeline, agentNames: ['claude', 'copilot'] });
    const plan = resolveSpawnPlan(config(pipeline), task(), custom, {}, { rawPrompt: 'go' });
    expect(plan.agent).toBe('copilot');
  });
});
