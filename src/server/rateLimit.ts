import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

type Bucket = {
  startedAt: number;
  count: number;
};

const buckets = new Map<string, Bucket>();

export function checkResponseRateLimit(request: FastifyRequest, config: AppConfig): boolean {
  const key = request.ip;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.startedAt > config.responseRateLimitWindow) {
    buckets.set(key, { startedAt: now, count: 1 });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= config.responseRateLimitMax;
}
