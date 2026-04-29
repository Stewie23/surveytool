import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { getAggregates, getTotals, upsertAggregate } from "./aggregate.js";
import { isAdminRequest } from "./auth.js";
import { type AppConfig, loadConfig } from "./config.js";
import { type Db, migrate, openDb, seedDefaultSurvey, syncPostalCodes, transaction } from "./db.js";
import { loadPostalCodes } from "./plzDataset.js";
import { checkResponseRateLimit } from "./rateLimit.js";
import { adminSurveySchema, randomResponsesSchema, responseSchema, surveyIdParamsSchema } from "./schemas.js";
import { SseHub } from "./sse.js";

type SurveyRow = {
  id: string;
  title: string;
  question_text: string;
  min_rating: number;
  max_rating: number;
  is_active: number;
};

export type BuildServerOptions = {
  config?: Partial<AppConfig>;
  db?: Db;
  postalCodes?: Set<string>;
};

export type BuiltServer = {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  postalCodes: Set<string>;
};

export function buildServer(options: BuildServerOptions = {}): BuiltServer {
  const config = loadConfig(options.config);
  ensureSqliteDir(config.sqlitePath);
  const db = options.db ?? openDb(config.sqlitePath);
  const postalCodes = options.postalCodes ?? loadPostalCodes(config.postalCodesPath);
  const hub = new SseHub();

  migrate(db);
  seedDefaultSurvey(db);
  syncPostalCodes(db, postalCodes);

  const app = Fastify({ logger: false });

  app.addHook("onClose", async () => {
    db.close();
  });

  app.get("/api/survey/active", async (_, reply) => {
    const survey = getActiveSurvey(db);
    if (!survey) return reply.code(404).send({ error: "No active survey configured" });
    return serializeSurvey(survey);
  });

  app.post("/api/admin/survey", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const parsed = adminSurveySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid survey", details: parsed.error.flatten() });
    }

    const now = new Date().toISOString();
    const id = "active";
    transaction(db, () => {
      if (parsed.data.is_active) {
        db.prepare("UPDATE surveys SET is_active = 0, updated_at = ?").run(now);
      }
      db.prepare(`
        INSERT INTO surveys (id, title, question_text, min_rating, max_rating, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          question_text = excluded.question_text,
          min_rating = excluded.min_rating,
          max_rating = excluded.max_rating,
          is_active = excluded.is_active,
          updated_at = excluded.updated_at
      `).run(
        id,
        parsed.data.title,
        parsed.data.question_text,
        parsed.data.min_rating,
        parsed.data.max_rating,
        parsed.data.is_active ? 1 : 0,
        now,
        now
      );
    });

    return serializeSurvey(db.prepare("SELECT * FROM surveys WHERE id = ?").get(id) as SurveyRow);
  });

  app.post("/api/responses", async (request, reply) => {
    if (!checkResponseRateLimit(request, config)) {
      return reply.code(429).send({ error: "Too many responses. Please try again later." });
    }

    const parsed = responseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid response", details: parsed.error.flatten() });
    }

    const { survey_id, postal_code, rating } = parsed.data;
    if (!postalCodes.has(postal_code)) {
      return reply.code(400).send({ error: "Unknown postal_code" });
    }

    const survey = db.prepare("SELECT * FROM surveys WHERE id = ?").get(survey_id) as SurveyRow | undefined;
    if (!survey || !survey.is_active) {
      return reply.code(400).send({ error: "Survey is not active" });
    }
    if (rating < survey.min_rating || rating > survey.max_rating) {
      return reply.code(400).send({ error: "Rating outside configured range" });
    }

    const now = new Date().toISOString();
    const responseId = randomUUID();
    const aggregate = transaction(db, () => {
      db.prepare(`
        INSERT INTO responses (id, survey_id, postal_code, rating, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(responseId, survey_id, postal_code, rating, now);
      return upsertAggregate(db, survey_id, postal_code, rating);
    });

    const publicAggregate = applyThreshold(aggregate, config.minPublicResponsesPerPlz);
    hub.broadcast(survey_id, {
      type: "aggregate-update",
      survey_id,
      ...publicAggregate
    }, "aggregate-update");

    return reply.code(201).send({ id: responseId, aggregate: publicAggregate });
  });

  app.get("/api/results/:surveyId", async (request, reply) => {
    const parsed = surveyIdParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid survey id" });
    return getAggregates(db, parsed.data.surveyId, config.minPublicResponsesPerPlz);
  });

  app.get("/api/results/:surveyId/stream", async (request, reply) => {
    const parsed = surveyIdParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid survey id" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    hub.add(parsed.data.surveyId, reply);
    hub.send(reply, {
      type: "aggregate-snapshot",
      survey_id: parsed.data.surveyId,
      aggregates: getAggregates(db, parsed.data.surveyId, config.minPublicResponsesPerPlz)
    }, "aggregate-snapshot");
  });

  app.get("/api/admin/export.csv", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const rows = db.prepare(`
      SELECT id, survey_id, postal_code, rating, created_at
      FROM responses
      ORDER BY created_at
    `).all() as Array<Record<string, unknown>>;

    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", "attachment; filename=\"responses.csv\"");
    return toCsv(rows, ["id", "survey_id", "postal_code", "rating", "created_at"]);
  });

  app.get("/api/admin/stats", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const survey = getActiveSurvey(db);
    return survey ? getTotals(db, survey.id) : { totalResponses: 0, postalCodeCount: 0 };
  });

  app.post("/api/admin/clear-results", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const survey = getActiveSurvey(db);
    transaction(db, () => {
      db.prepare("DELETE FROM responses").run();
      db.prepare("DELETE FROM postal_code_aggregates").run();
    });

    if (survey) {
      broadcastSnapshot(hub, db, survey.id, config.minPublicResponsesPerPlz);
    }

    return { totalResponses: 0, postalCodeCount: 0 };
  });

  app.post("/api/admin/random-responses", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const parsed = randomResponsesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid random response request", details: parsed.error.flatten() });
    }

    const survey = getActiveSurvey(db);
    if (!survey) {
      return reply.code(400).send({ error: "No active survey configured" });
    }

    const postalCodeList = Array.from(postalCodes);
    if (postalCodeList.length === 0) {
      return reply.code(400).send({ error: "No postal codes are available" });
    }

    transaction(db, () => {
      const insertResponse = db.prepare(`
        INSERT INTO responses (id, survey_id, postal_code, rating, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let index = 0; index < parsed.data.count; index += 1) {
        const postalCode = postalCodeList[randomInt(0, postalCodeList.length - 1)];
        const rating = randomInt(survey.min_rating, survey.max_rating);
        const now = new Date().toISOString();
        insertResponse.run(randomUUID(), survey.id, postalCode, rating, now);
        upsertAggregate(db, survey.id, postalCode, rating);
      }
    });

    broadcastSnapshot(hub, db, survey.id, config.minPublicResponsesPerPlz);
    return getTotals(db, survey.id);
  });

  if (fs.existsSync(path.join(config.staticDir, "index.html"))) {
    app.get("/*", async (request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return sendStaticFile(config.staticDir, request.raw.url ?? "/", reply);
    });
  }

  return { app, db, config, postalCodes };
}

function getActiveSurvey(db: Db): SurveyRow | undefined {
  return db.prepare("SELECT * FROM surveys WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1").get() as SurveyRow | undefined;
}

function serializeSurvey(survey: SurveyRow) {
  return {
    id: survey.id,
    title: survey.title,
    question_text: survey.question_text,
    min_rating: survey.min_rating,
    max_rating: survey.max_rating,
    is_active: Boolean(survey.is_active)
  };
}

function applyThreshold<T extends { count: number; average: number | null; hidden: boolean }>(aggregate: T, min: number): T {
  return {
    ...aggregate,
    average: aggregate.count < min ? null : aggregate.average,
    hidden: aggregate.count < min
  };
}

function broadcastSnapshot(hub: SseHub, db: Db, surveyId: string, minPublicResponses: number): void {
  hub.broadcast(surveyId, {
    type: "aggregate-snapshot",
    survey_id: surveyId,
    aggregates: getAggregates(db, surveyId, minPublicResponses)
  }, "aggregate-snapshot");
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toCsv(rows: Array<Record<string, unknown>>, headers: string[]): string {
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
  };
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))
  ].join("\n");
}

function ensureSqliteDir(sqlitePath: string): void {
  if (sqlitePath === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
}

function sendStaticFile(root: string, url: string, reply: FastifyReply) {
  const pathname = decodeURIComponent(url.split("?")[0] ?? "/");
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const requested = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  const staticFile = resolveStaticFile(requested, normalizedRoot);
  const filePath = staticFile.path;

  reply.type(contentType(filePath));
  if (staticFile.contentEncoding) {
    reply.header("content-encoding", staticFile.contentEncoding);
    reply.header("vary", "Accept-Encoding");
  }
  return fs.createReadStream(filePath);
}

function resolveStaticFile(requested: string, normalizedRoot: string): { path: string; contentEncoding?: string } {
  if (isWithinRoot(requested, normalizedRoot) && fs.existsSync(requested) && fs.statSync(requested).isFile()) {
    return { path: requested };
  }

  const brotliPath = `${requested}.br`;
  if (
    path.extname(requested) === ".topojson" &&
    isWithinRoot(brotliPath, normalizedRoot) &&
    fs.existsSync(brotliPath) &&
    fs.statSync(brotliPath).isFile()
  ) {
    return { path: brotliPath, contentEncoding: "br" };
  }

  return { path: path.join(normalizedRoot, "index.html") };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath.replace(/\.br$/i, ""));
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json" || ext === ".topojson") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
