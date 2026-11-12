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

/** 中心工作区视图（P2 面板与正文编辑共享中心区）。 */
export type CenterView = 'document' | 'diagrams' | 'features' | 'impact';

/** 对话中已选中的引用/小节（随 generate 发送 referenceIds/referenceSectionIds）。 */
export interface MentionSelection {
  referenceId: string;
  referenceTitle: string;
  /** 具体小节；null 表示整份引用。 */
  sectionId: string | null;
  locator: string | null;
}
