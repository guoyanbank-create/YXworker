# 阶段 0 勘察报告：univer-workspace 与 DSH 底座

> 需求源：`docs/PRODUCT_SPEC.md`（§2、§3、§5、§9、§10、§12）；路线：`docs/ROADMAP.md`。
> 勘察日期：2026-11-12。阶段 0 只做只读勘察与最小可复现冒烟，**未写业务代码**；未修改上游仓库。
> 证据标记：✅ 本次实测或代码/文档直接证据；🟡 需要扩展/自建；🔴 缺授权；⛔ 不可行；❓ 待验证。
> 文中 `file:line` 若未特别说明，均相对 `dream-num/univer-workspace@0f5f018` 或 `deepseek-ai/deepseek-harness@e8f7b93`。

## 0. 结论摘要

1. **底座可用，且本机已验证**：univer-workspace Server 依赖安装、启动、OpenAPI 探测均成功（127.0.0.1:3020，`/openapi.yaml` 200）；Browser / Server / CLI / MCP / Worktree / 原生评论 / 版本历史 / DOCX 导入导出均为上游已有能力。未发现“必须自研 Office 编辑器”的阻断。
2. **核心缺口不在编辑器，而在业务层**：上游没有 `ChangeProposal` 产品模型，没有“建议卡片 / 逐条采纳、拒绝、继续讨论”，也没有段落级 selective merge。P0 必须自建提案/审阅编排，**只把采纳内容写入 draft Worktree，最后 merge 一次**，不得对外宣称原生逐条 merge。
3. **文档权威源可行**：Workspace Server 的产品数据 + Collaboration 数据 + Blob 一套单进程（Express + SQLite + 本地目录）即唯一可信源；正文读写产品 API 不直接暴露，需经 Worktree changeset 或已发布 `univer-workspace-cli@0.6.0` 子进程受控执行并 read-back。
4. **DSH 适合作 Agent Runtime 与单页宿主**：本机已装 `0.2.2-rc.1`（MIT），并有官方 DSH 插件形态的 Space 插件先例（目标同为 0.2.2-rc.1）；但 DSH 是 pre-stable API、Web 单 owner、无文档级 Worktree，需精确 pin 版本并自建档位路由/可观测字段。
5. **许可是最硬的生产阻断**：仓库源码 Apache-2.0，但 Collaboration / Exchange / AI 等商业 SDK 属商业授权；内置开发凭据只授权 `localhost/app/127.0.0.1`，2027-02-03 到期；免费档仅 1 个协同节点、3 个编辑连接、每月 10 次导出。**自有域名/对外生产部署需采购 Univer Business 或 Enterprise License**，须由用户决策，详见 `docs/LICENSE_NOTES.md`。
6. **外部阻断**：本机无 Codex（无 `codex` 二进制、无 `~/.codex`），`CodexExecutionBackend` 当前不可用；DeepSeek/OpenAI API key 未配置（DSH 账户登录可用，但不等同于可复用的服务端 API key）。以上一律标“待验证”，不得以模拟冒充当“已接入”。

## 1. 勘察对象与版本基线

| 项 | 值 | 证据 |
| --- | --- | --- |
| univer-workspace | `dream-num/univer-workspace`，commit `0f5f0181ebafef6010667dfb8691db6559422089`（2026-11-11，`main`），**Apache-2.0** | `git clone` + `git rev-parse HEAD`；`LICENSE` |
| 仓库要求 | Node `>=24`，包管理器 `pnpm@11.24.0`；单进程 Express + SQLite + 本地 Blob | `package.json:38-41`；`apps/workspace/docs/architecture.md:1-24,206-214` |
| Univer SDK 基线 | `@univerjs/*`、`@univer-cli/*`、`@univerjs-pro/*` 统一精确 `1.4.0`；例外 `@univerjs-labs/* = 1.0.0-dev.0529939d`、`@univerjs/icons 1.38.0` | `apps/workspace/package.json`、`apps/cli/package.json`、`AGENTS.md:75-90` |
| CLI | npm `univer-workspace-cli@0.6.0`（`uvw` 同一程序），本机 `pnpm dlx` 安装成功 | `apps/cli/package.json`；实测 |
| 产品 HTTP 契约 | OpenAPI 3.1.2，`openapi.yaml` 共 92 个 path（认证、Spaces、Nodes、Resources、Blobs、Views、Trash、Permissions、Issues、Worktrees） | `apps/workspace/contracts/http/openapi.yaml` |
| 依赖来源 | 4 个 Univer scope 指向私有 registry `insider-npm-registry.univer.work` | `.npmrc:1-4` |
| DSH（本机） | `@deepseek-ai/dsh` **0.2.2-rc.1**（npm `latest`，2026-11-04 发布），**MIT**；本机 DSH 正在运行（本会话即由 DSH 驱动） | `node_modules/@deepseek-ai/dsh/package.json`；`dsh --version` |
| DSH（公开仓库） | `deepseek-ai/deepseek-harness`，master `e8f7b93`（2026-11-11，package version `0.2.2-rc.2`），MIT | `git log -1`；`LICENSE` |
| DSH 版本分叉 | univer Workspace Agent pin `0.1.5-rc.1`；univer Space 插件 pin `0.2.2-rc.1`；公开仓库 master `0.2.2-rc.2` | `apps/agent/package.json:54-80`；`apps/space-plugin/package.json:49-61` |
| 本机环境 | macOS 27 (arm64)、Node 24.21.0、全局 pnpm 12.18.0（安装时自动切换 11.24.0）、Docker 29.7.2 | 实测 |

## 2. 能力矩阵（“已有 / 需要扩展 / 缺授权 / 不可行”）

### 2.1 文档、协同与导出版

| # | 能力 | 上游现状与关键证据 | 结论 | P0 处置 |
| --- | --- | --- | --- | --- |
| 1 | Office 式编辑（Doc/Sheet/Slide/Base/Board/PDF） | Workspace Browser，五类 Unit + PDF；编辑器模块 `apps/workspace/web/src/features/editor/units/*` | ✅ 已有 | 直接复用 |
| 2 | Server 唯一可信源（身份/ACL/Space/Node/Resource/Blob） | 产品 OpenAPI 92 path；Server 解析权限；无外部 DB/Redis/S3 | ✅ 已有 | 直接复用，单进程部署 |
| 3 | 原生评论（Thread Comment） | Doc 文本范围锚点 `startOffset/endOffset/segmentId`、`doc-text-range`；可回复/Resolve | ✅ 已有 | 仅作展示锚点，不用评论文本执行修改 |
| 4 | 评论关联 proposalId、审阅状态 | 评论无自定义元数据；本体全局共享、只有 anchor 随 Unit 分支/合并 | 🟡 需要扩展 | 自建 proposalId↔threadId 映射与状态机 |
| 5 | 版本历史（查看/回退） | Trunk 五类 Unit 的标准 History UI + `/universer-api/history/*`；恢复=一次 changeset | ✅ 已有 | 直接用 |
| 6 | 命名版本 V1.0 / V1.1 | 无命名版本产品模型，只有 revision | 🟡 需要扩展 | 自建 revision↔版本名映射表 |
| 7 | DOCX 导入 | `@univerjs-pro/exchange-node`；导入不计导出配额；Trunk scope | ✅ 已有（需 license） | 直接用 |
| 8 | DOCX 导出（可编辑） | Exchange 导出；仅 Trunk 可导，Worktree/Merge Preview 不注册 Exchange；免费档 10 次/月 | ✅ 已有 / 🔴 生产受配额 | 先 merge 再 export；做配额与失败预警 |
| 9 | 服务端正文读写 | 产品 API 无通用“读/写正文”端点；写入走 `POST /api/worktrees/{id}/units/{unitId}/changesets`（Univer mutations）或 CLI | 🟡 需要扩展 | 用已发布 CLI 子进程（`uvw execute/inspect`）或自建 content worker，每次 read-back |

### 2.2 Worktree 与审阅

| # | 能力 | 上游现状与关键证据 | 结论 | P0 处置 |
| --- | --- | --- | --- | --- |
| 10 | Worktree 全流程 | `POST /api/worktrees`、`.../units`、`.../ready`、`.../reopen`、`.../merge`、`.../discard`；状态 `draft→ready→merging→merged`，per-Unit `mergeResult` | ✅ 已有 | 直接复用 |
| 11 | 结构化双栏对比 | `@univer/unit-comparison-viewer` + `/universer-api/worktrees/{id}/units/{unitId}/comparison` | ✅ 已有 | 直接复用（审阅面板） |
| 12 | 段落级 / 逐条 selective merge | `POST /api/worktrees/{id}/merge` 无请求体、无 Unit/段落选择参数，粒度=文档（Unit）；无 accept hunk/proposal 接口 | ⛔ 原生不可行 | 业务级逐条 patch，只写采纳内容，最后**一次** merge；不得虚报 |
| 13 | 建议卡片 / 采纳 / 拒绝 / 继续讨论 | 上游无产品模型；`apps/space-plugin` 有进程内 Proposal 生命周期（draft worktree→comparison→apply/reject，含 conflict/uncertain），不持久化、按整篇操作 | 🟡 需要扩展 | 自建提案库、卡片 UI、逐条编排；参考 Space 插件数据流 |
| 14 | 提案级冲突检测/安全重基 | Worktree merge 冲突会阻断 Merge；但没有 proposal 级 quote/hash/revision 校验 | 🟡 需要扩展 | 自建 anchor+quote+hash+revision 校验与 conflict 状态 |

### 2.3 Agent、CLI、MCP 与运行时

| # | 能力 | 上游现状与关键证据 | 结论 | P0 处置 |
| --- | --- | --- | --- | --- |
| 15 | Workspace Agent（DSH 0.1.5-rc.1 本地应用） | 源码构建、不发布 npm；单用户单活动账号；OAuth+PKCE 连 Workspace；对话+Worktree 审阅 | ⛔ 不可直接作产品前端 | 参考其交互与数据流 |
| 16 | DSH 运行时（agent loop/session/tools/审批/沙箱/持久化） | `@deepseek-ai/dsh* 0.2.2-rc.1`，MIT；SDK JSON-RPC 无 cancel，ACP 有 cancel/resume/模型选择/MCP | ✅ 已有 | P0/P1 作单页宿主与 ExecutionBackend |
| 17 | DSH 单页插件应用形态 | univer Space 插件（`dsh-space-plugin@0.18.4-preview.1`，目标 0.2.2-rc.1）在 DSH 内提供 Space 导航 + 可编辑 Univer Doc/Sheet + 浮动 AI 对话 + Worktree 审阅 | ✅ 已有先例 | **推荐**：在 DSH 插件内扩展 YXworker 单页 |
| 18 | 逻辑档位 draft/review/long_reasoning → 模型路由 | DSH 只有部署默认 + 每 Session `agent.model.select`，无档位概念 | 🟡 需要扩展 | 服务端实现 tier→provider/model/effort 映射，前端只发档位 |
| 19 | CLI 自动化（`uvw`） | npm 0.6.0；`auth login`/`--complete`；`worktree/pr`、`unit execute/inspect`、`import/export`、`--json`、`--worktree` | ✅ 已有 | 服务端子进程集成，受控执行 + read-back |
| 20 | MCP（外部 agent 接入） | `/mcp` Streamable HTTP；toolsets `core`(31)/`files`(13)/`admin`(10)/`all`；scopes `read/write/publish/worktree:merge`；执行层仅白名单且 Stage G（多租户隔离）已搁置 | 🟡 已有但受限 | 只作加速通道，不作交付依赖 |
| 21 | CodexExecutionBackend | 本机无 `codex` 二进制、无 `~/.codex`；仓库 rc.2 有 `dsh-subagent-codex` 但本机未装 | ⛔ 当前不可行 | 标“待验证”，不得报“已接入” |
| 22 | DSHExecutionBackend（业务级 fallback） | DSH 自带 agent loop/tools/审批/沙箱/Session 持久化/ACP；缺可用模型 key 时只能离线 | ✅ 运行时已有 / ❓ 凭据待验证 | P1 实现；明确“非 Codex 等价”，换模型≠换 Runtime |

### 2.4 许可与部署

| # | 能力 | 上游现状与关键证据 | 结论 | P0 处置 |
| --- | --- | --- | --- | --- |
| 23 | 商业 SDK 生产授权 | 一份 License 覆盖 Web/Collab/Exchange；Business `$99/月`或 `$1,000/年`（25+ 连接、5,000+ 导出/月、1 主域名）；Enterprise 定制 | 🔴 缺授权（对外生产） | 由用户采购/决策；见 LICENSE_NOTES |
| 24 | 内置 runtime 开发凭据 | 授权域 `localhost/app/127.0.0.1`，2026-11-03 签发、**2027-02-03 到期**；每 90 天轮换；不是软件许可证 | 🔴 仅本地开发可用 | 仅本机演示；过期/换域名前必须换正式 License |
| 25 | 免费档行为 | 无 license pair 时：1 协同节点、3 编辑连接、10 导出/月；浏览器域名不符协同 403(9018) | 🔴 容量受限 | 开发/评估可用，不能当生产容量 |
| 26 | 多用户 / 多租户 | DSH Web 单 owner（Cookie 单浏览器会话）；Workspace 支持 Team Space/ACL 但没有“每个终端用户一个 DSH” | ⛔ 不可行（单实例多租户） | YXworker 自建用户/权限，或每用户独立实例 |
| 27 | 多副本 / 多节点部署 | 单进程 + SQLite 单写者；多节点需商业多节点 License | 🟡/🔴 受许可+架构限制 | P0 单进程部署并显式声明限制 |

## 3. 关键接口速查（P0 直接使用）

**Server（产品 OpenAPI，认证后 `/api/**`）**

| 用途 | 接口 |
| --- | --- |
| 新建文档 | `POST /api/resources`（`kind:"univer"`、`unitType`、可选 `initialData`、幂等键） |
| 打开 / 权限 / 编辑器模式 | `POST /api/resources/{id}/open`、`GET /api/unit-resources/{unitId}` |
| 目录树/回收站 | `GET/POST /api/nodes`、`PATCH /api/nodes/{id}`、`.../trash` |
| Worktree | `POST /api/worktrees`、`POST /api/worktrees/{id}/units`、`POST .../units/{unitId}/changesets`、`POST .../ready`、`POST .../reopen`、`POST .../merge`、`POST .../discard` |
| 审阅数据 | `/universer-api/worktrees/{worktreeId}/units/{unitId}/comparison?view=draft|preview|merged`（内部契约，非产品 OpenAPI） |
| 评论/历史/协同快照 | `/universer-api/comment/*`、`/universer-api/history/*`、`/universer-api/snapshot/*`、`WS /universer-api/comb/connect`（内部协议） |
| 文档/OAS | `http://127.0.0.1:3020/api-docs`、`/openapi.yaml`（实测 200） |

**CLI（npm `univer-workspace-cli@0.6.0`）**：`uvw auth login`（打印一次性 URL+验证码，用户批准后 `uvw auth login --complete`）；`uvw worktree|pr ...`；`uvw unit execute --worktree`、`uvw inspect`、`uvw import/export`、`uvw compile-markdown/export-markdown`；`--json` 结构化输出，退出码 4 = 需登录。

**MCP**：`http(s)://<workspace>/mcp`（Streamable HTTP），OAuth 或 `Authorization: Bearer <PAT>`；`?toolsets=core,files,admin,all`。

**DSH**：`dsh --profile <name>`（web/headless/sdk/acp/desktop）+ `cordis.patch.yml` 按 row-id 层叠；外部编程接口：ACP（stdio JSON-RPC，支持 cancel/resume/模型选择/MCP）或 SDK JSON-RPC（无 cancel）；Office 能力需在 profile patch 中挂 `dsh-skill-office`/`dsh-tool-workspace-dependencies`/`dsh-office-to-pdf`（本机 web profile 默认未挂）。

## 4. 许可结论（摘要）

- **univer-workspace 源码 Apache-2.0**；但 `@univerjs-pro/*`（Collaboration/Exchange/History/Worktree 等商业 SDK）在 npm 上无 license 字段，按 Univer 商业条款授权；`@univerjs/*` 开源部分 Apache-2.0。**Workspace/Browser/Server/Agent/CLI 等开源应用不另收软件授权费**，但同一 License 的域名、容量、期限、部署权仍生效（[univer.ai/pricing](https://univer.ai/pricing/) FAQ）。
- **一份 License 覆盖 Web SDK / Collaboration SDK / Exchange**；无 License 时免费档为 1 协同节点、3 编辑连接、10 导出/月；导出按“成功转换”计数，耗尽不回退免费档（[server/license](https://docs.univer.ai/server/license.md)、[collaboration/license](https://docs.univer.ai/server/collaboration/license.md)）。
- **内置开发凭据不是软件许可**：仅 `localhost/app/127.0.0.1`，2027-02-03 到期，90 天轮换（`README.md:480-492`）。自有域名生产协同会 403(9018)，必须购买含该域名的 License。
- **DSH MIT**；唯一需合规关注的是随包 `libreoffice-kit` **MPL-2.0**（分发需提供对应源码与 NOTICE，不影响自有代码闭源）。AI SDK 不含模型/额度。
- 详细清单与行动项见 `docs/LICENSE_NOTES.md`。本报告不构成法律意见。

## 5. 外部依赖与阻断

| 依赖 | 状态 | 证据 | 影响 / 下一步 |
| --- | --- | --- | --- |
| univer-workspace 访问 | ✅ 可用 | GitHub 公开，commit `0f5f018`；匿名 `pnpm install` 成功（1717 包，1m34s） | 直接克隆/构建；Docker 构建未实测 ❓ |
| 私有 insider registry | 🟡 风险项 | `.npmrc:1-4`；本次匿名拉取成功，无官方公开分发政策 | 需镜像/缓存策略，CI 长期可用性待验证 |
| Univer 商业 License | 🔴 阻断（生产） | 免费档限额、开发凭据域名/期限、Business 定价 | 用户/法务决策：采购 Business/Enterprise 或限定本地演示 |
| DeepSeek / OpenAI 凭据 | ❓ 待验证 | 环境无 `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`；DSH 本机以账户登录可用，但非服务端可复用 API key；`api.deepseek.com` 未认证 401 | 需用户提供服务端 key；此前只能离线代码/测试 |
| Codex Runtime | ⛔ 当前不可用 | `which codex` 为空、无 `~/.codex` | CodexExecutionBackend 标待验证；不得报已接入 |
| DSH 版本漂移 | 🟡 风险项 | Agent pin `0.1.5-rc.1`、Space 插件/本机 `0.2.2-rc.1`、master `0.2.2-rc.2`；无 changelog/tag | 精确 pin `0.2.2-rc.1` 并冒烟；升级需回归 |
| Node/pnpm/Docker | ✅ 可用 | 本机 Node 24.21.0、pnpm 自动切 11.24.0、Docker 29.7.2 | 部署镜像固定 Node ≥24 |
| 网络可达性 | ✅ 本机可用 | GitHub/npm/insider registry/docs 200；api.deepseek.com 401（未认证） | 生产/内网环境需另行验证 |

## 6. P0 技术选型建议

**推荐方案：univer-workspace Server 作唯一可信源 + DSH 0.2.2-rc.1 插件应用作单页宿主 + YXworker 自建业务层。**

1. **文档底座**：部署 univer-workspace 单进程（3020，SQLite + 本地 Blob），使用其 Browser 能力与 Worktree 全流程；不 fork 上游 SDK，保持 SDK `1.4.0` 精确基线。
2. **单页工作台**：以 DSH 插件应用承载左侧项目/`@`引用/对话/运行状态与右侧 Univer 编辑器（参考 `dsh-space-plugin` 的 `dsh.client.platform=web` + inject + `cordis.patch.yml` 机制，目标 DSH `0.2.2-rc.1`）；对话/Session/审批复用 DSH，避免从零实现聊天与运行日志。Space 插件仅为 POC，需按其 `docs/development.md` 的已知限制做加固（焦点竞态、离线写入、History 未接入等）。
3. **自建业务层**（P0 硬需求）：`ChangeProposal`/`ReviewBatch` 持久化与状态机（`proposed→accepted/rejected/revised/conflicted`）、建议卡片与选中范围 UI、proposalId↔threadId 映射、命名版本 V1.0/V1.1、冲突校验（anchor+quote+hash+revision）、逻辑档位路由、运行记录与可观测字段。
4. **写入编排**：提案生成与校验只读；采纳内容通过 Worktree changeset 或 `uvw execute --worktree` 子进程写入 draft，每步 read-back；全部采纳项处理完后**一次** `POST /api/worktrees/{id}/merge`，再对 Trunk 导出 DOCX。评论只作展示锚点。
5. **ExecutionBackend**：按 PRODUCT_SPEC §3.1 抽象 `start/stream/cancel/resume/capabilities`；P0 可用 DSH 同进程 agent（`agent.cancel`）或 ACP（含标准 cancel）；Codex 当前不可用，保留接口与 Mock（UI 标“模拟”），不得以换 chat 模型冒充 Runtime fallback。
6. **模型层**：P0 后端直连 DeepSeek/OpenAI/OpenAI-compatible，逻辑档位由服务端映射；密钥仅服务端环境/密钥托管，前端不落 LocalStorage。

**备选方案**：自建 React 单页工作台，直接嵌入 Univer 编辑器 SDK（参考 `apps/workspace/web` 的 editor/features），后端调 Workspace 产品 API + `uvw` 子进程，DSH 仅作 headless/ACP 执行器。可控性更高、无 DSH UI 版本风险，但需自研聊天/会话/审批，工作量明显更大。

**不推荐**：直接改造 Workspace Browser 为业务工作台（上游应用边界与升级成本高）；直接使用 Workspace Agent 作产品前端（DSH 0.1.5-rc.1、本地单用户、源码构建不发布）；把 MCP 作为交付依赖（Stage G 搁置、执行层白名单）。

**P0 启动前必须先做的冒烟验证**（见 §7 第 2–6 项）：Server+Browser 新建/编辑/读取；Worktree create→changeset→ready→merge 全链路与冲突行为；DOCX 导入/导出保真；DSH `0.2.2-rc.1` + Space 插件构建/裁剪；模型真实请求与错误处理。

## 7. 待验证清单（按优先级）

1. **Univer 商业授权**：自有域名 + 商业 License 的协同/导出行为（403/9018、连接数、导出配额）；采购路径与范围。
2. **Space 插件可构建性**：从源码构建 `dsh-space-plugin`（当前无公开 Release，仅 GitHub Actions artifact），确认 DSH `0.2.2-rc.1` 下安装/裁剪/重启流程。
3. **Worktree 冲突粒度**：同一文档不同段落的并发修改是“整 Unit conflict”还是 changeset 级合并成功；决定逐条采纳用“一 proposal 一 Worktree”还是“单 draft 内合成 patch”。
4. **段落锚点稳定性**：Doc `PARAGRAPH_ID_PREFIX` 段落 ID + offset + context hash 在 AI 修改后的漂移/保留行为。
5. **DOCX 导出保真**：页码/目录/字体/表格/图片在真实 Word/WPS 中的效果，及配额/失败的处理与预警。
6. **模型凭据与真实请求**：服务端 DeepSeek/OpenAI key 配置、429/500/断网/认证失败的错误分流与安全重试。
7. **Codex 可用性**：官方安装/认证后 `CodexExecutionBackend` 的 start/stream/cancel/resume 端到端。
8. **DSH ACP 端到端**：session/cancel、resume、模型选择、MCP attach 的实际行为。
9. **DSH 版本漂移**：`0.2.2-rc.1` 与仓库 `0.2.2-rc.2` 的插件 API 差异；升级回归清单。
10. **私有 registry 长期可用性**：匿名访问政策、镜像/离线包与 CI 复制策略。
11. **多用户/多实例部署**：每用户独立 `DSH_HOME` + 端口 + 反向代理的成本与隔离方案。
12. **MCP 本机打通**：gateway+executor+renderer 以 PAT 打通 `execute/inspect/export`（可选，不作交付依赖）。
13. **Docker 部署**：`docker build -f apps/workspace/Dockerfile .` 与数据卷迁移在目标环境实测。

## 8. 证据与复现记录

- 克隆与版本：`git clone --depth 1 https://github.com/dream-num/univer-workspace` → HEAD `0f5f0181ebafef6010667dfb8691db6559422089`；`deepseek-ai/deepseek-harness` → HEAD `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`；`gh repo view` 均返回 `LICENSE: Apache-2.0 / MIT`。
- 依赖安装：`cd univer-workspace && pnpm install --frozen-lockfile` → ✅ `Done in 1m 33.8s using pnpm v11.24.0`，1717 个包（日志 `/tmp/phase0-recon/pnpm-install.log`）。
- Server 启动：`cp apps/workspace/.env.example apps/workspace/.env && pnpm workspace:dev:server` → ✅ `Univer Workspace is running` @ `127.0.0.1:3020`；`GET /openapi.yaml`、`GET /api-docs`、`GET /api/session` 实测 200（日志 `/tmp/phase0-recon/server.log`）。
- CLI：`pnpm dlx univer-workspace-cli@0.6.0 --version` → ✅ `0.6.0`。
- 许可事实：抓取 `docs.univer.ai/server/license.md`、`docs.univer.ai/server/collaboration/license.md`、`univer.ai/pricing/`（2026-11-12）；npm 元数据核对 `@univerjs-pro/*` 无 license 字段、`@univerjs/core 1.4.0` Apache-2.0。
- 本机能力：`node v24.21.0`、`pnpm 12.18.0`（仓库安装自动用 11.24.0）、`docker 29.7.2`；`command -v codex` 为空、`~/.codex` 不存在；环境无 `DEEPSEEK_API_KEY`/`OPENAI_API_KEY`。
- DSH：本机 `dsh 0.2.2-rc.1`（MIT，`engines.node>=24.9`）；331 个 `@deepseek-ai/*` 包中 327 MIT，例外仅 `libreoffice-kit*` MPL-2.0、`node-addon-system*` BSD-3；本机 DSH 正在运行（本会话即由 DSH 驱动）。
- 未执行（故不声称）：Docker 构建、DOCX 实际导出、Worktree 端到端写入/merge、DSH ACP、Codex 安装、真实模型 API 请求。以上均为“待验证”。

## 9. 阶段 0 边界声明

本阶段只产出勘察矩阵与许可记录（`docs/INVESTIGATION.md`、`docs/LICENSE_NOTES.md`），未新增业务代码、未改动上游仓库、未提交任何凭据。所有“已有”均指组件/代码/文档/本机冒烟层面的证据，不等同于端到端联网成功；所有“待验证”项必须由 P0 以真实运行补齐，不得以模拟冒充当已实现。
