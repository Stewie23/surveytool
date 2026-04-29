import type { FastifyReply } from "fastify";

export type SsePayload = Record<string, unknown>;

export class SseHub {
  private clients = new Map<string, Set<FastifyReply>>();

  add(surveyId: string, reply: FastifyReply): void {
    const clients = this.clients.get(surveyId) ?? new Set<FastifyReply>();
    clients.add(reply);
    this.clients.set(surveyId, clients);
    reply.raw.on("close", () => {
      clients.delete(reply);
      if (clients.size === 0) {
        this.clients.delete(surveyId);
      }
    });
  }

  send(reply: FastifyReply, payload: SsePayload, event = "message"): void {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcast(surveyId: string, payload: SsePayload, event = "message"): void {
    for (const reply of this.clients.get(surveyId) ?? []) {
      this.send(reply, payload, event);
    }
  }
}
