import type { HealthResponse } from '../shared/types.ts';

export function createHealthResponse(
  serverVersion: string,
  startedAt = new Date().toISOString(),
  instanceId = process.env.MC_INSTANCE_ID,
): HealthResponse {
  return Object.freeze({
    status: 'ok',
    apiVersion: 1,
    serverVersion,
    pid: process.pid,
    startedAt,
    // A blank id is treated as unclaimed: an empty string would otherwise match
    // a spawner that failed to inject one, and it would adopt a stranger.
    instanceId: instanceId ? instanceId : null,
  });
}
