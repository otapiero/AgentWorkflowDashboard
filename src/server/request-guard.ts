import type { FastifyInstance } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Why a request may not reach the API, or null when it may.
 *
 * Listening on 127.0.0.1 is not enough on its own. A page on another site can
 * submit a form to the server, and DNS rebinding lets that page's own domain
 * resolve to this machine so the browser treats the API as same-origin. The
 * first sends a foreign Origin, the second a foreign Host, so both are
 * refused. Clients without a browser (the VS Code extension, the notes MCP
 * server) send no Origin and are unaffected.
 */
export function rejectReason(host: string | undefined, origin: string | undefined): string | null {
  const server = host ? parseUrl(`http://${host}`) : null;
  if (!server || server.username || server.pathname !== '/' || !LOOPBACK.has(server.hostname)) {
    return 'unexpected Host header';
  }
  if (origin === undefined) return null;
  const page = parseUrl(origin);
  // The Vite dev proxy keeps the browser's Host, so this also holds in dev.
  if (!page || page.protocol !== 'http:' || page.host !== server.host) return 'cross-origin request';
  return null;
}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

export function registerRequestGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const reason = rejectReason(req.headers.host, req.headers.origin);
    if (reason) return reply.code(403).send({ error: `Forbidden: ${reason}` });
  });
}
