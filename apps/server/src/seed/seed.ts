/** 演示种子数据：幂等写入项目/文档/引用/初始版本。 */
import type { Db } from '../db.js';
import { newId, nowIso, transaction } from '../db.js';
import { buildContentJson, extractParagraphs } from '../domain/paragraphs.js';
import {
  DEMO_CHAPTERS,
  DEMO_DOCUMENT_TITLE,
  DEMO_PROJECT_DESCRIPTION,
  DEMO_PROJECT_NAME,
  DEMO_REFERENCES,
} from './content.js';

export interface SeedResult {
  projectId: string;
  documentId: string;
  skipped: boolean;
}

function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

export function ensureSeed(db: Db): SeedResult {
  const existing = db.prepare('SELECT id, document_id FROM projects ORDER BY created_at LIMIT 1').get() as
    | { id: string; document_id: string }
    | undefined;
  if (existing) {
    return { projectId: existing.id, documentId: existing.document_id, skipped: true };
  }

  return transaction(db, () => {
    const at = nowIso();
    const projectId = newId('prj');
    const documentId = newId('doc');
    const contentJson = buildContentJson(DEMO_CHAPTERS);
    const paragraphs = extractParagraphs(contentJson);

    db.prepare(
      `INSERT INTO projects (id, name, description, data_level, document_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, DEMO_PROJECT_NAME, DEMO_PROJECT_DESCRIPTION, 'internal', documentId, at, at);

    db.prepare(
      `INSERT INTO documents (id, project_id, title, content_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(documentId, projectId, DEMO_DOCUMENT_TITLE, JSON.stringify(contentJson), at, at);

    for (const ref of DEMO_REFERENCES) {
      const id = newId('ref');
      const plain = ref.content;
      db.prepare(
        `INSERT INTO references_docs (id, project_id, title, kind, filename, content_text, char_count, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, projectId, ref.title, ref.kind, ref.filename, plain, plain.length, excerptOf(plain), at);
    }

    // 初始命名版本 V1.0
    db.prepare(
      `INSERT INTO versions (id, document_id, name, revision, content_json, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId('ver'), documentId, 'V1.0', 1, JSON.stringify(contentJson), at, 'system');

    return { projectId, documentId, skipped: false };
  });
}
