# YXworker · AI 项目方案工作台（P0 本机版）

项目主题 → 引用资料 → AI 调研与方案 → 图表与功能拆解 → Office 式编辑 → AI 批注与逐条审阅
→ 历史版本 → Word 导出。

- 产品规格（唯一需求源）：[docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md)
- 阶段路线：[docs/ROADMAP.md](docs/ROADMAP.md)
- 架构与 P0 技术决策：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- API 契约：[docs/API_CONTRACT.md](docs/API_CONTRACT.md)
- P0 交付与验收对照：[docs/DELIVERY.md](docs/DELIVERY.md)
- 阶段 0 勘察报告：[docs/INVESTIGATION.md](docs/INVESTIGATION.md)、[docs/LICENSE_NOTES.md](docs/LICENSE_NOTES.md)

## 交付形态

**仅个人本机使用**：服务只监听 `127.0.0.1`，单用户；不做多用户、多租户、账号体系、
外部 ACL 与对外域名发布（不购买 Univer License）。数据只用脱敏或虚构材料。

## 快速开始（一条命令）

前置：Node.js >= 24.9（含内置 `node:sqlite`）、pnpm。

```bash
pnpm install
pnpm start          # 首次会自动构建，随后启动前端+后端
```

打开 <http://127.0.0.1:8787>。首次启动自动写入演示数据：项目「智惠导服智能问答优化」、
4 章节方案与两份引用资料。

### 端口与目录

| 项 | 值 |
| --- | --- |
| 服务地址 | `http://127.0.0.1:8787`（API + 已构建前端同端口） |
| 开发模式 | 后端 `8787`，前端 Vite `http://127.0.0.1:5173`（代理 `/api`） |
| 数据目录 | 仓库根 `.data/`（SQLite + WAL；`YXWORKER_DATA_DIR` 可覆盖） |
| 模型凭据 | `~/.config/yxworker/credentials.env`（chmod 600，仅服务端读取） |

### 模型凭据（仅在服务端）

真实模型需要 `~/.config/yxworker/credentials.env`（键名示例见
[configs/credentials.env.example](configs/credentials.env.example)）。密钥不写入仓库、
日志、数据库明文或前端。未配置时应用仍可运行，使用**模拟执行器**（UI 会明确标注“模拟”）。

### 常用命令

```bash
pnpm test           # 服务端单元/集成测试（vitest，不依赖网络）
pnpm test:e2e       # P0 端到端验收（Playwright + 系统 Chrome）
pnpm test:e2e:p1p2  # P1/P2 端到端验收（引用/provider/图表/清单/ImpactPlan/批量/模板）
pnpm acceptance     # P0 API 级 §11 验收
pnpm acceptance:p1p2 # P1/P2 API 级验收
pnpm verify:timeout # 模型硬超时/看门狗验证
pnpm dev            # 后端 + 前端开发模式
pnpm build          # 构建前端与服务端
pnpm seed           # 重新写入演示数据（幂等）
```

## 已实现能力（P0 + P1/P2）

- 单页工作台：项目 / 引用资料 / AI 对话 / 运行过程与错误 / Office 式富文本编辑 / 建议卡片 / 版本 / 导出。
- 提案审阅：JSON 结构化提案、段落锚点 + quote + hash + revision 校验、逐条采纳/拒绝/继续讨论、
  人工编辑触发冲突且禁止覆盖、只写入采纳内容。
- 版本：命名版本（V1.0/V1.1…）、只读查看、回退（生成新 revision）。
- 导出：可编辑 Word（`docx` 生成；用 LibreOffice 引擎渲染验证，见交付文档）。
- 模型：OpenAI 兼容网关 `json_object` + 服务端 Schema 校验 + 一次修复重试；
  429/5xx/网络/超时/数据分级外发分别给出明确错误；运行记录含模型/耗时/token/错误码。
- 执行器：`DSH`（默认，真实模型网关，最小受控执行器）、`Mock`（模拟，UI 标注）、
  `Codex`（本机未安装，仅探测为不可用）。
- **P1**：引用资料 @ 定位到小节/段落（locator+excerpt、来源弹窗）、卡片定位高亮与冲突定位兜底、
  provider 三选（openai-compatible / deepseek-anthropic / mock）与 `status.current` 超时展示、
  故障演练五类（429/500/网络/超时/数据分级）。
- **P2**：Mermaid 图表（源码+浏览器渲染+文档版本绑定）、功能清单（FeatureSpec）、
  ImpactPlan（先展示受影响章节/图表/功能再逐项执行）、政务公文/技术方案两套 Word 模板与批量采纳。

## 已知限制（详见 docs/DELIVERY.md）

- 未接入 `univer-workspace` 编辑器：公开 preset 的 Docs 正文 canvas 在本机实测空白，
  P0 改用 TipTap/ProseMirror 富文本 + 服务端权威段落块（ADR-001）。不宣称原生段落级 merge。
- P1/P2 已实现：引用 @ 定位、来源弹窗、定位高亮、provider 三选、Mermaid 图表（源码+渲染+版本绑定）、
  功能清单、ImpactPlan、政务/技术两套 Word 模板与批量采纳。
- 仍未做：图表服务端渲染/嵌入 DOCX、原型 HTML/React 预览、Dify/全站语义检索；多用户/账号/外部
  ACL/对外域名按交付形态要求不做。
- Codex 未安装，`CodexExecutionBackend` 仅保留接口与不可用探测，不声称已接入。
- Word 导出用 LibreOffice 引擎渲染校验；本机无 Microsoft Office/WPS，未做其原生人工检查。
- 真实模型依赖本机网关：凭据缺失时真实执行器显示“未配置”，模拟执行器（UI 标注“模拟”）仍可
  离线演示；模型调用默认 **60s 硬超时**（`YXWORKER_LLM_TIMEOUT_MS` 可覆盖），并有“模型超时 +
  30s”运行看门狗兜底，run 不会停留在 running；超时可见 `model_timeout`/`latencyMs`/`retryReason`。
- 真实与 Mock 的区分：Mock 提案在 UI 显示“模拟”徽章、`provider=mock`；真实模型提案显示 `DSH`
  与模型名（如 `deepseek-flash`），运行记录含 provider/model/latency/tokens。

阶段 0（仓库勘察）已完成并合并：勘察报告见 [docs/INVESTIGATION.md](docs/INVESTIGATION.md)，许可记录见 [docs/LICENSE_NOTES.md](docs/LICENSE_NOTES.md)。

