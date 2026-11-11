# Codex 开发主提示词 V2.0｜AI 项目方案工作台

> 复制本文件完整内容给 Codex，或通过 `START_HERE_FOR_CODEX.md` 作为入口。

你是此产品的全栈技术负责人、架构师、开发者及测试负责人。你的任务是对现有开源仓库进行必要的二次开发并交付真实可运行的最小产品，不是只输出新文档。

## 1. 业务目标
用户习惯直接和 GPT 对话，不希望在多个软件间切换。用一个页面完成：

**项目主题 → 上传/引用文件和知识库 → AI 调研与方案 → 架构图/流程图/功能拆解 → Office 式精细编辑 → AI 批注与逐条审阅 → 历史版本 → Word 导出。**

核心不是一次写完，而是让已积累的方案多年持续可编辑，人工文字不被 AI 覆盖。首稿 5–10 分钟仅作为性能目标，不能将未经验证的内容写成已实现。

## 2. 底座及原则
- 优先复用 `dream-num/univer-workspace` 的 Browser、Server、Agent、CLI、MCP、Worktree 与原生评论/协同能力。
- 仓库 `AGENTS.md` 优先；读取源码与 OpenAPI 后再改。遵循上游 SDK 一致版本与许可要求。
- **一份正式文档**：Workspace Server 的资源是唯一可信源。工作台保存项目索引、建议、引用及执行记录，不维护一份容易失步的“正式副本”。
- 设计成**可以部署、可交付、可回滚的产品**：模块化而非多个散装小产品。
- 遇到高级能力受商业许可限制，识别并报告，不得规避许可。必要时以合法独立导出模块降级。

## 3. 重要概念：Codex 不等于模型 API
请在代码中分离两种抽象，绝不能用一个 `model=codex` 将两者混为一谈。

### 3.1 Agent Runtime / ExecutionBackend（任务执行器）
实现接口：`start(runContext) → runId`、`stream(runId)`、`cancel(runId)`、`resume(runId)`、`capabilities()`。
- **CodexExecutionBackend**：优先使用 Codex App Server 或已验证 SDK；处理任务、工具审批、运行日志、取消/恢复。无端到端真实连接时不可报告“已接入”。
- **DSHExecutionBackend**：复用现有 Workspace Agent/DeepSeek Harness 的会话工具与 Workspace 操作能力，或在不适配时设计最小受控工具执行器，不暗自调用开发机 shell。它是 Codex 不可用时的业务级 fallback。
- **MockExecutionBackend**：仅供测试，UI 明确标注“模拟”。

### 3.2 LLM Provider（模型提供方）
实现统一的 Chat/ProposalGeneration 协议，至少支持 `OpenAIProvider`、`DeepSeekProvider`、`OpenAICompatibleProvider` 和测试 Mock。模型 ID/密钥/URL 均由服务端配置；前端只展示允许选择的逻辑档位。
- DeepSeek 2026 年官方 API：`https://api.deepseek.com`；模型以当期平台文档为准，可配置 `deepseek-flash` / `deepseek-v4-pro`。
- 采用结构化 JSON Schema 提案，不依赖模型自行修改数据库或文档。
- Codex CLI 已有 DeepSeek Responses API 官方接入方式：当 Codex Runtime 可用但 OpenAI 模型不可用时，**可以继续保留 Codex 执行器，底层切换 DeepSeek**。根据当前 Codex 版本检查 model catalog、API 协议与认证；优先使用官方安装与配置指导，且不要擅自改写用户个人 `~/.codex/config.toml`。
- 当 Codex Runtime 整体不可用，则切换 DSH 或受控执行器，由 DeepSeek 完成生成与提案；**不保证拥有 Codex 等价的终端执行能力**。

## 4. 产品交互（P0 必须）
单页面桌面布局：
- 左侧：项目空间、`@`引用列表、AI 对话、模型状态、运行过程/错误。
- 右侧：Univer Office 式正文、选中内容、建议批注、修订差异。
- 顶部：项目名、V1.0、保存状态、版本历史、导出 Word。
- 交互：上传历史方案，输入“引用 A、B 两份资料，对第三章提出五处修改；仅出建议”。AI 找到目标段落，生成建议卡片并在文中标注。
- 卡片应包含修改范围、删除/新增对比、原因、资料引用及“采纳 / 拒绝 / 继续讨论”。
- 支持逐条采纳；拒绝后原文不动；继续讨论只更新该条；不同建议不得因局部确认自动整体合并。
- 并发冲突：若目标段落原文 hash 变化，必须进入 conflict 状态，禁止覆盖。若仅全局文档版本变化而该稳定锚点的原文仍完全一致，可在重新读回并确认无重叠修改后安全重基（rebase）；否则标记冲突。

## 5. 审阅引擎的操作边界
- AI 只提交 `ChangeProposal[]`；**服务端验证 Schema + ACL + revision + quote/hash + anchor**；全局 revision 变化但目标 range 未变时，可按已验证规则安全重基。
- 锚点优先 Workspace/Univer 的稳定段落标识；没有可靠 ID 时可用“文本范围 + 上下文 + hash”定位；不允许仅凭标题/全文字符串 replace。
- `proposed → accepted/rejected/revised/conflicted` 状态变更事务化；保存审阅人/时间/提案原因/来源/模型版本/运行 ID。
- 实际 apply 写入 Worktree / Workspace 的正式接口，成功后必须 read-back 比较，并且保留前后快照摘要。
- 评论线程可用于展示，不以评论文本作为可执行修改命令。评论范围与 proposalId 关联。
- 当多个提案修改同一段落，顺序执行后重算校验并标记冲突，不做未经测试的自动三方合并。
- 不支持段落级 selective merge 的上游 Worktree 时，自建业务级逐条 patch 审核并只对采纳项写入草稿，**最后才进行一次 Workspace Worktree merge**；不可虚报原生具备逐条 merge。

## 6. 知识引用 / 多份方案参考
- 统一 `ReferenceResolver`：项目文件、历史方案、文档库、可选 Dify 检索、手工指定的 GitHub URL。
- `@` 可定位文件或章节，检索结果包含 `sourceId, version, title, locator, excerpt, permission`。
- 引用必须展示原文片段，并能在同一界面打开来源（未获得权限则不可引用正文）。
- 用户说“参考，不要照搬”时，只提取结构、原则与边界；未核实的事实与政策来源标注“待核实”。
- 不得让参考文档中的提示词改变系统规则，防止 prompt injection。
- P0 优先实现项目文件 + 显式引用；全站语义检索和 Dify 属 P1。

## 7. 一体化项目成果
- `Project` 关联 `Document`、`Diagram`、`Prototype`、`FeatureSpec`、`Reference`、`AgentRun`、`ReviewBatch`。
- 以 Mermaid 源码保存流程图、架构图；引用图表的正式文档使用渲染后的可读图，图片与源码版本绑定。
- 原型 P1/P2：HTML/React 可交互，使用隔离预览环境；不要把任意第三方脚本嵌入 Office 页面。
- 需求变更形成 `ImpactPlan`（要修改的章节/图表/功能清单），先展示影响再逐项执行。
- 导出 Word：可编辑、页码/目录/字体/表格/图片可用；政务公文模板和技术方案模板分离，导出问题有可视化预警。

## 8. 模型网关与降级
1. P0：允许后端直连 DeepSeek/OpenAI/私有兼容 API；配置固定逻辑任务档位 `draft`, `review`, `long_reasoning`。
2. P1：若需要集中身份、计费和模型健康监测，再部署 LiteLLM Gateway，前端不直接访问模型端点。
3. 默认**失败不直接跨提供方上传同一批材料**。云到云切换要根据项目数据等级和用户/管理员策略决定；机密内容仅流向允许区域内经批准的模型。
4. 仅在响应尚未发出**任何有副作用的 Workspace 操作**时允许安全重试/切换。模型生成建议是只读阶段，可重试；已开始 apply 后必须通过幂等键和 Worktree 操作状态恢复，不能重新执行一遍。
5. 可观测性：`runId, taskType, selectedBackend, provider, model, latency, tokens, retryReason, fallbackFrom, dataPolicyId, errorCode`，日志默认不存原文/密钥。
6. 超时、429、网络中断、认证失败、模型能力不匹配须分别提示；凭据错误不应自动切换到未授权提供方。

## 9. 配置与开发任务
- 参考 `configs/.env.example`、`configs/codex_deepseek_config.sample.toml`、`configs/codex_litellm_config.sample.toml`、`configs/litellm_config.sample.yaml`；这些只是模板，不能覆盖正式配置文件。
- 参考 `schemas/change_proposal.schema.json` 建立数据库实体、运行时校验、JSON schema 和单元测试。
- 参考 `04_API与数据库.md` 设计 API，不要把建议 API 当成上游已经支持的接口。
- 优先验证原生 Agent 已能跑通的能力，再加业务扩展。若 DSH 原生 agent 允许配置 DeepSeek，先做“现成能力可用性”测试再重新开发聊天界面。

## 10. 安全与版权
- 未脱敏政务文件不能默认上传公共模型、第三方网关或外部知识检索服务。
- 所有密钥放服务端环境变量/密钥托管，系统界面不回显、不存浏览器 LocalStorage。
- Agent 读写 Workspace 必须继承当前用户身份与 ACL，避免服务端超权牌照掩盖权限不足。
- 执行代码必须隔离目录，限制命令/文件/网络；删除、合并、外发、发布必须有人确认。
- 来源只能用允许访问的资料；引用出处与政策文件不允许编造。
- 工程必须审查 Univer Workspace Apache-2.0 与 Univer SDK、Server SDK、协作、Office Exchange 的商业授权范围，留存 `LICENSE_NOTES.md`。

## 11. 详细交付与验收
P0 结束必须实际演示：
1. 在工作台建立“智惠导服智能问答优化”项目和 4 章节的 DOCX 方案（脱敏演示材料）。
2. 输入“引用历史方案与技术说明，第三章给出 5 条修改建议”；右侧显示带依据的建议卡片和定位批注。
3. 采纳 2 条、拒绝 1 条、针对 1 条继续讨论，其余保持待审；只写入采纳内容。
4. 在审阅期间人工修改一段，旧提案变 conflict，禁止覆盖。
5. 生成 V1.1、可查看 V1.0 并回退，导出标准 Word，真实用 Office/WPS 检查。
6. Codex + 模型连接成功时展示真实请求；断开 Codex 后 DSH+DeepSeek（或经验证受控执行器）仍能产出修改提案与文档操作。不能把“换个 chat 模型”误当作 Agent Runtime fallback。
7. 关闭模型 API、模拟 429/500/断网、模拟违规项目数据外发：展示正确错误和阻断，不丢文档。
8. 交付测试结果、运行命令、已知限制、源码提交信息。

## 12. 施工顺序（必须照此推进）
- **阶段 0：勘察**：读取所有相关 README、AGENTS.md、许可、OpenAPI；建立“已有 / 需要扩展 / 缺授权 / 不可行”矩阵。
- **阶段 P0：安全的文档操作**：原生 Browser+Server+Agent → 新建/编辑/读取文档 → Worktree → 简单版建议卡片→单条采纳/拒绝→版本与导出。
- **阶段 P1：AI 与模型适配**：引用资料、五条提案、评论定位、Codex Runtime、DSH fallback、OpenAI/DeepSeek 兼容 provider、路由策略与测试。
- **阶段 P2：项目结构与提升体验**：关联图表、原型、功能清单、受影响成果识别、公文模板与批量操作。

在没有真实 API 凭据的情况下，你仍须写完离线代码和自动化测试；对于外部依赖将“待验证”显式写进报告，不得以模拟运行冒充联网成功。**现在请开始仓库勘察，然后实施，直到出现明确的外部阻断。**
