/**
 * MockExecutionBackend：仅用于离线测试与本机演示。
 * - 不发任何网络请求；
 * - 确定性产出 5 条针对第三章（chapterIndex=2）不同段落的提案；
 * - 走与真实模型相同的 zod / 段落 / 引用校验；
 * - 运行记录标注 mock，UI 必须显示“模拟”。
 */
import { createMockProvider, MOCK_MODEL, MOCK_TARGET_CHAPTER_INDEX } from '../llm/mockProvider.js';
import { runDiscussionWithProvider, runGenerationWithProvider } from './pipeline.js';
import type {
  BackendCapabilities,
  ExecutionBackend,
  ExecutionContext,
  ExecutionResult,
  ExecutionTask,
} from './types.js';

export function createMockBackend(): ExecutionBackend {
  const provider = createMockProvider();
  return {
    id: 'mock',
    capabilities(): BackendCapabilities {
      return {
        id: 'mock',
        label: '模拟（离线 Mock）',
        available: true,
        mock: true,
        reason: '离线确定性模拟：不访问外部网络，结果必须标注“模拟”。',
      };
    },
    async start(task: ExecutionTask, ctx: ExecutionContext): Promise<ExecutionResult> {
      ctx.emit('info', '模拟执行器已启动（mock，不访问外部网络）', {
        backend: 'mock',
        provider: provider.id,
        model: MOCK_MODEL,
        mock: true,
      });
      let effectiveTask: typeof task = task;
      if (task.type === 'proposal_generation') {
        const requestedChapter = task.targetChapterIndex ?? MOCK_TARGET_CHAPTER_INDEX;
        const hasTargetChapter = task.blocks.some(
          (block) =>
            block.chapterIndex === requestedChapter &&
            (block.type === 'paragraph' || block.type === 'blockquote'),
        );
        effectiveTask = {
          ...task,
          // 文档没有第三章且未显式解析出目标章节时，回退为“不限定章节”，避免直接失败。
          targetChapterIndex: hasTargetChapter ? requestedChapter : null,
        };
      }
      const result =
        effectiveTask.type === 'proposal_generation'
          ? await runGenerationWithProvider(provider, MOCK_MODEL, effectiveTask, ctx)
          : await runDiscussionWithProvider(provider, MOCK_MODEL, effectiveTask, ctx);
      return result;
    },
    cancel(): boolean {
      // Mock 立即返回，无需取消。
      return false;
    },
    resume(): boolean {
      return false;
    },
  };
}
