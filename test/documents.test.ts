import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classify,
  extensionOf,
  readArtifactDocument,
  resolveWriteTarget,
  writeArtifactDocument,
  MAX_DOCUMENT_BYTES,
} from '../src/orchestrator/documents.ts';
import { artifactsDir, artifactsManifestPath, taskDir } from '../src/orchestrator/paths.ts';
import type { ArtifactRef } from '../src/shared/types.ts';

describe('extensionOf', () => {
  test('lowercases and includes the dot', () => {
    expect(extensionOf('DESIGN.MD')).toBe('.md');
  });
  test('is empty for a name with no dot', () => {
    expect(extensionOf('NOTES')).toBe('');
  });
  test('treats a leading-dot name as its own extension, not as markdown', () => {
    expect(extensionOf('.gitignore')).toBe('.gitignore');
  });
  test('uses the basename, so a dotted directory does not leak in', () => {
    expect(extensionOf('docs.v2/plan')).toBe('');
  });
});

describe('classify', () => {
  const text = (s: string) => Buffer.from(s, 'utf8');

  test('markdown by extension', () => {
    expect(classify('design.md', text('# hi'))).toBe('markdown');
    expect(classify('design.markdown', text('# hi'))).toBe('markdown');
  });
  test('markdown when there is no extension at all', () => {
    expect(classify('NOTES', text('# hi'))).toBe('markdown');
  });
  test('other text extensions are text, not markdown', () => {
    expect(classify('data.json', text('{}'))).toBe('text');
    expect(classify('helper.ts', text('export {}'))).toBe('text');
  });
  test('a NUL byte anywhere in the sniff window means binary', () => {
    expect(classify('notes.md', Buffer.from([0x23, 0x00, 0x41]))).toBe('binary');
  });
  test('a NUL past the sniff window is not consulted', () => {
    const bytes = Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]);
    expect(classify('big.txt', bytes)).toBe('text');
  });
  test('the cap is two megabytes', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('resolveWriteTarget', () => {
  const ref = (origin: 'taskdir' | 'repo'): ArtifactRef => ({
    name: 'design.md',
    storedPath: 'artifacts/design.md',
    origin,
    originalPath: 'C:\\wt\\docs\\design.md',
  });

  test('writes the original when it still resolves', () => {
    expect(resolveWriteTarget(ref('repo'), () => true)).toBe('original');
  });
  test('falls back to the snapshot when the original is gone', () => {
    expect(resolveWriteTarget(ref('repo'), () => false)).toBe('snapshot');
  });
  test('origin does not enter the decision', () => {
    expect(resolveWriteTarget(ref('taskdir'), () => true)).toBe('original');
    expect(resolveWriteTarget(ref('taskdir'), () => false)).toBe('snapshot');
  });
  test('probes exactly the recorded original path', () => {
    const seen: string[] = [];
    resolveWriteTarget(ref('repo'), (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual(['C:\\wt\\docs\\design.md']);
  });
});

describe('readArtifactDocument / writeArtifactDocument', () => {
  const ISSUE = 77;
  let home: string;
  let originalDir: string;

  /** Seed a manifest plus the two copies an artifact normally has. */
  function seed(name: string, body: Buffer | string, opts: { original: boolean }) {
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
          { name, storedPath: `artifacts/${name}`, origin: 'repo', originalPath },
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
    seed('design.md', '# snap\n', { original: false });

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

  test('a manifest entry whose files have all vanished is gone', () => {
    seed('design.md', 'x', { original: false });
    rmSync(join(artifactsDir(ISSUE), 'design.md'));
    expect(readArtifactDocument(ISSUE, 'design.md')).toEqual({ ok: false, error: 'gone' });
  });

  test('a NUL-bearing artifact is binary', () => {
    seed('shot.png', Buffer.from([0x89, 0x50, 0x00, 0x0d]), { original: true });
    expect(readArtifactDocument(ISSUE, 'shot.png')).toEqual({ ok: false, error: 'binary' });
  });

  test('an oversized artifact is refused before it is read', () => {
    seed('huge.md', Buffer.alloc(2 * 1024 * 1024 + 1, 0x41), { original: true });
    expect(readArtifactDocument(ISSUE, 'huge.md')).toEqual({ ok: false, error: 'too-large' });
  });

  test('writing with a live original updates BOTH copies', () => {
    const original = seed('design.md', 'old\n', { original: true });

    expect(writeArtifactDocument(ISSUE, 'design.md', 'new\n')).toEqual({
      ok: true,
      value: 'original',
    });
    expect(readFileSync(original, 'utf8')).toBe('new\n');
    expect(readFileSync(join(artifactsDir(ISSUE), 'design.md'), 'utf8')).toBe('new\n');
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
