/**
 * P0 演示数据（脱敏/虚构，不含真实政务或个人数据）。
 * 对应 PRODUCT_SPEC §11.1：建立“智惠导服智能问答优化”项目与 4 章节 DOCX 方案。
 */
import type { SeedChapter } from '../domain/paragraphs.js';

export const DEMO_PROJECT_NAME = '智惠导服智能问答优化';

export const DEMO_PROJECT_DESCRIPTION =
  '面向政务导办场景的智能问答优化方案（演示用脱敏材料）。目标：引用历史方案与技术说明，对第三章提出逐条修改建议并经人工审阅后写入。';

export const DEMO_DOCUMENT_TITLE = '智惠导服智能问答优化方案（V1.0）';

export const DEMO_CHAPTERS: SeedChapter[] = [
  {
    title: '第一章 项目背景与目标',
    subtitle: '1.1 背景',
    paragraphs: [
      '政务服务热线与线上大厅日均咨询量持续增长，重复性问题占比高，人工坐席在高峰期响应压力明显。现有问答机器人依赖关键词匹配，回答命中率与可解释性不足，群众体验不稳定。',
      '本项目以“智惠导服”智能问答为切入点，在不改变现有办事流程的前提下，引入检索增强与模型问答能力，提升常见问题的首答准确率，并为人工坐席提供辅助建议。',
      '本项目为内部试点，使用脱敏或虚构材料进行验证，不接入真实个人信息。',
    ],
  },
  {
    title: '第二章 现状与问题诊断',
    subtitle: '2.1 现状梳理',
    paragraphs: [
      '现网问答系统包含政策知识库、事项指南与人工坐席三个部分。知识库以静态文档为主，更新依赖人工维护，同义表述覆盖不足。',
      '坐席辅助工具仅提供全文检索，缺少对回答依据的定位与引用展示，坐席需要人工核对政策原文，平均处理时长偏长。',
      '试点调研发现，影响体验的主要问题集中在三方面：检索召回不全、回答口径不一致、缺少可追溯的引用依据。',
    ],
  },
  {
    title: '第三章 功能拆解与实施路径',
    subtitle: '3.1 功能拆解',
    paragraphs: [
      '智能问答入口按办事咨询、材料准备、进度查询三类场景拆分，每类场景配置独立的提示词模板与转人工阈值。',
      '知识库按“政策原文—事项指南—问答对”三层组织，政策原文作为最终依据，问答对用于提升召回覆盖率。',
      '检索链路采用“关键词召回 + 向量召回 + 重排”的组合方式，优先保证政策原文的召回准确率，再对候选答案进行排序。',
      '模型接入层统一由服务端转发请求，密钥仅保存在服务端环境变量中，前端不接触模型端点，也不在浏览器存储中保存任何凭据。',
      '审核与兜底机制要求所有回答附带引用来源；当检索置信度低于阈值时，系统主动转人工，不生成无依据的回答。',
      '实施路径分为试点、扩面、稳定三个阶段，每个阶段设置明确的准入指标与责任人，未达到指标不进入下一阶段。',
      '运行监控需要覆盖响应时长、首答准确率、转人工率、引用命中率与异常率，并按周复盘形成改进清单。',
      '与既有系统的对接以接口方式完成，不修改原有业务数据库结构，避免影响现网办事流程。',
    ],
  },
  {
    title: '第四章 预期成效与保障措施',
    subtitle: '4.1 预期成效',
    paragraphs: [
      '试点阶段预期将常见问题首答准确率提升至 80% 以上，转人工率下降 15% 左右，坐席平均处理时长缩短 20%。',
      '通过引用来源与逐条审阅机制，方案修改过程可追溯、可回退，避免 AI 直接覆盖人工确认的内容。',
      '保障措施包括数据分级、密钥托管、灰度发布与回滚预案，以及每周运行复盘与问题闭环。',
    ],
  },
];

export interface DemoReferenceSeed {
  title: string;
  kind: 'md' | 'txt' | 'docx';
  filename: string;
  content: string;
  /** 供引用定位使用的逻辑小节，如“第 2 节 试点范围”。 */
  locators: string[];
}

export const DEMO_REFERENCES: DemoReferenceSeed[] = [
  {
    title: '智惠导服智能问答优化历史方案（2025 版）',
    kind: 'md',
    filename: 'yixiang-history-plan.md',
    locators: ['第 1 节 目标', '第 2 节 试点范围', '第 3 节 指标基线', '第 4 节 风险与约束'],
    content: `# 智惠导服智能问答优化历史方案（2025 版）

## 第 1 节 目标
以提升常见问题首答准确率与坐席处理效率为目标，试点期为三个月，覆盖办事咨询、材料准备、进度查询三类高频场景。

## 第 2 节 试点范围
试点先覆盖 20 个高频事项与 3 类咨询场景，参与坐席不超过 15 人；试点期间不改变对外服务入口，仅作为坐席辅助工具运行。

## 第 3 节 指标基线
2025 年基线：常见问题首答准确率 62%，转人工率 41%，坐席平均处理时长 6.5 分钟，引用命中率未纳入统计。目标值：首答准确率 80%，转人工率下降 15 个百分点，处理时长缩短 20%，引用命中率达到 90%。

## 第 4 节 风险与约束
模型输出必须附带引用来源；敏感信息不得进入外部模型；模型网关不可用时必须降级为人工，不能以无依据内容冒充回答。灰度发布按 10%、30%、100% 三档推进，出现异常可在一键回滚。`,
  },
  {
    title: '技术说明：知识库检索与模型网关接入要求',
    kind: 'md',
    filename: 'tech-notes-rag-gateway.md',
    locators: ['第 1 节 检索链路', '第 2 节 模型网关', '第 3 节 数据分级', '第 4 节 可观测性'],
    content: `# 技术说明：知识库检索与模型网关接入要求

## 第 1 节 检索链路
检索采用关键词召回与向量召回组合，向量库只保存脱敏后的政策片段；重排阶段优先保证政策原文片段，问答对仅用于补充召回。检索结果必须携带来源标识（文档 id、版本、小节位置），供回答引用。

## 第 2 节 模型网关
模型网关以 OpenAI 兼容协议提供 chat/completions 接口，支持 json_object 结构化输出，不支持 json_schema。提案生成必须由服务端做 JSON Schema 校验与重试修复，不能假定模型一定输出合法结构。密钥只允许保存在服务端，禁止写入仓库、日志或数据库明文。

## 第 3 节 数据分级
数据分为 public、internal、secret 三级。public 与 internal 材料可发送至经批准的外部模型网关；secret 材料一律禁止出域，包含敏感字段的请求必须在服务端拦截并记录错误码。

## 第 4 节 可观测性
每次模型调用记录 runId、任务类型、选中的执行器与提供方、模型、耗时、token 用量、重试原因与错误码；日志默认不保存原文与密钥。`,
  },
];

/** P2 演示图表（Mermaid 源码；渲染在浏览器完成，服务端只存源码）。 */
export interface DemoDiagramSeed {
  title: string;
  kind: string;
  source: string;
  description: string;
  chapterRef: string;
}

export const DEMO_DIAGRAMS: DemoDiagramSeed[] = [
  {
    title: '智能问答总体链路',
    kind: 'flowchart',
    description: '从用户入口到回答/转人工的端到端链路，对应方案第三章功能拆解。',
    chapterRef: '第三章 功能拆解与实施路径',
    source: `flowchart LR
  A[用户入口] --> B[关键词召回]
  A --> C[向量召回]
  B --> D[重排]
  C --> D
  D --> E{置信度达标?}
  E -- 是 --> F[模型生成回答]
  F --> G[引用与审核]
  G --> H[返回用户]
  E -- 否 --> I[转人工坐席]`,
  },
  {
    title: '系统架构与数据边界',
    kind: 'architecture',
    description: '工作台、服务端、知识库与模型网关的边界，对应第三章 3.1 与数据分级要求。',
    chapterRef: '第三章 功能拆解与实施路径',
    source: `flowchart TB
  subgraph 本机
    UI[单页工作台] --> API[服务端 API]
    API --> DB[(SQLite 文档/提案)]
  end
  API --> GW[模型网关 OpenAI 兼容]
  API --> KB[(知识库检索)]
  GW -. 仅 public/internal .-> EXT[[外部模型]]
  DB -. secret 阻断 .-> EXT`,
  },
];

/** P2 演示功能清单条目。 */
export interface DemoFeatureSeed {
  title: string;
  description: string;
  status: string;
  priority: string;
  chapterRef: string;
}

export const DEMO_FEATURES: DemoFeatureSeed[] = [
  {
    title: '智能问答入口与场景分流',
    description: '按办事咨询/材料准备/进度查询三类场景分流，配置独立提示词与转人工阈值。',
    status: 'in_progress',
    priority: 'P0',
    chapterRef: '第三章 功能拆解与实施路径',
  },
  {
    title: '知识库三层结构与检索重排',
    description: '政策原文—事项指南—问答对三层组织；关键词+向量召回后重排，引用可定位。',
    status: 'planned',
    priority: 'P0',
    chapterRef: '第三章 功能拆解与实施路径',
  },
  {
    title: '引用与逐条审阅闭环',
    description: 'AI 只提交建议，人工逐条采纳/拒绝/继续讨论，冲突禁止覆盖，保留版本。',
    status: 'done',
    priority: 'P0',
    chapterRef: '第三章 功能拆解与实施路径',
  },
  {
    title: '灰度发布与回滚预案',
    description: '按 10%、30%、100% 三档灰度，异常可一键回滚；运行指标按周复盘。',
    status: 'planned',
    priority: 'P1',
    chapterRef: '第四章 预期成效与保障措施',
  },
];
