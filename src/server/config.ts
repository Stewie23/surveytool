import path from "node:path";

export type AppConfig = {
  port: number;
  sqlitePath: string;
  adminToken: string;
  adminPassword: string;
  minPublicResponsesPerPlz: number;
  responseRateLimitWindow: number;
  responseRateLimitMax: number;
  postalCodesPath: string;
  staticDir: string;
  publicBaseUrl?: string;
};

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const adminToken = process.env.ADMIN_TOKEN ?? "dev-admin-token";
  return {
    port: numberFromEnv("PORT", 3000),
    sqlitePath: process.env.SQLITE_PATH ?? "survey.sqlite",
    adminToken,
    adminPassword: process.env.ADMIN_PASSWORD || adminToken,
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    responseRateLimitWindow: numberFromEnv("RESPONSE_RATE_LIMIT_WINDOW", 60_000),
    responseRateLimitMax: numberFromEnv("RESPONSE_RATE_LIMIT_MAX", 20),
    minPublicResponsesPerPlz: numberFromEnv("MIN_PUBLIC_RESPONSES_PER_PLZ", 1),
    postalCodesPath: path.resolve("public", "data", "postal-codes.json"),
    staticDir: path.resolve("dist", "client"),
    ...overrides
  };
}
