import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classify,
  readArtifactDocument,
  writeArtifactDocument,
} from '../src/orchestrator/documents.ts';
import { artifactsDir, artifactsManifestPath, taskDir } from '../src/orchestrator/paths.ts';

describe('classify', () => {
  const text = (s: string) => Buffer.from(s, 'utf8');

  test('markdown by extension', () => {
    expect(classify('DESIGN.MD', text('# hi'))).toBe('markdown');
    expect(classify('design.markdown', text('# hi'))).toBe('markdown');
  });
  test('markdown when there is no extension at all', () => {
    expect(classify('docs.v2/NOTES', text('# hi'))).toBe('markdown');
  });
  test('other text extensions are text, not markdown', () => {
    expect(classify('data.json', text('{}'))).toBe('text');
    expect(classify('.gitignore', text('dist/'))).toBe('text');
  });
});

describe('readArtifactDocument / writeArtifactDocument', () => {
  const ISSUE = 77;
  let home: string;
  let originalDir: string;

  /** Seed a manifest plus the two copies an artifact normally has. */
  function seed(name: string, body: string, opts: { original: boolean; origin?: 'taskdir' }) {
    mkdirSync(artifactsDir(ISSUE), { recursive: true });
    writeFileSync(join(artifactsDir(ISSUE), name), body);
    const originalPath = join(originalDir, name);
    if (opts.original) {
      mkdirSync(originalDir, { recursive: true });
      writeFileSync(originalPath, body);
    }
    writeFileSync(
      artifactsManifestPath(ISSUE),
      JSON.stringify({
        collectedAt: '2026-08-05T00:00:00.000Z',
        trigger: 'auto',
        artifacts: [
          { name, storedPath: `artifacts/${name}`, origin: opts.origin ?? 'repo', originalPath },
        ],
      }),
      'utf8',
    );
    return originalPath;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mc-docs-'));
    process.env.MC_HOME = home;
    originalDir = join(home, 'checkout', 'docs');
    mkdirSync(taskDir(ISSUE), { recursive: true });
  });

  afterEach(() => {
    delete process.env.MC_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('reads the original in preference to a stale snapshot', () => {
    const original = seed('design.md', '# stale\n', { original: true });
    writeFileSync(original, '# fresh\n');

    const result = readArtifactDocument(ISSUE, 'design.md');
    expect(result).toMatchObject({
      ok: true,
      value: { content: '# fresh\n', class: 'markdown', writeTarget: 'original' },
    });
  });

  test('falls back to the snapshot when the original is gone', () => {
    seed('design.md', '# snap\n', { original: false, origin: 'taskdir' });

    const result = readArtifactDocument(ISSUE, 'design.md');
    expect(result).toMatchObject({
      ok: true,
      value: { content: '# snap\n', writeTarget: 'snapshot' },
    });
  });

  test('a name absent from the manifest is not-found, never a path probe', () => {
    seed('design.md', 'x', { original: true });
    expect(readArtifactDocument(ISSUE, '../../secret')).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  test('writing with the original gone updates the snapshot and says so', () => {
    seed('design.md', 'old\n', { original: false });

    expect(writeArtifactDocument(ISSUE, 'design.md', 'new\n')).toEqual({
      ok: true,
      value: 'snapshot',
    });
    expect(readFileSync(join(artifactsDir(ISSUE), 'design.md'), 'utf8')).toBe('new\n');
  });

  test('writing an unknown name is not-found and touches nothing', () => {
    seed('design.md', 'old\n', { original: true });
    expect(writeArtifactDocument(ISSUE, 'nope.md', 'x')).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(readFileSync(join(artifactsDir(ISSUE), 'design.md'), 'utf8')).toBe('old\n');
  });
});
