import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, parseConfig } from '../src/orchestrator/config.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-cfg-'));
  process.env.MC_HOME = home;
});

afterEach(() => {
  delete process.env.MC_HOME;
  rmSync(home, { recursive: true, force: true });
});

const VALID = `
repo:
  path: 'C:\\Users\\alice\\Desktop\\V1\\widgets'
  owner: 'acme'
  name: 'widgets'
  baseBranch: 'dev'
  branchPrefix: 'alice'
github:
  auth: gh-cli
  pollIntervalSeconds: 30
  copilotReviewerLogin: 'copilot-pull-request-reviewer'
agents:
  claude:
    launch: 'claude'
    promptMode: positional
    modelFlag: '--model'
    instructionMode: flag
    instructionFlag: '--append-system-prompt'
  copilot:
    launch: 'copilot'
    promptMode: flag
    promptFlag: '-i'
    modelFlag: '--model'
    instructionMode: inline
  codex:
    launch: 'codex'
    promptMode: positional
    promptPosition: last
    modelFlag: '--model'
    effortFlag: '-c'
    effortValueTemplate: 'model_reasoning_effort="{{effort}}"'
    instructionMode: inline
pipeline:
  - id: plan
    label: Plan
    actor: claude
    command: mc-planner
    spawnable: true
    gate: { type: manual }
  - id: implement
    label: Implement
    actor: claude
    command: mc-implementer
    spawnable: true
    repeatable: true
    gate: { type: manual }
  - id: publish
    label: Publish
    actor: claude
    command: mc-publish
    spawnable: true
    gate: { type: auto, signal: pr_exists }
server:
  port: 4317
`;

describe('parseConfig', () => {
  test('accepts a valid config and returns typed values', () => {
    const cfg = parseConfig(VALID);
    expect(cfg.repo.owner).toBe('acme');
    expect(cfg.repo.name).toBe('widgets');
    expect(cfg.pipeline.map((p) => p.id)).toEqual(['plan', 'implement', 'publish']);
  });

  test('accepts Codex as a configured phase actor', () => {
    const cfg = parseConfig(VALID.replace('actor: claude', 'actor: codex'));
    expect(cfg.pipeline[0]?.actor).toBe('codex');
    expect(cfg.agents.codex?.promptPosition).toBe('last');
    expect(cfg.agents.codex?.effortValueTemplate).toContain('{{effort}}');
  });

  test('rejects duplicate phase ids', () => {
    const dup = VALID.replace('  - id: implement', '  - id: plan');
    expect(() => parseConfig(dup)).toThrow(/duplicate/i);
  });

  test('rejects a promptMode of flag with no promptFlag', () => {
    // Without the flag name there is no way to pass the prompt at all.
    const broken = VALID.replace("    promptFlag: '-i'\n", '');
    expect(() => parseConfig(broken)).toThrow(/promptFlag/i);
  });

  test('rejects an instructionMode of flag with no instructionFlag', () => {
    const broken = VALID.replace("    instructionFlag: '--append-system-prompt'\n", '');
    expect(() => parseConfig(broken)).toThrow(/instructionFlag/i);
  });

  test('rejects a phase whose actor is an agent that is not configured', () => {
    const broken = VALID.replace('actor: claude\n    command: mc-planner', 'actor: copilot\n    command: mc-planner')
      .replace(/^  copilot:\n(?:    .*\n)+/m, '');
    expect(() => parseConfig(broken)).toThrow(/copilot/i);
  });

  test('reports the offending field when validation fails', () => {
    // A user edits this file by hand; the error has to say what to fix.
    expect(() => parseConfig(VALID.replace("baseBranch: 'dev'", ''))).toThrow(/baseBranch/);
  });
});

describe('loadConfig', () => {
  test('throws a helpful error when the config file does not exist', () => {
    expect(() => loadConfig()).toThrow(/config\.yaml/);
  });

  test('reads and validates the file at the configured home', () => {
    writeFileSync(join(home, 'config.yaml'), VALID, 'utf8');
    expect(loadConfig().repo.baseBranch).toBe('dev');
  });
});
