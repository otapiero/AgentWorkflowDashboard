import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activeProjectSlug,
  configPath,
  listProjects,
  mcHome,
  projectSlug,
  projectsDir,
  scriptsDir,
  setActiveProject,
} from '../src/orchestrator/paths.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-root-'));
  process.env.MC_ROOT = root;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;
});

afterEach(() => {
  delete process.env.MC_ROOT;
  delete process.env.MC_HOME;
  delete process.env.MC_PROJECT;
  rmSync(root, { recursive: true, force: true });
});

function makeProject(slug: string): void {
  mkdirSync(join(root, 'projects', slug), { recursive: true });
}

describe('projectSlug', () => {
  test('joins owner and name with a double underscore, lowercased', () => {
    expect(projectSlug('Acme-Corp', 'Widget-Store')).toBe('acme-corp__widget-store');
  });

  test('replaces characters that are not directory-safe', () => {
    expect(projectSlug('my org', 'repo.js+')).toBe('my-org__repo.js');
  });
});

describe('active project resolution', () => {
  test('MC_PROJECT wins over everything', () => {
    makeProject('a__one');
    makeProject('b__two');
    setActiveProject('a__one');
    process.env.MC_PROJECT = 'b__two';
    expect(activeProjectSlug()).toBe('b__two');
  });

  test('falls back to the recorded active project', () => {
    makeProject('a__one');
    makeProject('b__two');
    setActiveProject('b__two');
    expect(activeProjectSlug()).toBe('b__two');
  });

  test('a sole project needs no recorded choice', () => {
    makeProject('a__one');
    expect(activeProjectSlug()).toBe('a__one');
  });

  test('no project at all names the command that fixes it', () => {
    expect(() => activeProjectSlug()).toThrow(/mc -- init/);
  });

  test('several projects and no choice names the command that fixes it', () => {
    makeProject('a__one');
    makeProject('b__two');
    expect(() => activeProjectSlug()).toThrow(/project use/);
  });

  test('listProjects returns the directory names, sorted', () => {
    makeProject('b__two');
    makeProject('a__one');
    expect(listProjects()).toEqual(['a__one', 'b__two']);
  });

  test('listProjects on a fresh root is empty, not a throw', () => {
    expect(listProjects()).toEqual([]);
  });
});

describe('the root/project split', () => {
  test('project state lives under projects/<slug>', () => {
    makeProject('a__one');
    expect(mcHome()).toBe(join(projectsDir(), 'a__one'));
    expect(configPath()).toBe(join(root, 'projects', 'a__one', 'config.yaml'));
  });

  test('MC_HOME still overrides the project home outright', () => {
    // This is what keeps every existing test file working unchanged.
    const explicit = join(root, 'somewhere-else');
    process.env.MC_HOME = explicit;
    expect(mcHome()).toBe(explicit);
  });

  test('scripts stay at the root even when MC_HOME is overridden', () => {
    process.env.MC_HOME = join(root, 'somewhere-else');
    expect(scriptsDir()).toBe(join(root, 'scripts'));
  });
});
