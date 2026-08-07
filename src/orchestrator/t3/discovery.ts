import { readFileSync } from 'node:fs';

import { T3_TIMEOUT_MS, t3ServerRuntimePath } from './paths.ts';
import {
  environmentDescriptorSchema,
  safeParseT3,
  serverRuntimeSchema,
  type ServerRuntime,
} from './schemas.ts';

/**
 * Finding T3 Code, or establishing that it is not there.
 *
 * Mission Control never spawns T3's server — the desktop application owns its
 * own lifecycle, which is what preserves the principle that the app is never
 * the parent of a run. So discovery is pure observation, and "not available"
 * is a first-class answer rather than an error.
 *
 * Each failure carries its own reason because the three cases need different
 * fixes: no file means start T3, a dead pid means T3 crashed, unreachable
 * means something is wrong with the server itself.
 */

export type T3Unavailable =
  | { reason: 'no-runtime-file'; detail: string }
  | { reason: 'unreadable-runtime-file'; detail: string }
  | { reason: 'dead-server'; detail: string }
  | { reason: 'unreachable'; detail: string };

export type T3Discovery =
  | {
      ok: true;
      origin: string;
      pid: number;
      serverVersion: string;
      capabilities: Record<string, unknown>;
    }
  | ({ ok: false } & T3Unavailable);

export function readServerRuntime(): ServerRuntime | undefined {
  try {
    return safeParseT3(serverRuntimeSchema, JSON.parse(readFileSync(t3ServerRuntimePath(), 'utf8')));
  } catch {
    // Missing, truncated, or unreadable — all mean the same thing to a caller.
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Join an origin to a path without producing a double slash. */
export function t3Url(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}

export async function discoverT3(fetchImpl: typeof fetch = fetch): Promise<T3Discovery> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(t3ServerRuntimePath(), 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { ok: false, reason: 'no-runtime-file', detail: t3ServerRuntimePath() }
      : { ok: false, reason: 'unreadable-runtime-file', detail: String(err) };
  }

  const runtime = safeParseT3(serverRuntimeSchema, raw);
  if (!runtime) {
    return { ok: false, reason: 'unreadable-runtime-file', detail: 'failed schema validation' };
  }

  if (!isProcessAlive(runtime.pid)) {
    return { ok: false, reason: 'dead-server', detail: `pid ${runtime.pid} is gone` };
  }

  // The descriptor is unauthenticated, which is what makes it usable as a
  // reachability probe and as the version pin even when pairing is broken.
  try {
    const res = await fetchImpl(t3Url(runtime.origin, '/.well-known/t3/environment'), {
      signal: AbortSignal.timeout(T3_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reason: 'unreachable', detail: `descriptor returned ${res.status}` };
    }
    const descriptor = safeParseT3(environmentDescriptorSchema, await res.json());
    if (!descriptor) {
      return { ok: false, reason: 'unreachable', detail: 'descriptor failed validation' };
    }
    return {
      ok: true,
      origin: runtime.origin,
      pid: runtime.pid,
      serverVersion: descriptor.serverVersion,
      capabilities: descriptor.capabilities,
    };
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: String(err) };
  }
}
