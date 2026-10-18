/** Scheduled-job persistence (infrastructure). No migrations: fresh CREATE TABLE
 * plus the reset-on-SCHEMA_VERSION-mismatch guard (bump to 4 in migrations).
 */
import type { DatabaseSync } from 'node:sqlite';

export type JobScope = 'ask' | 'do';
export type MissPolicy = 'run-once' | 'skip';

export interface Job {
  id: string;
  name: string;
  prompt: string;
  scope: JobScope;
  spec: string;
  tz: string;
  enabled: boolean;
  conversationId: string | null;
  missPolicy: MissPolicy;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastSummary: string | null;
  lastTaskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function ensureJobsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'ask', spec TEXT NOT NULL, tz TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, conversationId TEXT,
      missPolicy TEXT NOT NULL DEFAULT 'skip', lastTaskId TEXT,
      lastRunAt INTEGER, lastStatus TEXT, lastSummary TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
  `);
}

function row(r: Record<string, unknown>): Job {
  return {
    id: String(r.id), name: String(r.name), prompt: String(r.prompt),
    scope: r.scope === 'do' ? 'do' : 'ask',
    spec: String(r.spec), tz: String(r.tz || ''),
    enabled: Number(r.enabled) === 1,
    conversationId: r.conversationId ? String(r.conversationId) : null,
    missPolicy: r.missPolicy === 'run-once' ? 'run-once' : 'skip',
    lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
    lastTaskId: r.lastTaskId ? String(r.lastTaskId) : null,
    lastStatus: r.lastStatus ? String(r.lastStatus) : null,
    lastSummary: r.lastSummary ? String(r.lastSummary) : null,
    createdAt: Number(r.createdAt), updatedAt: Number(r.updatedAt),
  };
}

export function listJobs(db: DatabaseSync): Job[] {
  return (db.prepare('SELECT * FROM jobs ORDER BY createdAt').all() as Record<string, unknown>[]).map(row);
}

export function getJob(db: DatabaseSync, id: string): Job | null {
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? row(r) : null;
}

export function insertJob(db: DatabaseSync, j: Omit<Job, 'lastRunAt' | 'lastStatus' | 'lastSummary' | 'lastTaskId'>): void {
  db.prepare(
    'INSERT INTO jobs (id, name, prompt, scope, spec, tz, enabled, conversationId, missPolicy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(j.id, j.name, j.prompt, j.scope, j.spec, j.tz, j.enabled ? 1 : 0, j.conversationId, j.missPolicy, j.createdAt, j.updatedAt);
}

export function updateJob(db: DatabaseSync, id: string, patch: Partial<Omit<Job, 'id' | 'createdAt'>>): void {
  const cur = getJob(db, id);
  if (!cur) throw new Error('Unknown job');
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  db.prepare(
    'UPDATE jobs SET name = ?, prompt = ?, scope = ?, spec = ?, tz = ?, enabled = ?, conversationId = ?, missPolicy = ?, lastRunAt = ?, lastStatus = ?, lastSummary = ?, lastTaskId = ?, updatedAt = ? WHERE id = ?',
  ).run(next.name, next.prompt, next.scope, next.spec, next.tz, next.enabled ? 1 : 0, next.conversationId, next.missPolicy, next.lastRunAt, next.lastStatus, next.lastSummary, next.lastTaskId, next.updatedAt, id);
}

export function deleteJob(db: DatabaseSync, id: string): boolean {
  const r = db.prepare('DELETE FROM jobs WHERE id = ?').run(id) as unknown as { changes?: unknown };
  return typeof r?.changes === 'number' && r.changes > 0;
}

export function recordJobRun(db: DatabaseSync, id: string, status: string, summary: string, at = Date.now()): void {
  db.prepare('UPDATE jobs SET lastRunAt = ?, lastStatus = ?, lastSummary = ?, updatedAt = ? WHERE id = ?')
    .run(at, status, summary.slice(0, 500), at, id);
}
