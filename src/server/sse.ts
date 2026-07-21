import type { FastifyReply } from 'fastify';

/**
 * Server-sent events: one-directional push of reconciled state.
 *
 * The UI never polls — it renders whatever the last push contained, so the
 * board and the orchestrator can never drift apart.
 */
export class Broadcaster {
  private clients = new Set<FastifyReply>();

  add(reply: FastifyReply): void {
    this.clients.add(reply);
    reply.raw.on('close', () => this.clients.delete(reply));
  }

  get size(): number {
    return this.clients.size;
  }

  send(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
