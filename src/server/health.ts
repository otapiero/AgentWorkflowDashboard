import type { HealthResponse } from '../shared/types.ts';

export function createHealthResponse(
  serverVersion: string,
  startedAt = new Date().toISOString(),
): HealthResponse {
  return Object.freeze({ status: 'ok', apiVersion: 1, serverVersion, pid: process.pid, startedAt });
}
