/** 故障演练面板（仅本机演示，PRODUCT_SPEC §11.7）：显式触发 429/500/断网/数据分级外发。 */
import type { FaultKind } from '../api/types';
import type { FaultResult } from '../ui/types';
import { AlertIcon, BeakerIcon, CheckIcon } from './Icons';

export interface FaultPanelProps {
  enabled: boolean;
  busy: FaultKind | null;
  result: FaultResult | null;
  providerConfigured: boolean | null;
  onFault: (fault: FaultKind) => void;
}

const FAULTS: Array<{ fault: FaultKind; label: string; code: string; title: string }> = [
  {
    fault: 'rate_limit',
    label: '429 限流',
    code: 'model_rate_limited',
    title: '让真实模型网关返回 429，验证限流错误分流',
  },
  {
    fault: 'server_error',
    label: '500 网关错误',
    code: 'model_unavailable',
    title: '让真实模型网关返回 5xx，验证不可用错误分流',
  },
  {
    fault: 'network',
    label: '断网',
    code: 'model_unavailable',
    title: '模拟网络断开，验证网络错误分流',
  },
  {
    fault: 'timeout',
    label: '模型超时',
    code: 'model_timeout',
    title: '注入模型超时（含看门狗兜底），验证 504 超时错误分流且 run 不悬挂',
  },
  {
    fault: 'data_policy',
    label: '数据分级外发',
    code: 'data_policy_blocked',
    title: '把项目数据分级临时置为「机密」后调用真实模型，验证外发阻断',
  },
];

export function FaultPanel({ enabled, busy, result, providerConfigured, onFault }: FaultPanelProps) {
  return (
    <section className="panel-section fault-panel" data-testid="fault-panel">
      <div className="section-head">
        <h3>
          故障演练
          <span className="section-sub">仅本机演示</span>
        </h3>
      </div>
      <p className="section-hint">
        触发一次生成请求并注入五类故障之一（限流/网关错误/断网/超时/数据分级外发），验证错误码分流与“文档不丢”。
      演练不会写入正文；数据分级演练结束后会自动恢复原分级。
      </p>
      <div className="fault-grid">
        {FAULTS.map((item) => (
          <button
            key={item.fault}
            type="button"
            className="fault-btn"
            data-testid={`fault-${item.fault.replace('_', '-')}`}
            data-fault={item.fault}
            title={item.title}
            disabled={!enabled || busy !== null}
            onClick={() => onFault(item.fault)}
          >
            <BeakerIcon size={14} />
            <span className="fault-btn-label">
              {item.label}
              <span className="fault-btn-code">{item.code}</span>
            </span>
            {busy === item.fault ? <span className="spinner spinner-sm" /> : null}
          </button>
        ))}
      </div>
      {!enabled ? (
        <p className="fault-disabled-note">
          服务端未开启故障注入（YXWORKER_FAULT_INJECTION=0），演练按钮不可用。启动时设置该环境变量为 1 即可。
        </p>
      ) : null}
      {enabled && providerConfigured === false ? (
        <p className="fault-disabled-note">
          提示：真实模型未配置凭据时，429/500/断网演练可能先返回 credential_missing；建议切换模拟执行器或配置服务端凭据。
        </p>
      ) : null}
      {result ? (
        <div
          className={`fault-result${result.blocked ? ' is-ok' : ' is-fail'}`}
          data-testid="fault-result"
          data-code={result.code}
        >
          <span className="fault-result-icon">
            {result.blocked ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
          </span>
          <div>
            <strong>{result.blocked ? '错误已按预期阻断' : '未得到预期错误'}</strong>
            <p>
              <code>{result.code}</code> — {result.message}
            </p>
            <p className="fault-result-meta">
              文档内容未受影响，可继续编辑或导出。预期错误码：{FAULTS.find((item) => item.fault === result.fault)?.code ?? '—'}
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
