# Ultrawork 测试规划文档

## 1. 测试范围概述

基于已完成的 Phase 1-2 + Round 0-4 + 全面审查，本测试规划覆盖以下模块：

| 模块 | 包路径 | 类型 | 可自动化 |
|------|--------|------|---------|
| API Client | `packages/core/api-client` | 单元测试 | ✅ 完全 |
| SSE Client | `desktop/src/lib/sse-client.ts` | 单元测试 | ✅ 完全 |
| Config 存储 | `desktop/src/lib/config.ts` | 单元测试 | ✅ 完全 |
| i18n 国际化 | `desktop/src/lib/i18n-context.tsx` | 单元测试 | ✅ 完全 |
| Favorites Hook | `desktop/src/lib/use-favorites.ts` | 单元测试 | ✅ 完全 |
| cn() 工具函数 | `desktop/src/lib/utils.ts` | 单元测试 | ✅ 完全 |
| UI 组件 (chat) | `desktop/src/components/chat/` | 组件测试 | ✅ 大部分 |
| UI 组件 (session) | `desktop/src/components/session/` | 组件测试 | ✅ 大部分 |
| UI 组件 (layout) | `desktop/src/components/layout/` | 组件测试 | ⚠️ 部分 |
| Pages | `desktop/src/pages/` | 集成测试 | ⚠️ 部分 |
| Channel Gateway | `packages/channel/gateway/src` | 单元测试 | ✅ 完全（120+ cases：bridge / channel-manager / adapters） |
| Knowledge Sidecar | `packages/knowledge/sidecar/src` | 单元测试 | ⚠️ 覆盖薄（当前仅 `doc-parser.test.ts`，见下方缺口提示） |
| ACP Client Sidecar | `packages/agent/acp-client/src` | stdio e2e（`bun test src`，非 vitest） | ✅ 核心链路（mock ACP agent 确定性回放：turn 整形 / 权限 allow/reject/超时 deny + **W4b 持久化**——store reducer/roundtrip、session/load replay 抑制零外泄、manager 重启恢复、deleteSession，10 用例 92 断言）；另有真实 claude spike 脚本落盘 fixture → desktop `acp-turn-shaping.test.ts` 喂真实 `buildTurnModel` 断言（4 用例） |
| Tauri 集成 | 原生功能 | E2E | ❌ 手动 |
| OpenCode 联调 | 端到端流程 | E2E | ⚠️ 半自动（浏览器驱动法见 [conventions §11](./conventions.md)：Chrome 驱动 Vite :1420 + localStorage 预埋凭证/workspace，可自动化建会话/发消息/断言渲染/截图） |

> ⚠️ **覆盖缺口（Knowledge Sidecar）**：`:4098` 是 Phase 1 已上线模块，但单测目前仅覆盖 `doc-parser`。`store`（SQLite/FTS5/迁移）、`chunker`（Parent-Child 分块）、`retriever`（BM25+TF-IDF+RRF）、`indexer`（增量索引）、`mcp-bridge`（跨源搜索）、各 `adapters`（IMA/local-folder）均缺测试。新增知识库功能时应补齐对应单测。

---

## 2. 测试框架与工具

- **测试运行器**: Vitest (与 Vite 原生兼容)
- **DOM 环境**: jsdom
- **React 测试**: @testing-library/react + @testing-library/jest-dom
- **Mock**: vitest 内置 vi.mock / vi.fn / vi.spyOn
- **覆盖率**: vitest 内置 c8/v8

**jsdom 中测 Radix 浮层组件（2026-06-17 实测）**：
- `vi.mock` 工厂被提升到文件顶部，**不能引用其后声明的顶层变量**（报 "Cannot access ... before initialization"）。共享 mock 状态放进 `const h = vi.hoisted(() => ({ ... }))`，工厂里引用 `h.xxx`。
- **Radix `Popover` 在点击 trigger 时打开**（`fireEvent.click` 即可）；**`DropdownMenu` 走 `pointerdown`**——须 `fireEvent.pointerDown(trigger,{button:0})` + `pointerUp`，且 jsdom 缺 pointer-capture，要在 `beforeAll` 补桩 `Element.prototype.hasPointerCapture/setPointerCapture/releasePointerCapture`。
- 浮层内容在 portal 中、仅打开后渲染，断言用 `await screen.findByText(...)`；首帧同步断言后记得 `await waitFor(...)` 让 mount 期 fetch 在 act() 内 flush，避免 act 警告污染后续用例。

---

## 3. 自动化测试详细规划

### 3.1 API Client (`packages/core/api-client`)

#### 3.1.1 ApiClient 类测试

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| `constructor` | 正确存储 baseUrl, username, password | P0 |
| `getBaseUrl` | 返回配置的 baseUrl | P0 |
| `getCredentials` | 返回 username/password | P0 |
| `buildHeaders` - 有密码 | 生成 Basic Auth 头 (btoa) | P0 |
| `buildHeaders` - 无密码 | 无 Authorization 头 | P0 |
| `buildHeaders` - 默认用户名 | 无 username 时默认 "opencode" | P0 |
| `request` - 成功 | 返回 JSON 解析结果 | P0 |
| `request` - 204 空响应 | 返回 undefined | P0 |
| `request` - 空 body | Content-Length=0 返回 undefined | P0 |
| `request` - HTTP 错误 | 抛出包含 status 的 Error | P0 |
| `request` - 空文本响应 | 空 body text 返回 undefined | P1 |
| `listSessions` | 正确构建 query 参数 | P0 |
| `listSessions` - 无参数 | 不附加 query string | P1 |
| `createSession` | POST /session + body | P0 |
| `getSession` | GET /session/:id | P0 |
| `getMessages` | GET /session/:id/message | P0 |
| `deleteSession` | DELETE /session/:id | P0 |
| `updateSession` | PATCH /session/:id + body | P0 |
| `sendMessage` | POST body 含 parts[{type,text}] | P0 |
| `sendMessage` - AbortSignal | signal 传递给 fetch | P0 |
| `abortSession` | POST /session/:id/abort | P0 |
| `promptAsync` | POST /session/:id/prompt_async, 204 | P0 |
| `promptAsync` - with agent | body 包含 agent 字段 | P1 |
| `listPermissions` | GET /permission | P0 |
| `replyPermission` | POST /permission/:id/reply + body | P0 |
| `listQuestions` | GET /question | P0 |
| `replyQuestion` | POST /question/:id/reply + body | P0 |
| `rejectQuestion` | POST /question/:id/reject | P0 |
| `getConfig` | GET /config | P1 |
| `patchConfig` | PATCH /config + body | P1 |
| `getProviders` | GET /provider | P1 |
| `getMCP` | GET /mcp | P1 |
| `createMCP` | POST /mcp + body | P1 |
| `connectMCP` | POST /mcp/:name/connect (URL编码) | P1 |
| `disconnectMCP` | POST /mcp/:name/disconnect | P1 |
| `getFileTree` | GET /file?path=... (URL编码) | P1 |
| `getFileContent` | GET /file/content?path=... | P1 |
| `getFileStatus` | GET /file/status | P1 |
| `getSessionDiff` | GET /session/:id/diff | P1 |

### 3.2 SSE Client (`lib/sse-client.ts`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| `connect` - 成功 | 调用 fetch + 解析事件 | P0 |
| `connect` - Auth 头 | 有密码时发送 Basic Auth | P0 |
| `connect` - 无密码 | 无 Authorization 头 | P0 |
| `connect` - 防重复 | 已连接时不重复连接 | P1 |
| `disconnect` | abort + 清除 timer | P0 |
| `disconnect` - shouldReconnect=false | 不触发重连 | P0 |
| `on` / 取消订阅 | 添加/移除 handler | P0 |
| 事件解析 | `data: {...}` 格式正确解析 | P0 |
| 事件分发 | 多个 handler 都收到事件 | P0 |
| 自动重连 | 连接断开后触发指数退避重连 | P1 |
| 重连次数上限 | 超过 5 次停止重连 | P1 |
| JSON 解析错误 | 无效 JSON 不崩溃 | P1 |
| `getConnectionState` | 返回正确连接状态 | P2 |

### 3.3 Config 存储 (`lib/config.ts`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| `DEFAULT_CONFIG` | 验证默认值正确 | P0 |
| `ConfigStorage.load` - 无存储 | 返回 DEFAULT_CONFIG | P0 |
| `ConfigStorage.load` - 有存储 | 合并覆盖默认值 | P0 |
| `ConfigStorage.load` - 空密码回退 | 空密码回退到默认 | P0 |
| `ConfigStorage.load` - 无效 JSON | 返回默认配置 | P1 |
| `ConfigStorage.save` | 正确写入存储 | P0 |
| `ConfigStorage.reset` | 删除存储条目 | P0 |

### 3.4 i18n 国际化 (`lib/i18n-context.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| `t()` - 英文 | 返回英文翻译 | P0 |
| `t()` - 中文 | 返回中文翻译 | P0 |
| `t()` - 缺失 key | 返回 key 本身 | P0 |
| `t()` - 参数插值 | `{n}` 正确替换 | P0 |
| 翻译完整性 | en 和 zh key 一一对应 | P0 |
| `setLanguage` | 切换语言后 t() 输出变化 | P0 |

### 3.5 Favorites Hook (`lib/use-favorites.ts`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 初始状态 - 无存储 | 空 Set | P0 |
| 初始状态 - 有存储 | 从存储恢复 | P0 |
| `toggleFavorite` - 添加 | 添加到收藏 | P0 |
| `toggleFavorite` - 移除 | 从收藏移除 | P0 |
| `isFavorite` | 查询收藏状态 | P0 |
| 持久化 | 变更后同步到存储 | P0 |

### 3.6 工具函数 (`lib/utils.ts`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| `cn` - 基本合并 | 合并多个 class | P0 |
| `cn` - 条件 class | 布尔条件 class | P0 |
| `cn` - tailwind 冲突解决 | `p-4 p-2` → `p-2` | P0 |
| `cn` - 空/undefined | 安全处理空值 | P1 |

### 3.7 React 组件测试

#### 3.7.1 ChatInput (`chat/chat-input.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 渲染 - home variant | 显示大标题样式 | P0 |
| 渲染 - reply variant | 显示回复样式 | P0 |
| 输入文字 | textarea 值更新 | P0 |
| Enter 发送 | 触发 onSend callback | P0 |
| Shift+Enter | 不触发发送（换行） | P0 |
| 空内容不发送 | 空文本时 Enter 无反应 | P0 |
| loading 状态 | 显示 spinner, 禁用输入 | P0 |
| 自动调整高度 | textarea 高度随内容变化 | P2 |

#### 3.7.2 MessageList (`chat/message-list.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 渲染用户消息 | UserMessage 组件 | P0 |
| 渲染助手消息 | AssistantMessage + parts | P0 |
| loading 状态 | 显示 loading 指示器 | P0 |
| 空消息列表 | 显示空状态 | P1 |
| 流式消息 | streamingMessageId 高亮 | P1 |

#### 3.7.3 AssistantMessage (`chat/assistant-message.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 渲染 TextPart | Markdown 内容 | P0 |
| 渲染 ReasoningPart | ReasoningBlock 组件 | P0 |
| 渲染 ToolPart | ToolCallBlock 组件 | P0 |
| 渲染 StepFinishPart | StepIndicator 组件 | P0 |
| 渲染 FilePart | FileBlock 组件 | P1 |
| 渲染 PatchPart | PatchBlock 组件 | P1 |
| 未知 Part 类型 | 不崩溃，静默跳过 | P0 |
| streaming 状态 | 显示 typing 指示器 | P1 |

#### 3.7.4 ReasoningBlock (`chat/reasoning-block.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 默认折叠 | 内容不可见 | P0 |
| 点击展开 | 显示 reasoning 文本 | P0 |
| 再次点击折叠 | 内容隐藏 | P0 |

#### 3.7.5 ToolCallBlock (`chat/tool-call-block.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| pending 状态 | 灰色图标 | P0 |
| running 状态 | 旋转橙色图标 | P0 |
| completed 状态 | 绿色 Check 图标 | P0 |
| error 状态 | 红色图标 + 错误信息 | P0 |
| 展开详情 | 显示 input/output | P1 |

#### 3.7.6 ExecutionStatus (`chat/execution-status.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| working 状态 | Loader + "Working..." | P0 |
| done 状态 | Check + "Execution complete" | P0 |
| error 状态 | XCircle + 错误信息 | P0 |
| stopped 状态 | 显示已停止 | P1 |
| 停止按钮 | 触发 onStop callback | P0 |

#### 3.7.7 CommandSelector (`chat/command-selector.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 渲染命令列表 | 显示匹配的命令 | P0 |
| 键盘导航 | 上下箭头选择 | P0 |
| Enter 选择 | 触发 onSelect | P0 |
| Escape 关闭 | 关闭选择器 | P0 |

#### 3.7.8 ModelSelector (`chat/model-selector.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 显示当前模型 | 模型名称显示 | P0 |
| 点击打开 Popover | 显示模型列表 | P0 |
| 选择模型 | 触发切换 | P0 |

#### 3.7.9 StepIndicator (`chat/step-indicator.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 显示 token 统计 | input/output/reasoning | P0 |
| 显示 cost | 费用信息 | P0 |
| 显示 cache tokens | read/write cache | P1 |

#### 3.7.10 PermissionDock (`chat/permission-dock.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 渲染权限信息 | 权限名称和模式 | P0 |
| Allow Once 按钮 | 触发 onReply("once") | P0 |
| Always Allow 按钮 | 触发 onReply("always") | P0 |
| Reject 按钮 | 触发 onReply("reject") | P0 |

#### 3.7.11 QuestionDock (`chat/question-dock.tsx`)

| 测试用例 | 描述 | 优先级 |
|---------|------|--------|
| 渲染单选问题 | 选项列表 | P0 |
| 渲染多选问题 | 多选复选框 | P0 |
| 自定义输入 | 文本输入框 | P1 |
| Submit 提交 | 收集答案并提交 | P0 |
| Dismiss 取消 | 触发 onReject | P0 |
| 多问题导航 | Next/Back 按钮 | P1 |

#### 3.7.12 Session 面板组件

| 组件 | 测试用例 | 优先级 |
|------|---------|--------|
| ProgressPanel | 渲染步骤列表 + 状态图标 | P1 |
| ArtifactsPanel | 渲染产物列表 + 点击选择 | P1 |
| WorkspacePanel | 渲染文件树 + git 状态 | P1 |
| ArtifactPreview | 代码/Markdown/图片预览 | P2 |
| MCPPanel | 服务列表 + 连接/断开 | P2 |
| SkillsPanel | 按来源分组(内置/MCP/项目)渲染 + 点击填入输入框 + "管理技能"导航 | P1 |

---

## 4. 手动测试清单

以下功能需要真实环境（OpenCode 服务端 + Tauri 桌面窗口）进行手动验证：

### 4.1 端到端流程 (E2E) — ✅ 全部通过 (2026-03-07)

| # | 测试场景 | 步骤 | 预期结果 | 状态 |
|---|---------|------|---------|------|
| E1 | 启动应用 | 运行 `tauri dev` | 窗口正常显示, SSE 连接建立 | ✅ |
| E2 | 新建会话 | 点击侧栏"新建任务" | 创建成功, 跳转到会话页 | ✅ |
| E3 | 发送消息 | 输入文本, 按 Enter | 用户消息右侧显示, AI 回复左侧显示 | ✅ |
| E4 | 流式响应 | 发送消息等待 | 显示 "Working on it..." 状态 | ✅ |
| E5 | 停止执行 | 流式中点击"停止" | 执行中断, 状态切换为 stopped | ✅ (bugfix) |
| E6 | 消息渲染 | 触发 reasoning + tool 调用 | 思考过程可折叠, 工具调用卡片正确渲染 | ✅ |
| E7 | Permission 交互 | 触发需要权限的操作 | Permission Dock 出现, 可 Allow/Reject | ✅ |
| E8 | Question 交互 | 触发 Agent 提问 | Question Dock 出现, 可选择/输入/提交 | ✅ |
| E9 | 会话删除 | 右键菜单 → 删除 | 会话从列表移除 | ✅ |
| E10 | 会话重命名 | 右键菜单 → 重命名 | 内联编辑, Enter 保存 | ✅ |

> **E5 Bugfix**: 测试中发现停止后 AI 部分回复消失 + 新消息收到旧回答。根因为 SSE 事件泄漏竞态。
> 修复方案：引入 frozenMessageIdsRef 冻结旧交互消息 ID + 恢复 revertSession + temp 消息 ID 稳定化。
> 详见 `Session.tsx` handleStop / handleSSEEvent 改动。

### 4.2 UI 交互 — ✅ 全部通过 (2026-03-07)

| # | 测试场景 | 步骤 | 预期结果 | 状态 |
|---|---------|------|---------|------|
| U1 | 侧栏折叠/展开 | 点击切换按钮 | 侧栏宽度切换, 图标/文字切换 | ✅ |
| U2 | 右侧栏折叠/展开 | 点击 PanelRight 图标 | 右侧面板显示/隐藏 | ✅ |
| U3 | 主题切换 | 设置页切换 Light/Dark/System | 全局样式实时变化 | ✅ |
| U4 | 语言切换 | 设置页切换 English/中文 | 所有文本立即切换 | ✅ |
| U5 | 搜索会话 | 侧栏搜索框输入 | 实时过滤会话列表 | ✅ |
| U6 | 收藏/置顶 | 点击星标按钮 | 会话置顶, 星标填充 | ✅ |
| U7 | 日期分组 | 有多天会话 | Today/Yesterday/This Week/Earlier 分组正确 | ✅ |
| U8 | 中文输入法 | 使用拼音输入法 Enter | 不触发发送 (composing 状态) | ✅ |
| U9 | Shift+Enter | 按 Shift+Enter | 文本换行, 不发送 | ✅ |
| U10 | 连接状态 | 服务端运行/停止 | WiFi 图标绿色/灰色切换 | ✅ |
| U11 | 能力卡片 | Home 页点击卡片 | 填充示例 prompt 到输入框 | ✅ |
| U12 | 自动滚动 | 新消息到来 | 在底部时自动滚动, 不在底部时不打断 | ✅ |

### 4.3 模型管理 — ✅ 全部通过 (2026-03-07)

| # | 测试场景 | 步骤 | 预期结果 | 状态 |
|---|---------|------|---------|------|
| M1 | 打开 ModelDialog | 侧栏 SettingsPopover → 模型管理 | 显示供应商和模型列表 | ✅ (bugfix) |
| M2 | 搜索模型 | 输入模型名称 | 过滤显示匹配项, connected 优先排序 | ✅ (bugfix) |
| M3 | 快速切换模型 | ChatInput 区域 ModelSelector | Popover 打开, 搜索过滤, 选择后切换 | ✅ (bugfix) |
| M4 | 配置供应商 | ModelDialog → 配置供应商 | 两步式: 选择注册表供应商 → 配置 API Key + Base URL | ✅ (重构) |

> **M1 Bugfix**: `GET /provider` 返回 `{ all, default, connected }` 对象而非数组，`models` 是 object map 不是 array。修复 `getProviders()` 转换响应格式。
> **M2 Bugfix**: 搜索结果排序优化 — connected 供应商优先，名称匹配优先，再按字母排序。
> **M3 Bugfix**: ModelSelector Popover 添加搜索框，支持按模型名/供应商名/ID 过滤。
> **M4 重构**: 原「添加供应商」改为「配置供应商」两步式流程。OpenCode 注册表固定 98 个供应商，不支持创建自定义供应商。
> **Tailwind v4 全局修复**: `[--color-*]` → `[var(--color-*)]`，修复所有 Dialog/Popover/DropdownMenu 透明问题（30+ 文件）。
> **Vite HMR 修复**: `PATCH /config` 写入项目级 `config.json` 触发 Vite 刷新 → `/session/ID` 被 proxy 拦截返回原始 JSON。修复: watch 忽略 config.json + `/session` proxy bypass HTML 请求。
> **putProviderAuth 修复**: API 要求 `{ type: "api", key }` 格式，非 `{ apiKey }`。

### 4.4 MCP & 命令 — ✅ 全部通过 (2026-03-08)

| # | 测试场景 | 步骤 | 预期结果 | 状态 |
|---|---------|------|---------|------|
| C1 | MCP 列表 | 右侧栏 MCP 面板 | 显示已配置的 MCP 连接器 | ✅ |
| C2 | MCP 连接/断开 | 点击 Connect/Disconnect | 状态正确更新 | ✅ (bugfix) |
| C3 | 斜杠命令 | 输入 `/` | CommandSelector 弹出, 显示可用命令 | ✅ |
| C4 | 命令选择 | 选择命令 | 命令内容填入输入框 | ✅ |

> **C2 Bugfix — MCP 连接/断开/删除/持久化**:
> - **Disconnect 后列表清空**: 后端 `GET /mcp` 不返回已断开的 server。修复: disconnect 后本地设 `disabled` 状态，不依赖后端返回。
> - **Connect 无反应**: 后端断开后遗忘 server，`connectMCP(name)` 无效。修复: 存储 `configMap`，reconnect 时用 `createMCP` 重新注册。
> - **重启后 MCP 丢失**: React state 重启即失。修复: `configMap` 持久化到 `opencode.json`（通过 Tauri command 读写），启动时合并后端+本地数据。（注：最初用 localStorage，Issue#18 迁移到 opencode.json + 全局 `~/.config/ultrawork/opencode.json`）
> - **已删除 server 复活**: 后端 `POST /mcp` 返回全量 map（含 mcp-auth.json 中残留的 server）。修复: 新增 `hiddenSet` 记录用户删除的 server，所有后端响应经 `filterHidden()` 过滤。
> - **新增删除功能**: 非连接状态显示 Trash2 删除按钮，支持从列表移除不需要的 server。

### 4.5 产物与文件 — ✅ 全部通过 (2026-03-08)

| # | 测试场景 | 步骤 | 预期结果 | 状态 |
|---|---------|------|---------|------|
| F1 | 产物列表 | AI 生成文件 | 右侧栏产物面板显示文件列表 | ✅ |
| F2 | 产物预览 | 点击产物 | 50/50 分屏显示, 代码/MD/图片预览 | ✅ |
| F3 | 文件树 | 工作区面板 | 显示目录结构 + git 状态 | ✅ |
| F4 | 关闭预览 | 点击关闭按钮 | 恢复全宽对话 | ✅ |

### 4.6 技能

#### 4.6.1 右侧栏技能面板

| # | 测试场景 | 步骤 | 预期结果 |
|---|---------|------|---------|
| S1 | 面板加载 | 打开任意 session → 展开右侧栏 → 打开"技能"section | 显示 loading 后渲染技能列表 |
| S2 | 按来源分组 | 查看技能面板内容 | 分组标题显示（如"内置(2)"），每组带图标（Terminal/Globe/Sparkles） |
| S3 | 内置命令 | 检查"内置"分组 | 至少包含 init、review 两个命令，显示 `/{name}` 格式 |
| S4 | 描述截断 | 查看长描述技能 | 描述最多显示 2 行（line-clamp-2） |
| S5 | 点击填入 | 点击某个技能卡片（如 init） | 聊天输入框自动填入 `/{name} `（末尾有空格），光标在空格后 |
| S6 | 管理入口 | 点击面板底部"管理技能"链接 | 跳转到 Settings 页面且左侧导航高亮"技能"section |
| S7 | 空状态 | 后端无命令和技能 | 显示"暂无技能"提示文本 |
| S8 | 错误状态 | API 请求失败（如服务端离线） | 显示红色错误提示 |

#### 4.6.2 Settings 技能管理页

| # | 测试场景 | 步骤 | 预期结果 |
|---|---------|------|---------|
| S9 | 导航入口-侧栏 | Settings 页面左侧导航 → 点击"技能" | 右侧显示技能管理内容 |
| S10 | 导航入口-Popover | 左下角 SettingsPopover → 点击"技能管理" | 跳转到 Settings 技能 section |
| S11 | 页面结构 | 查看技能管理页 | 标题"技能" + 总数 badge + 描述 + 刷新按钮 |
| S12 | 分组列表 | 查看列表内容 | 按来源分组（内置/MCP/项目），每个技能卡片含图标、`/{name}`、来源 badge、描述 |
| S13 | 来源 badge | 查看不同来源的技能卡片 | 内置=灰色、MCP=蓝色、项目=紫色 badge |
| S14 | 项目技能位置 | 查看 source=skill 的卡片 | 卡片底部显示 SKILL.md 文件路径（font-mono） |
| S15 | 搜索过滤 | 搜索框输入关键词 | 按 name/description 实时过滤，分组仅显示有匹配项的 |
| S16 | 搜索无结果 | 输入不存在的关键词 | 显示 Search 图标 + "没有匹配的技能" 空状态 |
| S17 | 清空搜索 | 删除搜索内容 | 恢复完整列表 |
| S18 | 刷新按钮 | 点击刷新按钮 | 按钮图标旋转，重新拉取数据 |
| S19 | 配置区标题 | 滚动到列表下方 | 分隔线 + "技能配置"标题 |
| S20 | 添加路径 | 技能加载目录 → 输入路径 → 点击"添加" | 路径出现在列表中，toast "技能配置已保存" |
| S21 | 路径 Enter 提交 | 路径输入框按 Enter | 等同于点击"添加" |
| S22 | 路径去重 | 输入已存在的路径 → 添加 | 不重复添加（静默忽略） |
| S23 | 删除路径 | 点击已有路径右侧 X 按钮 | 路径移除，toast 提示 |
| S24 | 添加 URL | 远程技能源 → 输入 URL → 点击"添加" | URL 出现在列表中，toast 提示 |
| S25 | 删除 URL | 点击已有 URL 右侧 X 按钮 | URL 移除，toast 提示 |
| S26 | 空状态-全局 | 后端无任何技能 | 显示 Sparkles 图标 + "暂无可用技能，前往设置添加。" |
| S27 | 重启提示 | 查看配置区底部 | 显示"更改需要重启服务后生效。" |
| S28 | 中英文切换 | 切换语言 | 所有标签、描述、提示、badge 文本正确切换 |

### 4.7 错误处理与边界

| # | 测试场景 | 步骤 | 预期结果 |
|---|---------|------|---------|
| X1 | 服务端离线 | 关闭 OpenCode 后发送消息 | Toast 错误提示 |
| X2 | SSE 断连重连 | 网络中断后恢复 | 自动重连, 最多 5 次 |
| X3 | 无效密码 | 设置错误密码 | API 调用失败 + Toast |
| X4 | ErrorBoundary | 组件异常崩溃 | 显示友好错误页面, 不白屏 |
| X5 | 长消息 | 发送极长文本 | 正常渲染, 无截断 |
| X6 | 快速连续发送 | 连续点击发送多次 | 不重复发送, 状态正确 |

### 4.8 手动测试方法

#### 准备环境
```bash
# 1. 启动 OpenCode 服务端
cd packages/client/desktop
./src-tauri/binaries/opencode-server-aarch64-apple-darwin serve --port 4096

# 2. 启动开发服务器
cd packages/client/desktop && bun run --bun tauri dev

# 3. 或仅启动 Vite (不启动 Tauri)
cd packages/client/desktop && bun run dev
```

#### 测试流程
1. 打开浏览器 `http://localhost:1420` 或 Tauri 窗口
2. 按上表逐项测试
3. 在 Chrome DevTools Console 中观察 SSE 事件日志
4. 注意 Network 面板中 API 请求的状态码和响应

---

## 5. 测试文件组织

```
packages/core/api-client/
  src/__tests__/
    client.test.ts          # ApiClient 所有方法测试
    types.test.ts           # 类型验证测试

packages/client/desktop/
  src/__tests__/
    lib/
      config.test.ts        # ConfigStorage 测试
      utils.test.ts         # cn() 测试
      sse-client.test.ts    # SSEClient 测试
      i18n.test.ts          # 翻译完整性 + t() 测试
      use-favorites.test.ts # useFavorites hook 测试
    components/
      chat/
        chat-input.test.tsx       # ChatInput 组件
        assistant-message.test.tsx # AssistantMessage 组件
        reasoning-block.test.tsx  # ReasoningBlock 组件
        tool-call-block.test.tsx  # ToolCallBlock 组件
        execution-status.test.tsx # ExecutionStatus 组件
        permission-dock.test.tsx  # PermissionDock 组件
        question-dock.test.tsx    # QuestionDock 组件
        step-indicator.test.tsx   # StepIndicator 组件

packages/channel/gateway/
  src/                          # bridge / channel-manager / gateway-server /
    *.test.ts                   # session-store / adapters（dingtalk + wechat），120+ cases

packages/knowledge/sidecar/
  src/
    doc-parser.test.ts          # 文档解析（当前唯一；store/chunker/retriever/indexer/mcp-bridge/adapters 待补）
```

---

## 6. 覆盖率目标

| 模块 | 行覆盖率目标 | 分支覆盖率目标 |
|------|------------|-------------|
| api-client | 95% | 90% |
| lib/config.ts | 95% | 90% |
| lib/utils.ts | 100% | 100% |
| lib/sse-client.ts | 80% | 75% |
| lib/i18n-context.tsx | 90% | 85% |
| lib/use-favorites.ts | 95% | 90% |
| components/chat/* | 75% | 65% |

---

## 7. 优先级执行顺序

1. **P0 - 核心逻辑** (先做): api-client, config, utils, i18n 翻译完整性
2. **P0 - 关键组件**: ChatInput, MessageList, AssistantMessage, PermissionDock, QuestionDock
3. **P1 - 交互组件**: ReasoningBlock, ToolCallBlock, ExecutionStatus, CommandSelector
4. **P1 - Session面板**: ProgressPanel, ArtifactsPanel, WorkspacePanel
5. **P2 - 边缘场景**: ArtifactPreview, MCPPanel
6. **手动测试**: 按 4.1-4.7 清单执行（含技能面板 S1-S8 + 技能管理 S9-S28）

## 8. Headless 走查配方：LLM 流式 idle 看门狗（ADR-034）

验证「provider 流式回复静默挂死 → idle guard 转成错误终态 + 解锁会话」**在真实编译后的 sidecar 二进制上**生效（单测只能 mock 流，这层补「二进制运行时」缺口）。两侧 harness 思路一致：**隔离沙箱（独立 `XDG_CONFIG_HOME`/`XDG_DATA_HOME` + 非标准端口 + env 短超时）+ 一个故意「发部分流后静默」的 mock + 真起 sidecar + 观察终态 + 按 PID 清理 + 沙箱随删**，全程零碰真实数据。

**opencode 侧**（你截图的主路径）：
- mock = 一个 OpenAI-compatible `/chat/completions` SSE 端点（Bun.serve，`idleTimeout:0` 别让 Bun 关 socket），按路径分三态：`/idle` 发 2 个 content chunk 后**不关连接静默**、`/ttfb` 啥都不发就挂、`/normal` 发 chunk+finish+`[DONE]`；title 请求（body 含 "Generate a title"）一律快速正常回，免得标题生成挂住干扰主回合断言。
- 起 sidecar：`opencode serve --port <非标准>`，env 设 `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`OPENCODE_APP_NAME=ultrawork`/`ULTRAWORK_SIDECAR_PASSWORD=<已知>`/`OPENCODE_STREAM_IDLE_TIMEOUT_MS=2000`/`OPENCODE_STREAM_TTFB_TIMEOUT_MS=3500`。
- 配 provider：`PATCH /config`（带 `x-opencode-directory` header）写 `provider.<id>.{npm:"@ai-sdk/openai-compatible", options:{baseURL, apiKey}}`，baseURL 指向 mock 各路径。
- 发 `POST /session/:id/prompt_async`（`{parts:[{type:text,text}], model:{providerID,modelID}}`，204），轮询 `GET /session/:id/message` 看末条 assistant `info.error`（落 `"LLM stream idle for Nms"`）或 `info.time.completed`（终态）。**断言**：idle 路径 ~2s 报错、ttfb 路径 ~3.5s 报错（更长，证明两级）、normal 路径 `finish=stop` 无 error（不误杀）。实测 6/6。

**ACP 侧**：
- mock = 一个 silent ACP stdio agent（复用 `@agentclientprotocol/sdk`，**必须放在 acp-client 包内才解析得到 SDK**，走查后删），MODE env：`idle` prompt 永挂、`wedged` 发一个 `tool_call in_progress` 再挂、`spoke` 发一个 `agent_message_chunk` 再挂（验流中 idle 档）、`normal` 快速 end_turn。
- 起 acp-client 二进制：env `ACP_CLIENT_PORT=<非标准>`/`XDG_*`/`ACP_PROMPT_TTFB_TIMEOUT_MS`/`ACP_PROMPT_IDLE_TIMEOUT_MS`/`ACP_PROMPT_TOOL_SILENCE_MAX_MS`（全调短），agents.json 写进隔离 `$XDG_CONFIG_HOME/ultrawork/`。
- `POST /acp/session` 建会话、`POST /acp/session/:id/prompt`，**断言** 502 + error 文案（`idle for Nms`/`tool silent for Nms`）+ 时间窗 + SSE `session.error`；normal 200。实测 14/14。
- **坑**：silent agent 的 SDK 解析（放包内）、mock OpenAI 端点别被 Bun 的 socket idle timeout 提前关（`idleTimeout:0`）、prompt 后用回合**跨过**超时阈值才采得到（短回合测不出）。

## 9. 端口 / 进程相关测试的两条硬约束（ADR-045）

**测试里不要 `bind(0)` → drop → 再期望该端口仍空闲。** 临时端口是内核回收再分配的共享资源：一个测试释放后，并行跑的兄弟测试的 `bind(0)` 立刻就能拿到同一个号（实测 6 跑 5 挂）。两条出路：

- 要**确定性占住**一个端口 → 用**低于临时端口区间**的固定端口（macOS/Linux 起点 49152，`sysctl net.inet.ip.portrange.first`），一个测试一个号、不共享。见 `lifecycle_tests` 的 `PORT_RECLAIM` / `dynamic_port_tests` 的 `PORT_STRANGER_DYNAMIC`。
- 要断言「刚拿到的临时端口仍空闲」→ 只能把这几个测试**串行化**（模块级 `static Mutex` guard，见 `dynamic_port_tests::lock_ephemeral`）。同一个 TOCTOU 窗口在产品侧同样存在，所以那里靠重试而非靠运气。

**断言方向要成对。** 只写否定断言（「不杀陌生人」）的 suite，对「判定函数恒返回 false」这类回归**完全免疫**——判定函数退化成永远说"不是我的"，测试全绿。必须配一条肯定路径（「认得出并回收自家进程」）。收尾时做 A/B 反证：把判定函数分别退化为恒 `true` / 恒 `false`，**两个方向都要有测试变红**；只有一边红说明另一边没覆盖。

同理适用于鉴权：`401 on missing credential` 单独存在时，`app.use(() => 401)` 也能过。必须补 `200 with the correct credential`，以及「预检 OPTIONS 不被 401」。
