import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where T3 Code keeps the files Mission Control reads.
 *
 * Two directories exist and only one matters. Electron's Chromium profile
 * lives under %APPDATA%\t3code; everything this integration reads — the
 * server's runtime descriptor and the per-provider readiness caches — lives
 * under ~/.t3. Confusing them wastes an afternoon, which is why the split is
 * recorded here rather than at the call sites.
 *
 * T3_HOME overrides the location, which is what lets tests run against a temp
 * directory instead of the real one, mirroring MC_HOME in ./paths.ts.
 */
export function t3Home(): string {
  return process.env.T3_HOME ?? join(homedir(), '.t3');
}

/** T3's own record of the server it is currently running. */
export function t3ServerRuntimePath(): string {
  return join(t3Home(), 'userdata', 'server-runtime.json');
}

/**
 * Per-provider readiness, refreshed by T3 itself.
 *
 * This is the only source for whether an instance can actually run: the REST
 * surface carries projects and threads but no provider list, and provider
 * state lives on the WebSocket, which this integration does not use.
 */
export function t3ProviderCachePath(instanceId: string): string {
  return join(t3Home(), 'caches', `${instanceId}.json`);
}

/**
 * The ceiling on any request to T3.
 *
 * Same reasoning as SUBPROCESS_TIMEOUT_MS in ../exec.ts: reconciles run behind
 * the poller's single serialized promise, so one request that never returns
 * wedges the board permanently rather than losing one cycle. T3 is on loopback,
 * so this can be much tighter than the `gh` budget.
 */
export const T3_TIMEOUT_MS = 10_000;
