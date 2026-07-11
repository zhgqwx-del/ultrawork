# ADR-009: 产物预览 50/50 分屏
**状态**: Partially Superseded by [ADR-048](./048-preview-sidebar-layout-and-awareness.md)（2026-07-11）
**日期**: 2026-03-05
**关联轮次**: Round 7

> ⚠️ **本 ADR 的布局假设已被 ADR-048 推翻。** 下方「预览(w-1/2) | Chat(w-1/2) | Sidebar(w-80)」的三栏并排假设**从来就算不平**（三者宽度和 = 100% + sidebar 宽，溢出全由唯一可收缩的 chat 独吞）。ADR-048 改为**预览与右侧栏互斥** + `half`/`full` 双态。
>
> 仍然有效的部分：预览的**类型支持与渲染方式**（CodeMirror / Markdown / 图片 data URI / Diff）、Escape 关闭（`!e.defaultPrevented`）、文件树与产物列表统一入口、以及「否决 Modal / 底部 Panel / 新窗口」这三条替代方案的论证。

## 背景

Agent 执行 write/edit/create/patch 工具后产生文件产物，需要提供预览能力。用户希望在查看 Agent 生成或修改的文件内容的同时，继续与 Agent 对话交互，不中断工作流。

## 决策

Session 视图中 50/50 分屏布局：左侧 ArtifactPreview（代码/Markdown/图片/Diff），右侧聊天。Round 15 升级为 CodeMirror 6 语法高亮（17 语言包）。

- 布局结构：左=ArtifactPreview(w-1/2, border-r) | 右=Chat(w-1/2) | Sidebar(w-80)
- 支持的预览类型：代码（CodeMirror 语法高亮+行号+折叠）、Markdown 渲染、图片（data URI）、Diff 视图
- 产物提取从 ToolPart 的 `state.input.filePath`（camelCase）获取，只提取 write/edit/create/patch 工具
- Escape 键关闭预览，使用 `!e.defaultPrevented` 防止与 CommandSelector 等冲突
- 文件树点击也可触发预览：WorkspacePanel.onFileClick -> setSelectedArtifact({ type: "file", path })
- 图片预览使用 `data:${mime};base64,${content}` 格式，不使用原始文件路径

## 考虑过的替代方案

1. **弹窗（Modal）预览** — 遮挡聊天内容，用户无法同时查看 Agent 回复和产物。
2. **底部 Panel** — 视野太小，代码预览体验差，尤其是长文件。
3. **新窗口/Tab 预览** — 脱离聊天上下文，无法快速对照 Agent 解释和实际代码。

## 后果

**正面**：
- 预览与聊天并排，用户可同时查看 Agent 解释和生成的代码
- Escape 快捷键提供快速关闭体验
- 文件树和产物列表均可触发预览，入口统一
- CodeMirror 6 提供专业级代码查看体验（语法高亮、行号、折叠）

**负面**：
- 小屏幕下 50/50 分屏空间紧张，两侧内容都可能显示不全
- CodeMirror 6 + 17 个语言包增加了 bundle 大小
- isImage 需要双重检测（mime + 扩展名）以兼容不同来源的文件信息
