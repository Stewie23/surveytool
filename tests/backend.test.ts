import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, type BuiltServer } from "../src/server/app.js";

const adminToken = "test-admin-token";
const postalCodes = new Set(["10115", "20095", "80331"]);

describe("backend API", () => {
  let server: BuiltServer;

  beforeEach(() => {
    server = buildServer({
      config: {
        sqlitePath: ":memory:",
        adminToken,
        minPublicResponsesPerPlz: 3,
        responseRateLimitMax: 100
      },
      postalCodes
    });
  });

  afterEach(async () => {
    await server?.app.close();
  });

  it("seeds and fetches the active survey", async () => {
    const response = await server.app.inject({ method: "GET", url: "/api/survey/active" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "default",
      min_rating: -3,
      max_rating: 3
    });
  });

  it("requires admin auth and validates survey ranges", async () => {
    const rejected = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      payload: { title: "A", question_text: "Q", min_rating: -3, max_rating: 3, is_active: true }
    });
    expect(rejected.statusCode).toBe(401);

    const invalid = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      headers: { "x-admin-token": adminToken },
      payload: { title: "A", question_text: "Q", min_rating: 3, max_rating: 3, is_active: true }
    });
    expect(invalid.statusCode).toBe(400);

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/survey",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { title: "New", question_text: "Rate this", min_rating: -5, max_rating: 5, is_active: true }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ title: "New", min_rating: -5, max_rating: 5 });
  });

  it("rejects invalid response payloads", async () => {
    const survey = await activeSurveyId();
    const badFormat = await submit({ survey_id: survey, postal_code: "1011", rating: 1 });
    expect(badFormat.statusCode).toBe(400);

    const unknownPlz = await submit({ survey_id: survey, postal_code: "99999", rating: 1 });
    expect(unknownPlz.statusCode).toBe(400);

    const badRating = await submit({ survey_id: survey, postal_code: "10115", rating: 99 });
    expect(badRating.statusCode).toBe(400);
  });

  it("stores responses and updates aggregate values", async () => {
    const survey = await activeSurveyId();
    await submit({ survey_id: survey, postal_code: "10115", rating: 1 });
    await submit({ survey_id: survey, postal_code: "10115", rating: 3 });
    await submit({ survey_id: survey, postal_code: "10115", rating: -1 });

    const response = await server.app.inject({ method: "GET", url: `/api/results/${survey}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        postal_code: "10115",
        count: 3,
        average: 1,
        sum: 3,
        hidden: false
      }
    ]);
  });

  it("suppresses low-sample averages using the privacy threshold", async () => {
    const survey = await activeSurveyId();
    await submit({ survey_id: survey, postal_code: "20095", rating: 3 });

    const response = await server.app.inject({ method: "GET", url: `/api/results/${survey}` });
    expect(response.json()[0]).toMatchObject({
      postal_code: "20095",
      count: 1,
      average: null,
      sum: 3,
      hidden: true
    });
  });

  it("requires auth for CSV export and returns raw response rows", async () => {
    const survey = await activeSurveyId();
    await submit({ survey_id: survey, postal_code: "80331", rating: 2 });

    const rejected = await server.app.inject({ method: "GET", url: "/api/admin/export.csv" });
    expect(rejected.statusCode).toBe(401);

    const accepted = await server.app.inject({
      method: "GET",
      url: "/api/admin/export.csv",
      headers: { "x-admin-token": adminToken }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["content-type"]).toContain("text/csv");
    expect(accepted.payload).toContain("id,survey_id,postal_code,rating,created_at");
    expect(accepted.payload).toContain(",default,80331,2,");
  });

  it("clears stored responses and aggregates through the admin endpoint", async () => {
    const survey = await activeSurveyId();
    await submit({ survey_id: survey, postal_code: "80331", rating: 2 });

    const rejected = await server.app.inject({ method: "POST", url: "/api/admin/clear-results" });
    expect(rejected.statusCode).toBe(401);

    const accepted = await server.app.inject({
      method: "POST",
      url: "/api/admin/clear-results",
      headers: { "x-admin-token": adminToken }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ totalResponses: 0, postalCodeCount: 0 });

    const results = await server.app.inject({ method: "GET", url: `/api/results/${survey}` });
    expect(results.json()).toEqual([]);
  });

  it("fills the active survey with random response data through the admin endpoint", async () => {
    const survey = await activeSurveyId();

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

    const results = await server.app.inject({ method: "GET", url: `/api/results/${survey}` });
    const aggregates = results.json() as Array<{ count: number; postal_code: string }>;
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

  it("sends an initial SSE aggregate snapshot", async () => {
    const survey = await activeSurveyId();
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected test HTTP address");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/results/${survey}/stream`);
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

  async function activeSurveyId() {
    const response = await server.app.inject({ method: "GET", url: "/api/survey/active" });
    return response.json().id as string;
  }

  function submit(payload: { survey_id: string; postal_code: string; rating: number }) {
    return server.app.inject({
      method: "POST",
      url: "/api/responses",
      payload
    });
  }
});
