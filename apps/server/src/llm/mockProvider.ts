/**
 * Mock provider：离线、确定性，不发任何网络请求。
 *
 * 用途（API_CONTRACT §9）：`backend=mock` 的演示/测试执行器。必须确定性产出 5 条针对
 * 第三章（chapterIndex=2）不同段落的提案，并引用种子引用（referenceId/locator/excerpt）。
 * 结果仍会经过与真实模型完全相同的 zod 校验/读回流程，UI/运行记录明确标注“模拟”。
 */
import type { Citation, ParagraphBlock } from '../types.js';
import { excerptAt } from './reference.js';
import type {
  LlmCallRequest,
  LlmCallResult,
  LlmProvider,
  ReferenceMaterial,
  StructuredTaskContext,
} from './types.js';
import { LlmError } from './types.js';

export const MOCK_MODEL = 'mock-proposal-v1';
export const MOCK_PROVIDER_LABEL = '模拟（离线 Mock）';
/** Mock 固定针对的章节：第三章 = chapterIndex 2（API_CONTRACT §9 / PRODUCT_SPEC §11.2）。 */
export const MOCK_TARGET_CHAPTER_INDEX = 2;

interface MockTemplate {
  /** 追加到原文末尾的建议句（确定性）。 */
  append: string;
  reason: string;
  /** 引用 references 的索引（取模）。 */
  refIndex: number;
  /** 引用 locators 的索引（取模）。 */
  locatorOffset: number;
}

/**
 * 5 条确定性模板：按目标章节正文段落顺序依次取用，保证每条锚定不同段落。
 * 文案与种子引用（历史方案 / 技术说明）中的小节对应。
 */
export const MOCK_GENERATION_TEMPLATES: MockTemplate[] = [
  {
    append:
      '三类场景分别设置转人工阈值：当检索置信度低于约定阈值时立即转人工，并保留失败样本用于迭代优化。',
    reason:
      '历史方案“第 2 节 试点范围”要求试点期不改变对外服务入口；建议为每类场景补充转人工阈值与失败样本回流机制，避免无依据回答。',
    refIndex: 0,
    locatorOffset: 1,
  },
  {
    append:
      '知识库中的每条政策原文需标注来源文档 id、版本与生效日期，问答对不得替代政策原文作为最终依据。',
    reason:
      '技术说明“第 1 节 检索链路”要求检索结果携带来源标识（文档 id、版本、小节位置）；建议在知识库结构中补充版本与生效日期标注。',
    refIndex: 1,
    locatorOffset: 0,
  },
  {
    append: '重排阶段增加去重与来源覆盖检查，确保同一问题的回答优先引用政策原文片段。',
    reason:
      '技术说明“第 1 节 检索链路”指出重排应优先保证政策原文片段；建议增加去重与来源覆盖校验，提升回答可追溯性。',
    refIndex: 1,
    locatorOffset: 0,
  },
  {
    append:
      '网关调用统一使用 json_object 结构化输出，并由服务端做 Schema 校验与一次修复重试，避免解析失败导致提案丢失。',
    reason:
      '技术说明“第 2 节 模型网关”明确网关只支持 json_object、不支持 json_schema；建议在模型接入层补充服务端校验与修复重试要求。',
    refIndex: 1,
    locatorOffset: 1,
  },
  {
    append: '将引用命中率纳入运行监控指标（目标不低于 90%），低于阈值时按周输出改进清单。',
    reason:
      '历史方案“第 3 节 指标基线”给出引用命中率 90% 的目标；建议将引用命中率纳入兜底与运行监控指标。',
    refIndex: 0,
    locatorOffset: 2,
  },
];

function buildCitations(template: MockTemplate, references: ReferenceMaterial[]): Citation[] {
  if (references.length === 0) return [];
  const citations: Citation[] = [];
  const primary = references[template.refIndex % references.length];
  const primaryLocator =
    primary.locators[template.locatorOffset % Math.max(primary.locators.length, 1)] ??
    primary.locators[0];
  const primaryExcerpt = excerptAt(primary, primaryLocator, 120);
  citations.push({
    referenceId: primary.id,
    title: primary.title,
    locator: primaryExcerpt.locator,
    excerpt: primaryExcerpt.excerpt,
  });
  if (references.length > 1) {
    const secondary = references[(template.refIndex + 1) % references.length];
    if (secondary.id !== primary.id) {
      const secondaryExcerpt = excerptAt(secondary, secondary.locators[0], 120);
      citations.push({
        referenceId: secondary.id,
        title: secondary.title,
        locator: secondaryExcerpt.locator,
        excerpt: secondaryExcerpt.excerpt,
      });
    }
  }
  return citations;
}

function targetParagraphs(context: StructuredTaskContext): ParagraphBlock[] {
  if (context.task !== 'generation') return [];
  const targetChapter = context.chapterIndex ?? MOCK_TARGET_CHAPTER_INDEX;
  const inChapter = context.blocks.filter(
    (block) =>
      block.chapterIndex === targetChapter &&
      (block.type === 'paragraph' || block.type === 'blockquote'),
  );
  if (inChapter.length > 0) return inChapter;
  // 目标章节不存在时回退到全文正文段落，避免 mock 在自定义文档上完全不可用。
  return context.blocks.filter((block) => block.type === 'paragraph');
}

export function buildMockGenerationRaw(context: StructuredTaskContext): string {
  if (context.task !== 'generation') {
    throw new LlmError('model_schema_invalid', 'mock provider 仅支持生成任务', { retryable: false });
  }
  const paragraphs = targetParagraphs(context);
  const count = Math.min(context.count > 0 ? context.count : 5, 5, paragraphs.length);
  const proposals = paragraphs.slice(0, count).map((block, index) => {
    const template = MOCK_GENERATION_TEMPLATES[index % MOCK_GENERATION_TEMPLATES.length];
    return {
      paragraphId: block.id,
      oldText: block.text,
      newText: `${block.text}${template.append}`,
      reason: template.reason,
      citations: buildCitations(template, context.references),
    };
  });
  return JSON.stringify({ proposals });
}

export function buildMockDiscussionRaw(context: StructuredTaskContext): string {
  if (context.task !== 'discussion') {
    throw new LlmError('model_schema_invalid', 'mock provider 仅支持讨论任务', { retryable: false });
  }
  const message = context.message.replace(/\s+/g, ' ').trim();
  const note = message.length > 0 ? message.slice(0, 60) : '补充依据与边界';
  const newText = `${context.proposal.newText}（已按讨论意见调整：${note}）`;
  return JSON.stringify({
    newText,
    reason: `讨论后修订：${note}；保持原段落事实与引用口径，仅调整表述与边界。`,
  });
}

export interface MockProviderOptions {
  /** 便于测试/演示展示耗时，默认 0（离线即时返回）。 */
  latencyMs?: number;
}

export function createMockProvider(options: MockProviderOptions = {}): LlmProvider {
  const latencyMs = options.latencyMs ?? 0;
  return {
    id: 'mock',
    label: MOCK_PROVIDER_LABEL,
    mock: true,
    configured: true,
    models: [MOCK_MODEL],
    async generate(request: LlmCallRequest): Promise<LlmCallResult> {
      if (!request.context) {
        throw new LlmError('model_schema_invalid', 'mock provider 缺少结构化上下文', {
          retryable: false,
        });
      }
      const rawText =
        request.context.task === 'generation'
          ? buildMockGenerationRaw(request.context)
          : buildMockDiscussionRaw(request.context);
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      return {
        rawText,
        model: MOCK_MODEL,
        latencyMs,
        tokensIn: Math.max(
          1,
          Math.ceil(request.messages.reduce((total, item) => total + item.content.length, 0) / 4),
        ),
        tokensOut: Math.max(1, Math.ceil(rawText.length / 4)),
        finishReason: 'stop',
      };
    },
  };
}
