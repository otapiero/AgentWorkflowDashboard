import { describe, expect, test } from 'vitest';
import { countPorcelainChanges, parseCount } from '../src/orchestrator/worktree.ts';

describe('countPorcelainChanges', () => {
  test('a clean tree has no changes', () => {
    expect(countPorcelainChanges('')).toBe(0);
  });

  test('counts one line per changed file', () => {
    const out = ' M backend/Program.cs\n?? notes.txt\nA  frontend/app.tsx';
    expect(countPorcelainChanges(out)).toBe(3);
  });

  test('handles windows line endings', () => {
    // git on Windows via execa can yield CRLF; a stray \r must not become a file.
    expect(countPorcelainChanges(' M a.cs\r\n?? b.txt\r\n')).toBe(2);
  });

  test('ignores trailing blank lines', () => {
    expect(countPorcelainChanges(' M a.cs\n\n\n')).toBe(1);
  });

  test('counts a rename as a single change', () => {
    expect(countPorcelainChanges('R  old.cs -> new.cs')).toBe(1);
  });

  test('counts files whose paths contain spaces once each', () => {
    expect(countPorcelainChanges('?? "my file.cs"\n?? other file.cs')).toBe(2);
  });
});

describe('parseCount', () => {
  test('reads a plain count', () => {
    expect(parseCount('3')).toBe(3);
  });

  test('tolerates surrounding whitespace and newlines', () => {
    expect(parseCount('  7\n')).toBe(7);
  });

  test('treats empty output as zero', () => {
    expect(parseCount('')).toBe(0);
  });

  test('treats unparseable output as zero rather than NaN', () => {
    // A NaN leaking into the badge count would render as "NaN unpushed".
    expect(parseCount('fatal: bad revision')).toBe(0);
  });
});
