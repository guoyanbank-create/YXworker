/**
 * 数据库：Node 24 内置 node:sqlite（单进程、单写者；P0 单实例部署）。
 * 正式文档正文以 documents.content_json（TipTap JSON）为准，revision 单调递增。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data_level TEXT NOT NULL DEFAULT 'internal',
  document_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_document ON versions(document_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_document_name ON versions(document_id, name);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  paragraph_id TEXT NOT NULL,
  paragraph_index INTEGER NOT NULL,
  chapter_title TEXT NOT NULL,
  quote TEXT NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  backend TEXT NOT NULL,
  tier TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_hash TEXT NOT NULL,
  discussion_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  reviewer TEXT,
  conflict_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_document ON proposals(document_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(document_id, status);

CREATE TABLE IF NOT EXISTS proposal_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal ON proposal_events(proposal_id);

CREATE TABLE IF NOT EXISTS references_docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_references_project ON references_docs(project_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  backend TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  prompt TEXT NOT NULL,
  error_json TEXT,
  events_json TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  retry_reason TEXT,
  fallback_from TEXT,
  data_policy_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_document ON runs(document_id);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
