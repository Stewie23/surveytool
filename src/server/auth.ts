import type { FastifyRequest } from "fastify";

export function isAdminRequest(request: FastifyRequest, adminToken: string): boolean {
  const authorization = request.headers.authorization;
  const headerToken = request.headers["x-admin-token"];
  const queryToken = typeof (request.query as { token?: unknown }).token === "string"
    ? (request.query as { token: string }).token
    : null;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  return bearer === adminToken || headerToken === adminToken || queryToken === adminToken;
}
