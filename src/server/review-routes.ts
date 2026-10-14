import type { FastifyInstance } from 'fastify';

import type { createReviewRequestsReader } from '../orchestrator/review-requests.ts';
import type { createReviewWorktrees } from '../orchestrator/review-worktrees.ts';
import { errorMessage } from './route-helpers.ts';

export function registerReviewRoutes(app: FastifyInstance, {
  readReviewRequests,
  reviewWorktrees,
}: {
  readReviewRequests: ReturnType<typeof createReviewRequestsReader>;
  reviewWorktrees: ReturnType<typeof createReviewWorktrees>;
}): void {
  app.get<{ Querystring: { refresh?: string } }>('/api/review-requests', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ...await readReviewRequests(req.query.refresh === 'true'), worktrees: reviewWorktrees.list() };
  });

  app.post<{ Params: { number: string } }>('/api/review-requests/:number/open', async (req, reply) => {
    const number = Number(req.params.number);
    if (!Number.isSafeInteger(number) || number <= 0) return reply.code(400).send({ error: 'Invalid PR number' });
    try {
      // A local review remains available even after its GitHub request goes away.
      const local = reviewWorktrees.list().find(pr => pr.number === number);
      const snapshot = local ? null : await readReviewRequests(true);
      const pr = local ?? snapshot?.pullRequests.find(pr => pr.number === number);
      if (!pr) return reply.code(snapshot?.error ? 503 : 404).send({ error: snapshot?.error ?? 'PR is not waiting for your review' });
      return await reviewWorktrees.open(pr);
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });

  app.post<{ Params: { number: string } }>('/api/review-requests/:number/finish', async (req, reply) => {
    const number = Number(req.params.number);
    if (!Number.isSafeInteger(number) || number <= 0) return reply.code(400).send({ error: 'Invalid PR number' });
    try {
      if (!reviewWorktrees.list().some(pr => pr.number === number)) return reply.code(404).send({ error: 'No local review for this PR' });
      return await reviewWorktrees.finish(number);
    } catch (err) {
      return reply.code(409).send({ error: errorMessage(err) });
    }
  });
}
