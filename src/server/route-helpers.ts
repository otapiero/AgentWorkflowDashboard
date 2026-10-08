import type { FastifyReply } from 'fastify';

import type { cleanupDoneTask } from '../orchestrator/cleanup.ts';
import type { createReviewRequestsReader } from '../orchestrator/review-requests.ts';
import { getTask } from '../orchestrator/state.ts';
import type { Config, HealthResponse, TaskRecord, TaskWithDerived } from '../shared/types.ts';
import type { Broadcaster } from './sse.ts';

/** What every route module needs, resolved once by registerRoutes. */
export interface RouteContext {
  config: Config;
  broadcaster: Broadcaster;
  /** Re-derive and push to every connected board. A forced run broadcasts. */
  refresh: () => Promise<TaskWithDerived[]>;
  health: HealthResponse;
  cleanupTask: typeof cleanupDoneTask;
  readReviewRequests: ReturnType<typeof createReviewRequestsReader>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The task a `:issue` route param names. When the board has no such task the
 * 404 is already sent, so the caller only has to `return reply`.
 */
export function findTask(issueParam: string, reply: FastifyReply): TaskRecord | null {
  const task = getTask(Number(issueParam));
  if (!task) void reply.code(404).send({ error: 'task not on the board' });
  return task;
}
