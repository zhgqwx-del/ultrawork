# ADR-059：移除右侧栏低价值区块（执行活动 / 连接器 / 技能）

- 状态：已实现（Accepted）—— typecheck 8/8 + desktop 661（1 例 DingTalk QR 预存在 flake，隔离重跑绿）+ check-docs 全绿；真机观感待用户
- 日期：2026-07-16
- 相关：ADR-038（PlanPanel/ActivityPanel 分区）· ADR-044（连接器/MCP）· ADR-041（技能 zip 分发）· ADR-048（预览与右侧栏互斥）

## 背景

会话页右侧栏（`Session.tsx` 的 `<aside data-testid="right-sidebar">`）是一列垂直堆叠的折叠面板，顺序为：计划 → **执行活动** → 工作区 → 产物 → **连接器** → **技能**。真机使用中，其中三块价值偏低：

- **执行活动 `ActivityPanel`**：默认展开，展示扁平的工具调用时间线（running/done/error）。与转录区**已内联显示的工具调用** + **计划面板的结构化步骤**双重重叠，观测性并不独有。
- **连接器 `MCPPanel`** 与 **技能 `SkillsPanel`**：与「**设置 → 连接器**」「**设置 → 技能**」**功能完全重复**——设置页才是管理入口（SkillsPanel 底部本就有「管理技能」按钮跳设置页）。把"全局管理面板"塞进"单会话上下文"位置本就别扭。

三块中唯一的独有能力是 SkillsPanel 点技能卡片把 `/技能名 ` 插入输入框；用户可直接键入 `/` 触发，取舍后判定可弃。

## 决策

**D1 彻底删除这三个区块及其组件、i18n、死代码**（非仅隐藏）——遵循项目「无死代码」约定。删除后右栏聚焦为：计划（有计划时）+ 工作区 + 产物。

**D2 共享依赖一律保留。** 数据 hook `useSkills / useMCPServers / useBrowserMCP` 同时被设置页 `Settings.tsx` 使用，**不动**；绝大多数 `mcp.*` / `skills.*` 文案键与设置页共享，**不动**。删除范围严格限定在"仅被这三个面板引用"的部分。

### 精确改动清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `pages/Session.tsx` | 删三个渲染块（执行活动 `661-663`、连接器 `688-690`、技能 `691-693`）；`import`（`:32`）去掉 `ActivityPanel, MCPPanel, SkillsPanel`；删死代码 `handleSkillClick`（`348-350`）。`allMessages` 保留（多处仍用）。 |
| 2 | `components/session/` | 删文件 `progress-panel.tsx`、`mcp-panel.tsx`、`skills-panel.tsx` |
| 3 | `components/session/index.ts` | 删 `ActivityPanel` / `MCPPanel` / `SkillsPanel` 三行导出 |
| 4 | `lib/i18n-translations.ts` | 删 **9 个孤儿键**（en + zh-Hans 各一份）：`session.rightSidebar.activity` / `.mcp` / `.skills`、`message.noSteps`、`skills.manage`、`skills.noItems`、`skills.group.command` / `.mcp` / `.skill` |
| 5 | `lib/i18n-zh-hant.generated.ts` | **不手改**，跑 `bun run --bun scripts/gen-zh-hant.ts` 重新生成（对应繁体键自动消失；本次 760 keys） |

**孤儿键判定依据（已逐键核验）**：抽出三面板引用的全部 i18n 键，逐个全仓 grep。仅上述 9 个键的引用在删除后归零；其余（`common.loading`、`error.fetchMCP/Skills`、全部 `mcp.*` 含 `mcp.browser.*`、`mcp.noServers`、`skills.empty`、`skills.manageSources` 等）均与 `Settings.tsx` 或其测试共享，保留。

**⚠️ 实现期修正（6→9）**：初版方案的静态 `grep 't("key"'` 只抓到 6 个直接调用的键，**漏了 3 个动态引用键** `skills.group.command/mcp/skill`——它们在 SkillsPanel 里经 `t(GROUP_LABEL_KEYS[group.key])` 间接引用（键名存在常量映射表里，不是字面量传给 `t()`）。删面板后 grep 确认这 3 个也仅此一处引用→一并删。教训：**判定 i18n 孤儿键不能只 grep `t("literal")`，必须一并搜键名字面量本身**（覆盖 `t(VAR[k])` / `Record<_, string>` 映射表这类间接引用）。`message.noSteps` 亦较隐蔽（仅 ActivityPanel 空态用）。

## 影响面

- **纯 renderer 改动**，三平台一致，不碰数据层 / 后端 / Tauri。
- 单会话与 Team 会话共用同一右栏，行为一致。
- **测试锁定（实现期修正）**：单测（`__tests__/`）确实无断言——`right-sidebar-section.test.tsx`（通用折叠壳）保留不受影响。**但 e2e（`e2e/`）有 2 处硬断言 Activity 段存在**，初版方案漏查（只搜了 `__tests__/`）：`plan-panel-ui.e2e.ts`（`activityShown` 进 `ok` 条件）与 `ui-density-walkthrough.e2e.ts`（`activityOpen` 进 checks 数组）——**已同步删除这两处 Activity 断言**（各测的主目标 Task Plan / 密度不变）。另 `preview-layout.e2e.ts` 注释提到「Activity 段在上方」已改为「Workspace 段在上方」（选择器 scope 到 `artifacts-panel` 本就正确、功能不受影响，只是注释归真——且 Workspace 段仍在其上、scope 仍必要）。会话右栏 MCP/Skills 段无任何 e2e 断言（Settings 页的 Skills/Connectors e2e 不受影响）。**教训**：判定「无测试锁定」必须同时搜 `__tests__/` 与 `e2e/`。（注：`plan-panel-ui.e2e.ts` 除删 Activity 断言外，还顺带修复了一处**与本删除无关的预存在腐化**——发送/水合/误关侧栏，详见 CHANGELOG [Unreleased] Fixed；那部分不属本 ADR 范围。）
- 右栏无空态风险：工作区区块恒渲染。

## 验证（已执行）

- `turbo run typecheck` **8/8 绿**（抓漏网 import / 未用变量：`ActivityPanel/MCPPanel/SkillsPanel` import 已随删除清掉、死代码 `handleSkillClick` 已删）。
- `cd packages/client/desktop && bun run --bun test`：**660 passed / 1 failed（total 661）**；唯一失败 = `channels-section.test.tsx` 的 DingTalk QR flow，与本改动无关（**隔离重跑 6/6 绿**），系预存在 async flake。
- `scripts/check-docs.ts` **全绿**（含 §9 zh-Hant 漂移守卫；`gen-zh-hant.ts` 已重新生成 760 keys）。
- 删除后对抗式自查：9 键在 en/zh-Hans/zh-Hant 三处均已消失、非 i18n 引用归零（`skills.manageSources` 系前缀误报，实为独立键，保留）；`ActivityPanel/MCPPanel/SkillsPanel/progress-panel/mcp-panel/skills-panel/handleSkillClick` 全仓无残留引用。
- 真机观感（右栏是否更聚焦）归用户判断。

## 非目标 / 权衡

- **不做可配置开关**（设置项 toggle 显隐）——过度工程；这三块是判定为冗余而非"部分用户需要"。
- **不迁移技能快捷插入**（`/技能名` 插入输入框）——用户已确认可弃，直接键入 `/` 即可。
- 设置页的连接器 / 技能管理入口不动，仍是唯一权威管理面。
