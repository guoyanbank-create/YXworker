# YXworker P0 API 契约（v1）

> 本文件是前后端、提案引擎与后端 API 的接口约定。服务端权威类型见
> `apps/server/src/types.ts`；前端在 `apps/web/src/api/types.ts` 保留同构副本。
> 所有路径前缀 `/api`，请求/响应均为 JSON（导出接口除外）。

## 0. 通用约定

- 成功：HTTP 200/201，直接返回资源对象或 `{ ... }` 包装（见各接口）。
- 失败：`{ "error": { "code": string, "message": string, "details"?: unknown } }`。
- 时间：ISO-8601 字符串；ID：`prj_/doc_/prop_/run_/ver_/ref_` 前缀 + 20 位随机串。
- 认证：无。仅监听 `127.0.0.1`，单用户本机使用（PRODUCT_SPEC §10 的 ACL 要求在本机单用户
  形态下降级为“服务端单一用户”，在交付文档中明确）。
- 模型密钥：只在服务端读取，任何响应/日志/数据库都不得出现密钥明文。

### 错误码

| code | HTTP | 说明 |
| --- | --- | --- |
| `not_found` | 404 | 资源不存在 |
| `invalid_json` | 400 | 请求体非法 JSON |
| `validation_error` | 400 | 参数校验失败（zod） |
| `revision_conflict` | 409 | 乐观锁 revision 不匹配（`details.currentRevision`） |
| `proposal_state_invalid` | 409 | 提案状态不允许该操作 |
| `proposal_conflicted` | 409 | 目标段落已变化，提案冲突，禁止覆盖 |
| `apply_validation_failed` | 422 | 采纳后的读回校验失败 |
| `credential_missing` | 400 | 所选提供方未配置凭据 |
| `data_policy_blocked` | 403 | 数据分级禁止发送到外部模型 |
| `model_rate_limited` | 429 | 模型返回 429 |
| `model_unavailable` | 502 | 模型 5xx/网络失败 |
| `model_timeout` | 504 | 模型超时 |
| `model_schema_invalid` | 502 | 模型输出经修复后仍不符合 Schema |
| `backend_unavailable` | 400 | 执行器不可用（如 Codex 未安装） |
| `fault_injected` | 按故障类型 | 仅当开启故障注入且请求显式携带 `fault` |

## 1. 状态与配置

### GET /api/health
`{ ok: true, app, version, time }`

### GET /api/status → StatusResponse（见 types.ts）
- `app.mockMode`：当前是否强制模拟（`YXWORKER_MOCK_ONLY=1`）。
- `providers[]`：远端模型提供方是否已配置、可用档位；不得返回密钥或完整 baseUrl（返回 host 可省略）。
- `backends[]`：`dsh`（默认，真实模型网关）、`mock`（模拟，UI 必须标注“模拟”）、`codex`（本机未安装 → unavailable）。
- `faultInjectionEnabled`：是否允许演示故障注入。
- `dataPolicy`：数据分级策略。

## 2. 项目

### GET /api/projects → `{ projects: Project[] }`
### POST /api/projects `{ name, description?, dataLevel? }` → `201 { project: Project }`
- 创建项目时自动创建一份空白文档（标题 `<name> 方案（V1.0）`，revision=1），并创建 V1.0 版本。
- `dataLevel` 默认 `internal`。

### GET /api/projects/:id → `{ project: Project, document: DocumentSummary }`
### PATCH /api/projects/:id `{ name?, description?, dataLevel? }` → `{ project: Project }`
- 仅用于本机 P0 的数据分级演示（`secret` 时真实模型调用被 `data_policy_blocked` 阻断）。
### GET /api/projects/:id/runs?limit=20 → `{ runs: Run[] }`（按创建时间倒序）

## 3. 文档与自动保存

### GET /api/documents/:id → `{ document: Document }`
- `contentJson` 为 TipTap/ProseMirror JSON；`paragraphs` 为服务端派生的段落块（含 hash、章节信息）。
- 前端只读展示/编辑均以此为准；`revision` 用于乐观锁。

### PUT /api/documents/:id/content
请求：`{ contentJson: object, baseRevision: number, actor?: string }`
响应：`{ document: Document, conflictedProposals: Proposal[] }`

规则：
1. `baseRevision !== 当前 revision` → `409 revision_conflict`（`details.currentRevision`）。前端应
   重新拉取文档后再合并（P0 单用户，冲突时前端提示并刷新，不自动覆盖）。
2. 保存成功后 `revision + 1`，重新派生段落块。
3. 对比旧/新段落块：若某条 `proposed`/`revised` 提案的目标段落文本 hash 变化 → 该提案转
   `conflicted`（记录 `conflictReason`、写 proposal_event），并在响应中返回。这是“审阅期间人工
   修改导致旧提案冲突”的实现。
4. contentJson 必须是 `{ type: "doc", content: [...] }`，段落节点必须带 `paragraphId`（缺失时服务端
   以 `auto_<index>` 兜底，但前端编辑器必须为新块生成 `paragraphId`）。
5. 每次保存写入 audit 到 `documents.updated_at`；不自动生成命名版本。

## 4. 提案（审阅）

### GET /api/proposals/:id → `{ proposal: Proposal }`
### GET /api/documents/:id/proposals → `{ proposals: Proposal[] }`
按创建时间升序。UI 展示卡片：范围/删除-新增对比/原因/引用/操作按钮。

### POST /api/documents/:id/proposals/generate
请求：
```json
{
  "prompt": "引用历史方案与技术说明，第三章给出 5 条修改建议；仅出建议",
  "tier": "draft|review|long_reasoning（默认 review）",
  "backend": "dsh|mock（默认 dsh，即真实模型网关；未配置凭据时返回 credential_missing）",
  "count": 5,
  "fault": "rate_limit|server_error|network|timeout|data_policy（可选，仅演示）"
}
```
响应：`202 { run: Run }`（异步执行；前端轮询 `GET /api/runs/:id`，状态 `succeeded` 后拉取提案与文档）

规则：
1. 创建 Run（`type=proposal_generation`），执行器负责调用 provider；事件与耗时/用量写入 Run。
2. provider 输出必须经服务端 zod/JSON-Schema 校验：每条提案含目标段落 id、oldText、newText、
   reason、citations。`oldText` 必须与当前段落文本完全一致，`paragraphId` 必须存在于文档。
   不合法时进行一次“修复重试”（把错误回给模型要求只输出合法 JSON），仍失败则 `model_schema_invalid`。
3. `citations[]` 中 `referenceId` 必须属于本项目引用；`locator`/`excerpt` 来自引用正文可见片段。
4. 生成只读：不修改文档；提案初始状态 `proposed`，记录 `baseRevision`、`baseHash`、model/provider/backend/tier、runId。
5. `secret` 级项目调用外部 provider → `403 data_policy_blocked`（不创建 Run 或 Run 标 failed）。
6. `fault` 仅在 `faultInjectionEnabled` 时生效，用于验收 §11.7 的错误分流演示。

### POST /api/proposals/:id/accept
请求：`{ reviewer?: string }`
响应：`{ proposal: Proposal, document: Document }`

规则（对应 PRODUCT_SPEC §5）：
1. 仅 `proposed`/`revised` 可采纳；否则 `409 proposal_state_invalid`。
2. 目标段落当前 hash 与 `baseHash` 不一致 → 标记 `conflicted` 并 `409 proposal_conflicted`
   （禁止覆盖；`details.proposal` 返回最新提案）。
3. 若仅全局 revision 变化、目标段落原文 hash 未变 → 安全重基（更新 `baseRevision`）后继续。
4. 服务端把 `newText` 写入文档 JSON（保留块类型/层级），revision+1，再**读回校验**：
   只有目标段落文本变化且等于 `newText`（`validateSingleParagraphChange`），否则回滚并
   `422 apply_validation_failed`。
5. 成功：提案 → `accepted`，记录 reviewer/decidedAt/事件；返回最新 Document 供前端 `setContent`。
6. 事务化：文档、提案、事件、版本审计同事务提交。

### POST /api/proposals/:id/reject
请求：`{ reviewer?: string, note?: string }` → `{ proposal: Proposal }`
- 仅 `proposed`/`revised` 可拒绝；文档不变；状态 `rejected`。

### POST /api/proposals/:id/discuss
请求：`{ message: string, tier?: string, fault?: string }`
响应：`202 { run: Run }`（异步执行；完成后用 `GET /api/proposals/:id` 刷新该条提案）
- 只更新该条提案（`newText`/`reason` 可变化，`discussionCount+1`，状态 → `revised`）；
  不改文档、不影响其它提案（对应 §4“继续讨论只更新该条”）。
- 真实 provider 返回结构化 JSON；解析失败按 generate 的重试/错误规则处理。

## 5. 版本与导出

### GET /api/documents/:id/versions → `{ versions: Version[] }`（升序）
### POST /api/documents/:id/versions `{ name: string }` → `201 { version: Version }`
- 版本名唯一（如 `V1.1`），保存当前 revision 的内容快照。
### POST /api/versions/:id/restore → `{ document: Document }`
- 以该版本内容生成**新 revision**（不删除历史）；`versions.revision` 指向当时 revision。
### GET /api/documents/:id/export.docx?versionId=... → DOCX 二进制
- `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `Content-Disposition: attachment; filename="<title>.docx"`
- 不传 versionId 时导出当前文档；无版本时仍可导出。

## 6. 引用资料

### GET /api/projects/:id/references → `{ references: Reference[] }`
### POST /api/projects/:id/references（multipart/form-data，字段 `file`）→ `201 { reference: Reference }`
- 支持 `.docx`（mammoth 提取纯文本）、`.md`、`.txt`；大小上限 10MB；标题默认取文件名（不含扩展名）。
- 只保存提取后的纯文本与摘要；不保存二进制；不使用未授权材料。

## 7. 运行记录

### GET /api/runs/:id → `{ run: Run }`
### POST /api/runs/:id/cancel → `{ run: Run }`
- 仅 `queued/running` 可取消；模拟执行器立即取消，真实 execution 在下一个事件边界响应。
- 前端轮询 `GET /api/runs/:id` 展示运行过程（Running 时 300–500ms 一次）。

## 8. 前端轮询/保存时序（约定）

1. 载入：`GET /projects` → `GET /projects/:id` → `GET /documents/:id` → `GET /documents/:id/proposals`。
2. 编辑防抖 800ms：`PUT /documents/:id/content`；保存状态在顶部展示（保存中/已保存/保存失败）。
3. 生成：禁用按钮 → `POST .../proposals/generate`（202 返回 run）→ 300–500ms 轮询 `GET /api/runs/:id` 直到 succeeded/failed → 刷新提案。
4. 采纳：先 flush 自动保存 → accept → 用返回的 `document.contentJson` 覆盖编辑器内容 → 刷新提案列表。
5. 冲突：accept 返回 409 `proposal_conflicted` → 刷新提案与文档，卡片标记冲突。

## 9. 真实模型要求（本机凭据）

- 默认 `backend=dsh`：使用本机 `~/.config/yxworker/credentials.env` 中的 OpenAI 兼容网关
  （`YXWORKER_LLM_BASE_URL` / `YXWORKER_LLM_API_KEY`）。密钥仅服务端持有。
- 该网关实测支持 `json_object`，**不支持 `json_schema`**：提案请求必须用
  `response_format: { type: "json_object" }`，由服务端 zod 校验 + 一次修复重试。
- 逻辑档位映射：`draft/review → YXWORKER_TIER_REVIEW`，`long_reasoning → YXWORKER_TIER_LONG_REASONING`。
- 超时默认 60s（`YXWORKER_LLM_TIMEOUT_MS` 可覆盖）；429/5xx/网络/超时分别映射为
  `model_rate_limited` / `model_unavailable` / `model_timeout`，另由看门狗兜底（模型超时+30s），
  保证 run 不会停留在 running；
  仅对只读阶段（生成/讨论）做有限重试，不做跨提供方自动上传。
- `backend=mock` 为离线模拟执行器：确定性地产生 5 条提案用于本地演示/测试，UI 必须显示“模拟”。

---

# P1/P2 扩展契约（v1.1）

> P0 契约（上文）保持不变；本节为 P1/P2 新增/扩展。字段类型见 `apps/server/src/types.ts`。

## P1-1 引用资料定位（@ 章节/段落、locator + excerpt、来源打开）

- 上传引用时服务端用 `domain/referenceSections.ts` 自动切分小节/段落并写入 `reference_sections`。
- `GET /api/projects/:id/references` → `{ references: Reference[] }`（Reference 增加可选 `sectionCount`）。
- `GET /api/projects/:id/references/locators?q=&limit=20` → `{ results: ReferenceLocatorResult[] }`
  （跨本项目全部引用检索；返回 `referenceId/referenceTitle/sectionId/locator/excerpt`）。
- `GET /api/projects/:id/references/:refId/sections` → `{ reference, sections: ReferenceSection[] }`
  （按 `paragraphIndex` 升序；用于 @ 选择器与来源弹窗）。
- `GET /api/projects/:id/references/:refId/sections/:sectionId` → `{ reference, section }`
  （“卡片可点开来源”用；404 `not_found`）。

## P1-2 批注定位闭环

- 服务端无需新接口：Proposal 已含 `paragraphId/paragraphIndex/quote/chapterTitle`；
  前端“定位”用 `paragraphId` 在编辑器 `data-paragraph-id` 中查找并高亮选中范围；
  找不到（段落被删除/重建）时按 `paragraphIndex`/`quote` 文本兜底定位并给出“段落已变化”提示。
- 冲突项（`status=conflicted`）定位到当前文档中对应段落（或兜底位置），高亮 conflict 样式。

## P1-3 Provider 三选切换 / 故障与超时可见

- `POST /api/documents/:id/proposals/generate` 与 `POST /api/proposals/:id/discuss` 新增可选：
  - `provider?: 'openai-compatible' | 'deepseek-anthropic' | 'mock'`：选择模型提供方；不传用
    `GET /api/status.current.providerId` 默认值；`backend=mock` 强制 mock provider。
  - `referenceIds?: string[]`、`referenceSectionIds?: string[]`：只把指定引用/小节注入提示词；
    必须属于本项目，否则 400 `validation_error`。
- `ProviderStatus` 增加可选 `current: boolean`；`StatusResponse` 增加：
  ```json
  "current": {
    "backend": "dsh|mock",
    "providerId": "openai-compatible|deepseek-anthropic|mock",
    "providerLabel": "...",
    "providerKind": "...",
    "model": "deepseek-flash",
    "modelTimeoutMs": 60000,
    "watchdogTimeoutMs": 90000,
    "realModelConfigured": true
  }
  ```
- 故障演练：fault ∈ `rate_limit | server_error | network | timeout | data_policy`（现有注入已支持
  timeout；UI 五个按钮分别展示 `model_rate_limited / model_unavailable / model_timeout /
  data_policy_blocked`）。
- 运行记录（Run）必须体现所选 provider 与模型；Mock 运行/提案 UI 标注“模拟”。

## P1-4 Codex 边界

- 保持 `CodexExecutionBackend` 仅探测；`/api/status.backends` 中 codex 不可用并给出原因；
  DSH fallback 的能力边界写入 `docs/DELIVERY.md`（不调开发机 shell、不提供 Codex 终端能力、
  模型层可切换 provider）。

## P2-5 Mermaid 图表（源码 + 渲染预览 + 版本绑定）

- `GET /api/projects/:id/diagrams` → `{ diagrams: Diagram[] }`（按 updatedAt 倒序）。
- `POST /api/projects/:id/diagrams` `{ title, kind?, source, description?, chapterRef?, versionId? }`
  → `201 { diagram }`；默认绑定当前文档 `revision`（`versionName=null` 表示当前工作版本），
  传 `versionId` 则绑定该命名版本的 `revision + name`。
- `GET /api/diagrams/:id` → `{ diagram }`
- `PUT /api/diagrams/:id` `{ title?, kind?, source?, description?, chapterRef?, versionId? }`
  → `{ diagram }`；更新内容默认重新绑定当前 revision。
- `POST /api/diagrams/:id/bind` `{ versionId }` → `{ diagram }`（显式绑定命名版本）
- `DELETE /api/diagrams/:id` → `204`
- 图表 `kind` ∈ `flowchart | architecture | sequence | class | state`；渲染在浏览器（mermaid 包），
  服务端只保存源码，不执行/不信任渲染结果。

## P2-6 功能清单（FeatureSpec）

- `GET /api/projects/:id/features` → `{ features: FeatureSpec[] }`
- `POST /api/projects/:id/features` `{ title, description?, status?, priority?, chapterRef?, diagramId? }`
  → `201 { feature }`；status ∈ `planned|in_progress|done|dropped`，priority ∈ `P0|P1|P2`。
- `PATCH /api/features/:id` → `{ feature }`；`DELETE /api/features/:id` → `204`。

## P2-7 ImpactPlan（先展示影响再逐项执行）

- `POST /api/documents/:id/impact-plan` `{ proposalIds?: string[], trigger?: string }`
  → `201 { plan: ImpactPlan }`
  - chapters：提案目标段落所在章节（按 `document.paragraphs.chapterIndex/chapterTitle` 聚合）。
  - diagrams：`diagram.chapterRef` 命中受影响章节标题，或 `diagram.documentRevision < document.revision`
    （绑定版本落后，需同步）。
  - featureSpecs：`feature.chapterRef` 命中受影响章节，或 `feature.diagramId` 命中受影响图表。
  - proposals：本次纳入计划的提案快照（默认=document 下所有 proposed/revised）。
- `GET /api/impact-plans/:id` → `{ plan }`
- `POST /api/impact-plans/:id/execute` `{ proposalIds?: string[] }`
  → `{ plan, batch: BatchAcceptResult }`；执行=批量采纳，逐条失败不影响其余；成功后 `executedAt`。

## P2-8 批量采纳与公文模板

- `POST /api/documents/:id/proposals/batch-accept` `{ ids: string[], reviewer? }`
  → `{ results: BatchAcceptItemResult[], document }`；逐条服务端校验/写入，单条 409/422 记录
  `error` 不抛出；整体仍返回最新文档。
- `GET /api/templates` → `{ templates: DocumentTemplateInfo[] }`（`gov` 政务公文 / `tech` 技术方案）。
- `GET /api/documents/:id/export.docx?versionId=&template=gov|tech`；默认 `tech`。模板只影响
  Word 版式/字体/标题样式，不改正文内容。
