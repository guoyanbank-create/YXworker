/** 前端 UI 层公共类型（非 API 契约类型）。 */
import type { FaultKind } from '../api/types';

/** 顶部保存状态（对应 API 契约 §8.2）。 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

/** 面向 UI 的 API 错误信息（保留错误码用于分流提示）。 */
export interface ApiErrorInfo {
  code: string;
  message: string;
  hint: string | null;
  at: string;
}

export interface FaultResult {
  fault: FaultKind;
  code: string;
  message: string;
  /** 是否按预期被阻断/失败（错误分流演示成功）。 */
  blocked: boolean;
}

export type RunKind = 'generate' | 'discuss' | 'fault';
