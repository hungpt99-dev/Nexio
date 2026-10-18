import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 4;

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversationId TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL,
      mode TEXT, command TEXT, args TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversationId);
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, trigger TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, trigger TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, steps TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, workflowId TEXT NOT NULL,
      status TEXT NOT NULL, output TEXT, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
      service TEXT PRIMARY KEY, value BLOB NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, point TEXT NOT NULL,
      engine TEXT NOT NULL, model TEXT NOT NULL, modelVersion TEXT NOT NULL DEFAULT '',
      inputHash TEXT NOT NULL, probabilities TEXT NOT NULL, verdict TEXT NOT NULL,
      choice TEXT, confidence REAL NOT NULL, latencyMs INTEGER NOT NULL, outcome TEXT
    );
    CREATE TABLE IF NOT EXISTS decision_calibrations (
      key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, model TEXT NOT NULL, version TEXT NOT NULL,
      pointId TEXT NOT NULL, act REAL NOT NULL, confirm REAL NOT NULL,
      falseActRate REAL NOT NULL, ece REAL NOT NULL, n INTEGER NOT NULL, fittedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, inputHash TEXT NOT NULL,
      latencyMs INTEGER NOT NULL, ok INTEGER NOT NULL, errorCode TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'ask', spec TEXT NOT NULL, tz TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, conversationId TEXT,
      missPolicy TEXT NOT NULL DEFAULT 'skip', lastTaskId TEXT,
      lastRunAt INTEGER, lastStatus TEXT, lastSummary TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
  `);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
  // why: stamp every fresh DB (file or :memory:) so the open-time guard can tell stale from current.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
