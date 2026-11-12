/** 演示种子数据：幂等写入项目/文档/引用/初始版本。 */
import type { Db } from '../db.js';
import { newId, nowIso, transaction } from '../db.js';
import { buildContentJson, extractParagraphs } from '../domain/paragraphs.js';
import { parseReferenceSections } from '../domain/referenceSections.js';
import {
  DEMO_CHAPTERS,
  DEMO_DIAGRAMS,
  DEMO_DOCUMENT_TITLE,
  DEMO_FEATURES,
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

/**
 * P1/P2 演示数据补齐（幂等）：引用小节切分、Mermaid 图表、功能清单。
 * 在 ensureSeed 之后调用；对已存在的演示项目做增量补齐（含 P0 数据迁移）。
 */
export function ensureSeedExtras(db: Db): void {
  const project = db
    .prepare('SELECT id, document_id FROM projects ORDER BY created_at LIMIT 1')
    .get() as { id: string; document_id: string } | undefined;
  if (!project) return;
  const at = nowIso();

  // P1：引用小节/段落切分（缺失时补齐）
  const references = db
    .prepare('SELECT id, content_text FROM references_docs WHERE project_id = ?')
    .all(project.id) as unknown as Array<{ id: string; content_text: string }>;
  for (const reference of references) {
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM reference_sections WHERE reference_id = ?')
      .get(reference.id) as { n: number };
    if (Number(count.n) > 0) continue;
    for (const section of parseReferenceSections(reference.content_text)) {
      db.prepare(
        `INSERT INTO reference_sections (id, reference_id, locator, section_title, paragraph_index, excerpt, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('rsec'),
        reference.id,
        section.locator,
        section.sectionTitle,
        section.paragraphIndex,
        section.excerpt,
        section.content,
        at,
      );
    }
  }

  const document = db
    .prepare('SELECT id, revision FROM documents WHERE id = ?')
    .get(project.document_id) as { id: string; revision: number } | undefined;
  if (!document) return;
  const version = db
    .prepare('SELECT name, revision FROM versions WHERE document_id = ? ORDER BY created_at LIMIT 1')
    .get(document.id) as { name: string; revision: number } | undefined;

  // P2：Mermaid 图表（默认绑定 V1.0 版本，若无命名版本则绑定当前 revision）
  const diagramCount = db
    .prepare('SELECT COUNT(*) AS n FROM diagrams WHERE project_id = ?')
    .get(project.id) as { n: number };
  if (Number(diagramCount.n) === 0) {
    for (const diagram of DEMO_DIAGRAMS) {
      db.prepare(
        `INSERT INTO diagrams (id, project_id, title, kind, source, description, document_id, document_revision, version_name, chapter_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('dia'),
        project.id,
        diagram.title,
        diagram.kind,
        diagram.source,
        diagram.description,
        document.id,
        version?.revision ?? document.revision,
        version?.name ?? null,
        diagram.chapterRef,
        at,
        at,
      );
    }
  }

  // P2：功能清单
  const featureCount = db
    .prepare('SELECT COUNT(*) AS n FROM feature_specs WHERE project_id = ?')
    .get(project.id) as { n: number };
  if (Number(featureCount.n) === 0) {
    for (const feature of DEMO_FEATURES) {
      db.prepare(
        `INSERT INTO feature_specs (id, project_id, title, description, status, priority, chapter_ref, diagram_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        newId('feat'),
        project.id,
        feature.title,
        feature.description,
        feature.status,
        feature.priority,
        feature.chapterRef,
        at,
        at,
      );
    }
  }
}
