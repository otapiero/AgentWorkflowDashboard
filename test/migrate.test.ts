import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateLegacyHome } from '../src/orchestrator/migrate.ts';
import { activeProjectSlug, mcRoot, projectHome, projectSlug } from '../src/orchestrator/paths.ts';

let root: string;
let legacy: string;

const CONFIG = `
repo:
  path: 'C:\\src\\widgets'
  owner: 'acme'
  name: 'widgets'
  baseBranch: 'main'
  branchPrefix: 'alice'
github:
  auth: gh-cli
  pollIntervalSeconds: 30
  copilotReviewerLogin: 'copilot-pull-request-reviewer'
agents:
  claude:
    launch: 'claude'
    promptMode: positional
    instructionMode: flag
    instructionFlag: '--append-system-prompt'
pipeline:
  - id: plan
    label: Plan
    actor: claude
    command: mc-planner
    gate: { type: manual }
server:
  port: 4317
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-mig-root-'));
  legacy = mkdtempSync(join(tmpdir(), 'mc-mig-legacy-'));
  process.env.MC_ROOT = root;
  process.env.MC_LEGACY_HOME = legacy;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;

  writeFileSync(join(legacy, 'config.yaml'), CONFIG, 'utf8');
  writeFileSync(join(legacy, 'state.json'), '{"tasks":[]}', 'utf8');
  mkdirSync(join(legacy, 'tasks', '3060', 'markers'), { recursive: true });
  writeFileSync(join(legacy, 'tasks', '3060', 'plan.md'), '# plan', 'utf8');
  mkdirSync(join(legacy, 'scripts'), { recursive: true });
  writeFileSync(join(legacy, 'scripts', 'run-phase.ps1'), '# script', 'utf8');
  writeFileSync(join(legacy, 't3-token.json'), '{"access_token":"x"}', 'utf8');
});

afterEach(() => {
  delete process.env.MC_ROOT;
  delete process.env.MC_LEGACY_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
});

describe('migrateLegacyHome', () => {
  test('moves the install under projects/<slug> and makes it active', () => {
    const result = migrateLegacyHome();
    expect(result.slug).toBe(projectSlug('acme', 'widgets'));
    expect(result.to).toBe(projectHome(result.slug));
    expect(activeProjectSlug()).toBe(result.slug);
  });

  test('carries task artifacts across intact', () => {
    const result = migrateLegacyHome();
    expect(readFileSync(join(result.to, 'tasks', '3060', 'plan.md'), 'utf8')).toBe('# plan');
    expect(existsSync(join(result.to, 'tasks', '3060', 'markers'))).toBe(true);
  });

  test('lifts the shared files to the install root', () => {
    // Scripts and the T3 token belong to the machine, not to one repository.
    const result = migrateLegacyHome();
    expect(existsSync(join(mcRoot(), 'scripts', 'run-phase.ps1'))).toBe(true);
    expect(existsSync(join(mcRoot(), 't3-token.json'))).toBe(true);
    expect(existsSync(join(result.to, 't3-token.json'))).toBe(false);
    expect(result.sharedFiles).toContain('t3-token.json');
  });

  test('the legacy directory is gone afterwards', () => {
    const result = migrateLegacyHome();
    expect(existsSync(result.from)).toBe(false);
  });

  test('refuses when the destination project already exists', () => {
    migrateLegacyHome();
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.yaml'), CONFIG, 'utf8');
    expect(() => migrateLegacyHome()).toThrow(/already/i);
  });

  test('says so plainly when there is nothing to migrate', () => {
    rmSync(legacy, { recursive: true, force: true });
    expect(() => migrateLegacyHome()).toThrow(/nothing to migrate/i);
  });
});
