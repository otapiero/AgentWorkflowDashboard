import type { FastifyReply } from 'fastify';

/**
 * Server-sent events: one-directional push of reconciled state.
 *
 * The UI never polls — it renders whatever the last push contained, so the
 * board and the orchestrator can never drift apart.
 */
export class Broadcaster {
  private clients = new Set<FastifyReply>();
  /** The most recent payload per event, replayed so a new tab is never blank. */
  private last = new Map<string, string>();

  add(reply: FastifyReply): void {
    this.clients.add(reply);
    // Catch the new client up with the latest of each event immediately, rather
    // than forcing a fresh reconcile just because a tab opened.
    for (const payload of this.last.values()) {
      try {
        reply.raw.write(payload);
      } catch {
        this.clients.delete(reply);
      }
    }
    reply.raw.on('close', () => this.clients.delete(reply));
  }

  get size(): number {
    return this.clients.size;
  }

  send(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.last.set(event, payload);
    for (const client of this.clients) {
      try {
        client.raw.write(payload);
      } catch {
        // A disconnected client is not an error worth surfacing.
        this.clients.delete(client);
      }
    }
  }
}
