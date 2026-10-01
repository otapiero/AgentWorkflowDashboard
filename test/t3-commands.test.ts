import { describe, expect, test } from 'vitest';

import {
  buildModelSelection,
  buildMissionControlScript,
  buildProjectCreateCommand,
  buildProjectScriptsUpdateCommand,
  buildThreadCreateCommand,
  buildTurnStartCommand,
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
  test('maps an agent to its T3 provider instance', () => {
    const selection = buildModelSelection(codex, { model: 'gpt-5.6-sol', effort: null });
    expect(selection).toEqual({ instanceId: 'codex', model: 'gpt-5.6-sol' });
  });

  test('renders effort as the canonical options array, not a CLI flag', () => {
    // The per-CLI flag divergence buildAgentArgs exists to absorb is not this
    // path's concern; T3's provider drivers handle invocation.
    const selection = buildModelSelection(codex, { model: 'gpt-5.6-sol', effort: 'high' });
    expect(selection?.options).toEqual([{ id: 'effort', value: 'high' }]);
  });

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

describe('buildProjectCreateCommand', () => {
  test('creates a project rooted at the repo Mission Control was configured with', () => {
    const command = buildProjectCreateCommand({
      commandId: 'cmd-1',
      projectId: 'proj-1',
      title: 'widgets',
      workspaceRoot: 'C:\\repo',
      createdAt: '2026-08-07T09:00:00.000Z',
    }) as Record<string, unknown>;

    expect(command.type).toBe('project.create');
    expect(command.projectId).toBe('proj-1');
    expect(command.workspaceRoot).toBe('C:\\repo');
    expect(command.createdAt).toBe('2026-08-07T09:00:00.000Z');
  });
});

/**
 * The thread is created by its own dispatch, not by thread.turn.start's
 * `bootstrap.createThread`.
 *
 * The plan's one-dispatch design was refused by a live T3 0.0.32:
 *
 *   OrchestrationCommandInvariantError, commandType 'thread.turn.start',
 *   "Thread 'b21d313d-…' does not exist for command 'thread.turn.start'."
 *
 * The bootstrap field is in the schema and every field we sent matched it, but
 * the dispatch path does not act on it. `thread.create` takes exactly the same
 * fields, so creating explicitly and then starting the turn is both what the
 * server asks for and one command per concern.
 */
describe('buildThreadCreateCommand', () => {
  const input = {
    commandId: 'cmd-1',
    threadId: 'thread-1',
    projectId: 'proj-1',
    title: '#3060 plan',
    worktreePath: 'C:\\Users\\alice\\.mission-control\\projects\\acme__widgets\\worktrees\\issue-3060',
    branch: 'alice/3060-thing',
    modelSelection: { instanceId: 'codex', model: 'gpt-5.6-sol' },
    modes: { runtimeMode: 'approval-required' as const, interactionMode: 'plan' as const },
    createdAt: '2026-08-07T09:00:00.000Z',
  };

  test('is a thread.create naming the thread the turn will use', () => {
    const command = buildThreadCreateCommand(input) as any;
    expect(command.type).toBe('thread.create');
    expect(command.threadId).toBe('thread-1');
    expect(command.projectId).toBe('proj-1');
  });

  test('binds the thread to Mission Controls worktree, not one T3 chose', () => {
    // This is what lets worktreePath(issue) stay a pure function of the issue
    // number, so markers, artifacts and badges keep working unchanged.
    const command = buildThreadCreateCommand(input) as any;
    expect(command.worktreePath).toBe(
      'C:\\Users\\alice\\.mission-control\\projects\\acme__widgets\\worktrees\\issue-3060',
    );
    expect(command.branch).toBe('alice/3060-thing');
  });

  test('sends both modes explicitly', () => {
    // T3's decoding default for runtimeMode is full-access, so an omission
    // grants more than the phase asked for.
    const command = buildThreadCreateCommand(input) as any;
    expect(command.runtimeMode).toBe('approval-required');
    expect(command.interactionMode).toBe('plan');
  });

  test('titles the thread so T3s sidebar groups phases legibly', () => {
    expect((buildThreadCreateCommand(input) as any).title).toBe('#3060 plan');
  });

  test('carries the model selection', () => {
    expect((buildThreadCreateCommand(input) as any).modelSelection).toEqual({
      instanceId: 'codex',
      model: 'gpt-5.6-sol',
    });
  });
});

describe('buildTurnStartCommand', () => {
  const input = {
    commandId: 'cmd-1',
    threadId: 'thread-1',
    messageId: 'msg-1',
    prompt: 'Plan issue 3060.',
    modelSelection: { instanceId: 'codex', model: 'gpt-5.6-sol' },
    modes: { runtimeMode: 'approval-required' as const, interactionMode: 'plan' as const },
    createdAt: '2026-08-07T09:00:00.000Z',
  };

  test('is a thread.turn.start carrying the rendered prompt verbatim', () => {
    const command = buildTurnStartCommand(input) as any;
    expect(command.type).toBe('thread.turn.start');
    expect(command.threadId).toBe('thread-1');
    expect(command.message.role).toBe('user');
    expect(command.message.text).toBe('Plan issue 3060.');
    expect(command.message.attachments).toEqual([]);
  });

  test('rejects oversized input before dispatch without truncating user instructions', () => {
    expect(() => buildTurnStartCommand({ ...input, prompt: 'x'.repeat(120001) })).toThrow(/120,000/);
  });

  test('never asks T3 to bootstrap anything', () => {
    // The thread already exists by the time this is sent, and prepareWorktree
    // hard-codes path: null and picks its own directory, which would make the
    // checkout location a lookup rather than a derivation.
    const command = buildTurnStartCommand(input) as any;
    expect(command.bootstrap).toBeUndefined();
  });

  test('sends both modes explicitly', () => {
    const command = buildTurnStartCommand(input) as any;
    expect(command.runtimeMode).toBe('approval-required');
    expect(command.interactionMode).toBe('plan');
  });

  test('carries the model selection so the turn cannot drift from the thread', () => {
    expect((buildTurnStartCommand(input) as any).modelSelection).toEqual({
      instanceId: 'codex',
      model: 'gpt-5.6-sol',
    });
  });
});

describe('buildMissionControlScript', () => {
  test('points T3s preview panel at the board', () => {
    const script = buildMissionControlScript('http://127.0.0.1:4317') as any;
    expect(script.previewUrl).toBe('http://127.0.0.1:4317');
    expect(script.autoOpenPreview).toBe(true);
  });

  test('uses an icon from T3s closed set', () => {
    const script = buildMissionControlScript('http://127.0.0.1:4317') as any;
    expect(['play', 'test', 'lint', 'configure', 'build', 'debug']).toContain(script.icon);
  });

  test('does not run on worktree creation', () => {
    // The board is a singleton; a per-worktree copy makes no sense.
    expect((buildMissionControlScript('http://127.0.0.1:4317') as any).runOnWorktreeCreate).toBe(
      false,
    );
  });

  test('its command is a probe, not a launcher', () => {
    // T3 runs scripts in a worktree-scoped terminal, so starting the board
    // there would tie its lifetime to a thread.
    const script = buildMissionControlScript('http://127.0.0.1:4317') as any;
    expect(script.command).toContain('4317');
    expect(script.command).not.toContain('npm start');
  });

  test('probes the endpoint that actually exists', () => {
    // /health is not a route. It falls through to the SPA not-found handler,
    // which serves index.html with a 200 — so `curl -sf` would report success
    // while proving nothing about the server. Verified 2026-08-07.
    const script = buildMissionControlScript('http://127.0.0.1:4317') as any;
    expect(script.command).toContain('/api/health');
  });
});

describe('buildProjectScriptsUpdateCommand', () => {
  test('updates only the scripts, leaving title and workspace root alone', () => {
    // Every other field on project.meta.update is optional, and sending one we
    // did not mean to change would overwrite whatever the operator set in T3.
    const command = buildProjectScriptsUpdateCommand({
      commandId: 'cmd-1',
      projectId: 'proj-1',
      scripts: [buildMissionControlScript('http://127.0.0.1:4317')],
    }) as any;

    expect(command.type).toBe('project.meta.update');
    expect(command.projectId).toBe('proj-1');
    expect(command.scripts).toHaveLength(1);
    expect(command).not.toHaveProperty('title');
    expect(command).not.toHaveProperty('workspaceRoot');
  });
});
