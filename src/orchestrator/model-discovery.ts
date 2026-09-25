import { statSync } from 'node:fs';

import { readInstanceReadiness } from './t3/instances.ts';
import { t3ProviderCachePath } from './t3/paths.ts';

/**
 * Where an agent's live model list can be read from.
 *
 * None of the three CLIs has a non-interactive "list models" command that
 * reflects what the account may actually use — copilot's only lives behind
 * the interactive /model picker, and an org admin can withdraw models at any
 * time (a withdrawn one fails as `Model "…" from --model flag is not
 * available`). T3 does the asking for us: each provider instance's readiness
 * cache under ~/.t3/caches carries the models that account is entitled to,
 * and T3 refreshes it itself. Copilot has no T3 driver, so its list comes from
 * OpenCode's `github-copilot/` models — the same Copilot entitlement, reached
 * through the same subscription.
 *
 * `pinned` are the CLI's own pseudo-models (default, auto, family aliases);
 * no provider advertises them, so they are kept in front of what is found.
 */
const SOURCES: Record<string, { instance: string; prefix?: string; pinned: string[] }> = {
  claude: { instance: 'claudeAgent', pinned: ['default', 'opus', 'sonnet', 'haiku'] },
  copilot: { instance: 'opencode', prefix: 'github-copilot/', pinned: ['auto'] },
  codex: { instance: 'codex', pinned: ['default'] },
};

const cache = new Map<string, { mtimeMs: number; models: string[] }>();

/**
 * The models this agent's account currently offers, or null when there is no
 * source to ask (unknown agent, T3 not installed, provider not ready) and the
 * caller should fall back to its static list.
 */
export function discoverModels(agent: string, t3Instance?: string): string[] | null {
  const source = SOURCES[agent];
  if (!source) return null;
  const instance = t3Instance ?? source.instance;

  // Keyed on the file's mtime: capabilities are read on every poll, and the
  // cache only changes when T3 rewrites it.
  const path = t3ProviderCachePath(instance);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const key = `${agent}:${path}`;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit.models.length ? hit.models : null;

  const readiness = readInstanceReadiness(instance);
  const found = readiness.ready
    ? readiness.models
        .filter((slug) => !source.prefix || slug.startsWith(source.prefix))
        .map((slug) => (source.prefix ? slug.slice(source.prefix.length) : slug))
    : [];
  const models = found.length
    ? [...source.pinned, ...found.filter((slug) => !source.pinned.includes(slug))]
    : [];
  cache.set(key, { mtimeMs, models });
  return models.length ? models : null;
}
