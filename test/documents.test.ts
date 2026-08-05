import { describe, expect, test } from 'vitest';

import {
  classify,
  extensionOf,
  resolveWriteTarget,
  MAX_DOCUMENT_BYTES,
} from '../src/orchestrator/documents.ts';
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
