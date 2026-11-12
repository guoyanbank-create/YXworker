# 许可与授权记录（LICENSE_NOTES）

> 需求源：`docs/PRODUCT_SPEC.md` §10（“工程必须审查 Univer Workspace Apache-2.0 与 Univer SDK、Server SDK、协作、Office Exchange 的商业授权范围，留存 LICENSE_NOTES.md”）。
> 记录日期：2026-11-12。本文件是工程合规记录，**不构成法律意见**；最终商用授权以 Univer 官方书面许可/合同为准。

## 1. 结论摘要

| 结论 | 内容 |
| --- | --- |
| 可以自由使用 | univer-workspace 仓库源码（Apache-2.0）与其中开源应用（Browser/Server/Agent/CLI/MCP），以及 DSH（DeepSeek Harness，MIT）。 |
| 需要商业授权 | Univer Web SDK 商业功能、Server SDK（Collaboration/Exchange/History/Worktree 等 `@univerjs-pro/*`）、AI SDK。**对外交付或自有域名的生产自托管部署需购买 Business 或 Enterprise License**。 |
| 仅本地开发可用 | 仓库内置的 runtime development credential：只授权 `localhost`/`app`/`127.0.0.1`，2026-11-03 签发、**2027-02-03 到期**，每 90 天轮换；不是软件许可证，不能作为生产授权。 |
| 免费档限制 | 无 license pair：Collaboration 免费档 1 个协同节点、3 个编辑连接；Exchange 免费档每月 10 次导出。自有域名协同会 403（code 9018）。 |
| 需随分发合规 | DSH 的 `libreoffice-kit` 为 MPL-2.0，分发二进制需提供对应源码与 NOTICE。 |

## 2. 组件许可清单

| 组件 | 许可 | 依据 | 结论/义务 |
| --- | --- | --- | --- |
| univer-workspace 仓库（Browser/Server/Agent/CLI/MCP 应用与产品代码） | Apache-2.0 | 仓库 `LICENSE`；`package.json` `license: Apache-2.0` | 可商用、可修改，需保留版权与许可声明；上游商标/品牌使用另计 |
| Univer Web SDK 开源部分（`@univerjs/*`，如 core/docs/sheets/engine-render） | Apache-2.0 | npm 元数据 `@univerjs/core@1.4.0` `license: Apache-2.0` | 同上 |
| Univer 商业 SDK（`@univerjs-pro/*`：collaboration、exchange、history、worktree、license、docs/sheets/slides 高级功能等） | 商业授权（npm 元数据无 `license` 字段） | npm registry 实测；仓库 `.npmrc` 指向 insider registry | 需按 Univer 商业条款授权；不得当作 OSS 自由分发 |
| Univer AI SDK（CLI 的 headless/markdown 编译等能力） | 商业授权（含在 Business/Enterprise 的 Server & AI SDK 内） | [univer.ai/pricing](https://univer.ai/pricing/) FAQ | AI SDK **不含模型与额度**，模型费用另计 |
| Univer 文档库 / Server SDK | 商业授权 | https://docs.univer.ai/server/license.md | 一份 License 同时服务 Web SDK、Collaboration SDK、Exchange |
| DSH（DeepSeek Harness，`@deepseek-ai/dsh*`） | MIT | 本机 `/…/node_modules/@deepseek-ai/dsh/package.json`；仓库 `LICENSE` | 可商用；保留版权与许可声明 |
| `libreoffice-kit*`（DSH Office→PDF 原生引擎） | MPL-2.0 | DSH `THIRD_PARTY_NOTICES.md:197-201`；本机包元数据 | 文件级 copyleft：分发时需提供对应源码与 NOTICE；不影响自有代码闭源 |
| `node-addon-system*` | BSD-3-Clause | 本机包元数据 | 保留版权/许可声明 |
| Univer Workspace 内置 runtime 开发凭据 | 应用凭据（非开源许可，也非商业许可） | `README.md:480-492`；`apps/workspace/web/src/features/editor/features/license.ts:1-8` | 仅本地开发；域名限定、有到期日、不可当生产授权 |

## 3. Univer 商业授权要点（官方文档，2026-11-12 抓取）

- **覆盖范围**：一份 License 覆盖 Web SDK、Collaboration SDK、Exchange；License 由 `license.txt` + `licenseKey.txt` 组成，分别配置在浏览器、服务端、CLI 运行处。
- **无 License 的降级**：Web SDK 仅免费功能；Collaboration 免费档 1 节点 / 3 协同编辑连接；Exchange 免费档每月 10 次导出（[server/license](https://docs.univer.ai/server/license.md)）。
- **License 决定的要素**：协同编辑连接数、授权域名、协同节点数、文档类型；浏览器域名不在授权列表时，Collaboration Endpoint 返回 403（code 9018）（[collaboration/license](https://docs.univer.ai/server/collaboration/license.md)）。
- **商业档位**（[univer.ai/pricing](https://univer.ai/pricing/)）：Business 自托管生产/商用，`$99/月` 起或 `$1,000/年`（25+ 编辑连接、5,000+ 导出/月、1 个主域名及子域、无水印、无导入/打印限制）；Enterprise 不限连接/导出、按需报价；Freemium 带水印与功能限制，仅适合开发/测试/评估。
- **Workspace 与官方开源项目**：购买 Office SDK License 后，Workspace（含 Server/Web/Desktop）与官方开源 CLI/插件不另收软件授权费；但 License 的期限、授权域名、连接容量、导出额度仍适用。
- **导出/导入计数**：导入不限；导出按“成功转换”计数，失败不计；配额耗尽后不回退免费档。
- **AI SDK**：不含模型或模型额度，需自备模型与 Agent。

## 4. 本项目的授权行动项（P0 前/交付前）

1. **决策**：确认 YXworker 的交付形态是“本机/内网演示”还是“对外生产自托管”。后者需采购 Univer Business/Enterprise，并确认授权域名（含子域）、编辑连接数、导出配额是否覆盖验收场景。
2. **替换开发凭据**：任何非 `localhost/app/127.0.0.1` 的部署域名，构建时必须提供 `VITE_UNIVER_LICENSE`，服务端/CLI 提供 `UNIVER_LICENSE` + `UNIVER_LICENSE_KEY`（两者成对）；不得继续依赖内置凭据。
3. **过期管理**：内置开发凭据 2027-02-03 到期（每 90 天轮换）；建立到期提醒与轮换/替换 owner。
4. **导出配额**：为 DOCX 导出做配额监控与用户可见预警；P0 验收演示（采纳 2 条→导出 Word）需在配额内完成。
5. **分发合规**：随产品分发 DSH 二进制/容器时，保留 MIT、MPL-2.0（`libreoffice-kit`）与 `THIRD_PARTY_NOTICES`；univer-workspace 源码分发保留 Apache-2.0 声明。
6. **数据合规联动**：未脱敏政务文件不得上传公共模型/第三方网关（PRODUCT_SPEC §10）；此条与模型 Provider 授权/数据区域策略一并评审。
7. **记录**：采购/授权结论、License 域名与容量、决策人、日期，回写到本文件；未确认项保持“待验证/未授权”。

## 5. 未决与风险

- `@univerjs-pro/*` 私有 registry 的访问/分发政策未公开；本次匿名安装成功，但长期可用性与 CI 复制策略待验证。
- 内置开发凭据 payload 的容量字段未解密核对，实际容量以 SDK 运行时 `license.status/limits` 为准（待验证）。
- 免费档下自有域名的 403(9018) 行为已在文档确认，但真实域名/反向代理场景需 P0 复验。
- 本文件未覆盖所有传递依赖的许可证（npm 传递闭包以 `pnpm licenses list` 为准）；P0 交付前需跑一次全量许可证清单并归档。
