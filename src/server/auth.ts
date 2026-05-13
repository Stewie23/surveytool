import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

const ADMIN_SESSION_COOKIE = "admin_session";

export function isAdminRequest(request: FastifyRequest, adminToken: string, adminSessions: ReadonlySet<string> = new Set()): boolean {
  const authorization = request.headers.authorization;
  const headerToken = request.headers["x-admin-token"];
  const queryToken = typeof (request.query as { token?: unknown }).token === "string"
    ? (request.query as { token: string }).token
    : null;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
  return bearer === adminToken || headerToken === adminToken || queryToken === adminToken || isAdminSessionRequest(request, adminSessions);
}

export function isAdminSessionRequest(request: FastifyRequest, adminSessions: ReadonlySet<string>): boolean {
  const sessionId = getCookie(request, ADMIN_SESSION_COOKIE);
  return Boolean(sessionId && adminSessions.has(sessionId));
}

export function hasAdminPassword(candidate: unknown, adminPassword: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(adminPassword);
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function adminSessionCookie(sessionId: string): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    process.env.NODE_ENV === "production" ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

export function clearAdminSessionCookie(): string {
  return [
    `${ADMIN_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    process.env.NODE_ENV === "production" ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

export function getAdminSessionId(request: FastifyRequest): string | null {
  return getCookie(request, ADMIN_SESSION_COOKIE);
}

function getCookie(request: FastifyRequest, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  for (const part of cookies.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}
