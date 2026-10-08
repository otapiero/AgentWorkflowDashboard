import type { FastifyInstance } from 'fastify';

import type { RouteContext } from './route-helpers.ts';

/** The SSE stream the board listens on for pushed updates. */
export function registerEventsRoutes(
  app: FastifyInstance,
  { broadcaster, refresh }: Pick<RouteContext, 'broadcaster' | 'refresh'>,
): void {
  app.get<{ Querystring: { replay?: string } }>('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const replay = req.query.replay !== '0';
    // The 0->1 transition means a tab opened after a dormant stretch: kick one
    // fresh reconcile so the board is current. Replay-disabled clients establish
    // their own authoritative baseline after opening, so they need only future pushes.
    const wasEmpty = broadcaster.size === 0;
    // Register before the first response body write so transitions racing with a
    // replay-disabled client's baseline are buffered by its open SSE response.
    broadcaster.add(reply, { replay });
    reply.raw.write(': connected\n\n');
    if (wasEmpty && replay) void refresh();
  });
}
