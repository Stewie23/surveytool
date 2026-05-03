import type { Db } from "./db.js";

export type AggregateRow = {
  question_id: string;
  postal_code: string;
  count: number;
  average: number | null;
  sum: number;
  hidden: boolean;
};

export type QuestionAggregateGroup = {
  question_id: string;
  aggregates: AggregateRow[];
};

type RawAggregate = {
  question_id: string;
  postal_code: string;
  response_count: number;
  rating_sum: number;
  rating_avg: number;
};

export function upsertAggregate(db: Db, surveyId: string, questionId: string, postalCode: string, rating: number): AggregateRow {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO postal_code_aggregates
      (survey_id, question_id, postal_code, response_count, rating_sum, rating_avg, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(survey_id, question_id, postal_code) DO UPDATE SET
      response_count = response_count + 1,
      rating_sum = rating_sum + excluded.rating_sum,
      rating_avg = CAST(rating_sum + excluded.rating_sum AS REAL) / (response_count + 1),
      updated_at = excluded.updated_at
  `).run(surveyId, questionId, postalCode, rating, rating, now);

  const row = db.prepare(`
    SELECT question_id, postal_code, response_count, rating_sum, rating_avg
    FROM postal_code_aggregates
    WHERE survey_id = ? AND question_id = ? AND postal_code = ?
  `).get(surveyId, questionId, postalCode) as RawAggregate;

  return serializeAggregate(row, 1);
}

export function getAggregates(db: Db, surveyId: string, minPublicResponses: number): QuestionAggregateGroup[] {
  const rows = db.prepare(`
    SELECT question_id, postal_code, response_count, rating_sum, rating_avg
    FROM postal_code_aggregates
    WHERE survey_id = ?
    ORDER BY question_id, postal_code
  `).all(surveyId) as RawAggregate[];

  return groupAggregates(rows.map((row) => serializeAggregate(row, minPublicResponses)));
}

export function getTotals(db: Db, surveyId: string): { totalResponses: number; postalCodeCount: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS totalResponses,
      COUNT(DISTINCT postal_code) AS postalCodeCount
    FROM responses
    WHERE survey_id = ?
  `).get(surveyId) as { totalResponses: number; postalCodeCount: number };

  return row;
}

function serializeAggregate(row: RawAggregate, minPublicResponses: number): AggregateRow {
  const hidden = row.response_count < minPublicResponses;
  return {
    question_id: row.question_id,
    postal_code: row.postal_code,
    count: row.response_count,
    average: hidden ? null : row.rating_avg,
    sum: row.rating_sum,
    hidden
  };
}

function groupAggregates(rows: AggregateRow[]): QuestionAggregateGroup[] {
  const groups = new Map<string, AggregateRow[]>();
  for (const row of rows) {
    groups.set(row.question_id, [...(groups.get(row.question_id) ?? []), row]);
  }
  return Array.from(groups, ([question_id, aggregates]) => ({ question_id, aggregates }));
}
