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
  db.exec(`
    CREATE TABLE IF NOT EXISTS surveys (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      question_text TEXT NOT NULL,
      min_rating INTEGER NOT NULL DEFAULT -3,
      max_rating INTEGER NOT NULL DEFAULT 3,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS postal_codes (
      postal_code TEXT PRIMARY KEY,
      source_name TEXT,
      geometry_available INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      survey_id TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      rating INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (survey_id) REFERENCES surveys(id)
    );

    CREATE TABLE IF NOT EXISTS postal_code_aggregates (
      survey_id TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      response_count INTEGER NOT NULL,
      rating_sum INTEGER NOT NULL,
      rating_avg REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (survey_id, postal_code)
    );
  `);
}

export function seedDefaultSurvey(db: Db): void {
  const existing = db.prepare("SELECT id FROM surveys WHERE is_active = 1 LIMIT 1").get();
  if (existing) {
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO surveys (id, title, question_text, min_rating, max_rating, is_active, created_at, updated_at)
    VALUES (?, ?, ?, -3, 3, 1, ?, ?)
  `).run("default", "Stimmungsbild", "Wie bewerten Sie die aktuelle Situation?", now, now);
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
