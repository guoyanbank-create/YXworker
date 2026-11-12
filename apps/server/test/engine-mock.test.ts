/**
 * Mock provider / Mock execution backend 的确定性测试（离线，不发网络请求）。
 */
import { describe, expect, it } from 'vitest';
import { buildContentJson, extractParagraphs } from '../src/domain/paragraphs.js';
import { createMockProvider, MOCK_MODEL, MOCK_TARGET_CHAPTER_INDEX } from '../src/llm/mockProvider.js';
import { parseLocators } from '../src/llm/reference.js';
import type { ReferenceMaterial, StructuredTaskContext } from '../src/llm/types.js';
import { createMockBackend } from '../src/runtime/mockBackend.js';
import type { DiscussionTask, GenerationTask } from '../src/runtime/types.js';
import { DEMO_CHAPTERS, DEMO_REFERENCES } from '../src/seed/content.js';

function demoContext(): StructuredTaskContext {
  const blocks = extractParagraphs(buildContentJson(DEMO_CHAPTERS));
  const references: ReferenceMaterial[] = DEMO_REFERENCES.map((reference, index) => ({
    id: `ref_${index}`,
    title: reference.title,
    content: reference.content,
    locators: parseLocators(reference.content),
  }));
  return {
    task: 'generation',
    chapterIndex: MOCK_TARGET_CHAPTER_INDEX,
    chapterTitle: '第三章 功能拆解与实施路径',
    blocks,
    count: 5,
    references,
  };
}

function generationTask(blocks = extractParagraphs(buildContentJson(DEMO_CHAPTERS))): GenerationTask {
  return {
    type: 'proposal_generation',
    projectName: '智惠导服智能问答优化',
    documentTitle: '智惠导服智能问答优化方案（V1.0）',
    documentRevision: 1,
    prompt: '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议',
    count: 5,
    tier: 'review',
    targetChapterIndex: 2,
    chapterTitle: '第三章 功能拆解与实施路径',
    blocks,
    references: demoContext().references as ReferenceMaterial[],
  };
}

describe('mock provider 确定性', () => {
  it('对同一上下文两次调用输出完全一致，且为 5 条针对第三章不同段落的提案', async () => {
    const provider = createMockProvider();
    const request = {
      messages: [{ role: 'user' as const, content: 'ignored' }],
      model: MOCK_MODEL,
      responseFormat: 'json_object' as const,
      timeoutMs: 1000,
      context: demoContext(),
    };
    const first = await provider.generate(request);
    const second = await provider.generate(request);
    expect(first.rawText).toBe(second.rawText);
    expect(first.model).toBe(MOCK_MODEL);
    expect(provider.mock).toBe(true);
    expect(provider.configured).toBe(true);

    const parsed = JSON.parse(first.rawText) as {
      proposals: Array<{
        paragraphId: string;
        oldText: string;
        newText: string;
        reason: string;
        citations: Array<{ referenceId: string; locator: string; excerpt: string }>;
      }>;
    };
    expect(parsed.proposals).toHaveLength(5);
    const blocks = extractParagraphs(buildContentJson(DEMO_CHAPTERS));
    const byId = new Map(blocks.map((block) => [block.id, block]));
    const ids = parsed.proposals.map((proposal) => proposal.paragraphId);
    expect(new Set(ids).size).toBe(5);
    for (const proposal of parsed.proposals) {
      const block = byId.get(proposal.paragraphId);
      expect(block).toBeDefined();
      expect(block?.chapterIndex).toBe(2);
      expect(block?.type).toBe('paragraph');
      expect(proposal.oldText).toBe(block?.text);
      expect(proposal.newText).not.toBe(proposal.oldText);
      expect(proposal.newText.startsWith(proposal.oldText)).toBe(true);
      expect(proposal.reason.length).toBeGreaterThan(0);
      expect(proposal.citations.length).toBeGreaterThan(0);
      for (const citation of proposal.citations) {
        expect(['ref_0', 'ref_1']).toContain(citation.referenceId);
        expect(citation.locator.length).toBeGreaterThan(0);
        expect(citation.excerpt.length).toBeGreaterThan(0);
      }
    }
  });

  it('mock backend 走完整校验流水线并保真返回 5 条提案', async () => {
    const backend = createMockBackend();
    expect(backend.capabilities()).toMatchObject({ id: 'mock', mock: true, available: true });
    const events: string[] = [];
    const result = await backend.start(generationTask(), {
      runId: 'run_test_mock',
      signal: new AbortController().signal,
      emit: (level, message) => events.push(`${level}:${message}`),
    });
    expect(result.provider).toBe('mock');
    expect(result.model).toBe(MOCK_MODEL);
    expect(result.generation?.proposals).toHaveLength(5);
    expect(result.retryReason).toBeNull();
    expect(events.some((event) => event.includes('模拟'))).toBe(true);
  });

  it('mock 讨论确定性：只产出 newText/reason', async () => {
    const task: DiscussionTask = {
      type: 'discussion',
      projectName: '智惠导服智能问答优化',
      documentTitle: '演示方案',
      proposal: {
        paragraphId: 'p_012',
        oldText: '原文段落',
        newText: '原文段落（建议文本）',
        reason: '原理由',
      },
      message: '请补充试点范围与指标口径',
      tier: 'review',
      references: demoContext().references as ReferenceMaterial[],
    };
    const backend = createMockBackend();
    const context = {
      runId: 'run_test_discussion',
      signal: new AbortController().signal,
      emit: () => undefined,
    };
    const first = await backend.start(task, context);
    const second = await backend.start(task, context);
    expect(first.discussion?.newText).toBe(second.discussion?.newText);
    expect(first.discussion?.newText).not.toBe(task.proposal.newText);
    expect(first.discussion?.newText).toContain('讨论意见');
    expect(first.discussion?.reason.length).toBeGreaterThan(0);
  });

  it('目标章节缺失时回退到全文正文段落（仍确定性、不崩溃）', async () => {
    const blocks = extractParagraphs(
      buildContentJson([{ title: '唯一章节', paragraphs: ['唯一段落'] }]),
    );
    const backend = createMockBackend();
    const result = await backend.start(generationTask(blocks), {
      runId: 'run_test_fallback',
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    expect(result.generation?.proposals).toHaveLength(1);
  });
});
