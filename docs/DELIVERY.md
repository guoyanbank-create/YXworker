# P0 交付与验收记录（YXworker）

> 交付形态：仅个人本机使用（`127.0.0.1` / `localhost`），单用户；不购买 Univer License，
> 不做多用户/多租户/账号体系/外部 ACL/对外域名发布。材料为脱敏或虚构演示数据。
> 验收口径：本机一条命令启动 + `docs/PRODUCT_SPEC.md` §11 的 8 条；默认 DSH provider，
> 不要求 Codex。

## 1. 启动与端口

```bash
pnpm install
pnpm start          # 首次自动构建；输出 http://127.0.0.1:8787
```

| 项 | 值 |
| --- | --- |
| 服务地址 | `http://127.0.0.1:8787`（API + 已构建前端） |
| 开发模式 | `pnpm dev`：后端 `127.0.0.1:8787`，前端 `http://127.0.0.1:5173` |
| 数据目录 | `.data/`（SQLite + WAL；`YXWORKER_DATA_DIR` 覆盖） |
| 模型凭据 | `~/.config/yxworker/credentials.env`（chmod 600，仅服务端读取） |
| 首次使用 | 启动自动写入演示项目「智惠导服智能问答优化」、4 章节文档与 2 份引用 |

## 2. 测试与验收证据

本机实测（2026-11-12，macOS arm64 / Node 24.21.0）：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | **96/96 通过**（10 个测试文件：domain 9 + backend 38 + engine 45 + run 看门狗 4） |
| `pnpm build` | 前端 Vite 构建 + 服务端 `tsc` 均通过 |
| `pnpm acceptance` | **§11 验收 29/29 通过**（真实网关；明细 `artifacts/acceptance/result.json`） |
| `pnpm verify:timeout` | **硬超时 7/7 通过**（悬挂网关被 3s 硬超时终止，run 不悬挂；`artifacts/timeout/result.json`） |
| `pnpm test:e2e` | UI 端到端（Playwright + 系统 Chrome，真实 dsh 生成）：见 **§2.1** |
| DOCX 渲染验证 | `scripts/verify-docx.mjs`：LibreOffice 引擎渲染 2 页 PDF/PNG，`missingFonts=2`（字体回退，不影响阅读） |

### 2.1 UI E2E 覆盖与截图

`pnpm test:e2e` 在临时数据目录启动真实服务端，使用系统 Chrome 完成：载入工作台 → 真实模型
生成 5 条建议 → 采纳 2 条 → 拒绝 1 条 → 继续讨论 1 条 → 定位待审段落并人工输入触发冲突
（禁止覆盖）→ 创建 V1.1 → 导出 Word → 故障演练 429。截图与结果写入 `artifacts/e2e/`，关键
截图同时归档到 `docs/evidence/`。

### 2.2 缺陷修复：真实模型调用可能悬挂（2026-11-12）

外部验证在一个**临时自检实例**（`127.0.0.1:8790`，其数据里是 Mock 生成的提案）上发现真实模型
run 可在 `running` 悬挂 3 分钟以上。排查与修复如下：

- 定位：`8790` 是前端自检期间启动的**临时实例**（临时数据目录，其提案 provenance 为
  `mock/mock-proposal-v1`），并非交付实例；同一 HEAD 的交付实例上真实模型已多次成功（19–38s，
  tokens>0）。排查同时确认了工程风险：**网络请求悬挂时必须对用户可见**，不能停留在 running。
- 关于“tokens/latency 一直为 0”：悬挂/已取消的 run 不会写入完成值；真实成功 run 会写入
  （证据：`latency=28001ms`、`tokens=1716/6201`；UI E2E 中 `latency=38502ms`、`tokens=1717/4249`）。
- 修复 1（provider 硬超时）：默认模型超时调整为 **60s**，可用 `YXWORKER_LLM_TIMEOUT_MS` 覆盖；
  超时映射为 run 的 `error.code=model_timeout`、写入 `latencyMs`，`retryReason=provider_timeout`。
- 修复 2（运行看门狗）：即使执行器 Promise 永不 settle，看门狗在“模型超时 + 30s”后强制把 run
  置为 failed(`model_timeout`)、写 `retryReason=watchdog_timeout` 并中止请求，**不可能长期停留在
  running**（`runService.scheduleRunWatchdog` + 4 条回归测试）。
- 修复 3（编辑器锚点）：TipTap splitBlock 会把 `paragraphId` 复制到新段落，已在前端
  `normalizeParagraphIds` 中去重重新分配，避免服务端锚点/冲突校验歧义。
- 证据：`pnpm verify:timeout` 用一个“只接受连接、永不响应”的网关复现，run 在 3.07s 内进入
  failed(model_timeout)、latencyMs=3007、事件链完整、不产生提案（`docs/evidence/timeout-verification.json`）。
- 真实模型证据（最终构建，交付实例 `pnpm start` @ 127.0.0.1:8787，非 Mock）：
  `backend=dsh provider=openai-compatible model=deepseek-flash`，`latency=21081ms`、
  `tokensIn/Out=1712/4461`；提案 id
  `prop_bf184acc38ad4b158c6b, prop_490ed2383ab24bba83bc, prop_22eeb32d59af42d289e6, prop_570ace11696a45029df0, prop_12c7887b240644bdbe2a`
  （完整 run/事件/提案见 `docs/evidence/real-model-run.json`；API 级验证明细见
  `docs/evidence/acceptance-result.json`，UI E2E 明细见 `docs/evidence/e2e-result.json`）。
- 真实/Mock 区分：UI 对 Mock 提案显示“模拟”徽章；`docs/evidence/` 中真实模型证据的
  `provider/model` 明确为 `openai-compatible/deepseek-flash`，Mock 为 `mock/mock-proposal-v1`。
  交付实例默认执行器为 DSH（真实网关），Mock 仅用于离线演示/故障演练。

## 3. §11 验收逐条对照

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 11.1 | 建立「智惠导服智能问答优化」项目与 4 章节 DOCX 方案（脱敏） | ✅ 通过 | 种子数据 4 章节；导出 DOCX 11,471 bytes；DOCX 作为引用回传提取 1,011 字 |
| 11.2 | 输入“引用历史方案与技术说明，第三章给出 5 条修改建议”；右侧建议卡片带依据与定位 | ✅ 通过 | 真实网关 `deepseek-flash`，19.2s，5 条全部定位第三章、均带引用；UI 卡片截图 |
| 11.3 | 采纳 2、拒绝 1、继续讨论 1、其余待审；只写入采纳内容 | ✅ 通过 | revision 1→3，仅两条采纳段落变化且等于 `newText`；拒绝不改；讨论只更新该条；其余 proposed |
| 11.4 | 审阅期间人工修改一段，旧提案 conflict 且禁止覆盖 | ✅ 通过 | 保存响应返回 conflicted 提案；再次采纳 409 `proposal_state_invalid`，revision 不变 |
| 11.5 | 生成 V1.1、查看 V1.0、回退、导出标准 Word 并检查 | ✅ 通过（检查方式受限） | V1.0/V1.1 版本；回退到 V1.0 文本完全一致；DOCX 可编辑、LibreOffice 渲染 2 页；**本机无 Office/WPS，未做其原生人工检查** |
| 11.6 | 真实模型请求可见；无 Codex 时 DSH+DeepSeek 仍产出提案（Codex 不要求） | ✅ 通过 | 交付实例真实 run：`openai-compatible/deepseek-flash`、21081ms、tokens 1712/4461、5 条提案（provenance 非 mock）；DSH 默认可用、Codex 探测不可用；Mock 兜底标注模拟 |
| 11.7 | 关闭模型/429/500/断网/违规外发：正确错误与阻断，不丢文档 | ✅ 通过 | 429→`model_rate_limited`、500/断网→`model_unavailable`、secret→403 `data_policy_blocked`；失败后 revision 与段落不变 |
| 11.8 | 测试结果、运行命令、已知限制、源码提交信息 | ✅ 通过 | 本文件、`pnpm test` 92/92、验收 27/27、PR 提交记录 |

## 4. 已知限制（如实说明）

1. **未接入 univer-workspace 编辑器**：公开 `@univerjs/presets@1.4.0` 的 Docs 正文 canvas 在本机
   实测空白（模型层有数据、渲染层不出内容；Sheet preset 正常）。P0 改用 TipTap/ProseMirror
   富文本 + 服务端权威段落块（详见 `docs/ARCHITECTURE.md` ADR-001）。不宣称原生段落级 merge。
2. **未实现 P1/P2 的图表、原型、功能清单、ImpactPlan、Dify 检索、公文模板批量操作**；
   多用户/账号/外部 ACL/对外域名按交付形态要求不做。
3. **Codex 未安装**：`CodexExecutionBackend` 仅保留接口与不可用探测（状态页可见），不声称已接入。
4. **Word 检查方式**：本机无 Microsoft Office/WPS，使用 DSH 随包 LibreOffice 引擎把导出的 DOCX
   渲染为 PDF/PNG 取证；不声称在 Office/WPS 中人工检查过。
5. **真实模型依赖本机网关**：`~/.config/yxworker/credentials.env` 缺失时真实执行器显示“未配置”，
   模拟执行器（UI 标注“模拟”）仍可离线演示；本机网关可用性与配额属于外部依赖。
6. **单机单进程 SQLite**：不支持多副本/多节点；数据目录需随备份策略自行保护。
7. **许可**：univer-workspace 源码 Apache-2.0、DSH MIT、LibreOffice Kit MPL-2.0（仅使用其
   渲染验证，不随产品分发）；本项目不依赖 Univer 商业 SDK（无 License 采购）。
