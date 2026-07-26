import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { samePath, parseSessionFile, missionUsage } from '../src/orchestrator/usage.ts';
import { worktreePath } from '../src/orchestrator/paths.ts';

function line(obj: unknown): string { return JSON.stringify(obj); }
function asst(cwd: string, usage: Record<string, number>, ts: string, model = 'claude-opus-4-8') {
  return line({ type: 'assistant', cwd, timestamp: ts, sessionId: 'sess', message: { model, usage } });
}

describe('samePath', () => {
  test('ignores drive-letter case and separator style', () => {
    expect(samePath('C:\\Users\\o\\wt', 'c:/users/o/wt')).toBe(true);
    expect(samePath('C:\\a', 'C:\\b')).toBe(false);
  });
});

describe('parseSessionFile', () => {
  const cwd = 'c:\\Users\\o\\.mc\\worktrees\\issue-1';
  test('sums the four usage fields for matching-cwd assistant lines', () => {
    const content = [
      asst(cwd, { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }, '2026-07-26T00:00:00Z'),
      asst(cwd, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T00:05:00Z'),
    ].join('\n');
    const s = parseSessionFile(content, 'sess', cwd)!;
    expect(s.tokens).toEqual({ input: 3, output: 6, cacheCreate: 10, cacheRead: 20, total: 39 });
    expect(s.startedAt).toBe('2026-07-26T00:00:00Z');
    expect(s.endedAt).toBe('2026-07-26T00:05:00Z');
    expect(s.models).toEqual(['claude-opus-4-8']);
  });

  test('excludes lines whose cwd differs', () => {
    const content = [
      asst(cwd, { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T00:00:00Z'),
      asst('c:\\somewhere\\else', { input_tokens: 99, output_tokens: 99, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T00:01:00Z'),
    ].join('\n');
    const s = parseSessionFile(content, 'sess', cwd)!;
    expect(s.tokens.total).toBe(10);
  });

  test('returns null when no line matches', () => {
    expect(parseSessionFile(asst('c:\\other', {}, 't'), 'sess', cwd)).toBeNull();
  });
});

describe('missionUsage', () => {
  let projects: string;
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'mc-proj-'));
    process.env.MC_CLAUDE_PROJECTS = projects;
    process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-home-'));
  });
  afterEach(() => {
    delete process.env.MC_CLAUDE_PROJECTS;
    delete process.env.MC_HOME;
    rmSync(projects, { recursive: true, force: true });
  });

  test('rolls all sessions for a worktree into a mission total', () => {
    const cwd = worktreePath(1); // uses MC_HOME
    const folder = join(projects, 'issue-1-folder');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'a.jsonl'), asst(cwd, { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, '2026-07-26T00:00:00Z'));
    writeFileSync(join(folder, 'b.jsonl'), asst(cwd, { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T01:00:00Z'));
    const u = missionUsage(1);
    expect(u.tracked).toBe(true);
    expect(u.sessions).toHaveLength(2);
    expect(u.total.total).toBe(20);
  });

  test('reports untracked when nothing matches', () => {
    expect(missionUsage(999).tracked).toBe(false);
    expect(missionUsage(999).total.total).toBe(0);
  });
});
