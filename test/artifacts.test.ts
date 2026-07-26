import { describe, it, expect } from 'vitest';
import {
  parsePorcelainPaths,
  diffFiles,
  uniqueName,
  shouldCollectPlan,
} from '../src/orchestrator/artifacts.ts';

describe('parsePorcelainPaths', () => {
  it('extracts paths and resolves renames to their new name', () => {
    const out = ' M docs/spec.md\n?? docs/new.md\nR  a.md -> b.md\n';
    expect(parsePorcelainPaths(out)).toEqual(['docs/spec.md', 'docs/new.md', 'b.md']);
  });
  it('returns [] for empty output', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });
});

describe('diffFiles', () => {
  it('returns entries present in after but not before', () => {
    expect(diffFiles(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });
});

describe('uniqueName', () => {
  it('keeps the base when free', () => {
    expect(uniqueName([], 'plan.md')).toBe('plan.md');
  });
  it('suffixes before the extension on collision', () => {
    expect(uniqueName(['plan.md'], 'plan.md')).toBe('plan-1.md');
    expect(uniqueName(['plan.md', 'plan-1.md'], 'plan.md')).toBe('plan-2.md');
  });
});

describe('shouldCollectPlan', () => {
  const base = { liveSpawn: null, planMdExists: true, planDoneMarker: false, manifestExists: false };
  it('collects when the plan spawn has ended and produced a plan', () => {
    expect(shouldCollectPlan(base)).toBe(true);
  });
  it('collects on the done marker even if a process still looks live', () => {
    expect(shouldCollectPlan({ ...base, liveSpawn: { pid: 1 }, planDoneMarker: true })).toBe(true);
  });
  it('never collects once a manifest exists', () => {
    expect(shouldCollectPlan({ ...base, manifestExists: true })).toBe(false);
  });
  it('waits while a spawn is live with no done marker', () => {
    expect(shouldCollectPlan({ ...base, liveSpawn: { pid: 1 } })).toBe(false);
  });
});
