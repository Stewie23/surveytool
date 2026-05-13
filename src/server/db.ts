import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

export function openDb(sqlitePath: string): Db {
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate(db: Db): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS surveys (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question_text TEXT NOT NULL,
      min_rating INTEGER NOT NULL DEFAULT -3,
      max_rating INTEGER NOT NULL DEFAULT 3,
      rating_labels TEXT NOT NULL DEFAULT '{}',
      pages TEXT NOT NULL DEFAULT '[]',
      terms_enabled INTEGER NOT NULL DEFAULT 0,
      terms_text TEXT NOT NULL DEFAULT '',
      use_aggregated_shapes INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS postal_codes (
      postal_code TEXT PRIMARY KEY,
      source_name TEXT,
      geometry_available INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS survey_pages (
      survey_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (survey_id, id),
      FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS survey_questions (
      survey_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      id TEXT NOT NULL,
      text TEXT NOT NULL,
      min_rating INTEGER NOT NULL,
      max_rating INTEGER NOT NULL,
      rating_labels TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      PRIMARY KEY (survey_id, id),
      FOREIGN KEY (survey_id, page_id) REFERENCES survey_pages(survey_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      survey_id TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      rating INTEGER,
      terms_accepted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (survey_id) REFERENCES surveys(id)
    );

    CREATE TABLE IF NOT EXISTS postal_code_aggregates (
      survey_id TEXT NOT NULL,
      question_id TEXT NOT NULL DEFAULT 'default-question',
      postal_code TEXT NOT NULL,
      response_count INTEGER NOT NULL,
      rating_sum INTEGER NOT NULL,
      rating_avg REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (survey_id, question_id, postal_code)
    );
  `);

  const surveyColumns = tableColumns(db, "surveys");
  if (!surveyColumns.some((column) => column.name === "rating_labels")) {
    db.exec("ALTER TABLE surveys ADD COLUMN rating_labels TEXT NOT NULL DEFAULT '{}'");
  }
  if (!surveyColumns.some((column) => column.name === "pages")) {
    db.exec("ALTER TABLE surveys ADD COLUMN pages TEXT NOT NULL DEFAULT '[]'");
  }
  if (!surveyColumns.some((column) => column.name === "terms_enabled")) {
    db.exec("ALTER TABLE surveys ADD COLUMN terms_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!surveyColumns.some((column) => column.name === "terms_text")) {
    db.exec("ALTER TABLE surveys ADD COLUMN terms_text TEXT NOT NULL DEFAULT ''");
  }
  if (!surveyColumns.some((column) => column.name === "use_aggregated_shapes")) {
    db.exec("ALTER TABLE surveys ADD COLUMN use_aggregated_shapes INTEGER NOT NULL DEFAULT 0");
  }

  backfillSurveyPages(db);
  backfillNormalizedSurveyDefinitions(db);
  migrateResponsesTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS response_answers (
      submission_id TEXT NOT NULL,
      survey_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (submission_id, question_id),
      FOREIGN KEY (submission_id) REFERENCES responses(id) ON DELETE CASCADE,
      FOREIGN KEY (survey_id) REFERENCES surveys(id)
    );
  `);
  migrateAggregateTable(db);
  backfillResponseAnswers(db);
}

export function seedDefaultSurvey(db: Db): void {
  const existing = db.prepare("SELECT id FROM surveys WHERE is_active = 1 LIMIT 1").get();
  if (existing) {
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO surveys
      (id, title, question_text, min_rating, max_rating, rating_labels, pages, terms_enabled, terms_text, use_aggregated_shapes, is_active, created_at, updated_at)
    VALUES (?, ?, ?, -3, 3, '{}', ?, 0, '', 0, 1, ?, ?)
  `).run(
    "default",
    "Stimmungsbild",
    "Wie bewerten Sie die aktuelle Situation?",
    JSON.stringify([{
      id: "default-page",
      title: "Stimmungsbild",
      questions: [{
        id: "default-question",
        text: "Wie bewerten Sie die aktuelle Situation?",
        min_rating: -3,
        max_rating: 3,
        rating_labels: {}
      }]
    }]),
    now,
    now
  );
  backfillNormalizedSurveyDefinitions(db);
}

export function syncPostalCodes(db: Db, postalCodes: Set<string>, sourceName = "local"): void {
  const insert = db.prepare(`
    INSERT INTO postal_codes (postal_code, source_name, geometry_available)
    VALUES (?, ?, 1)
    ON CONFLICT(postal_code) DO UPDATE SET
      source_name = excluded.source_name,
      geometry_available = excluded.geometry_available
  `);
  transaction(db, () => {
    for (const postalCode of postalCodes) {
      insert.run(postalCode, sourceName);
    }
  });
}

function tableColumns(db: Db, tableName: string): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; notnull: number }>;
}

function backfillSurveyPages(db: Db): void {
  const rows = db.prepare(`
    SELECT id, title, question_text, min_rating, max_rating, rating_labels, pages
    FROM surveys
  `).all() as Array<{
    id: string;
    title: string;
    question_text: string;
    min_rating: number;
    max_rating: number;
    rating_labels: string;
    pages: string;
  }>;
  const update = db.prepare("UPDATE surveys SET pages = ? WHERE id = ?");
  for (const row of rows) {
    if (hasUsablePages(row.pages)) continue;
    update.run(JSON.stringify([{
      id: `${row.id}-page-1`,
      title: row.title,
      questions: [{
        id: `${row.id}-question-1`,
        text: row.question_text,
        min_rating: row.min_rating,
        max_rating: row.max_rating,
        rating_labels: parseJsonObject(row.rating_labels)
      }]
    }]), row.id);
  }
}

function backfillNormalizedSurveyDefinitions(db: Db): void {
  const rows = db.prepare(`
    SELECT id, title, question_text, min_rating, max_rating, rating_labels, pages
    FROM surveys
    WHERE NOT EXISTS (
      SELECT 1
      FROM survey_pages
      WHERE survey_pages.survey_id = surveys.id
    )
  `).all() as Array<{
    id: string;
    title: string;
    question_text: string;
    min_rating: number;
    max_rating: number;
    rating_labels: string;
    pages: string;
  }>;
  const insertPage = db.prepare(`
    INSERT INTO survey_pages (survey_id, id, title, position)
    VALUES (?, ?, ?, ?)
  `);
  const insertQuestion = db.prepare(`
    INSERT INTO survey_questions
      (survey_id, page_id, id, text, min_rating, max_rating, rating_labels, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    const pages = normalizedPagesForBackfill(row);
    for (const [pageIndex, page] of pages.entries()) {
      insertPage.run(row.id, page.id, page.title, pageIndex);
      for (const [questionIndex, question] of page.questions.entries()) {
        insertQuestion.run(
          row.id,
          page.id,
          question.id,
          question.text,
          question.min_rating,
          question.max_rating,
          JSON.stringify(question.rating_labels),
          questionIndex
        );
      }
    }
  }
}

function migrateResponsesTable(db: Db): void {
  const columns = tableColumns(db, "responses");
  const ratingColumn = columns.find((column) => column.name === "rating");
  const needsRebuild = ratingColumn?.notnull === 1 || !columns.some((column) => column.name === "terms_accepted");
  if (!needsRebuild) return;

  db.exec(`
    ALTER TABLE responses RENAME TO responses_old;
    CREATE TABLE responses (
      id TEXT PRIMARY KEY,
      survey_id TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      rating INTEGER,
      terms_accepted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (survey_id) REFERENCES surveys(id)
    );
    INSERT INTO responses (id, survey_id, postal_code, rating, terms_accepted, created_at)
    SELECT id, survey_id, postal_code, rating, 0, created_at
    FROM responses_old;
    DROP TABLE responses_old;
  `);
}

function migrateAggregateTable(db: Db): void {
  const columns = tableColumns(db, "postal_code_aggregates");
  if (columns.some((column) => column.name === "question_id")) return;

  db.exec(`
    ALTER TABLE postal_code_aggregates RENAME TO postal_code_aggregates_old;
    CREATE TABLE postal_code_aggregates (
      survey_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      response_count INTEGER NOT NULL,
      rating_sum INTEGER NOT NULL,
      rating_avg REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (survey_id, question_id, postal_code)
    );
  `);

  const rows = db.prepare(`
    SELECT survey_id, postal_code, response_count, rating_sum, rating_avg, updated_at
    FROM postal_code_aggregates_old
  `).all() as Array<{
    survey_id: string;
    postal_code: string;
    response_count: number;
    rating_sum: number;
    rating_avg: number;
    updated_at: string;
  }>;
  const insert = db.prepare(`
    INSERT INTO postal_code_aggregates
      (survey_id, question_id, postal_code, response_count, rating_sum, rating_avg, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.survey_id,
      firstQuestionIdForSurvey(db, row.survey_id),
      row.postal_code,
      row.response_count,
      row.rating_sum,
      row.rating_avg,
      row.updated_at
    );
  }
  db.exec("DROP TABLE postal_code_aggregates_old");
}

function backfillResponseAnswers(db: Db): void {
  const rows = db.prepare(`
    SELECT id, survey_id, rating, created_at
    FROM responses
    WHERE rating IS NOT NULL
  `).all() as Array<{ id: string; survey_id: string; rating: number; created_at: string }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO response_answers (submission_id, survey_id, question_id, rating, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(row.id, row.survey_id, firstQuestionIdForSurvey(db, row.survey_id), row.rating, row.created_at);
  }
}

function firstQuestionIdForSurvey(db: Db, surveyId: string): string {
  const normalizedQuestion = db.prepare(`
    SELECT survey_questions.id
    FROM survey_questions
    JOIN survey_pages
      ON survey_pages.survey_id = survey_questions.survey_id
      AND survey_pages.id = survey_questions.page_id
    WHERE survey_questions.survey_id = ?
    ORDER BY survey_pages.position, survey_questions.position
    LIMIT 1
  `).get(surveyId) as { id: string } | undefined;
  if (normalizedQuestion) return normalizedQuestion.id;

  const row = db.prepare("SELECT pages FROM surveys WHERE id = ?").get(surveyId) as { pages: string } | undefined;
  if (!row) return "default-question";
  const pages = parseJsonArray(row.pages);
  const page = pages[0] as { questions?: unknown[] } | undefined;
  const question = page?.questions?.[0] as { id?: unknown } | undefined;
  return typeof question?.id === "string" && question.id.length > 0 ? question.id : "default-question";
}

function hasUsablePages(value: string): boolean {
  const pages = parseJsonArray(value);
  const page = pages[0] as { questions?: unknown[] } | undefined;
  return Boolean(page?.questions?.length);
}

type BackfillSurveyRow = {
  id: string;
  title: string;
  question_text: string;
  min_rating: number;
  max_rating: number;
  rating_labels: string;
  pages: string;
};

type BackfillPage = {
  id: string;
  title: string;
  questions: BackfillQuestion[];
};

type BackfillQuestion = {
  id: string;
  text: string;
  min_rating: number;
  max_rating: number;
  rating_labels: Record<string, string>;
};

function normalizedPagesForBackfill(row: BackfillSurveyRow): BackfillPage[] {
  const pages = parseJsonArray(row.pages).flatMap((page): BackfillPage[] => {
    if (!page || typeof page !== "object" || Array.isArray(page)) return [];
    const pageRecord = page as Record<string, unknown>;
    if (typeof pageRecord.id !== "string" || typeof pageRecord.title !== "string" || !Array.isArray(pageRecord.questions)) {
      return [];
    }
    const questions = pageRecord.questions.flatMap((question): BackfillQuestion[] => {
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
        rating_labels: parseJsonObject(JSON.stringify(questionRecord.rating_labels ?? {}))
      }];
    });
    return questions.length > 0 ? [{ id: pageRecord.id, title: pageRecord.title, questions }] : [];
  });
  if (pages.length > 0) return pages;

  return [{
    id: `${row.id}-page-1`,
    title: row.title,
    questions: [{
      id: `${row.id}-question-1`,
      text: row.question_text,
      min_rating: row.min_rating,
      max_rating: row.max_rating,
      rating_labels: parseJsonObject(row.rating_labels)
    }]
  }];
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, label]) => /^-?\d+$/.test(key) && typeof label === "string")
    );
  } catch {
    return {};
  }
}
