import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeProjectsDir, worktreePath } from './paths.ts';

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
}
export interface SessionUsage {
  sessionId: string;
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
    tokens,
    models: [...models],
    startedAt: startedAt ?? '',
    endedAt: endedAt ?? '',
  };
}

/** All Claude Code sessions attributable to a mission's worktree. */
export function missionUsage(issue: number): MissionUsage {
  const targetCwd = worktreePath(issue);
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

  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const total = sessions.reduce<TokenTotals>((acc, s) => addUsage(acc, {
    input_tokens: s.tokens.input,
    output_tokens: s.tokens.output,
    cache_creation_input_tokens: s.tokens.cacheCreate,
    cache_read_input_tokens: s.tokens.cacheRead,
  }), { ...ZERO });

  return { total, sessions, tracked: sessions.length > 0 };
}
