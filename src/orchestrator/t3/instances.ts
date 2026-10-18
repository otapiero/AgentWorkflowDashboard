import { readFileSync } from 'node:fs';

import { t3ProviderCachePath } from './paths.ts';
import { providerCacheSchema, safeParseT3 } from './schemas.ts';

/**
 * Can this T3 provider instance actually run a turn?
 *
 * T3 exposes no provider list over REST — the snapshot carries projects and
 * threads only, and provider state requires a separate live subscription.
 * What T3 does publish is one readiness file per
 * instance under ~/.t3/caches, which it refreshes itself. Reading it is the
 * same discipline as reading server-runtime.json.
 *
 * Checking before dispatch is what turns an opaque server rejection into a
 * sentence the operator can act on.
 */

/** One 'select' knob a model exposes, e.g. codex's reasoningEffort. */
export interface ModelOptionDescriptor {
  id: string;
  values: string[];
}

export interface InstanceReadiness {
  instanceId: string;
  ready: boolean;
  /** Present when ready is false — a sentence fit to show on a card. */
  reason: string | null;
  models: string[];
  /**
   * The select knobs each model slug advertises. Every provider names its
   * reasoning scale differently — claudeAgent calls it 'effort', codex
   * 'reasoningEffort', opencode 'variant' — so the id cannot be assumed, and
   * a guess is silently discarded by T3 rather than rejected. Carrying the
   * instance's own descriptors is what lets a spawn send the id it uses.
   *
   * Optional: a caller that cannot supply them (a test double, an older
   * cache) falls back to the historical 'effort' id rather than losing the
   * launch.
   */
  options?: Record<string, ModelOptionDescriptor[]>;
}

/** Instance ids are slugs in T3; anything else cannot name a cache file. */
const INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;

export function readInstanceReadiness(instanceId: string): InstanceReadiness {
  const notReady = (reason: string): InstanceReadiness => ({
    instanceId,
    ready: false,
    reason,
    models: [],
    options: {},
  });

  // config.yaml is hand-edited, so a typo must not become a read of an
  // arbitrary path.
  if (!INSTANCE_ID.test(instanceId)) {
    return notReady(`'${instanceId}' is not a valid T3 provider instance id.`);
  }

  let cache;
  try {
    cache = safeParseT3(
      providerCacheSchema,
      JSON.parse(readFileSync(t3ProviderCachePath(instanceId), 'utf8')),
    );
  } catch {
    return notReady(
      `T3 has no provider instance '${instanceId}' (looked for ${t3ProviderCachePath(instanceId)}).`,
    );
  }
  if (!cache) {
    return notReady(`T3's readiness file for '${instanceId}' could not be understood.`);
  }

  const name = cache.displayName || instanceId;
  const models = cache.models.map((m) => m.slug);
  const options: Record<string, ModelOptionDescriptor[]> = {};
  for (const model of cache.models) {
    options[model.slug] = (model.capabilities?.optionDescriptors ?? [])
      .filter((descriptor) => descriptor.type === 'select')
      .map((descriptor) => ({
        id: descriptor.id,
        values: descriptor.options.map((option) => option.id),
      }));
  }

  if (!cache.enabled) return notReady(`${name} is disabled in T3.`);
  if (!cache.installed) {
    return notReady(cache.message ?? `${name}'s CLI is not installed or not on PATH.`);
  }
  if (cache.status !== 'ready') {
    return notReady(cache.message ?? `${name} reports status '${cache.status}'.`);
  }

  return { instanceId, ready: true, reason: null, models, options };
}
