import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { getAggregates, getTotals, upsertAggregate } from "./aggregate.js";
import { adminSessionCookie, clearAdminSessionCookie, getAdminSessionId, hasAdminPassword, isAdminRequest, isAdminSessionRequest } from "./auth.js";
import { type AppConfig, loadConfig } from "./config.js";
import { type Db, migrate, openDb, seedDefaultSurvey, syncPostalCodes, transaction } from "./db.js";
import { loadPostalCodes } from "./plzDataset.js";
import { checkResponseRateLimit } from "./rateLimit.js";
import { adminSurveySchema, newsletterContactSchema, randomResponsesSchema, responseSchema, surveyIdParamsSchema } from "./schemas.js";
import { SseHub } from "./sse.js";
import { DEFAULT_MAP_PALETTE, isMapPaletteId } from "../shared/mapPalettes.js";
import type { MapLodLevel } from "../shared/types.js";

type SurveyRow = {
  id: string;
  title: string;
  question_text: string;
  min_rating: number;
  max_rating: number;
  rating_labels: string;
  pages: string;
  start_text?: string;
  start_logo_data_url?: string;
  thank_you_text?: string;
  terms_enabled: number;
  terms_text: string;
  use_aggregated_shapes: number;
  map_lod_levels?: string;
  map_palette?: string;
  is_active: number;
};

type SurveyPage = {
  id: string;
  title: string;
  questions: SurveyQuestion[];
};

type SurveyQuestion = {
  id: string;
  text: string;
  min_rating: number;
  max_rating: number;
  rating_labels: Record<string, string>;
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
  const adminSessions = new Set<string>();

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
    return serializeSurvey(db, survey);
  });

  app.get("/api/admin/session", async (request) => ({
    authenticated: isAdminSessionRequest(request, adminSessions)
  }));

  app.post("/api/admin/login", async (request, reply) => {
    const password = typeof request.body === "object" && request.body && "password" in request.body
      ? (request.body as { password?: unknown }).password
      : undefined;

    if (!hasAdminPassword(password, config.adminPassword)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const sessionId = randomUUID();
    adminSessions.add(sessionId);
    reply.header("set-cookie", adminSessionCookie(sessionId));
    return { authenticated: true };
  });

  app.post("/api/admin/logout", async (request, reply) => {
    const sessionId = getAdminSessionId(request);
    if (sessionId) {
      adminSessions.delete(sessionId);
    }
    reply.header("set-cookie", clearAdminSessionCookie());
    return { authenticated: false };
  });

  app.post("/api/admin/survey", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken, adminSessions)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const parsed = adminSurveySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid survey", details: parsed.error.flatten() });
    }

    const now = new Date().toISOString();
    const id = "active";
    const firstQuestion = parsed.data.pages[0].questions[0];
    const pagesJson = JSON.stringify(parsed.data.pages);
    transaction(db, () => {
      if (parsed.data.is_active) {
        db.prepare("UPDATE surveys SET is_active = 0, updated_at = ?").run(now);
      }
      db.prepare(`
        INSERT INTO surveys
          (id, title, question_text, min_rating, max_rating, rating_labels, pages, start_text, start_logo_data_url, thank_you_text, terms_enabled, terms_text, use_aggregated_shapes, map_lod_levels, map_palette, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          question_text = excluded.question_text,
          min_rating = excluded.min_rating,
          max_rating = excluded.max_rating,
          rating_labels = excluded.rating_labels,
          pages = excluded.pages,
          start_text = excluded.start_text,
          start_logo_data_url = excluded.start_logo_data_url,
          thank_you_text = excluded.thank_you_text,
          terms_enabled = excluded.terms_enabled,
          terms_text = excluded.terms_text,
          use_aggregated_shapes = excluded.use_aggregated_shapes,
          map_lod_levels = excluded.map_lod_levels,
          map_palette = excluded.map_palette,
          is_active = excluded.is_active,
          updated_at = excluded.updated_at
      `).run(
        id,
        parsed.data.title,
        firstQuestion.text,
        firstQuestion.min_rating,
        firstQuestion.max_rating,
        JSON.stringify(firstQuestion.rating_labels),
        pagesJson,
        parsed.data.start_text,
        parsed.data.start_logo_data_url,
        parsed.data.thank_you_text,
        parsed.data.terms_enabled ? 1 : 0,
        parsed.data.terms_text,
        parsed.data.use_aggregated_shapes ? 1 : 0,
        JSON.stringify(parsed.data.map_lod_levels),
        parsed.data.map_palette,
        parsed.data.is_active ? 1 : 0,
        now,
        now
      );
      replaceSurveyDefinition(db, id, parsed.data.pages);
    });

    return serializeSurvey(db, db.prepare("SELECT * FROM surveys WHERE id = ?").get(id) as SurveyRow);
  });

  app.post("/api/responses", async (request, reply) => {
    if (!checkResponseRateLimit(request, config)) {
      return reply.code(429).send({ error: "Too many responses. Please try again later." });
    }

    const parsed = responseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid response", details: parsed.error.flatten() });
    }

    const { survey_id, postal_code, answers, terms_accepted } = parsed.data;
    if (!postalCodes.has(postal_code)) {
      return reply.code(400).send({ error: "Unknown postal_code" });
    }

    const survey = db.prepare("SELECT * FROM surveys WHERE id = ?").get(survey_id) as SurveyRow | undefined;
    if (!survey || !survey.is_active) {
      return reply.code(400).send({ error: "Survey is not active" });
    }
    if (survey.terms_enabled && terms_accepted !== true) {
      return reply.code(400).send({ error: "Terms must be accepted" });
    }

    const questions = getQuestions(db, survey);
    const questionById = new Map(questions.map((question) => [question.id, question]));
    const answerByQuestionId = new Map<string, number>();
    for (const answer of answers) {
      if (answerByQuestionId.has(answer.question_id)) {
        return reply.code(400).send({ error: "Duplicate answer question_id" });
      }
      const question = questionById.get(answer.question_id);
      if (!question) {
        return reply.code(400).send({ error: "Unknown question_id" });
      }
      if (answer.rating < question.min_rating || answer.rating > question.max_rating) {
        return reply.code(400).send({ error: "Rating outside configured range" });
      }
      answerByQuestionId.set(answer.question_id, answer.rating);
    }
    if (answerByQuestionId.size !== questions.length) {
      return reply.code(400).send({ error: "Response must answer every survey question exactly once" });
    }

    const now = new Date().toISOString();
    const responseId = randomUUID();
    const aggregates = transaction(db, () => {
      db.prepare(`
        INSERT INTO responses (id, survey_id, postal_code, rating, terms_accepted, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(responseId, survey_id, postal_code, answers[0].rating, terms_accepted ? 1 : 0, now);

      const insertAnswer = db.prepare(`
        INSERT INTO response_answers (submission_id, survey_id, question_id, rating, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      return answers.map((answer) => {
        insertAnswer.run(responseId, survey_id, answer.question_id, answer.rating, now);
        return upsertAggregate(db, survey_id, answer.question_id, postal_code, answer.rating);
      });
    });

    const publicAggregates = aggregates.map((aggregate) => applyThreshold(aggregate, config.minPublicResponsesPerPlz));
    hub.broadcast(survey_id, {
      type: "aggregate-update",
      survey_id,
      aggregates: publicAggregates
    }, "aggregate-update");

    return reply.code(201).send({ id: responseId, aggregates: publicAggregates });
  });

  app.post("/api/newsletter-contacts", async (request, reply) => {
    const parsed = newsletterContactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid newsletter contact", details: parsed.error.flatten() });
    }

    db.prepare(`
      INSERT INTO newsletter_contacts (name, email, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        created_at = excluded.created_at
    `).run(parsed.data.name, parsed.data.email, new Date().toISOString());

    return reply.code(201).send({ saved: true });
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
    if (!isAdminRequest(request, config.adminToken, adminSessions)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const rows = db.prepare(`
      SELECT
        responses.id AS submission_id,
        responses.survey_id,
        responses.postal_code,
        response_answers.question_id,
        response_answers.rating,
        responses.terms_accepted,
        responses.created_at
      FROM responses
      JOIN response_answers ON response_answers.submission_id = responses.id
      ORDER BY responses.created_at, responses.id, response_answers.question_id
    `).all() as Array<Record<string, unknown>>;

    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", "attachment; filename=\"responses.csv\"");
    return toCsv(rows, ["submission_id", "survey_id", "postal_code", "question_id", "rating", "terms_accepted", "created_at"]);
  });

  app.get("/api/admin/newsletter.csv", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken, adminSessions)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const rows = db.prepare(`
      SELECT
        newsletter_contacts.name,
        newsletter_contacts.email,
        newsletter_contacts.created_at
      FROM newsletter_contacts
      ORDER BY newsletter_contacts.created_at, newsletter_contacts.email
    `).all() as Array<Record<string, unknown>>;

    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", "attachment; filename=\"newsletter-contacts.csv\"");
    return toCsv(rows, ["name", "email", "created_at"]);
  });

  app.get("/api/admin/stats", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken, adminSessions)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const survey = getActiveSurvey(db);
    return survey ? getTotals(db, survey.id) : { totalResponses: 0, postalCodeCount: 0 };
  });

  app.post("/api/admin/clear-results", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken, adminSessions)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const survey = getActiveSurvey(db);
    transaction(db, () => {
      deleteFromTableIfExists(db, "response_answers");
      deleteFromTableIfExists(db, "responses");
      deleteFromTableIfExists(db, "postal_code_aggregates");
    });
    if (config.sqlitePath !== ":memory:") {
      db.exec("VACUUM");
    }

    if (survey) {
      broadcastSnapshot(hub, db, survey.id, config.minPublicResponsesPerPlz);
    }

    return { totalResponses: 0, postalCodeCount: 0 };
  });

  app.post("/api/admin/random-responses", async (request, reply) => {
    if (!isAdminRequest(request, config.adminToken, adminSessions)) {
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
        INSERT INTO responses (id, survey_id, postal_code, rating, terms_accepted, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertAnswer = db.prepare(`
        INSERT INTO response_answers (submission_id, survey_id, question_id, rating, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const questions = getQuestions(db, survey);
      for (let index = 0; index < parsed.data.count; index += 1) {
        const postalCode = postalCodeList[randomInt(0, postalCodeList.length - 1)];
        const now = new Date().toISOString();
        const responseId = randomUUID();
        const firstRating = randomInt(questions[0].min_rating, questions[0].max_rating);
        insertResponse.run(responseId, survey.id, postalCode, firstRating, survey.terms_enabled ? 1 : 0, now);
        insertAnswer.run(responseId, survey.id, questions[0].id, firstRating, now);
        upsertAggregate(db, survey.id, questions[0].id, postalCode, firstRating);
        for (const question of questions.slice(1)) {
          const rating = randomInt(question.min_rating, question.max_rating);
          insertAnswer.run(responseId, survey.id, question.id, rating, now);
          upsertAggregate(db, survey.id, question.id, postalCode, rating);
        }
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

function serializeSurvey(db: Db, survey: SurveyRow) {
  const pages = getSurveyPages(db, survey);
  const firstQuestion = pages[0]?.questions[0];
  return {
    id: survey.id,
    title: survey.title,
    pages,
    start_text: survey.start_text ?? "",
    start_logo_data_url: survey.start_logo_data_url ?? "",
    thank_you_text: survey.thank_you_text ?? "Thanks, your response was submitted.",
    terms_enabled: Boolean(survey.terms_enabled),
    terms_text: survey.terms_text,
    use_aggregated_shapes: Boolean(survey.use_aggregated_shapes),
    map_lod_levels: parseMapLodLevels(survey.map_lod_levels, Boolean(survey.use_aggregated_shapes)),
    map_palette: survey.map_palette && isMapPaletteId(survey.map_palette) ? survey.map_palette : DEFAULT_MAP_PALETTE,
    question_text: firstQuestion?.text ?? survey.question_text,
    min_rating: firstQuestion?.min_rating ?? survey.min_rating,
    max_rating: firstQuestion?.max_rating ?? survey.max_rating,
    rating_labels: firstQuestion?.rating_labels ?? parseRatingLabels(survey.rating_labels),
    is_active: Boolean(survey.is_active)
  };
}

function parseMapLodLevels(value: string | null | undefined, useAggregatedShapes: boolean): MapLodLevel[] {
  const fallback: MapLodLevel[] = useAggregatedShapes ? [1, 2, 3, 4, 5] : [5];
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const levels = parsed.filter((level): level is MapLodLevel =>
      level === 1 || level === 2 || level === 3 || level === 4 || level === 5
    );
    const unique = Array.from(new Set(levels));
    return unique.length > 0 ? unique : fallback;
  } catch {
    return fallback;
  }
}

function getQuestions(db: Db, survey: SurveyRow): SurveyQuestion[] {
  return getSurveyPages(db, survey).flatMap((page) => page.questions);
}

function getSurveyPages(db: Db, survey: SurveyRow): SurveyPage[] {
  const normalizedPages = readNormalizedPages(db, survey.id);
  return normalizedPages.length > 0 ? normalizedPages : parsePages(survey);
}

function readNormalizedPages(db: Db, surveyId: string): SurveyPage[] {
  const rows = db.prepare(`
    SELECT
      survey_pages.id AS page_id,
      survey_pages.title AS page_title,
      survey_pages.position AS page_position,
      survey_questions.id AS question_id,
      survey_questions.text AS question_text,
      survey_questions.min_rating,
      survey_questions.max_rating,
      survey_questions.rating_labels,
      survey_questions.position AS question_position
    FROM survey_pages
    JOIN survey_questions
      ON survey_questions.survey_id = survey_pages.survey_id
      AND survey_questions.page_id = survey_pages.id
    WHERE survey_pages.survey_id = ?
    ORDER BY survey_pages.position, survey_questions.position
  `).all(surveyId) as Array<{
    page_id: string;
    page_title: string;
    page_position: number;
    question_id: string;
    question_text: string;
    min_rating: number;
    max_rating: number;
    rating_labels: string;
    question_position: number;
  }>;

  const pages = new Map<string, SurveyPage>();
  for (const row of rows) {
    const page = pages.get(row.page_id) ?? {
      id: row.page_id,
      title: row.page_title,
      questions: []
    };
    page.questions.push({
      id: row.question_id,
      text: row.question_text,
      min_rating: row.min_rating,
      max_rating: row.max_rating,
      rating_labels: parseRatingLabels(row.rating_labels)
    });
    pages.set(row.page_id, page);
  }
  return Array.from(pages.values());
}

function replaceSurveyDefinition(db: Db, surveyId: string, pages: SurveyPage[]): void {
  db.prepare("DELETE FROM survey_questions WHERE survey_id = ?").run(surveyId);
  db.prepare("DELETE FROM survey_pages WHERE survey_id = ?").run(surveyId);

  const insertPage = db.prepare(`
    INSERT INTO survey_pages (survey_id, id, title, position)
    VALUES (?, ?, ?, ?)
  `);
  const insertQuestion = db.prepare(`
    INSERT INTO survey_questions
      (survey_id, page_id, id, text, min_rating, max_rating, rating_labels, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  pages.forEach((page, pageIndex) => {
    insertPage.run(surveyId, page.id, page.title, pageIndex);
    page.questions.forEach((question, questionIndex) => {
      insertQuestion.run(
        surveyId,
        page.id,
        question.id,
        question.text,
        question.min_rating,
        question.max_rating,
        JSON.stringify(question.rating_labels ?? {}),
        questionIndex
      );
    });
  });
}

function parsePages(survey: SurveyRow): SurveyPage[] {
  try {
    const parsed = JSON.parse(survey.pages) as unknown;
    if (!Array.isArray(parsed)) return legacyPages(survey);
    const pages = parsed.flatMap((page): SurveyPage[] => {
      if (!page || typeof page !== "object" || Array.isArray(page)) return [];
      const pageRecord = page as Record<string, unknown>;
      if (typeof pageRecord.id !== "string" || typeof pageRecord.title !== "string" || !Array.isArray(pageRecord.questions)) {
        return [];
      }
      const questions = pageRecord.questions.flatMap((question): SurveyQuestion[] => {
        if (!question || typeof question !== "object" || Array.isArray(question)) return [];
        const questionRecord = question as Record<string, unknown>;
        if (
          typeof questionRecord.id !== "string" ||
          typeof questionRecord.text !== "string" ||
          typeof questionRecord.min_rating !== "number" ||
          typeof questionRecord.max_rating !== "number"
        ) {
          return [];
        }
        return [{
          id: questionRecord.id,
          text: questionRecord.text,
          min_rating: questionRecord.min_rating,
          max_rating: questionRecord.max_rating,
          rating_labels: parseRatingLabels(JSON.stringify(questionRecord.rating_labels ?? {}))
        }];
      });
      return questions.length > 0 ? [{ id: pageRecord.id, title: pageRecord.title, questions }] : [];
    });
    return pages.length > 0 ? pages : legacyPages(survey);
  } catch {
    return legacyPages(survey);
  }
}

function legacyPages(survey: SurveyRow): SurveyPage[] {
  return [{
    id: `${survey.id}-page-1`,
    title: survey.title,
    questions: [{
      id: `${survey.id}-question-1`,
      text: survey.question_text,
      min_rating: survey.min_rating,
      max_rating: survey.max_rating,
      rating_labels: parseRatingLabels(survey.rating_labels)
    }]
  }];
}

function parseRatingLabels(value: string | null | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([rating, label]) => /^-?\d+$/.test(rating) && typeof label === "string")
    );
  } catch {
    return {};
  }
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

function deleteFromTableIfExists(db: Db, tableName: string): void {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  if (row) {
    db.prepare(`DELETE FROM ${tableName}`).run();
  }
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
  if (ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".json" || ext === ".topojson" || ext === ".geojson") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
