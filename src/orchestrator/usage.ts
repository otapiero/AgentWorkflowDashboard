import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { claudeProjectsDir, codexSessionsDir, worktreePath } from './paths.ts';

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
}
export interface SessionUsage {
  sessionId: string;
  agent: 'claude' | 'codex';
  tokens: TokenTotals;
  models: string[];
  startedAt: string;
  endedAt: string;
}
export interface MissionUsage {
  total: TokenTotals;
  sessions: SessionUsage[];
  tracked: boolean;
}

const ZERO: TokenTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };

/** Case- and separator-insensitive path equality (Windows transcript cwd). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function addUsage(acc: TokenTotals, u: Record<string, unknown>): TokenTotals {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const input = acc.input + n(u.input_tokens);
  const output = acc.output + n(u.output_tokens);
  const cacheCreate = acc.cacheCreate + n(u.cache_creation_input_tokens);
  const cacheRead = acc.cacheRead + n(u.cache_read_input_tokens);
  return { input, output, cacheCreate, cacheRead, total: input + output + cacheCreate + cacheRead };
}

/**
 * Sum the usage of one transcript file, counting only assistant lines whose cwd
 * matches the mission's worktree. Returns null if nothing matched.
 */
export function parseSessionFile(
  content: string,
  sessionId: string,
  targetCwd: string,
): SessionUsage | null {
  let tokens = { ...ZERO };
  const models = new Set<string>();
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let matched = false;

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: {
      type?: string;
      cwd?: string;
      timestamp?: string;
      message?: { model?: string; usage?: Record<string, unknown> };
    };
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // a truncated tail line is not a reason to lose the session
    }
    if (line?.type !== 'assistant') continue;
    if (typeof line.cwd !== 'string' || !samePath(line.cwd, targetCwd)) continue;
    const usage = line.message?.usage;
    if (!usage) continue;

    matched = true;
    tokens = addUsage(tokens, usage);
    if (typeof line.message?.model === 'string') models.add(line.message.model);
    const ts = typeof line.timestamp === 'string' ? line.timestamp : null;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }
  }

  if (!matched) return null;
  return {
    sessionId,
    agent: 'claude',
    tokens,
    models: [...models],
    startedAt: startedAt ?? '',
    endedAt: endedAt ?? '',
  };
}

function codexTokens(usage: Record<string, unknown>): TokenTotals {
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const inputTotal = n(usage.input_tokens);
  const cacheRead = n(usage.cached_input_tokens);
  const cacheCreate = n(usage.cache_write_input_tokens);
  // Codex input_tokens includes cached input. Keep the four UI categories
  // disjoint so their sum equals total_tokens rather than double-counting it.
  const input = Math.max(0, inputTotal - cacheRead - cacheCreate);
  const output = n(usage.output_tokens);
  const total = n(usage.total_tokens) || input + output + cacheCreate + cacheRead;
  return { input, output, cacheCreate, cacheRead, total };
}

/** Parse one Codex rollout, using its final cumulative token_count event. */
export function parseCodexSessionFile(
  content: string,
  fallbackSessionId: string,
  targetCwd: string,
): SessionUsage | null {
  let sessionId = fallbackSessionId;
  let sessionMatches = false;
  let startedAt = '';
  let endedAt = '';
  let tokens: TokenTotals | null = null;
  const models = new Set<string>();

  for (const raw of content.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let line: {
      type?: string;
      timestamp?: string;
      payload?: {
        type?: string;
        id?: string;
        cwd?: string;
        model?: string;
        info?: { total_token_usage?: Record<string, unknown> };
      };
    };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }

    if (line.type === 'session_meta') {
      if (typeof line.payload?.id === 'string') sessionId = line.payload.id;
      if (typeof line.payload?.cwd === 'string') {
        sessionMatches = samePath(line.payload.cwd, targetCwd);
      }
      if (typeof line.timestamp === 'string') startedAt = line.timestamp;
      continue;
    }

    if (line.type === 'turn_context' && typeof line.payload?.model === 'string') {
      models.add(line.payload.model);
    }

    if (
      line.type === 'event_msg' &&
      line.payload?.type === 'token_count' &&
      line.payload.info?.total_token_usage
    ) {
      tokens = codexTokens(line.payload.info.total_token_usage);
      if (typeof line.timestamp === 'string') endedAt = line.timestamp;
    }
  }

  if (!sessionMatches || !tokens) return null;
  return {
    sessionId,
    agent: 'codex',
    tokens,
    models: [...models],
    startedAt,
    endedAt,
  };
}

function collectClaudeSessions(targetCwd: string, issue: number): SessionUsage[] {
  const root = claudeProjectsDir();
  const sessions: SessionUsage[] = [];

  if (existsSync(root)) {
    // Prefilter by folder name for speed; the per-line cwd check is what makes
    // attribution correct, so a false-positive folder is harmless.
    const wanted = `issue-${issue}`;
    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory() || !folder.name.includes(wanted)) continue;
      const dir = join(root, folder.name);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace(/\.jsonl$/, '');
        const parsed = parseSessionFile(readFileSync(join(dir, file), 'utf8'), sessionId, targetCwd);
        if (parsed) sessions.push(parsed);
      }
    }
  }

  return sessions;
}

function jsonlFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...jsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}

function collectCodexSessions(targetCwd: string): SessionUsage[] {
  const root = codexSessionsDir();
  if (!existsSync(root)) return [];

  const sessions: SessionUsage[] = [];
  for (const file of jsonlFiles(root)) {
    const fallbackId = basename(file, '.jsonl');
    const parsed = parseCodexSessionFile(readFileSync(file, 'utf8'), fallbackId, targetCwd);
    if (parsed) sessions.push(parsed);
  }
  return sessions;
}

/** All supported agent sessions attributable to a mission's worktree. */
export function missionUsage(issue: number): MissionUsage {
  const targetCwd = worktreePath(issue);
  const sessions = [
    ...collectClaudeSessions(targetCwd, issue),
    ...collectCodexSessions(targetCwd),
  ];

  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const total = sessions.reduce<TokenTotals>((acc, s) => addUsage(acc, {
    input_tokens: s.tokens.input,
    output_tokens: s.tokens.output,
    cache_creation_input_tokens: s.tokens.cacheCreate,
    cache_read_input_tokens: s.tokens.cacheRead,
  }), { ...ZERO });

  return { total, sessions, tracked: sessions.length > 0 };
}
