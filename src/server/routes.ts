import type { FastifyInstance } from 'fastify';

import { cleanupDoneTask } from '../orchestrator/cleanup.ts';
import { createReviewRequestsReader } from '../orchestrator/review-requests.ts';
import { createReviewWorktrees } from '../orchestrator/review-worktrees.ts';
import type { NotesService } from '../orchestrator/notes.ts';
import type { Config, HealthResponse, TaskWithDerived } from '../shared/types.ts';
import { registerConfigRoutes } from './config-routes.ts';
import { registerDocumentRoutes } from './document-routes.ts';
import { registerEventsRoutes } from './events-routes.ts';
import { registerNotesRoutes } from './notes-routes.ts';
import { registerReviewRoutes } from './review-routes.ts';
import type { RouteContext } from './route-helpers.ts';
import { registerRunRoutes } from './run-routes.ts';
import { registerTaskRoutes } from './task-routes.ts';
import { registerStackRoutes } from './stack-routes.ts';
import type { Broadcaster } from './sse.ts';

interface Deps {
  config: Config;
  broadcaster: Broadcaster;
  refresh: () => Promise<TaskWithDerived[]>;
  health: HealthResponse;
  notes?: NotesService;
  /** Injected so the move route can be tested without shelling out to git. */
  cleanup?: typeof cleanupDoneTask;
  reviewWorktrees?: ReturnType<typeof createReviewWorktrees>;
}

/** The one entry point: each area of the API registers itself from here. */
export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const { config, broadcaster, refresh, health } = deps;
  if (deps.notes) registerNotesRoutes(app, { service: deps.notes });

  const ctx: RouteContext = {
    config,
    broadcaster,
    refresh,
    health,
    cleanupTask: deps.cleanup ?? cleanupDoneTask,
    readReviewRequests: createReviewRequestsReader(config),
  };

  registerConfigRoutes(app, ctx);
  registerReviewRoutes(app, {
    readReviewRequests: ctx.readReviewRequests,
    reviewWorktrees: deps.reviewWorktrees ?? createReviewWorktrees(config),
  });
  registerTaskRoutes(app, ctx);
  registerStackRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerDocumentRoutes(app, config);
  registerEventsRoutes(app, ctx);
}
