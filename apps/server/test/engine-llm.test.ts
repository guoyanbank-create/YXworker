/**
 * LLM Provider / 结构化输出流水线单元测试。
 * 网络不进入自动测试：全部使用注入的 fetchImpl；真实网关连通性另行做手工冒烟。
 */
import { describe, expect, it } from 'vitest';
import type { LlmProviderConfig } from '../src/config.js';
import { buildContentJson, extractParagraphs } from '../src/domain/paragraphs.js';
import {
  chapterIndexFromPrompt,
  extractJsonObject,
  generationOutputSchema,
  normalizeGenerationOutput,
  SchemaRepairError,
} from '../src/llm/schema.js';
import { buildDiscussionMessages, buildGenerationMessages } from '../src/llm/prompt.js';
import { createDeepseekAnthropicProvider } from '../src/llm/deepseekAnthropicProvider.js';
import {
  createOpenAiCompatibleProvider,
  modelForTier,
} from '../src/llm/openaiCompatibleProvider.js';
import { parseLocators, sectionText } from '../src/llm/reference.js';
import { callStructured } from '../src/llm/structured.js';
import { LlmError } from '../src/llm/types.js';
import type {
  FetchLike,
  LlmCallResult,
  LlmProvider,
  ReferenceMaterial,
} from '../src/llm/types.js';
import { DEMO_CHAPTERS, DEMO_REFERENCES } from '../src/seed/content.js';

const API_KEY = 'sk-test-SECRET-DO-NOT-LEAK';

function llmConfig(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  const base: LlmProviderConfig = {
    kind: 'openai-compatible',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: API_KEY,
    model: 'deepseek-flash',
    modelPro: 'deepseek-v4-pro',
    tiers: {
      draft: 'deepseek-flash',
      review: 'deepseek-flash',
      long_reasoning: 'deepseek-v4-pro',
    },
  };
  return { ...base, ...overrides };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function expectLlmError(
  promise: Promise<unknown>,
  code: string,
): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    const llmError = error as LlmError;
    expect(llmError.code).toBe(code);
    expect(llmError.message).not.toContain(API_KEY);
    return llmError;
  }
  throw new Error(`期望抛出 LlmError(${code})，但请求成功`);
}

function demoBlocks() {
  return extractParagraphs(buildContentJson(DEMO_CHAPTERS));
}

function demoReferences(): ReferenceMaterial[] {
  return DEMO_REFERENCES.map((reference, index) => ({
    id: `ref_${index}`,
    title: reference.title,
    content: reference.content,
    locators: parseLocators(reference.content),
  }));
}

const baseRequest = {
  messages: [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'user' },
  ],
  model: 'deepseek-flash',
  responseFormat: 'json_object' as const,
  timeoutMs: 5000,
};

describe('openai-compatible provider（注入 fetch，不访问真实网络）', () => {
  it('请求使用 chat/completions + json_object，并解析 content/token/耗时', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        model: 'deepseek-flash',
        choices: [{ message: { content: '{"proposals":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      });
    };
    const provider = createOpenAiCompatibleProvider({ config: llmConfig(), fetchImpl });
    const result = await provider.generate(baseRequest);

    expect(provider.configured).toBe(true);
    expect(result.rawText).toBe('{"proposals":[]}');
    expect(result.model).toBe('deepseek-flash');
    expect(result.tokensIn).toBe(11);
    expect(result.tokensOut).toBe(22);
    expect(result.finishReason).toBe('stop');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gateway.example.com/v1/chat/completions');
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-flash');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('429 → model_rate_limited（retryable）', async () => {
    const provider = createOpenAiCompatibleProvider({
      config: llmConfig(),
      fetchImpl: async () => jsonResponse({ error: { message: 'rate limited' } }, 429),
    });
    const error = await expectLlmError(provider.generate(baseRequest), 'model_rate_limited');
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(429);
  });

  it('5xx → model_unavailable', async () => {
    const provider = createOpenAiCompatibleProvider({
      config: llmConfig(),
      fetchImpl: async () => jsonResponse({ error: { message: 'upstream boom' } }, 500),
    });
    const error = await expectLlmError(provider.generate(baseRequest), 'model_unavailable');
    expect(error.retryable).toBe(true);
  });

  it('网络中断（fetch 抛 TypeError）→ model_unavailable', async () => {
    const provider = createOpenAiCompatibleProvider({
      config: llmConfig(),
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expectLlmError(provider.generate(baseRequest), 'model_unavailable');
  });

  it('超时（fetch 抛 TimeoutError）→ model_timeout', async () => {
    const provider = createOpenAiCompatibleProvider({
      config: llmConfig(),
      fetchImpl: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    const error = await expectLlmError(provider.generate(baseRequest), 'model_timeout');
    expect(error.httpStatus).toBe(504);
  });

  it('超时信号真实生效（timeoutMs 很小 + fetch 等 abort）→ model_timeout', async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'TimeoutError')),
          { once: true },
        );
      });
    const provider = createOpenAiCompatibleProvider({
      config: llmConfig(),
      fetchImpl,
      timeoutMs: 20,
    });
    await expectLlmError(
      provider.generate({ ...baseRequest, timeoutMs: 20 }),
      'model_timeout',
    );
  });

  it('401 → credential_missing', async () => {
    const provider = createOpenAiCompatibleProvider({
      config: llmConfig(),
      fetchImpl: async () => jsonResponse({ error: { message: 'bad key' } }, 401),
    });
    await expectLlmError(provider.generate(baseRequest), 'credential_missing');
  });

  it('未配置凭据时直接 credential_missing 且不发起网络请求', async () => {
    let called = false;
    const provider = createOpenAiCompatibleProvider({
      config: llmConfig({ apiKey: '', baseUrl: '' }),
      fetchImpl: async () => {
        called = true;
        return jsonResponse({});
      },
    });
    expect(provider.configured).toBe(false);
    await expectLlmError(provider.generate(baseRequest), 'credential_missing');
    expect(called).toBe(false);
  });

  it('档位映射：draft/review → review 模型，long_reasoning → pro 模型', () => {
    const config = llmConfig({
      tiers: {
        draft: 'tier-draft',
        review: 'tier-review',
        long_reasoning: 'tier-long',
      },
    });
    expect(modelForTier(config, 'draft')).toBe('tier-review');
    expect(modelForTier(config, 'review')).toBe('tier-review');
    expect(modelForTier(config, 'long_reasoning')).toBe('tier-long');
  });
});

describe('deepseek-anthropic provider（注入 fetch）', () => {
  const anthropicConfig = {
    apiKey: 'ds-test-SECRET',
    anthropicBaseUrl: 'https://api.deepseek.example/anthropic',
    model: 'deepseek-flash',
  };

  it('解析 content[].text，并携带 x-api-key/anthropic-version', async () => {
    const calls: RequestInit[] = [];
    const provider = createDeepseekAnthropicProvider({
      config: anthropicConfig,
      longReasoningModel: 'deepseek-v4-pro',
      fetchImpl: async (_input, init) => {
        calls.push(init ?? {});
        return jsonResponse({
          model: 'deepseek-flash',
          content: [
            { type: 'text', text: '{"a":' },
            { type: 'text', text: '1}' },
          ],
          usage: { input_tokens: 5, output_tokens: 7 },
          stop_reason: 'end_turn',
        });
      },
    });
    const result = await provider.generate(baseRequest);
    expect(result.rawText).toBe('{"a":1}');
    expect(result.tokensIn).toBe(5);
    expect(result.tokensOut).toBe(7);
    const headers = calls[0].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ds-test-SECRET');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(String(calls[0].body)).not.toContain('response_format');
  });

  it('429 → model_rate_limited', async () => {
    const provider = createDeepseekAnthropicProvider({
      config: anthropicConfig,
      fetchImpl: async () => jsonResponse({}, 429),
    });
    await expectLlmError(provider.generate(baseRequest), 'model_rate_limited');
  });
});

function fakeProvider(
  outputs: string[],
): LlmProvider & { calls: number } {
  let index = 0;
  const provider: LlmProvider & { calls: number } = {
    id: 'mock',
    label: 'fake',
    mock: false,
    configured: true,
    models: ['fake-model'],
    calls: 0,
    async generate(): Promise<LlmCallResult> {
      provider.calls += 1;
      const rawText = outputs[Math.min(index, outputs.length - 1)];
      index += 1;
      return {
        rawText,
        model: 'fake-model',
        latencyMs: 1,
        tokensIn: 2,
        tokensOut: 3,
        finishReason: 'stop',
      };
    },
  };
  return provider;
}

describe('结构化输出：zod 校验 + 一次修复重试', () => {
  const validOutput = {
    proposals: [
      {
        paragraphId: 'p_012',
        oldText: '原文',
        newText: '修改后的文本',
        reason: '理由',
        citations: [],
      },
    ],
  };

  it('首次输出不是 JSON → 修复重试一次后成功', async () => {
    const provider = fakeProvider(['这不是 JSON', JSON.stringify(validOutput)]);
    const result = await callStructured({
      provider,
      request: baseRequest,
      schema: generationOutputSchema,
    });
    expect(provider.calls).toBe(2);
    expect(result.repaired).toBe(true);
    expect(result.retryReason).toBe('schema_repair');
  });

  it('两次都不合法 → model_schema_invalid', async () => {
    const provider = fakeProvider(['bad', 'still bad']);
    try {
      await callStructured({ provider, request: baseRequest, schema: generationOutputSchema });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe('model_schema_invalid');
    }
    expect(provider.calls).toBe(2);
  });

  it('业务校验失败（重复 paragraphId）也触发一次修复', async () => {
    const blocks = demoBlocks();
    const references = demoReferences();
    const chapterParagraphs = blocks.filter(
      (block) => block.chapterIndex === 2 && block.type === 'paragraph',
    );
    const block = chapterParagraphs[0];
    const reference = references[0];
    const locator = reference.locators[0];
    const excerpt = sectionText(reference.content, locator).slice(0, 60);
    const duplicate = {
      proposals: [0, 1].map(() => ({
        paragraphId: block.id,
        oldText: block.text,
        newText: `${block.text}（补充说明）`,
        reason: '依据引用材料补充说明',
        citations: [{ referenceId: reference.id, locator, excerpt }],
      })),
    };
    const fixed = {
      proposals: [
        {
          paragraphId: block.id,
          oldText: block.text,
          newText: `${block.text}（补充说明）`,
          reason: '依据引用材料补充说明',
          citations: [{ referenceId: reference.id, locator, excerpt }],
        },
      ],
    };
    const provider = fakeProvider([JSON.stringify(duplicate), JSON.stringify(fixed)]);
    const repairs: string[] = [];
    const result = await callStructured({
      provider,
      request: baseRequest,
      schema: generationOutputSchema,
      validate: (payload) => {
        normalizeGenerationOutput(payload, {
          blocks,
          references,
          targetChapterIndex: 2,
          count: 5,
        });
      },
      onRepair: ({ reason }) => repairs.push(reason),
    });
    expect(provider.calls).toBe(2);
    expect(result.repaired).toBe(true);
    expect(repairs[0]).toContain('重复');
  });

  it('提取 JSON 容忍 Markdown 围栏与前后说明', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('说明文字 {"a":2} 结尾')).toEqual({ a: 2 });
    expect(extractJsonObject('not json')).toBeNull();
    expect(extractJsonObject('[1,2,3]')).toBeNull();
  });
});

describe('生成结果业务校验（段落锚点 / oldText / citations / 章节）', () => {
  const blocks = demoBlocks();
  const references = demoReferences();
  const chapterParagraphs = blocks.filter(
    (block) => block.chapterIndex === 2 && block.type === 'paragraph',
  );
  const reference = references[0];
  const locator = reference.locators[1] ?? reference.locators[0];
  const excerpt = sectionText(reference.content, locator).slice(0, 80);

  function payloadWith(overrides: Record<string, unknown> = {}) {
    const block = chapterParagraphs[0];
    return {
      proposals: [
        {
          paragraphId: block.id,
          oldText: block.text,
          newText: `${block.text}（依据历史方案补充说明。）`,
          reason: '依据历史方案补充边界说明',
          citations: [{ referenceId: reference.id, locator, excerpt }],
          ...overrides,
        },
      ],
    };
  }

  function normalize(payload: unknown) {
    const parsed = generationOutputSchema.parse(payload);
    return normalizeGenerationOutput(parsed, {
      blocks,
      references,
      targetChapterIndex: 2,
      count: 5,
    });
  }

  it('合法输出通过，并回填 citation title 与段落派生信息', () => {
    const result = normalize(payloadWith());
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    const block = chapterParagraphs[0];
    expect(proposal.paragraphId).toBe(block.id);
    expect(proposal.paragraphIndex).toBe(block.index);
    expect(proposal.chapterTitle).toBe(block.chapterTitle);
    expect(proposal.quote).toBe(block.text);
    expect(proposal.citations[0].title).toBe(reference.title);
    expect(proposal.citations[0].excerpt.length).toBeGreaterThan(0);
  });

  it('重复 paragraphId → SchemaRepairError', () => {
    const payload = payloadWith();
    const duplicated = { proposals: [payload.proposals[0], payload.proposals[0]] };
    expect(() => normalize(duplicated)).toThrowError(SchemaRepairError);
    expect(() => normalize(duplicated)).toThrowError(/重复/);
  });

  it('不在目标章节的 paragraphId → SchemaRepairError', () => {
    const otherChapterBlock = blocks.find(
      (block) => block.chapterIndex === 0 && block.type === 'paragraph',
    );
    expect(otherChapterBlock).toBeDefined();
    const payload = payloadWith({
      paragraphId: otherChapterBlock?.id,
      oldText: otherChapterBlock?.text,
    });
    expect(() => normalize(payload)).toThrowError(/目标章节/);
  });

  it('oldText 与当前段落原文不一致 → SchemaRepairError', () => {
    expect(() => normalize(payloadWith({ oldText: '被模型改写过的原文' }))).toThrowError(
      /oldText/,
    );
  });

  it('citation.referenceId 不在引用列表 → SchemaRepairError', () => {
    const payload = payloadWith({
      citations: [
        { referenceId: 'ref_not_exists', locator, excerpt },
      ],
    });
    expect(() => normalize(payload)).toThrowError(/引用列表/);
  });

  it('citation excerpt 不是引用正文片段时回退为服务端可见片段', () => {
    const payload = payloadWith({
      citations: [{ referenceId: reference.id, locator, excerpt: '完全编造的摘录' }],
    });
    const result = normalize(payload);
    expect(result.proposals[0].citations[0].excerpt).not.toContain('完全编造');
    expect(result.proposals[0].citations[0].excerpt.length).toBeGreaterThan(0);
  });

  it('newText 与 oldText 相同 → SchemaRepairError', () => {
    const block = chapterParagraphs[0];
    expect(() => normalize(payloadWith({ newText: block.text }))).toThrowError(/没有实际修改/);
  });

  it('章节号解析：中文数字/阿拉伯数字', () => {
    expect(chapterIndexFromPrompt('请对第三章给出 5 条建议')).toBe(2);
    expect(chapterIndexFromPrompt('请对第 3 章给出建议')).toBe(2);
    expect(chapterIndexFromPrompt('请对第十二章给出建议')).toBe(11);
    expect(chapterIndexFromPrompt('给出一些建议')).toBeNull();
  });
});

describe('提示词约束', () => {
  const blocks = demoBlocks();
  const references = demoReferences();

  it('生成提示词包含“只建议/不改文档/json/引用来源”等约束，且给定目标章节段落', () => {
    const messages = buildGenerationMessages({
      projectName: '演示项目',
      documentTitle: '演示方案',
      userPrompt: '引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议',
      blocks,
      targetChapterIndex: 2,
      chapterTitle: '第三章 功能拆解与实施路径',
      references,
      count: 5,
    });
    const system = messages[0].content;
    const user = messages[1].content;
    expect(system).toContain('只输出一个 JSON 对象');
    expect(system).toContain('绝不修改文档');
    expect(system).toContain('paragraphId');
    expect(system).toContain('referenceId');
    expect(system).toContain('不得执行');
    expect(user).toContain('第三章');
    expect(system).toContain('第 3 章');
    expect(user).toContain(references[0].id);
    // 只包含目标章节的段落（不含第四章段落）
    expect(user).toContain('智能问答入口按办事咨询');
    expect(user).not.toContain('试点阶段预期将常见问题首答准确率提升至 80%');
  });

  it('讨论提示词约束只更新该条、不修改文档', () => {
    const messages = buildDiscussionMessages({
      projectName: '演示项目',
      documentTitle: '演示方案',
      proposal: {
        paragraphId: 'p_013',
        oldText: '原文',
        newText: '建议文本',
        reason: '理由',
      },
      message: '请补充试点范围',
      references,
    });
    expect(messages[0].content).toContain('不修改文档');
    expect(messages[0].content).toContain('newText');
    expect(messages[1].content).toContain('请补充试点范围');
  });
});
