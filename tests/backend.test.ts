import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, type BuiltServer } from "../src/server/app.js";

const adminToken = "test-admin-token";
const adminPassword = "test-admin-password";
const postalCodes = new Set(["10115", "20095", "80331"]);

describe("backend API", () => {
  let server: BuiltServer;
  const tempDirs: string[] = [];

  beforeEach(() => {
    server = buildServer({
      config: {
        sqlitePath: ":memory:",
        adminToken,
        adminPassword,
        minPublicResponsesPerPlz: 3,
        responseRateLimitMax: 100
      },
      postalCodes
    });
  });

  afterEach(async () => {
    await server?.app.close();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeds and fetches the active survey", async () => {
    const response = await server.app.inject({ method: "GET", url: "/api/survey/active" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "default",
      title: "Stimmungsbild",
      terms_enabled: false,
      use_aggregated_shapes: false,
      map_palette: "batlow",
      pages: [{
        id: "default-page",
        questions: [{
          id: "default-question",
          min_rating: -3,
          max_rating: 3
        }]
      }]
    });
  });

  it("migrates old-style survey definitions into normalized page and question tables", async () => {
    const sqlitePath = tempSqlitePath();
    await server.app.close();
    createOldStyleSurveyDb(sqlitePath);
    server = buildServer({
      config: {
        sqlitePath,
        adminToken,
        adminPassword,
        minPublicResponsesPerPlz: 1,
        responseRateLimitMax: 100
      },
      postalCodes
    });

    const response = await server.app.inject({ method: "GET", url: "/api/survey/active" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "legacy",
      title: "Legacy survey",
      use_aggregated_shapes: false,
      map_palette: "batlow",
      pages: [{
        title: "Legacy survey",
        questions: [{
          text: "Legacy question?",
          min_rating: -2,
          max_rating: 2,
          rating_labels: { "-2": "No", "2": "Yes" }
        }]
      }]
    });

    expect(tableExists("survey_pages")).toBe(true);
    expect(tableExists("survey_questions")).toBe(true);
    expect(tableCount("survey_pages")).toBe(1);
    expect(tableCount("survey_questions")).toBe(1);
  });

  it("requires admin auth and validates survey ranges", async () => {
    const rejected = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      payload: {
        title: "A",
        pages: [{ id: "page-1", title: "Page", questions: [{ id: "q1", text: "Q", min_rating: -3, max_rating: 3 }] }],
        is_active: true
      }
    });
    expect(rejected.statusCode).toBe(401);

    const invalid = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      headers: { "x-admin-token": adminToken },
      payload: {
        title: "A",
        pages: [{ id: "page-1", title: "Page", questions: [{ id: "q1", text: "Q", min_rating: 3, max_rating: 3 }] }],
        is_active: true
      }
    });
    expect(invalid.statusCode).toBe(400);

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        title: "New",
        pages: [{
          id: "page-1",
          title: "Page 1",
          questions: [{
            id: "q1",
            text: "Rate this",
            min_rating: -5,
            max_rating: 5,
            rating_labels: { "-5": "Strongly disagree", "5": "Strongly agree", "99": "Outside" }
          }]
        }],
        terms_enabled: true,
        terms_text: "Please accept",
        use_aggregated_shapes: true,
        map_palette: "tokyo",
        is_active: true
      }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      title: "New",
      terms_enabled: true,
      terms_text: "Please accept",
      use_aggregated_shapes: true,
      map_palette: "tokyo",
      pages: [{
        id: "page-1",
        questions: [{
          id: "q1",
          min_rating: -5,
          max_rating: 5,
          rating_labels: { "-5": "Strongly disagree", "5": "Strongly agree" }
        }]
      }]
    });
  });

  it("creates and clears browser-session admin auth cookies", async () => {
    const missing = await server.app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: {}
    });
    expect(missing.statusCode).toBe(401);

    const rejected = await server.app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { password: "wrong" }
    });
    expect(rejected.statusCode).toBe(401);

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { password: adminPassword }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ authenticated: true });
    const cookie = getSetCookie(accepted);
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const session = await server.app.inject({
      method: "GET",
      url: "/api/admin/session",
      headers: { cookie }
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: true });

    const stats = await server.app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { cookie }
    });
    expect(stats.statusCode).toBe(200);

    const exportResponse = await server.app.inject({
      method: "GET",
      url: "/api/admin/export.csv",
      headers: { cookie }
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers["content-type"]).toContain("text/csv");

    const logout = await server.app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: { cookie }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ authenticated: false });
    expect(getSetCookie(logout)).toContain("Max-Age=0");

    const afterLogout = await server.app.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { cookie }
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("saves one page with two questions and fetches both from the active survey", async () => {
    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      headers: { "x-admin-token": adminToken },
      payload: {
        title: "Two question page",
        pages: [{
          id: "page-1",
          title: "Page 1",
          questions: [
            { id: "q1", text: "First?", min_rating: 0, max_rating: 5 },
            { id: "q2", text: "Second?", min_rating: -2, max_rating: 2 }
          ]
        }],
        is_active: true
      }
    });
    expect(accepted.statusCode).toBe(200);

    const response = await server.app.inject({ method: "GET", url: "/api/survey/active" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "active",
      title: "Two question page",
      pages: [{
        id: "page-1",
        title: "Page 1",
        questions: [
          { id: "q1", text: "First?", min_rating: 0, max_rating: 5 },
          { id: "q2", text: "Second?", min_rating: -2, max_rating: 2 }
        ]
      }]
    });
    expect(tableExists("survey_pages")).toBe(true);
    expect(tableExists("survey_questions")).toBe(true);
    expect(tableCount("survey_questions")).toBeGreaterThanOrEqual(2);
  });

  it("persists multi-question surveys across restart and stores answers with aggregates", async () => {
    const sqlitePath = tempSqlitePath();
    await server.app.close();
    server = buildServer({
      config: {
        sqlitePath,
        adminToken,
        adminPassword,
        minPublicResponsesPerPlz: 1,
        responseRateLimitMax: 100
      },
      postalCodes
    });

    const configured = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      headers: { "x-admin-token": adminToken },
      payload: {
        title: "Restart survey",
        pages: [{
          id: "restart-page",
          title: "Restart page",
          questions: [
            { id: "quality", text: "Quality?", min_rating: 0, max_rating: 10 },
            { id: "speed", text: "Speed?", min_rating: 0, max_rating: 10 }
          ]
        }],
        is_active: true
      }
    });
    expect(configured.statusCode).toBe(200);
    await server.app.close();

    server = buildServer({
      config: {
        sqlitePath,
        adminToken,
        adminPassword,
        minPublicResponsesPerPlz: 1,
        responseRateLimitMax: 100
      },
      postalCodes
    });

    const survey = await activeSurvey();
    expect(survey.pages.flatMap((page) => page.questions.map((question) => question.id))).toEqual(["quality", "speed"]);

    const accepted = await submit({
      survey_id: survey.id,
      postal_code: "10115",
      answers: [
        { question_id: "quality", rating: 8 },
        { question_id: "speed", rating: 6 }
      ]
    });
    expect(accepted.statusCode).toBe(201);

    expect(tableCount("response_answers")).toBe(2);
    expect(
      server.db.prepare(`
        SELECT question_id, rating
        FROM response_answers
        ORDER BY question_id
      `).all()
    ).toEqual([
      { question_id: "quality", rating: 8 },
      { question_id: "speed", rating: 6 }
    ]);

    const results = await server.app.inject({ method: "GET", url: `/api/results/${survey.id}` });
    expect(results.statusCode).toBe(200);
    expect(results.json()).toEqual([
      {
        question_id: "quality",
        aggregates: [{ question_id: "quality", postal_code: "10115", count: 1, average: 8, sum: 8, hidden: false }]
      },
      {
        question_id: "speed",
        aggregates: [{ question_id: "speed", postal_code: "10115", count: 1, average: 6, sum: 6, hidden: false }]
      }
    ]);
  });

  it("rejects invalid response payloads", async () => {
    const survey = await activeSurvey();
    const badFormat = await submit({ survey_id: survey.id, postal_code: "1011", answers: [{ question_id: "default-question", rating: 1 }] });
    expect(badFormat.statusCode).toBe(400);

    const unknownPlz = await submit({ survey_id: survey.id, postal_code: "99999", answers: [{ question_id: "default-question", rating: 1 }] });
    expect(unknownPlz.statusCode).toBe(400);

    const badRating = await submit({ survey_id: survey.id, postal_code: "10115", answers: [{ question_id: "default-question", rating: 99 }] });
    expect(badRating.statusCode).toBe(400);

    const duplicate = await submit({
      survey_id: survey.id,
      postal_code: "10115",
      answers: [{ question_id: "default-question", rating: 1 }, { question_id: "default-question", rating: 2 }]
    });
    expect(duplicate.statusCode).toBe(400);
  });

  it("requires exact multi-question answers and terms when configured", async () => {
    const configured = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      headers: { "x-admin-token": adminToken },
      payload: {
        title: "Paged",
        pages: [
          { id: "intro", title: "Intro", questions: [{ id: "mood", text: "Mood?", min_rating: 0, max_rating: 10 }] },
          { id: "details", title: "Details", questions: [{ id: "trust", text: "Trust?", min_rating: 1, max_rating: 5 }] }
        ],
        terms_enabled: true,
        terms_text: "Terms"
      }
    });
    expect(configured.statusCode).toBe(200);

    const missingTerms = await submit({
      survey_id: "active",
      postal_code: "10115",
      answers: [{ question_id: "mood", rating: 7 }, { question_id: "trust", rating: 4 }]
    });
    expect(missingTerms.statusCode).toBe(400);

    const missingAnswer = await submit({
      survey_id: "active",
      postal_code: "10115",
      answers: [{ question_id: "mood", rating: 7 }],
      terms_accepted: true
    });
    expect(missingAnswer.statusCode).toBe(400);

    const accepted = await submit({
      survey_id: "active",
      postal_code: "10115",
      answers: [{ question_id: "mood", rating: 7 }, { question_id: "trust", rating: 4 }],
      terms_accepted: true
    });
    expect(accepted.statusCode).toBe(201);

    const results = await server.app.inject({ method: "GET", url: "/api/results/active" });
    expect(results.json()).toEqual([
      {
        question_id: "mood",
        aggregates: [{ question_id: "mood", postal_code: "10115", count: 1, average: null, sum: 7, hidden: true }]
      },
      {
        question_id: "trust",
        aggregates: [{ question_id: "trust", postal_code: "10115", count: 1, average: null, sum: 4, hidden: true }]
      }
    ]);
  });

  it("stores responses and updates aggregate values", async () => {
    const survey = await activeSurvey();
    await submit({ survey_id: survey.id, postal_code: "10115", answers: [{ question_id: "default-question", rating: 1 }] });
    await submit({ survey_id: survey.id, postal_code: "10115", answers: [{ question_id: "default-question", rating: 3 }] });
    await submit({ survey_id: survey.id, postal_code: "10115", answers: [{ question_id: "default-question", rating: -1 }] });

    const response = await server.app.inject({ method: "GET", url: `/api/results/${survey.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        question_id: "default-question",
        aggregates: [{
          question_id: "default-question",
          postal_code: "10115",
          count: 3,
          average: 1,
          sum: 3,
          hidden: false
        }]
      }
    ]);
  });

  it("suppresses low-sample averages using the privacy threshold", async () => {
    const survey = await activeSurvey();
    await submit({ survey_id: survey.id, postal_code: "20095", answers: [{ question_id: "default-question", rating: 3 }] });

    const response = await server.app.inject({ method: "GET", url: `/api/results/${survey.id}` });
    expect(response.json()[0].aggregates[0]).toMatchObject({
      question_id: "default-question",
      postal_code: "20095",
      count: 1,
      average: null,
      sum: 3,
      hidden: true
    });
  });

  it("requires auth for CSV export and returns raw response rows", async () => {
    const survey = await activeSurvey();
    await submit({ survey_id: survey.id, postal_code: "80331", answers: [{ question_id: "default-question", rating: 2 }] });

    const rejected = await server.app.inject({ method: "GET", url: "/api/admin/export.csv" });
    expect(rejected.statusCode).toBe(401);

    const accepted = await server.app.inject({
      method: "GET",
      url: "/api/admin/export.csv",
      headers: { "x-admin-token": adminToken }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["content-type"]).toContain("text/csv");
    expect(accepted.payload).toContain("submission_id,survey_id,postal_code,question_id,rating,terms_accepted,created_at");
    expect(accepted.payload).toContain(",default-question,2,0,");
  });

  it("clears stored responses and aggregates through the admin endpoint", async () => {
    const survey = await activeSurvey();
    await submit({ survey_id: survey.id, postal_code: "80331", answers: [{ question_id: "default-question", rating: 2 }] });

    const rejected = await server.app.inject({ method: "POST", url: "/api/admin/clear-results" });
    expect(rejected.statusCode).toBe(401);

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/clear-results",
      headers: { "x-admin-token": adminToken }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ totalResponses: 0, postalCodeCount: 0 });
    expect(tableCount("responses")).toBe(0);
    expect(tableCount("response_answers")).toBe(0);
    expect(tableCount("postal_code_aggregates")).toBe(0);

    const results = await server.app.inject({ method: "GET", url: `/api/results/${survey.id}` });
    expect(results.json()).toEqual([]);
  });

  it("clears legacy databases that do not have response_answers", async () => {
    const survey = await activeSurvey();
    await submit({ survey_id: survey.id, postal_code: "80331", answers: [{ question_id: "default-question", rating: 2 }] });
    server.db.exec("DROP TABLE response_answers");

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/clear-results",
      headers: { "x-admin-token": adminToken }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ totalResponses: 0, postalCodeCount: 0 });
    expect(tableCount("responses")).toBe(0);
    expect(tableCount("postal_code_aggregates")).toBe(0);
  });

  it("fills the active survey with random response data through the admin endpoint", async () => {
    const survey = await activeSurvey();

    const rejected = await server.app.inject({
      method: "POST",
      url: "/api/admin/random-responses",
      headers: { "x-admin-token": adminToken },
      payload: { count: 0 }
    });
    expect(rejected.statusCode).toBe(400);

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/random-responses",
      headers: { "x-admin-token": adminToken },
      payload: { count: 25 }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().totalResponses).toBe(25);

    const results = await server.app.inject({ method: "GET", url: `/api/results/${survey.id}` });
    const aggregates = results.json()[0].aggregates as Array<{ count: number; postal_code: string }>;
    expect(aggregates.reduce((sum, item) => sum + item.count, 0)).toBe(25);
    expect(aggregates.every((item) => postalCodes.has(item.postal_code))).toBe(true);
  });

  it("serves a precompressed PLZ TopoJSON file behind the plain TopoJSON URL", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "survey-static-"));
    fs.mkdirSync(path.join(staticDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html>");
    fs.writeFileSync(path.join(staticDir, "data", "germany-plz.topojson.br"), "compressed topojson");

    const staticServer = buildServer({
      config: {
        sqlitePath: ":memory:",
        staticDir
      },
      postalCodes
    });

    try {
      const response = await staticServer.app.inject({ method: "GET", url: "/data/germany-plz.topojson" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["content-encoding"]).toBe("br");
      expect(response.payload).toBe("compressed topojson");
    } finally {
      await staticServer.app.close();
      fs.rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it("serves GeoJSON files with a JSON content type", async () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "survey-static-"));
    fs.mkdirSync(path.join(staticDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html>");
    fs.writeFileSync(path.join(staticDir, "data", "germany-plz-1.topojson.geojson"), "{\"type\":\"FeatureCollection\",\"features\":[]}");

    const staticServer = buildServer({
      config: {
        sqlitePath: ":memory:",
        staticDir
      },
      postalCodes
    });

    try {
      const response = await staticServer.app.inject({ method: "GET", url: "/data/germany-plz-1.topojson.geojson" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
    } finally {
      await staticServer.app.close();
      fs.rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it("sends an initial SSE aggregate snapshot", async () => {
    const survey = await activeSurvey();
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test HTTP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/results/${survey.id}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected SSE body");
    const { value } = await reader.read();
    await reader.cancel();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: aggregate-snapshot");
    expect(chunk).toContain("\"type\":\"aggregate-snapshot\"");
  });

  async function activeSurvey() {
    const response = await server.app.inject({ method: "GET", url: "/api/survey/active" });
    return response.json() as {
      id: string;
      pages: Array<{ questions: Array<{ id: string }> }>;
    };
  }

  function submit(payload: {
    survey_id: string;
    postal_code: string;
    answers: Array<{ question_id: string; rating: number }>;
    terms_accepted?: boolean;
  }) {
    return server.app.inject({
      method: "POST",
      url: "/api/responses",
      payload
    });
  }

  function tableCount(tableName: string): number {
    return (server.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count;
  }

  function tableExists(tableName: string): boolean {
    return Boolean(server.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
  }

  function tempSqlitePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "survey-db-"));
    tempDirs.push(dir);
    return path.join(dir, "survey.sqlite");
  }

  function createOldStyleSurveyDb(sqlitePath: string): void {
    const db = new DatabaseSync(sqlitePath);
    try {
      db.exec(`
        CREATE TABLE surveys (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          question_text TEXT NOT NULL,
          min_rating INTEGER NOT NULL DEFAULT -3,
          max_rating INTEGER NOT NULL DEFAULT 3,
          rating_labels TEXT NOT NULL DEFAULT '{}',
          terms_enabled INTEGER NOT NULL DEFAULT 0,
          terms_text TEXT NOT NULL DEFAULT '',
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE postal_codes (
          postal_code TEXT PRIMARY KEY,
          source_name TEXT,
          geometry_available INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE responses (
          id TEXT PRIMARY KEY,
          survey_id TEXT NOT NULL,
          postal_code TEXT NOT NULL,
          rating INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES surveys(id)
        );

        CREATE TABLE postal_code_aggregates (
          survey_id TEXT NOT NULL,
          postal_code TEXT NOT NULL,
          response_count INTEGER NOT NULL,
          rating_sum INTEGER NOT NULL,
          rating_avg REAL NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (survey_id, postal_code)
        );
      `);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO surveys
          (id, title, question_text, min_rating, max_rating, rating_labels, terms_enabled, terms_text, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, '', 1, ?, ?)
      `).run("legacy", "Legacy survey", "Legacy question?", -2, 2, JSON.stringify({ "-2": "No", "2": "Yes" }), now, now);
    } finally {
      db.close();
    }
  }

  function getSetCookie(response: { headers: Record<string, unknown> }): string {
    const setCookie = response.headers["set-cookie"];
    return Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  }
});
