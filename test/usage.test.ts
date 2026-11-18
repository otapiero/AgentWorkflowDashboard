import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseCodexSessionFile,
  parseSessionFile,
  missionUsage,
} from '../src/orchestrator/usage.ts';
import { worktreePath } from '../src/orchestrator/paths.ts';

function line(obj: unknown): string { return JSON.stringify(obj); }
function asst(cwd: string, usage: Record<string, number>, ts: string, model = 'claude-opus-4-8') {
  return line({ type: 'assistant', cwd, timestamp: ts, sessionId: 'sess', message: { model, usage } });
}

describe('parseSessionFile', () => {
  const cwd = 'c:\\Users\\alice\\.mission-control\\projects\\acme__widgets\\worktrees\\issue-1';
  test('sums usage for the same worktree despite Windows path spelling differences', () => {
    const content = [
      asst(cwd, { input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 }, '2026-07-26T00:00:00Z'),
      asst(cwd, { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '2026-07-26T00:05:00Z'),
    ].join('\n');
    const s = parseSessionFile(content, 'sess', 'C:/Users/Alice/.mission-control/projects/acme__widgets/worktrees/issue-1')!;
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
  const cwd = 'c:\\Users\\alice\\.mission-control\\projects\\acme__widgets\\worktrees\\issue-1';

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
        timestamp: '2026-08-03T00:02:00Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } },
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
  let home: string;
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'mc-proj-'));
    codexSessions = mkdtempSync(join(tmpdir(), 'mc-codex-'));
    process.env.MC_CLAUDE_PROJECTS = projects;
    process.env.MC_CODEX_SESSIONS = codexSessions;
    home = mkdtempSync(join(tmpdir(), 'mc-home-'));
    process.env.MC_HOME = home;
  });
  afterEach(() => {
    delete process.env.MC_CLAUDE_PROJECTS;
    delete process.env.MC_CODEX_SESSIONS;
    delete process.env.MC_HOME;
    rmSync(projects, { recursive: true, force: true });
    rmSync(codexSessions, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test('reports untracked when nothing matches', () => {
    expect(missionUsage(999).tracked).toBe(false);
    expect(missionUsage(999).total.total).toBe(0);
  });

  test('combines multiple Claude sessions and a nested Codex session for the same worktree', () => {
    const cwd = worktreePath(1);
    const claudeFolder = join(projects, 'issue-1-folder');
    mkdirSync(claudeFolder, { recursive: true });
    writeFileSync(
      join(claudeFolder, 'claude.jsonl'),
      asst(cwd, { input_tokens: 1, output_tokens: 2 }, '2026-08-03T00:00:00Z'),
    );
    writeFileSync(
      join(claudeFolder, 'claude-next.jsonl'),
      asst(cwd, { input_tokens: 4 }, '2026-08-03T00:30:00Z'),
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
    expect(usage.sessions.map((session) => session.agent)).toEqual(['claude', 'claude', 'codex']);
    expect(usage.total.total).toBe(19);
  });
});
