import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  samePath,
  parseCodexSessionFile,
  parseSessionFile,
  missionUsage,
} from '../src/orchestrator/usage.ts';
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

describe('parseCodexSessionFile', () => {
  const cwd = 'c:\\Users\\o\\.mc\\worktrees\\issue-1';

  test('uses the final cumulative total and does not double-count cached input', () => {
    const content = [
      line({
        type: 'session_meta',
        timestamp: '2026-08-03T00:00:00Z',
        payload: { id: 'codex-session', cwd },
      }),
      line({
        type: 'turn_context',
        timestamp: '2026-08-03T00:00:01Z',
        payload: { model: 'gpt-5.6-sol', cwd },
      }),
      line({
        type: 'event_msg',
        timestamp: '2026-08-03T00:05:00Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 60,
              cache_write_input_tokens: 10,
              output_tokens: 20,
              total_tokens: 120,
            },
          },
        },
      }),
    ].join('\n');

    const parsed = parseCodexSessionFile(content, 'fallback', cwd)!;
    expect(parsed.agent).toBe('codex');
    expect(parsed.sessionId).toBe('codex-session');
    expect(parsed.models).toEqual(['gpt-5.6-sol']);
    expect(parsed.tokens).toEqual({
      input: 30,
      output: 20,
      cacheCreate: 10,
      cacheRead: 60,
      total: 120,
    });
    expect(parsed.endedAt).toBe('2026-08-03T00:05:00Z');
  });

  test('rejects a rollout from another worktree', () => {
    const content = line({
      type: 'session_meta',
      payload: { id: 'other', cwd: 'c:\\other' },
    });
    expect(parseCodexSessionFile(content, 'fallback', cwd)).toBeNull();
  });
});

describe('missionUsage', () => {
  let projects: string;
  let codexSessions: string;
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'mc-proj-'));
    codexSessions = mkdtempSync(join(tmpdir(), 'mc-codex-'));
    process.env.MC_CLAUDE_PROJECTS = projects;
    process.env.MC_CODEX_SESSIONS = codexSessions;
    process.env.MC_HOME = mkdtempSync(join(tmpdir(), 'mc-home-'));
  });
  afterEach(() => {
    delete process.env.MC_CLAUDE_PROJECTS;
    delete process.env.MC_CODEX_SESSIONS;
    delete process.env.MC_HOME;
    rmSync(projects, { recursive: true, force: true });
    rmSync(codexSessions, { recursive: true, force: true });
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

  test('combines Claude and nested Codex sessions for the same worktree', () => {
    const cwd = worktreePath(1);
    const claudeFolder = join(projects, 'issue-1-folder');
    mkdirSync(claudeFolder, { recursive: true });
    writeFileSync(
      join(claudeFolder, 'claude.jsonl'),
      asst(cwd, { input_tokens: 1, output_tokens: 2 }, '2026-08-03T00:00:00Z'),
    );

    const dateFolder = join(codexSessions, '2026', '08', '03');
    mkdirSync(dateFolder, { recursive: true });
    writeFileSync(
      join(dateFolder, 'rollout-codex.jsonl'),
      [
        line({ type: 'session_meta', timestamp: '2026-08-03T01:00:00Z', payload: { id: 'codex', cwd } }),
        line({ type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd } }),
        line({
          type: 'event_msg',
          timestamp: '2026-08-03T01:05:00Z',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } },
          },
        }),
      ].join('\n'),
    );

    const usage = missionUsage(1);
    expect(usage.sessions.map((session) => session.agent)).toEqual(['claude', 'codex']);
    expect(usage.total.total).toBe(15);
  });
});
