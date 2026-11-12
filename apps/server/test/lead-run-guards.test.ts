/**
 * 运行硬超时看门狗（Lead 集成修复）回归测试。
 *
 * 背景：缺陷报告发现「真实模型 run 可在 running 上悬挂」。provider 层已有 AbortSignal 超时，
 * 本测试覆盖防御性兜底：即使执行器 Promise 永不 settle，看门狗也必须把 run 置为
 * failed(model_timeout)，写入 latencyMs/retryReason 并触发中止。
 */
import { describe, expect, it } from 'vitest';
import { makeTestContext } from './helpers.js';
import * as runService from '../src/services/runService.js';

function createRun(ctx: ReturnType<typeof makeTestContext>) {
  return runService.createRun(ctx.db, {
    projectId: ctx.projectId,
    documentId: ctx.documentId,
    type: 'proposal_generation',
    backend: 'dsh',
    provider: 'openai-compatible',
    model: 'deepseek-flash',
    tier: 'review',
    prompt: '真实模型超时兜底测试',
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Run 硬超时看门狗', () => {
  it('running 超时被强制标记 failed(model_timeout)，写 latencyMs/retryReason 并触发中止', async () => {
    const ctx = makeTestContext();
    const run = createRun(ctx);
    runService.markRunRunning(ctx.db, run.id);
    let aborted = false;
    runService.scheduleRunWatchdog(ctx.db, run.id, 25, () => {
      aborted = true;
    });
    await sleep(120);
    const after = runService.getRun(ctx.db, run.id);
    expect(after.status).toBe('failed');
    expect(after.error?.code).toBe('model_timeout');
    expect(after.retryReason).toBe('watchdog_timeout');
    expect(after.latencyMs).toBeGreaterThanOrEqual(0);
    expect(aborted).toBe(true);
    expect(after.events.some((event) => event.message.includes('model_timeout'))).toBe(true);
  });

  it('不覆盖已成功的 run', async () => {
    const ctx = makeTestContext();
    const run = createRun(ctx);
    runService.markRunRunning(ctx.db, run.id);
    runService.finishRun(ctx.db, run.id, {
      latencyMs: 12,
      tokensIn: 10,
      tokensOut: 5,
      retryReason: null,
    });
    runService.scheduleRunWatchdog(ctx.db, run.id, 25);
    await sleep(100);
    const after = runService.getRun(ctx.db, run.id);
    expect(after.status).toBe('succeeded');
    expect(after.tokensIn).toBe(10);
    expect(after.tokensOut).toBe(5);
  });

  it('清除看门狗后不再触发', async () => {
    const ctx = makeTestContext();
    const run = createRun(ctx);
    runService.markRunRunning(ctx.db, run.id);
    runService.scheduleRunWatchdog(ctx.db, run.id, 60);
    runService.clearRunWatchdog(run.id);
    await sleep(150);
    const after = runService.getRun(ctx.db, run.id);
    expect(after.status).toBe('running');
  });

  it('默认看门狗时长 = 模型超时 + 30s', () => {
    const previous = process.env.YXWORKER_LLM_TIMEOUT_MS;
    delete process.env.YXWORKER_LLM_TIMEOUT_MS;
    expect(runService.runWatchdogTimeoutMs()).toBe(90_000);
    process.env.YXWORKER_LLM_TIMEOUT_MS = '5000';
    expect(runService.runWatchdogTimeoutMs()).toBe(35_000);
    if (previous === undefined) delete process.env.YXWORKER_LLM_TIMEOUT_MS;
    else process.env.YXWORKER_LLM_TIMEOUT_MS = previous;
  });
});
