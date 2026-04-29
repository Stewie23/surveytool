import type { Db } from "./db.js";

export type AggregateRow = {
  postal_code: string;
  count: number;
  average: number | null;
  sum: number;
  hidden: boolean;
};

type RawAggregate = {
  postal_code: string;
  response_count: number;
  rating_sum: number;
  rating_avg: number;
};

export function upsertAggregate(db: Db, surveyId: string, postalCode: string, rating: number): AggregateRow {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO postal_code_aggregates
      (survey_id, postal_code, response_count, rating_sum, rating_avg, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(survey_id, postal_code) DO UPDATE SET
      response_count = response_count + 1,
      rating_sum = rating_sum + excluded.rating_sum,
      rating_avg = CAST(rating_sum + excluded.rating_sum AS REAL) / (response_count + 1),
      updated_at = excluded.updated_at
  `).run(surveyId, postalCode, rating, rating, now);

  const row = db.prepare(`
    SELECT postal_code, response_count, rating_sum, rating_avg
    FROM postal_code_aggregates
    WHERE survey_id = ? AND postal_code = ?
  `).get(surveyId, postalCode) as RawAggregate;

  return serializeAggregate(row, 1);
}

export function getAggregates(db: Db, surveyId: string, minPublicResponses: number): AggregateRow[] {
  const rows = db.prepare(`
    SELECT postal_code, response_count, rating_sum, rating_avg
    FROM postal_code_aggregates
    WHERE survey_id = ?
    ORDER BY postal_code
  `).all(surveyId) as RawAggregate[];

  return rows.map((row) => serializeAggregate(row, minPublicResponses));
}

export function getTotals(db: Db, surveyId: string): { totalResponses: number; postalCodeCount: number } {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(response_count), 0) AS totalResponses,
      COUNT(*) AS postalCodeCount
    FROM postal_code_aggregates
    WHERE survey_id = ?
  `).get(surveyId) as { totalResponses: number; postalCodeCount: number };

  return row;
}

function serializeAggregate(row: RawAggregate, minPublicResponses: number): AggregateRow {
  const hidden = row.response_count < minPublicResponses;
  return {
    postal_code: row.postal_code,
    count: row.response_count,
    average: hidden ? null : row.rating_avg,
    sum: row.rating_sum,
    hidden
  };
}
