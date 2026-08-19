import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  exampleConfigPath,
  initProject,
  renderConfigTemplate,
  type DetectedRepo,
} from '../src/orchestrator/init.ts';
import { parseConfig } from '../src/orchestrator/config.ts';
import { activeProjectSlug, projectHome, projectSlug } from '../src/orchestrator/paths.ts';

let root: string;

const REPO: DetectedRepo = {
  path: 'C:\src\widgets',
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
  branchPrefix: 'alice',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-init-'));
  process.env.MC_ROOT = root;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;
});

afterEach(() => {
  delete process.env.MC_ROOT;
  rmSync(root, { recursive: true, force: true });
});

describe('renderConfigTemplate', () => {
  test('produces a config that actually validates', () => {
    // The example is the shipped default, so a template that renders to an
    // invalid config would break every new install and nothing else.
    const template = readFileSync(exampleConfigPath(), 'utf8');
    const cfg = parseConfig(renderConfigTemplate(template, REPO));
    expect(cfg.repo).toEqual(REPO);
  });

  test('leaves no unsubstituted repo placeholders behind', () => {
    const template = readFileSync(exampleConfigPath(), 'utf8');
    const rendered = renderConfigTemplate(template, REPO);
    for (const name of ['repoPath', 'owner', 'repoName', 'baseBranch', 'branchPrefix']) {
      expect(rendered).not.toContain(`{{${name}}}`);
    }
  });

  test('leaves the agent argument placeholders alone', () => {
    // {{effort}} and {{taskDir}} are expanded at spawn time, not at init.
    // Substituting them here would bake one task's directory into the config.
    const template = readFileSync(exampleConfigPath(), 'utf8');
    const rendered = renderConfigTemplate(template, REPO);
    expect(rendered).toContain('{{effort}}');
    expect(rendered).toContain('{{taskDir}}');
  });

  test('titles the T3 project after the repository', () => {
    const template = readFileSync(exampleConfigPath(), 'utf8');
    const cfg = parseConfig(renderConfigTemplate(template, REPO));
    expect(cfg.t3?.projectTitle).toBe('widgets');
  });
});

describe('initProject', () => {
  test('writes the config into the project home and makes it active', () => {
    const result = initProject(REPO);
    expect(result.slug).toBe(projectSlug('acme', 'widgets'));
    expect(existsSync(result.configPath)).toBe(true);
    expect(activeProjectSlug()).toBe(result.slug);
  });

  test('the written config loads back through the real validator', () => {
    const result = initProject(REPO);
    expect(parseConfig(readFileSync(result.configPath, 'utf8')).repo.owner).toBe('acme');
  });

  test('creates the tasks and worktrees directories the runtime expects', () => {
    const result = initProject(REPO);
    expect(existsSync(join(projectHome(result.slug), 'tasks'))).toBe(true);
    expect(existsSync(join(projectHome(result.slug), 'worktrees'))).toBe(true);
  });

  test('refuses to clobber an existing config', () => {
    initProject(REPO);
    expect(() => initProject(REPO)).toThrow(/already/i);
  });

  test('force replaces an existing config', () => {
    initProject(REPO);
    const again = initProject({ ...REPO, branchPrefix: 'bob' }, { force: true });
    expect(parseConfig(readFileSync(again.configPath, 'utf8')).repo.branchPrefix).toBe('bob');
  });

  test('a second repository gets its own project, leaving the first intact', () => {
    const first = initProject(REPO);
    const second = initProject({ ...REPO, name: 'gadgets', path: 'C:\src\gadgets' });
    expect(second.slug).not.toBe(first.slug);
    expect(existsSync(first.configPath)).toBe(true);
    expect(activeProjectSlug()).toBe(second.slug);
  });
});
