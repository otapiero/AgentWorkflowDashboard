import { readFileSync } from 'node:fs';

import { t3ProviderCachePath } from './paths.ts';
import { providerCacheSchema, safeParseT3 } from './schemas.ts';

/**
 * Can this T3 provider instance actually run a turn?
 *
 * T3 exposes no provider list over REST — the snapshot carries projects and
 * threads only, and provider state lives on the WebSocket this integration
 * deliberately does not use. What T3 does publish is one readiness file per
 * instance under ~/.t3/caches, which it refreshes itself. Reading it is the
 * same discipline as reading server-runtime.json.
 *
 * Checking before dispatch is what turns an opaque server rejection into a
 * sentence the operator can act on.
 */

export interface InstanceReadiness {
  instanceId: string;
  ready: boolean;
  /** Present when ready is false — a sentence fit to show on a card. */
  reason: string | null;
  models: string[];
}

/** Instance ids are slugs in T3; anything else cannot name a cache file. */
const INSTANCE_ID = /^[a-zA-Z0-9_-]+$/;

export function readInstanceReadiness(instanceId: string): InstanceReadiness {
  const notReady = (reason: string): InstanceReadiness => ({
    instanceId,
    ready: false,
    reason,
    models: [],
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

  if (!cache.enabled) return notReady(`${name} is disabled in T3.`);
  if (!cache.installed) {
    return notReady(cache.message ?? `${name}'s CLI is not installed or not on PATH.`);
  }
  if (cache.status !== 'ready') {
    return notReady(cache.message ?? `${name} reports status '${cache.status}'.`);
  }

  return { instanceId, ready: true, reason: null, models };
}
