import { describe, expect, test } from 'vitest';

import {
  availableModes,
  buildDocList,
  clampFontPx,
  clampSplit,
  dirtyKeys,
  docKey,
  effectiveMode,
  FONT_DEFAULT,
  FONT_MAX,
  FONT_MIN,
  SPLIT_DEFAULT,
} from '../src/web/doc-model.ts';
import type { ArtifactRef } from '../src/shared/types.ts';

const ref = (name: string, origin: 'taskdir' | 'repo'): ArtifactRef => ({
  name,
  storedPath: `artifacts/${name}`,
  origin,
  originalPath: `C:\\wt\\${name}`,
});

describe('docKey', () => {
  test('namespaces artifacts so a file named "plan" cannot collide', () => {
    expect(docKey({ kind: 'plan' })).toBe('plan');
    expect(docKey({ kind: 'artifact', name: 'plan' })).toBe('artifact:plan');
  });
});

describe('buildDocList', () => {
  test('puts the plan first and keeps manifest order after it', () => {
    const list = buildDocList([ref('spec.md', 'repo'), ref('notes.txt', 'taskdir')]);
    expect(list.map((d) => d.label)).toEqual(['plan.md', 'spec.md', 'notes.txt']);
  });

  test('flags only repo-origin artifacts as in-checkout', () => {
    const list = buildDocList([ref('spec.md', 'repo'), ref('notes.txt', 'taskdir')]);
    expect(list.map((d) => d.inCheckout)).toEqual([false, true, false]);
  });

  test('handles a task with no artifacts at all', () => {
    expect(buildDocList([])).toHaveLength(1);
  });

  test('carries arbitrary names through untouched', () => {
    const list = buildDocList([ref('2026-08-05-whatever-the-agent-chose.md', 'repo')]);
    expect(list[1]!.label).toBe('2026-08-05-whatever-the-agent-chose.md');
    expect(list[1]!.id).toEqual({ kind: 'artifact', name: '2026-08-05-whatever-the-agent-chose.md' });
  });
});

describe('clampFontPx', () => {
  test('holds the documented bounds', () => {
    expect(FONT_MIN).toBe(11);
    expect(FONT_MAX).toBe(24);
    expect(FONT_DEFAULT).toBe(13);
  });
  test('clamps below and above', () => {
    expect(clampFontPx(2)).toBe(11);
    expect(clampFontPx(99)).toBe(24);
  });
  test('rounds and passes through the middle', () => {
    expect(clampFontPx(15.4)).toBe(15);
  });
  test('a corrupt stored value falls back to the default', () => {
    expect(clampFontPx(Number.NaN)).toBe(13);
  });
});

describe('clampSplit', () => {
  test('clamps to 0.2 .. 0.8 and defaults on garbage', () => {
    expect(clampSplit(0.05)).toBe(0.2);
    expect(clampSplit(0.95)).toBe(0.8);
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
  });
});

describe('dirtyKeys', () => {
  test('reports every edited buffer, not just the visible one', () => {
    const keys = dirtyKeys({
      plan: { text: 'a', loaded: 'a' },
      'artifact:spec.md': { text: 'changed', loaded: 'original' },
      'artifact:notes.txt': { text: 'also changed', loaded: '' },
    });
    expect(keys.sort()).toEqual(['artifact:notes.txt', 'artifact:spec.md']);
  });
  test('is empty when nothing has been touched', () => {
    expect(dirtyKeys({ plan: { text: 'a', loaded: 'a' } })).toEqual([]);
  });
});

describe('availableModes / effectiveMode', () => {
  test('markdown offers all three modes', () => {
    expect(availableModes('markdown')).toEqual(['edit', 'split', 'preview']);
  });
  test('plain text offers editing only', () => {
    expect(availableModes('text')).toEqual(['edit']);
  });
  test('a preferred mode a text document cannot honour degrades to edit', () => {
    expect(effectiveMode('preview', 'text')).toBe('edit');
    expect(effectiveMode('split', 'text')).toBe('edit');
  });
  test('a preferred mode markdown can honour is kept', () => {
    expect(effectiveMode('split', 'markdown')).toBe('split');
  });
});
