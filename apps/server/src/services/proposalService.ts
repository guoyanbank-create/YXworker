/**
 * 提案服务（契约桩，由 ai-engine 负责人实现并替换本文件）。
 * 约定：这些函数不自行 BEGIN/COMMIT 事务；需要多写操作的调用方用 `transaction(db, fn)` 包裹。
 */
import type { Db } from '../db.js';
import type { ParagraphBlock, Proposal } from '../types.js';

/** 文档内容变化后，将目标段落原文 hash 已变化的 proposed/revised 提案标记为 conflicted。 */
export function markConflictedProposalsForContentChange(
  _db: Db,
  _documentId: string,
  _oldBlocks: ParagraphBlock[],
  _newBlocks: ParagraphBlock[],
): Proposal[] {
  return [];
}

export function listProposals(_db: Db, _documentId: string): Proposal[] {
  return [];
}
