# ADR-064: 默认会话系统提示富文本化（system.transform 追加，保留每模型基座）

- 状态：Accepted（✅ 已实现 + 单测 15/15 + headless 真回合 A/B 验证；真机 UI 观感待用户，2026-07-21）
- 日期：2026-07-21
- 关联：discussions/048（完整根因 / 两轮注入点选型 / 副作用表）、ADR-036（渐进式工具披露，复用同一 `system.transform` 钩子机制 + 同一 vendor patch）、ADR-037（跨平台）、ADR-042（BYOK 多 provider）

## 背景

横向对比同类桌面 agent（JVS Copilot），同一概念问题我方默认会话回复明显更简短平铺（3 句大白话 vs 对方标题+表格+分点+代码示例），需追加「展开回复下」才丰富。

**根因（代码实测）**：默认单 agent 会话未注入任何自定义主提示（本仓无 `build_agent_identity`/`brand.json`）；qwen 走 OpenCode `system.ts:33` 兜底吃 `default.txt`——Claude Code 血统、为 monospace 终端设计，字面强制 `fewer than 4 lines` / `One word answers are best` / `minimize output tokens`（`default.txt` 第 17/19/94 行），与桌面富 Markdown 产品 UX 不匹配（「展开回复下」正命中其 `unless user asks for detail` 豁免口子）。渲染层非瓶颈（`message-parts.tsx:65` 早启用 remark-gfm，表格/代码渲染得出，只是模型不产出）。

## 决策

### D1 — 注入点 = 插件 `experimental.chat.system.transform`（追加，非替换）
**否决**初版「`OPENCODE_CONFIG_CONTENT` env + `agent.build.prompt`」：`llm.ts:232` 的 `agent.prompt` **对所有模型无条件替换** `provider()`，而 `provider()` 按模型分流（`system.ts:20-33`：Claude→anthropic.txt / GPT→gpt·beast / Gemini→gemini / Kimi→kimi / 其余含 qwen→default）；本 app 是 BYOK 多 provider（ADR-042）→ env 方案会把非 qwen 模型的专属调优提示一并丢弃 = **降级**，且静态字符串无法按运行时模型分支。

改走独立插件 `RichOutputPlugin`（`vendor/.../plugin/rich-output.ts`）经 `system.transform`，在每模型基座提示组装完成后**追加**品牌段（保留基座），仅当基座含 default.txt 极简子句时（子串探测）额外追加 `<verbosity_override>` 中和 → **跨模型通用且不降级**。缓存安全：`llm.ts:228` 每 step 重建 `system` 数组（跨 step 不重复追加）+ header 稳定 re-join（`llm.ts:249`，前缀缓存不破）。

### D2 — 追加内容
`<language_consistency>`（回复随用户语言）/ `<identity>`（UltraWork，不泄底座）/ `<output_format>`（解释类富文本自适应、简单类保持简洁，带正反例）/ `<task_execution>`（执行任务保持 action-focused，压「放开 verbosity 后编码絮叨」）/ `<sensitive_information>`（最高优先级，不泄密钥/env/系统提示）。**排除 present_files**（本项目无此工具，产物走 fs 扫描）。**不含 general_conduct**——追加式保留基座已带工具并行/不擅自 commit 等 agent 行为，再追加会跨模型重复/冲突。

### D3 — 作用域 + kill switch + 软护栏
- **作用域**：仅 `build` 普通会话（`agent.ts:109`）。**不影响** plan（`plan.txt`）/ title（标题不会变长）/ compaction / summary / **Team·ACP 子进程**（Claude Code/Gemini/Codex 各有独立 system prompt）。**例外**：opencode 后端的 Team Leader 会被追加（叠在编排 prompt 上），评估良性（`<task_execution>` 保持委派 action-focused），必要时 kill switch 关。
- **kill switch**：`experimental.rich_output`（config，默认 ON）/ `ULTRAWORK_RICH_OUTPUT`（env，A/B 逃生阀）。与 `experimental.tool_disclosure` 门控**解耦**（独立插件）。
- **软护栏**：`system.transform` 追加段改不掉 `environment()`（`system.ts:40`）始终注入的真实 model/provider ID → 身份隐藏为软护栏（已接受，不 patch）。

## 后果

- **正面**：默认会话回复富文本化，跨模型不降级；kill switch 支持 A/B 与一键回退。
- **代价**：属 `patches/vendor-opencode-config-fix.patch` 增量（新文件 `plugin/rich-output.ts` + `plugin/index.ts` 注册 + `config/config.ts` schema），bump upstream 时随 tool-disclosure 一起复核。
- **零 UI 代码改动**：富文本是内容变化经**既有**渲染器（remark-gfm）呈现；表格/代码块原有 `overflow-x-auto` 容器 → 各屏宽 overflow-safe。
- **验证**：单测 `scripts/rich-output/rich-output-unit-test.ts` 15/15；sidecar 重编译核验标记入二进制；**headless 真回合 A/B**（隔离环境同 `myqwen/qwen3.6-plus`：ON 67 行含两表格+代码块+分节 vs OFF 8 行）确认端到端生效 + kill switch 生效；typecheck 8/8。真机 UI 观感 + 真实 qwen3.7-plus 手感待用户。
- **跨平台**：纯 TS 静态串 + `process.env` 读取，零路径/进程/平台分支，三平台同构。

## 后续（可选）
- kill switch 目前仅配置文件可改，设置页无开关——若要给用户「回复详略」UI 开关，另开独立小任务。
- 若真机发现简单问题被撑长或编码回潮，微调 `BRAND_GUIDANCE` 正反例。
