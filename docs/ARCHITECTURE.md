# 架构与关键决策（P0）

> 交付形态（2026-11-12 用户补充）：**仅个人本机使用，不购买 Univer License**。部署目标
> `127.0.0.1`/`localhost`；不做多用户、多租户、账号体系、外部 ACL、对外域名发布，
> 对应的 P1/P2 事项一律不做。数据只用脱敏或虚构材料。验收为“本机一条命令启动 + 走完
> `docs/PRODUCT_SPEC.md` §11 的 8 条”，默认 DSH provider，不要求 Codex。

## 1. 形态

单仓库 pnpm workspace：

```
apps/server    Node 24 + Express 5 + node:sqlite（同一端口提供 API 与构建后的 Web）
apps/web       React 19 + Vite + TipTap/ProseMirror 富文本编辑器
scripts/       E2E、截图、DOCX 渲染验证脚本
```

一条命令启动（P0 本机交付）：

```bash
pnpm install && pnpm build && pnpm start   # http://127.0.0.1:8787
```

模型凭据仅服务端读取：`~/.config/yxworker/credentials.env`（或 `YXWORKER_CREDENTIALS_FILE`），
不写入仓库/日志/数据库明文/前端。

## 2. 为什么 P0 未直接嵌入 univer-workspace 编辑器（ADR-001）

阶段 0 报告（PR #2）建议「univer-workspace Server 唯一可信源 + DSH 插件宿主」。P0 落地时
按用户补充的交付形态（仅本机、不购买 License）与可交付性做了如下取舍，**这是一次显式的
技术选型，不是遗漏**：

1. **许可**：univer-workspace 的商业 License 风险主要来自自有域名/对外生产部署；本机单用户
   形态可用其开源部分。但用户明确不购买 License，且要求不做对外域名发布。
2. **实测阻断**：本机用公开 npm 的 `@univerjs/presets@1.4.0` + `@univerjs/preset-docs-core@1.4.0`
   搭了最小 Docs 编辑器（Apache-2.0），**文档正文 canvas 始终为空白**：模型层
   `getParagraphs()` 有正确数据，但渲染层不出内容（headless/headed Chrome、带 COOP/COEP
   头、延迟创建、traditional/modern 两种文档风味均复现）；同环境 Sheet preset 正常渲染。
   证据保留在勘察记录中，未把该缺陷带入交付路径。
3. **复杂度**：univer-workspace Server 的内容读写需经 Worktree changeset / `uvw` 子进程，
   且上游无段落级 selective merge；业务层（提案/逐条审阅/冲突/版本）是本产品真正的缺口，
   在单一可信源原则下先自建业务层更可控。
4. **P0 结论**：文档正文采用「TipTap/ProseMirror JSON + 服务端权威段落块派生」的模型，
   Office 式富文本编辑（标题/正文/列表/引用/对齐）+ 逐条建议 + Word 导出在本机可运行、可测试。
   `DocumentStore` 边界保持独立，后续若引入 Workspace Server，可替换持久化与编辑器接入层。
   **不得**对外声称已接入 univer-workspace 编辑器或原生段落级 merge。

## 3. 数据与权威源

- `documents.content_json`（TipTap JSON）是正文唯一可信源；`revision` 单调递增。
- 服务端从 JSON 派生 `paragraphs`（id/文本/hash/章节），用于提案锚点、hash 冲突校验、
  单段落补丁读回校验与 DOCX 导出。
- `proposals` 状态机：`proposed → accepted | rejected | revised | conflicted`；`revised` 可再
  采纳/拒绝/冲突。每次状态变更写 `proposal_events`（审阅人/时间/原因/来源/模型/runId）。
- 采纳采用服务端权威写入：校验 baseHash/baseRevision → 安全重基 → 写入 → 重新派生块并
  校验“仅目标段落变化且等于新文本” → 事务提交。前端用返回的 JSON 覆盖编辑器内容。
- 版本：命名版本保存 revision+JSON 快照；回退生成新 revision，不删历史。
- 引用：上传 `.docx/.md/.txt` 提取纯文本（mammoth），提案引用需带 `referenceId/locator/excerpt`。

## 4. 执行器与模型层（PRODUCT_SPEC §3）

- `ExecutionBackend` 接口：`start/stream/cancel/resume/capabilities`（`apps/server/src/runtime`）。
- `DSHExecutionBackend`：**默认路径**。本机 P0 形态下实现为“最小受控执行器”：服务端直接
  调用已配置的 OpenAI 兼容网关完成生成/讨论，不调用开发机 shell，不冒充 Codex 终端能力。
- `MockExecutionBackend`：仅用于离线测试与本机演示，UI/运行记录明确标注“模拟”。
- `CodexExecutionBackend`：仅做可用性探测（本机无 `codex`/`~/.codex`），不可用时不参与默认路径。
- `LLM Provider`：`openai-compatible`（默认网关，json_object + 服务端 zod 校验 + 一次修复重试）、
  `deepseek-anthropic`（官方端点可选）、`mock`。档位：`draft/review/long_reasoning` 由服务端映射。
- 安全重试：仅生成/讨论（只读）可重试；不回传密钥；429/5xx/网络/超时分别映射错误码。
- 数据分级：`secret` 一律不发送外部网关（403 `data_policy_blocked`）。

## 5. 交付边界（P0）

- 单用户、本机、无认证；不做多租户/ACL/账号/对外域名（按用户补充说明）。
- 图表/原型/功能清单/ImpactPlan/Dify 检索等 P1/P2 项不做，仅在报告列明。
- 不虚报外部能力：Codex 未安装标“不可用/待验证”；真实模型验证结果以本机实际请求为准。
