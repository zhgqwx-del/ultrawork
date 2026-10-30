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
| Brand | `packages/core/brand` + `scripts/brand-build.test.ts` | 身份/构建契约、真实子进程与 Python 运行时路径测试 | ✅ 自动化；原生安装/签名另验，见 §16 |
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

### 8.1 工具参数相位（ADR-049 追加）

复用上面的 opencode 侧 harness，新增一个 mock 模式复刻 **DashScope 缓冲模式**：发 content chunk（让 `sawFirstToken` 置真）→ 发 `tool_calls[0].function.name` + 几十字节参数前缀 → **静默 N 秒** → 一次性 flush 剩余参数 + `finish_reason:"tool_calls"`。env 缩短三个常量（如 `IDLE=2s / TOOL_INPUT=6s / TTFB=8s`）。**四条断言**：① 静默 4s（> idle 杠、< 工具参数杠）⇒ 回合**不再被杀**、工具正常执行、正常收尾；② 静默 8.5s（> 工具参数杠）⇒ **仍**落 `LLM stream idle for 6000ms`（证明看门狗没被改废）；③ 文本相位静默 ⇒ 仍报 `idle for 2000ms`（ADR-034 不回归）；④ 正常流不误杀。实测 4/4。

**踩过的四个坑**（都会让测试假绿/假红）：
1. **`OPENCODE_APP_NAME` 不设 ⇒ 沙箱配置读不到**：`global/index.ts` 的目录名取自该 env（缺省 `opencode`），而生产是 `ultrawork`。配置写进 `<XDG_CONFIG_HOME>/ultrawork/` 但 sidecar 去 `<XDG_CONFIG_HOME>/opencode/` 找 → provider 不存在 → prompt 静悄悄没反应（**mock 零请求**是这个症状的指纹）。
2. **标题识别不能用宽松匹配**：`body.includes("title")` 会命中**工具 schema 里的 `title` 字段** ⇒ 主回合请求也走进「快速正常回答」旁路 ⇒ 四个模式全部秒「完成」、全绿但什么都没测。必须用严格签名 `body.includes("Generate a title")`。
3. **tool part 在「工具执行的那一步」，不在最后一条 assistant 消息**：opencode 每个 step 一条 assistant 消息，最后一条是工具结果回灌后的收尾步（无 tool part）。断言必须**跨全部 assistant 消息**找。
4. **`scripts/build-opencode.ts` 的新鲜度检查看不到裸的 vendor 源码改动**（它 hash 的是 submodule HEAD + **patch 文件** + 脚本自身）。做 A/B 反证时若只改源码不重生成 patch，会打印 `up-to-date, skipping build` 并**继续跑旧二进制**（表现为「撤掉修复后测试依然全绿」）。**A/B 必须加 `--force`**。

### 8.2 真渲染层 e2e：`e2e/idle-guard-toolinput.e2e.ts`（ADR-049）

真实 opencode 二进制 + 真 qwen3.7-max + 真 composer（Chrome / WebKit 双引擎，隔离 HOME/XDG 沙箱）。断言：① 转录区不出现 `LLM stream idle` 报错；② 回合正常收尾；③ **静默窗口内 UI 不假完成**（停止按钮仍在——后端不杀了，但前端若自己把回合判死同样是故障）。

**停流是 provider 行为，无法强制**：脚本会量出本轮的最长静默，**< 30s 时断言 ③ 直接 SKIP 而不是假绿**（那一轮 DashScope 走了流式模式、根本没触发缺陷场景）。实测：Chrome 撞上 32s 停流 3/3 PASS；WebKit 第一轮只静默 28s → 如实 SKIP，重跑撞上 30s → 3/3 PASS。

## 9. 端口 / 进程相关测试的两条硬约束（ADR-045）

**测试里不要 `bind(0)` → drop → 再期望该端口仍空闲。** 临时端口是内核回收再分配的共享资源：一个测试释放后，并行跑的兄弟测试的 `bind(0)` 立刻就能拿到同一个号（实测 6 跑 5 挂）。两条出路：

- 要**确定性占住**一个端口 → 用**低于临时端口区间**的固定端口（macOS/Linux 起点 49152，`sysctl net.inet.ip.portrange.first`），一个测试一个号、不共享。见 `lifecycle_tests` 的 `PORT_RECLAIM` / `dynamic_port_tests` 的 `PORT_STRANGER_DYNAMIC`。
- 要断言「刚拿到的临时端口仍空闲」→ 只能把这几个测试**串行化**（模块级 `static Mutex` guard，见 `dynamic_port_tests::lock_ephemeral`）。同一个 TOCTOU 窗口在产品侧同样存在，所以那里靠重试而非靠运气。

**断言方向要成对。** 只写否定断言（「不杀陌生人」）的 suite，对「判定函数恒返回 false」这类回归**完全免疫**——判定函数退化成永远说"不是我的"，测试全绿。必须配一条肯定路径（「认得出并回收自家进程」）。收尾时做 A/B 反证：把判定函数分别退化为恒 `true` / 恒 `false`，**两个方向都要有测试变红**；只有一边红说明另一边没覆盖。

同理适用于鉴权：`401 on missing credential` 单独存在时，`app.use(() => 401)` 也能过。必须补 `200 with the correct credential`，以及「预检 OPTIONS 不被 401」。

## 10. `getByRole(..., { name })` 在大列表视图里是超时 flake 的来源（2026-07-27）

**症状**：`about-legal.test.tsx` 的两个用例在**单跑时 ~2s、满负载并跑时 >5s**，随机撞上 vitest 默认 `testTimeout: 5000` 变红。产品代码没有任何问题，纯测试查询开销。

**根因（实测，非推断）**：带 `name` 的 role 查询会对**每一个**匹配该 role 的元素计算可访问名（`computeAccessibleName`）。该页面渲染时有 **108 个** `button` / `role="button"` 元素（50 个可展开行 + 50 个链接按钮 + 5 个筛选 chip + 分页 + 返回）：

| 查询 | 耗时 |
|---|---|
| `screen.getByRole("button", { name })` | **~1000ms**，且**每次 DOM 变动后重新付一遍**（它依赖的 jsdom 样式缓存被 mutation 打掉） |
| 同上加 `hidden: true` | **~1000ms —— 没用**（只跳过可见性过滤，不跳过名字计算） |
| `screen.getByText("标签")` | **5ms**（标签是按钮唯一子节点时直接返回该 `<button>`） |
| `within(小容器).getByRole("button", { name })` | **31–84ms**（候选从 108 降到 5） |
| `screen.getAllByRole("button")`（不带 name） | 21ms（role 匹配本身不贵，贵的是名字计算） |

**处置**：
- 标签就是按钮唯一子节点时 → `getByText`，拿到的就是 `<button>`，`toBeDisabled()` 照常可用。
- 需要靠附加内容消歧时（如 chip 的 `标签 84` 要和 49 个同名行区分）→ `within(容器)` 缩小候选集，别改产品代码加 testid。
- **不要靠调高 `testTimeout` 掩盖** —— 那只是把 flake 推后。

**判断是否适用**：只在**渲染了大量同 role 元素**的视图里才需要在意（本仓库其余测试并跑时最慢单测 736ms，无风险）。小组件测试继续用 `getByRole` 是对的 —— 它的可访问性语义更强。

> 修复效果：两个用例 1994ms→119ms、1896ms→184ms；文件总耗时 4.26s→0.59s；连跑 5 次全量 730/730 全绿。

## 11. 断流类 e2e：可切断 TCP 代理 + 非空转门 + 两档场景（ADR-072 / discussions/058）

常驻 harness = `packages/client/desktop/e2e/stream-gap-resync.e2e.ts`（`bun run --bun e2e/stream-gap-resync.e2e.ts`），配套 `e2e/cuttable-proxy.ts`。

### 三个必须照做的设计点

**① 断流必须发生在传输层，Playwright 的 `setOffline` 不切 loopback。**
第一版用 `setOffline` 测出 `missing=0`，补上非空转检查后实测**断流期间 marker 仍从 7 涨到 66** —— 网络从没断过，那份 `missing=0` 是一份关于空转的报告。
改用可切断 TCP 代理插在 **Vite 与 opencode 之间**（`Vite → proxy(4096) → opencode(4196)`）：renderer 不用改配置、CORS origin 不变。`cut()` 同时**断掉所有活连接**并**拒绝新连接** —— 这才是「服务端继续跑而客户端聋了」的真实形态。杀 opencode 不是这个场景（回合跟着一起死，没有「服务端继续产出」可言）。

**② 非空转门是 FAIL 而不是 warning。**
断流期间界面 marker 数必须**停止增长**，否则整轮判 FAIL。两种失败要分开报，因为指向完全不同的原因：

| 现象 | 含义 |
|---|---|
| marker **变多** | 传输层根本没断（`setOffline` 的典型症状） |
| marker **变少 / 归零** | 页面被重置了 —— 十有八九是**边跑边改源码触发 Vite HMR**，不是产品缺陷 |

**③ 两档场景都要跑，只跑一档必得出自信的错误结论。**
A 档（断流落在回合内）应当自愈，存在的意义是证明修复**没破坏**自愈；B 档（断流跨越回合结束）才是被修的那个。只跑 A 会得出「不存在缺陷」，只跑 B 会不知道自己顺手弄坏了什么。同时断言 `spannedTurnEnd` 与预期一致 —— 机器慢的时候 A 档会漂成 B 档，那样这轮就是在给别的场景打分。

### ⚠️ 参数是标定出来的，改之前先重跑负向控制

`CHUNKS=300 / DELAY=120ms`、A 档断流 8s、B 档 45s，取自 discussions/058 在干净代码上的实测（A=300/300，B=7/300）。
**曾经为了让 harness 快一点缩到 90 chunk / 4s 断流，负向控制立刻暴露 A 档也只剩 19/90** —— 自愈在回合结束前没跑完，于是「A 档通过」其实是修复本身在兜底，A 档静默退化成第二个 B 档。**自愈能不能跑完取决于重连之后还剩多少回合**（它靠后续 `message.part.updated` 带的全量 part 正文）。
⇒ 任何缩短参数的改动都必须重跑负向控制。

### case C：用户「加载更早」出来的历史必须活过补拉

A/B 只能证明正文被修好了 —— **一次 re-seed 也能把 A/B 修得同样漂亮**，同时悄悄扔掉用户拉出来的更早历史。case C 就是钉这一条：API 直灌 20 轮历史（> `TURN_INIT` 15，所以最老几轮一开始被 turn 窗口挡住）→ 断言最老一轮**不可见**（本档的非空转门：一开始就可见的话，「最后仍可见」什么也证明不了）→ 点「加载更早消息」→ 断言可见 → 再跑一次跨回合结束的断流 → 断言正文补齐**且最老一轮仍在**。
case C 用**独立 workspace**：opencode 按目录分实例，这样 A/B 那两个标题里全是 `M####` 的会话不会出现在 C 的侧栏里污染整页 marker 计数。

### ⚠️ mock 的「快速通道」哨兵必须只匹配最后一条消息，不能匹配整个请求体

case C 需要 20 轮历史，等不起每轮 `CHUNKS×DELAY`，于是给 `mock-llm.ts` 加了条：prompt 里带 `SEEDTURN` 就一帧答完。**第一版对整个 request body 做 `includes`，直接把真实回合也吃掉了** —— opencode 每次请求都会把**整段会话历史**回放给模型，只要这个会话被 seed 过，它的历史里就永远带着 `SEEDTURN`。症状是 case C 报 `stream never started`，看起来像产品问题。
⇒ 判据：**哨兵只对 `messages` 的最后一条求值**。与 §8 坑 2（`body.includes("title")` 连工具 schema 里的 `title` 字段一起命中）是同一类错误 —— **在会被历史回放的载荷上做子串匹配，等于给自己埋一个随会话年龄增长而必然触发的开关**。

### ⚠️ Playwright 的 scroll-into-view 会触发 app 自己的滚动回调，把点击目标从 DOM 上摘掉（WebKit 实测）

case C 要点「加载更早消息」。**Chromium 一直好好的，WebKit 上必挂**：
```
- attempting click action
- element is visible, enabled and stable
- scrolling into view if needed / done scrolling
- element was detached from the DOM, retrying     ← 循环到 30s 超时
```
机制：那个按钮就在转录**顶部**，Playwright 为了点它先把它滚进视野 ⇒ 落到顶部 ⇒ 触发 app 自己的 `onScrollNearTop → backfillTurns` ⇒ 重渲染 ⇒ 按钮被摘掉 ⇒ 点击永远落不下去。**讽刺的是它触发的回填正是我们想要的效果** —— 历史其实已经展开了，只是那次点击完成不了。
⇒ 判据：**目标是「历史被展开」，不是「按钮被点到」。断言结果，别断言手势。** 改成「循环：查结果 → 试点一次（短超时、吞异常）→ 再查」后两个引擎都稳。
⇒ 推广：**凡是点击目标位于会触发滚动副作用的位置（列表顶/底、无限滚动边界），都别用裸 `click()`** —— 它隐含一次 scroll，而那次 scroll 可能就是改变 DOM 的那只手。

### 双引擎是必须的，不是锦上添花

`E2E_ENGINE=webkit` 跑同一套（约定见 `math-render-realapp.e2e.ts`）。Chromium = Windows 的 WebView2；**WebKit = macOS 的 WKWebView 与 Linux 的 WebKitGTK**。
本轮实证价值：**修复本体 A/B 两档在两个引擎都过**，而 **case C 的脆弱性只有 WebKit 暴露得出来** —— 只跑 Chromium 会一直以为那段 harness 是稳的。同类前科见 gotchas §20⑭。

### ⚠️ case C 的鉴别力来自 `turnStart`，不来自消息列表 —— 半吊子的反证会给它发假通行证

给 C 做负向控制时，第一版只把合并换成 `setMessages(snapshot)`（以为这就是「re-seed」）。**C 照样绿**。
原因：C 的会话只有 21 轮 = 42 条，**一页 80 装得下**，所以 re-seed 并不丢消息；而「加载更早」把 `turnStart` 设成 0 之后，这版 sabotage 根本没碰 `turnStart`。
只有**忠实地模拟真正的错误实现**（复用初始加载：`setMessages` + 重算 `turnStart` + 重置 `cursor`/`hasMore`）才把它打红 —— 因为 `turnStart` 会被重算成 `21-15=6`，最老几轮重新被窗口挡住。
⇒ 两条判据：① **负向控制必须复刻「那个更省事的错误写法」，而不是你临时想到的某种破坏**，否则等于给守卫发假通行证；② 想让 C 同时守住「列表被截断」，需要 seed 超过 `INITIAL_PAGE_SIZE`（> 40 轮）—— **目前它守不住这一条**，harness 注释里已写明。

### 负向控制怎么做（2026-07-30 实跑结果）

在 `use-session-messages.ts` 的 resync effect 顶部加一条 `return`：

| | A 档（应自愈） | B 档（应被修复） |
|---|---|---|
| 有修复 | 300/300 ✅ | 300/300 ✅ |
| **无修复** | **300/300 ✅**（自愈是真的） | **19/300 ❌**（缺 281） |

单测侧同一次负向控制：17 例挂 5 例；剩下 12 例里有 3 例是「**不**应该补拉」的断言（busy 中 / 已停止 / 首连），按设计就不该被这次反证影响。

---

## 12. 浏览器 harness 的三个"尺子坏了"（2026-08-22，`e2e/message-timestamp.e2e.ts` 实战）

① **`page.addInitScript` 每次导航都重跑。** 里面无条件写 `localStorage` 会把**被测行为**悄悄覆盖回去 ——
一次语言切换的走查因此判红，被误读成产品缺陷。要么"只在不存在时 seed"，要么改用应用自己的 UI 去切。

② **用 reload 测"模块级缓存"是空的。** 重新导航后模块重新求值、缓存本来就是空的，
所以"单例 formatter 把 locale 钉死"这类 bug 在 reload 型用例下**必然通过**。
要在同一 document 内热切换（走应用自己的设置面板），或直接
`await page.evaluate(() => import("/src/lib/xxx.ts"))` 打暖缓存。

③ **断言要先要求"量到了东西"。** `before.h === after.h` 在元素不存在时是 `null === null` ⇒ 照样绿；
这条空转是**负向控制臂**抓出来的，正向那一轮它一直是绿的。凡是比较两次测量的断言，先断言测量非空。

配套事实：本机 `channel:"chrome"`（系统 Chrome 151 + playwright-core 1.61.1）**可信 click / hover 在真实 app 页面上是通的**
（CSS `:hover` 正常传播），playwright 自带 chromium revision 未下载所以只能走 `channel`；
`E2E_ENGINE=webkit` 可切到 WebKit —— 那才是 macOS 生产环境（WKWebView）的引擎。


---

## 13. mutant（控制臂）的两条纪律（discussions/060，2026-08-23）

### ① 全绿之后要逐个注入缺陷，确认每条断言都会红

草稿保留那批做了 12 个 mutant，每个只打红它对应的断言（M1 全局 12 条 / M7 成员相关 3 条 / 其余各 1 条）。
没有这一步，「断言在空转」和「实现是对的」在报告里长得一模一样。

### ② **mutant 不变红 ≠ 测试空转**，也可能是你对「什么算缺陷」判断错了

实例：把 `DraftProvider` 从 `RouterProvider` 外挪进 `RootLayout` 内，本以为端到端探针会红，**结果照样 PASS** ——
因为父路由在子路由切换时不卸载，两个位置对 `/` ↔ `/settings` 本来就等价（gotchas §23②）。
真正能区分的是 `/workspace` 往返，补上那一步 mutant 才变红。
⇒ 先证伪自己的缺陷模型，再去改测试。

### ③ harness 的时序必须复刻真实时序

验「交接指令顶掉草稿」时，第一版让 seeder 与被测页面**同批次挂载**，effect 读到的还是空草稿，
于是输出「零 toast」—— 看着像另一个 bug，其实是尺子错了。
改成真实时序（打字 → 离开 → 带 state 回来）才暴露出 StrictMode 双 toast 这个真缺陷。

### ④ 真机自动化（macOS）能做到哪一步

`tauri dev` + AppleScript `click at` + `screencapture` 可以逐步取证；
但 **WKWebView 不外露 web 内容的 accessibility 树**（`entire contents of window 1` 只有 4 个元素），
所以只能靠坐标 + 截图判读，**不能按角色/文本定位**。
另：**单次点击没反应不等于按钮被禁用**（焦点时序），重试一次再下结论。

## 14. 原生窗口生命周期的 macOS 真机门禁（ADR-074 / discussions/061，2026-09-15）

`scripts/verify-close-to-background-macos.sh`（约 4 分钟，35 条断言，exit code = 失败数，**空闲桌面上连续四轮全绿**；需要 `swiftc` 编译 `scripts/macos-hid.swift` 发真实输入，没有则退回 AX 且全屏步骤可能假红）。**Playwright 结构上碰不到关闭按钮、Dock、菜单栏 status item**，
这个门禁用 `System Events`（Accessibility）驱动**原生**窗口，断言只取 `pgrep` / `lsof -sTCP:LISTEN` / AX 窗口数 / `com.apple.spaces`，不看截图。
覆盖：X 隐藏 · Dock `Reopen` · Cmd+W + 菜单栏菜单 · 最小化→Dock · 全屏下 Cmd+W 只退全屏 · 二次启动 single-instance · Cmd+Q 零残留 ·
**反向臂**：用外来进程占住 4096 制造启动失败 ⇒ X 必须真退出。前置：终端有辅助功能权限；1420/4096-4099 空闲（**正式版 Ultrawork.app 现在关窗不退，先 Cmd+Q 它**）。

写这个门禁时踩的七个尺子坑（全部会把好产品判成坏的）：
1. **显示器睡眠后 AX 读到 0 窗口 / 0 菜单栏、`keystroke` 不投递、截图全黑** ⇒ 脚本自己 `caffeinate -d -u`。
2. **`grep -c` 零匹配时既打印 `0` 又返回 1** ⇒ `|| echo 0` 会输出两行 `0`；只有零匹配的断言红、四匹配的绿，看起来像产品在「X 后就 shutdown」。
3. **退全屏后 Dock 还在滑入，AX 点 Dock 会落空** ⇒ `click_dock` 重试一次并**打印出来**（重试是尺子抖，第二次失败才是产品）。
4. **`tauri dev` 期间改任何 `src-tauri/*.rs` 会热重建并静默换实例** ⇒ 一轮 soak 作废；门禁运行期间别碰 `packages/client/desktop`。
5. **AX 的 `AXPress`（模拟按绿色按钮）和 `keystroke` 不是真实输入**：连续几轮后 AppKit 的全屏状态机进入半状态——`toggleFullScreen:` 从任何来源都被吞、AX 点绿色按钮也退不出、只有键盘 ⌃⌘F 能救；换 CGEvent 真实鼠标/键盘（`scripts/macos-hid.swift`）后 16/16。
   **判据**：AX 只用来**读**（位置、属性、窗口数），凡是要**触发** AppKit 状态机的动作（全屏、关窗快捷键）用真实事件。差一点把「产品 50% 概率退不出全屏」写进 ADR。
6. **真实点击之后光标停在红绿灯上**：退全屏后 macOS 的「移动与调整大小」悬停弹出层会冒出来吃掉之后所有 Cmd+W / Cmd+Q；下一轮窗口开在同一位置，光标还在那儿，从第一步就中毒——两批三连跑全红，症状看起来像「产品退全屏后快捷键失灵」。每次真实点击后 `macos-hid move` 把光标停到窗口正文。
7. **门禁需要空闲桌面**：AX 点击和 CGEvent 都发给最前面的东西，用户开个别的 app 就整轮级联失败——跑前先问用户要一段窗口。

以及一条被门禁抓出来、手工探针 3/3 漏掉的产品缺陷：全屏 → Cmd+W 用 900ms 定时隐藏，窗口会以**全屏态**被藏起来、唤回后又是全屏。
手工探针与脚本只差几百毫秒的时序。修法不是调时间（styleMask 轮询同样 3/3 失败——AppKit 在退出**开始**时就清那一位），
而是改契约：全屏下关窗只退全屏、不隐藏。**没有外部可读的「退出完成」信号时，别用定时器假装有。**

## 15. 技能改动的 app 内真机验收：headless 驱动 sidecar API（2026-09-16，豆腐块守卫实战）

技能脚本改完，CLI 级门禁（`test-docx-skill.py` 等）全绿仍验不到三层：**安装副本有没有随 sentinel 刷新**、
**模型会不会把脚本的报错原样转述**、**会不会擅自走逃生口**。这三层没有门禁，但可以不用手点 app 就跑到：

1. `cd packages/client/desktop && bun run --bun tauri dev`（要造环境故障时把变量挂在这条命令前，如 `SAL_USE_VCLPLUGIN=svp`，
   它顺着 app → sidecar → python → soffice 传下去；用 `ps eww -p $(lsof -ti:4096)` **实证**变量到了 sidecar，别假定）。
2. 等 `GET /global/health` 200；核对 `~/.config/ultrawork/skills/builtin/.builtin-version` 等于本次打包的 hash。
3. 用 sidecar Basic Auth（`~/.config/ultrawork/sidecar-auth.json`）：`POST /session`（header `x-opencode-directory` = 工作区路径）→
   `POST /session/:id/prompt_async`，body `{"parts":[{"type":"text","text":…}],"model":{"providerID","modelID"}}` →
   轮询 `GET /session/status` 直到该 id 消失 → `GET /session/:id/message?limit=100` 读全部 tool part（`state.input.command` /
   `state.output`）和 assistant text。
   ⚠️ **model 要用工作区 `opencode.json` 里那个**（custom provider 的 baseURL 是 per-workspace 的，用全局 provider 会报
   `"undefined/chat/completions" cannot be parsed as a URL` 且会话 7 秒就 idle）。
4. 正向臂 + 故障臂各一轮；读的是**模型看到的原始 stdout/stderr** 和它**写给用户的那段话**，两者之间的失真就是要验的东西。

视觉/措辞判断留给人：产物面板里 PDF 看一眼、agent 回复能不能让不懂技术的用户明白「为什么没交付、修法在哪」。

## 16. 独立品牌发行版的验证（ADR-075）

身份与隔离决策见 [ADR-075](./decisions/075-independent-brand-releases.md)，构建命令和目录约定见 [build-and-deploy §0.6](./build-and-deploy.md#06-独立品牌发行版adr-075)。验证必须分别报告构建契约、运行时隔离、renderer 启动门禁、原生包与平台签名，不能用某一层的成功代替全部完成。

### 自动化命令与覆盖

以下命令从仓库根目录运行；Vitest/Bun 套件按包保持原有运行器。

```bash
# 配置/参数/图标、身份账本、构建租约、默认/定制 sidecar metadata、探针隔离与产物导出
bun test scripts/brand-build.test.ts scripts/brand-sidecars.test.ts scripts/mywork-icon.test.ts scripts/macos-icon.test.ts scripts/brand-macos-icon.test.ts scripts/setup.test.ts scripts/vendor-dependencies.test.ts scripts/vendor-patches.test.ts scripts/sync-plugin-version.test.ts
bun run --bun scripts/verify-dmg-layout.ts --self-test

# 可选真实 vendor Global 初始化验收：须先 checkout vendor 并准备其依赖
ULTRAWORK_TEST_VENDOR_GLOBAL=1 bun test scripts/brand-build.test.ts scripts/brand-sidecars.test.ts

# 官方原图保留，圆角派生图与来源摘要可重复生成
bun run --bun scripts/gen-mywork-icon.ts --check
bun run --bun scripts/gen-macos-icon.ts --check

# 纯身份、RuntimeContext、Bun/Python 真实子进程和同 HOME 多品牌持久化
bun run --bun turbo run test --filter=@agent/brand

# renderer：品牌文案、原生启动门禁、Blocked 页面、端口与凭证严格模式
bun run --bun turbo run test --filter=@agent/client-desktop

# 后端回归；ACP/Knowledge 使用 bun test，其余包使用各自 Vitest 脚本
bun run --bun turbo run test --filter=@agent/acp-client --filter=@agent/channel-gateway --filter=@agent/knowledge-sidecar --filter=@agent/orchestrator

# 完整工作区回归（含各包配置的前置构建/类型任务）
bun run --bun turbo run test

# delegate MCP：真实 HTTP 动态端口切换、预热与错误品牌 registry 零请求
bun test packages/agent/acp-client/src/__tests__/delegate-mcp.test.ts

bun run --bun turbo run typecheck
cargo test --manifest-path packages/client/desktop/src-tauri/Cargo.toml

# 已编译的本机四种 sidecar，各启动 Ultrawork/MyWork 一份；--keep 保留临时报告
bun run --bun scripts/verify-brand-sidecars.ts --keep

# 加入确定性 ACP Agent、Team 委托、Pipeline 与重启恢复
bun run --bun scripts/verify-brand-sidecars.ts --agents --keep

# 用本地 OpenAI-compatible SSE fixture 驱动真实 OpenCode 单 Agent/Team 工具循环
bun run --bun scripts/verify-brand-sidecars.ts --models --keep

# 真 Vite/React + Chrome，默认/MyWork × 三语 × 五类阻断/错误状态
bun run --bun packages/client/desktop/e2e/brand-startup.e2e.ts

# 正常 Ready 页面：默认/MyWork × 三语，Home/About 品牌、Solo/Team 切换与草稿保留
# IPC/HTTP 为明确 fixture，严格启动身份/端口/凭证门禁仍真实执行
bun run --bun packages/client/desktop/e2e/brand-ready.e2e.ts

# 可选 WebKit 家族复验；测试引擎只下载到仓库忽略目录
PLAYWRIGHT_BROWSERS_PATH=.brand-build/playwright bun run --bun node_modules/playwright-core/cli.js install webkit
PLAYWRIGHT_BROWSERS_PATH=.brand-build/playwright E2E_ENGINE=webkit E2E_OUTPUT=.brand-build/verification/browser-brand-startup-webkit bun run --bun packages/client/desktop/e2e/brand-startup.e2e.ts
PLAYWRIGHT_BROWSERS_PATH=.brand-build/playwright E2E_ENGINE=webkit E2E_OUTPUT=.brand-build/verification/browser-brand-ready-webkit bun run --bun packages/client/desktop/e2e/brand-ready.e2e.ts

# 已导出 DMG 的 manifest；验证包内签名、安装身份与中文/空格路径搬迁
bun run --bun scripts/verify-brand-macos-package.ts --manifest .brand-build/artifacts/mywork/darwin-arm64/manifest-darwin-arm64.json --output .brand-build/verification/macos-mywork-dmg.json --keep

# 对搬迁后的真实包内 sidecar 复验；替换为上一命令报告 copiedApp 的路径
bun run --bun scripts/verify-brand-sidecars.ts --binaries-dir '<copiedApp>/Contents/MacOS' --models --keep

# macOS 原生宿主：独立临时 HOME/XDG、C locale，不授予系统权限
# alternate 使用基础 identifier 的 MyWork.app，覆盖与 Dev 包的数据租约互斥
bun run --bun scripts/verify-brand-native-macos.ts --default-app '<Ultrawork Dev.app>' --brand-app '<copiedApp>' --brand-alternate-app '<MyWork.app>' --output .brand-build/verification/native-hosts-final-macos.json

# macOS 已安装默认构建→当前构建的数据前向读取；只执行显式 sidecar，不启动桌面宿主
bun run --bun scripts/verify-brand-upgrade.ts --legacy-app '<installed Ultrawork.app>' --output .brand-build/verification/legacy-default-data-forward.json
```

上述前置环境变量命令为 macOS/Linux shell 形式；Windows 用 PowerShell `$env:PLAYWRIGHT_BROWSERS_PATH` / `$env:E2E_ENGINE` / `$env:ULTRAWORK_TEST_VENDOR_GLOBAL` 设置同名环境变量。macOS 包验证器仅在 macOS 使用，不能以其结果替代其他平台安装验收。

品牌核心的 `runtime-integration.test.ts` 让 MyWork、第二品牌和默认 Ultrawork 在**同一个临时 HOME/USERPROFILE/XDG** 下运行真实 Bun 子进程，实际写入 ACP sessions、Gateway channels、Team registry、orchestrator runs、Knowledge SQLite 与 workspace 产物目录；旧默认数据只由默认品牌读到。另有 registry 品牌/instanceId 不符时拒绝使用 4099、受管缺上下文入口在初始化前退出，以及 Python 技能路径解析测试。它验证实际持久化实现；已编译 sidecar 联调由下一层单独负责。

`mywork-icon.test.ts` 在临时目录执行真实 Tauri icon，核对 MyWork 与默认图标的全部 15 个原生 PNG、ICNS 的 8 个 PNG/2 个 legacy alpha，以及 ICO 的 6 档尺寸；共 31 个原生表示的 alpha 差异像素均为 0，同时检查官方原图的不透明像素未被重绘或改色。`setup.test.ts` 在临时 checkout 中以惰性 git/bun/cargo/rustup stub 验证外部调用目录、中文/空格参数、默认 dev、品牌参数与 force 转发、退出码及失败前不执行外部命令；不会启动真实应用或安装依赖。Shell 相关测试仅适用于 macOS/Linux，Windows 继续执行跨平台入口和品牌构建契约。

上述原始模板保留不变，当前 macOS 应用图标另走 `macos-icon.test.ts`/`brand-macos-icon.test.ts`：真实 Tauri ICNS 的全部 PNG/legacy alpha 两品牌一致，1024px 主体为824px、边距100px；验证已留白/半透明/空图/非居中输入、重复处理不缩小、SVG文字与原Tauri对照、chunk排序确定性、仅导出ICNS不改PNG/ICO。真实自定义 prepare 在临时 checkout 内持有构建锁，核对配置和编译环境指向新 ICNS，UI仍用原snapshot，并验证默认回构不继承自定义overlay。`build.rs` 跟踪最终ICNS文件与环境变量；旧开发会话需完整退出重启，不能用WebView刷新替代。

依赖冻结由 `vendor-dependencies.test.ts` 的真实离线 file 包验证全 OS/CPU 安装、stale manifest 拒绝、Bun skip 环境覆盖清理及锁不变；wrapper fixture 覆盖五目标参数、缓存输入变化、损坏 metadata/二进制自动重建和失败不导出新缓存。`vendor-patches.test.ts` 使用真实临时 Git，覆盖 clean/全部已应用/旧源码已应用但新 pin 未应用、冲突前零写、`.git` 文件型子仓库与错误父仓库拒绝。版本同步另验证完整累计文件集合和真实 Git index 不被改动。Windows 跳过 Unix shell wrapper fixture，但执行其余冻结与 patch 契约；真实 native 构建由新增三平台 `vendor-build` CI job 执行。

`scripts/verify-brand-sidecars.ts` 使用已有的本机四种 native 二进制，在同一临时 HOME/XDG/workspace 下启动两个品牌共 8 个服务，分配独立动态端口且刻意使用**同一个密码**，避免把“密码不同”误当成数据隔离。基础模式校验所有服务错密码返回 401，通过真实 HTTP 写入/读取 OpenCode 全局配置与 session、Gateway 渠道、ACP agents、Knowledge 源，并检查配置/数据库落盘；写完 MyWork 后重读默认数据，停止默认四个服务后确认 MyWork 四个仍健康。

`--agents` 进一步用确定性本地 ACP fixture 检查单 Agent 的 Knowledge MCP、Team Leader/Member 的 delegate MCP、成员委托权限、Pipeline/worktree/产物持久化，以及 ACP 重启后单 Agent/Team 绑定与已完成 Pipeline 的恢复。`--models` 包含这些检查，并通过 `brand-model-fixture.ts` 在 loopback 提供 OpenAI-compatible SSE，驱动**真实 OpenCode**单 Agent 回复和 Team 的 `list_agents → delegate → ACP Member → tool result → 最终回复` 循环；不是用假 OpenCode HTTP 替代后端。`--binaries-dir` 可将同一验收转向从 DMG 搬迁出来的真实 sidecar，覆盖包内二进制和带中文/空格路径。finally 回收本脚本拥有的子进程，`--keep` 只留报告和日志。不接外部付费模型、真实 IM、远程知识库或真实第三方 ACP 产品，不能把本地 fixture 的通过解释为这些外部服务均已验收。

`verify-brand-upgrade.ts` 的范围是数据前向兼容，名称不表示已执行安装器升级。它只从显式指定的已安装默认 app 读取四种 sidecar 路径，在新建 HOME/XDG/workspace 下由旧构建写入 fixture，再由当前默认构建读取，最后检查 MyWork 不暴露这些默认记录。macOS `sandbox-exec` 独立拒绝临时根外写入，并先验证根内可写、根外写入失败的正负控制；不会启动已安装桌面宿主或复制真实用户数据。本轮旧/当前软件版本号均为 0.3.9，不能推导其他历史版本、降级或跨版本安装器兼容。

Rust 测试覆盖路径派生、身份记录、租约与进程身份等宿主规则；renderer 测试覆盖 host/界面身份不一致、IPC 异常、端口或凭证无效时进入 Blocked，以及阻断态不挂业务 providers。既有业务浏览器 harness 使用仅开发模式生效的显式 `__ULTRAWORK_BROWSER_TEST__` 标记；品牌启动 E2E 刻意**不设置**此标记，以执行严格 native 门禁。真实 native IPC 出错不能自动退回浏览器默认端口。

宿主复审后的完整 Rust 套件为 **185/185**（`.brand-build/verification/rust-jsonc-final-review.log`），macOS GUI/C locale 下中文进程路径的独立真实子进程回归也通过（`rust-macos-locale-review.log`）。新增负例及修复集中在：Windows PowerShell 进程身份 JSON 显式使用 UTF-8，避免客户中文路径受 OEM 代码页影响；macOS 内部 `ps` 查询固定 UTF-8 locale，避免 LaunchServices 缺省环境把路径转成 BSD `M-` 转义；拿不到 OS identity 时仍以真实 `CommandChild` 句柄回收自己启动的子进程；事件流关闭不是进程死亡证明，未收到终止确认不能提前删除 registry；正常 Unix 退出先 SIGTERM 等待 flush，强杀仅作超时兜底；旧 registry 的活 PID 无可信 identity 时阻断。IPC 在集中 ready 闸门只放行启动诊断所需入口，MockRuntime 使用真实 `copy_attachment_into_workspace` 验证 Blocked 不写入、Ready 才写入。macOS 上未执行 Windows 专属 PowerShell Unicode 分支，不能把本机通过数写成该 Windows 运行时行为已验收。

补充复审发现并修复两处真实重启/时序缺陷。其一，OpenCode 的 PATCH 写出带尾逗号的 JSONC，宿主旧纯 JSON 读取会跳过受管 MCP 归一，导致旧端口/品牌 environment 残留。现支持注释、尾逗号和 BOM，保留字符串中的 URL、Windows 路径及注释标记，仍拒绝缺值、重复逗号、未闭合注释等无效输入；I/O 或解析失败须在业务初始化前阻断，不能把已有配置当空对象覆盖。Rust 新增解析、用户字段保留、重复启动与失败不改原文件的回归。原生 harness 增加真实 `PATCH /global/config → 写入旧受管 environment 的 JSONC → crash/restart → GET /mcp` 验收；修复前包体确实因 stale `ACP_CLIENT_PORT` 未清除而退出 1（`native-jsonc-negative-control.log`），最新包体则保留用户字段、移除旧受管 environment，并将 Knowledge/delegate MCP 均恢复到 connected，正向结果已纳入最终原生 9 项报告。

其二，OpenCode 预热 stdio MCP 时 ACP 可能尚未确定动态端口，shim 不能在握手时把端口固定到整个连接生命周期。delegate/list_agents 现于每次工具调用读取当前品牌/instanceId registry，缺失或外来 registry 返回工具错误且不请求默认端口；由 ACP 直接注入的明确端口及无受管上下文的 standalone 行为保留。delegate 套件 **33/33、96 断言**（`delegate-lazy-registry-final.log`），含真实 HTTP 端口 A→B、外来 registry 零请求、预热握手不读取未就绪 registry；品牌真实子进程 integration **3/3**。两种 ACP 架构与三种 macOS 包已按最新源码重建，原生 **9 项**及最新 Universal 包内工具循环 **12 项**均复验通过；测试拥有的 native/MCP/sidecar 进程完成回收，随后只读进程检查未见残留。

公共默认/定制构建入口都校验四个 sidecar 的 metadata 与 builder 当前源码指纹；`--skip-sidecar` 不得放行缺失、旧协议或同协议旧逻辑的二进制。`scripts/sidecar-freshness.test.ts` 还使用复制的真实四个 builder 检查源码/依赖漂移、二进制与 metadata 篡改、纯读 `--check`、Universal 切片来源及两品牌公共入口前置拒绝；Linux 安装布局的异步校验必须完成后才能导出 artifact。OpenCode vendor build 的版本探针使用独立 `OPENCODE_TEST_HOME` 与四个 XDG 根，防止 import Global 时的初始化或缓存版本清理影响正在运行的用户程序。常规 CI 不依赖 vendor checkout 或其自身依赖目录，执行无 vendor 的真实子进程六路径/原 cache/version/canary 功能契约；真实 vendor Global import 为显式 opt-in 验收，设置 `ULTRAWORK_TEST_VENDOR_GLOBAL=1` 后缺少 vendor 或依赖会失败，不能静默跳过。

品牌浏览器脚本使用真实 Vite、React 与浏览器引擎，覆盖默认/MyWork × 英文/简体/繁体 × namespace 已占用、错误品牌、损坏状态、无效端口、无效凭证共 30 个场景。它检查只读诊断、复制/重试/退出、名称与 Logo，确认没有业务 Provider、业务 IPC 或后台 HTTP 请求，并保存报告及截图。Vite 的 `/src/components/session/*.tsx` 是模块加载，不能误作 `/session` API；侦听路径须从根锚定。

`brand-ready.e2e.ts` 补正常启动页面：每个引擎跑两品牌 × 三语共 6 条流程/30 个检查组，真实 React 渲染 Home/About、精确作用域内的默认棱镜或 MyWork 预置图字节、document title、Solo/Team 控件切换与往返草稿。它不设置浏览器宽松启动标记，使用明确 Ready IPC 与独立 loopback HTTP fixtures；拒绝未知 IPC、HTTP 写入、外部请求和浏览器错误。这里的 Solo/Team 是界面切换，真正工具循环由包内 sidecar `--models` 另验。Vite 直接由 Bun 执行 JS 入口，finally 回收自有进程。Playwright WebKit 仍不能代表原生 WKWebView 或系统权限已通过。

所有品牌测试须自建临时 home 与 XDG 根；不得清理或写入开发者真实 `~/.ultrawork`、`~/.mywork` 或现有配置。Rust 测试必须由 `cargo test` 选择 harness，不能直接执行未确认身份的 `target/debug/deps` 文件。原生界面工具可能重新启动应用且不继承脚本的临时环境，隔离验收不以此类手动启动替代；需要 GUI 操作时使用专用测试账号或 VM。脚本中的 home/XDG 隔离只覆盖应用业务目录，不承诺系统 WebView、LaunchServices 或权限记录零写入。进程测试只能关闭自己启动且身份可验证的子进程。临时监听/连接受环境限制时须记录受阻层次，不能把超时写成通过；偏离隔离要求的工具操作应独立记录，不能纳入“隔离无副作用”通过证据。

### 双品牌 Release CI 的验收

`v*` tag 的 `release.yml` 必须构建默认 Ultrawork 与 MyWork 各自的 macOS/Windows/Linux 安装包；六个任务全部成功后，发布 job 才收集本次 run 的品牌/平台 artifact。workflow_dispatch 可选 `all`、`default` 或 `mywork`，仅提供验证 artifact，不自动创建 Release。

每次发布保存 tag、提交 SHA、workflow run URL 和各品牌/平台的结果。发布 job 校验两品牌各三份 manifest，核对身份、release 模式及清单内安装包的大小和 SHA-256，拒绝缺包、额外文件和 GitHub Release 的同名安装包；只将清单核验后的安装包上传到同一个 Release。manifest 保留在品牌/平台 artifact 中，不能将扁平目录下的同名 manifest 混合发布。

两个 macOS 品牌须分别确认 Universal 架构、Developer ID Authority、`Notarization approved ✓` 和 `stapler validate` 通过。正式 tag 不允许 `--unsigned`、跳过公证或布局检查等降级；`ALLOW_UNSIGNED_RELEASE` 只适用于显式 dispatch 的 `.dev` 验包。Windows/Linux 记录实际打包与签名状态，不能将 macOS 的签名结论扩展到其他平台。

发布构建与客户机器验收分别记录：CI 打包或签名成功不能推导安装、升级、卸载、双品牌并行、真实账号业务和系统权限均已通过。补齐后在本节追加该 run 的实际结果，保留下面本机验收时的历史证据和环境限制；新 CI 尚未执行的项目不得提前写成通过。

2026-10-29 首次远端验收：PR #33 的提交 `c5a7b0adfe849155476dcaf3fdc9e6c813ff4936` 在 [CI run 40926729831](https://github.com/zhgqwx-del/ultrawork/actions/runs/40926729831) 完成 **16/16** 三平台门禁；合入 main 的 `19d98d56d9e55e9f6936b3c1f7949bc93c985b2f` 与该提交树一致。`v0.3.10` 的 [Release run 40929239588](https://github.com/zhgqwx-del/ultrawork/actions/runs/40929239588) 暴露两项阻断：两个 macOS 品牌完成 Universal 编译及签名操作后，Apple 自动公证返回 HTTP 403（必需协议缺失或过期），最终签名/票据校验未执行；Linux 检查器将没有 `./` 前缀的真实归档条目误判为缺文件。前者需要 Account Holder 核实协议状态，后者由后续 patch 版本修复并增加真实 `.deb` 门禁；不移动旧标签，不把该尝试记作已发布或公证通过。

该次发布尝试的完整结果如下；publish 因构建失败被跳过，没有创建公开的半套安装包。对应 main 的 [CI run 40929071877](https://github.com/zhgqwx-del/ultrawork/actions/runs/40929071877) 在仅重跑 Windows L3 压力自检耗尽 runner 内存的任务后完成 **16/16**。

| 平台 | Ultrawork | MyWork |
|---|---|---|
| macOS | Universal 编译、签名操作已执行；Apple 协议 403 阻断公证，最终签名/票据/DMG 验收未完成 | 同左 |
| Windows x64 | MSI、在线 EXE、离线 EXE 均构建成功，离线 WebView2 检查通过；未配置发行签名 | 同左 |
| Linux x64 | deb/rpm 已生成，随后布局检查器误判而失败，未导出通过校验的发行 artifact | 同左 |

Linux 修复由 [PR #34](https://github.com/zhgqwx-del/ultrawork/pull/34) 合入 main 的 `209429770fa22033a2520fd1e4f67dbca710dbdf`：Debian 通过 `dpkg-deb --fsys-tarfile → GNU tar` 流式读取机器文件列表，RPM 保留权限模式与完整文件名；同时检查两侧退出码并限制诊断长度。提交 `a2e4c992be594e543e11444513d2d6f55808de32` 的 [CI run 40934056079](https://github.com/zhgqwx-del/ultrawork/actions/runs/40934056079) 完成 **16/16**，Linux 的六个真实 deb 正例与缺文件、跨品牌污染、损坏载荷三个负例全部通过；macOS/Windows 四项解析测试通过，三个 Linux 原生测试明确跳过。后续 `v0.3.11` 的正式发布验收结果如下；不能将首次尝试中的编译及签名操作等同于公证成功。

### v0.3.11 正式发行验收（2026-10-29）

Account Holder 处理协议后，以 `07cdda9502471862c36bea3996b2287b63295aa6` 创建新标签 `v0.3.11`，旧标签保持不变。[该提交的源码 CI](https://github.com/zhgqwx-del/ultrawork/actions/runs/40941185560) **16/16** 成功，[Release run 40986120666](https://github.com/zhgqwx-del/ultrawork/actions/runs/40986120666) **8/8** 成功（guard、六个构建、publish）；[正式 Release](https://github.com/zhgqwx-del/ultrawork/releases/tag/v0.3.11) 为非草稿、非预发布，两个品牌各六个、共 **12 个安装包**均已上传。发布前六份 manifest 的身份、大小、SHA-256 校验通过；本机随后下载全部产物独立复验，并逐个匹配 GitHub Release API 的文件名、大小与 digest（`release-v0.3.11-final-assets.json`）。

| 平台 | 两品牌实际结果 |
|---|---|
| macOS | 两个 Universal DMG 均通过 Developer ID、代码签名、公证、app/DMG staple 与独立 validate；DMG 布局通过，应用在左、Applications 在右 |
| Windows x64 | 每品牌 MSI、在线 EXE、离线 EXE 共三包构建通过，离线 WebView2 内容与大小检查通过；未配置发行签名 |
| Linux x64 | 每品牌 deb/rpm 均构建通过，实际安装包主程序、带品牌前缀的 sidecar 与品牌资源路径检查通过；未配置发行签名 |

下载的两个 macOS 包分别完成 **7 项静态验包**，包含 manifest/hash、Info.plist 身份、中文/空格路径搬迁、图标逐字节一致、资源与动态库依赖检查；五个二进制均有 ARM64/Intel 切片。另行确认 Developer ID Authority、Hardened Runtime、app/DMG 离线票据，Gatekeeper 均返回 `accepted / Notarized Developer ID`。报告：`release-0.3.11-{default,mywork}-{package,signed-macos}.json`。

两个签名包的 sidecar 各完成 **12 项本地业务验收**：分别在两品牌 namespace 下验证八服务并行、同密码鉴权负例、数据隔离、单 ACP＋Knowledge MCP、Team Leader/Member 委托、成员权限、Pipeline/worktree/产物、ACP 重启恢复，以及真实 OpenCode 的本地 SSE 模型工具循环。整个 harness 使用新建 HOME/XDG/TMPDIR、禁用真实 Git 配置/模板/hooks/签名的 shim；额外文件写入沙箱仅放行本次临时根及 `/dev/null`，目录内可写/目录外拒绝及 loopback 正向控制通过。未启动桌面宿主、未使用真实外部账号；没有将这些 fixture 扩写为独立证明零外网连接。报告：`release-0.3.11-{default,mywork}-signed-sidecars.json`。测试脚本回收自有句柄后，只读快照中已记录的直接 PID、临时上下文根、复制包路径及 fixture 命令均无残留；此结论不扩展为全系统所有孙进程的普遍证明。

正式发行与以上自动化验收已完成；下方历史快照仍保留取证时的未验状态。Windows/Linux 图形桌面安装、升级/卸载及双品牌并行，Intel macOS 实际运行、系统权限弹窗、真实 IM/模型/知识库/第三方 ACP 账号仍按本节原生场景步骤补验，不能用构建、静态签名或本地 fixture 代替。

### 本机验证边界快照（2026-10-29）

下表记录发布 CI 启动前的本机验收结果；“未触发远端 CI”等内容描述取得该证据时的状态。后续 CI 与原生安装结果须关联具体 tag、提交和 run 单独追加，不能覆盖成这些本机测试已验证其他操作系统或正式签名。

| 项目 | 已掌握证据 | 尚未完成 |
|---|---|---|
| 品牌核心、构建与后端 | 完整工作区 test 的 **13 个任务全部成功**（9 包范围，含前置任务，`all-packages-final.log`）；品牌身份/上下文/真实子进程及后端套件通过。常规构建契约 **29 通过、1 显式跳过**，真实 vendor opt-in **30/30 通过**（`build-contracts-clean-ci.log`、`build-contracts-vendor-optin.log`），含 PNG 解码、默认兼容、签名、Linux 安装布局、macOS 单实例键冲突、默认 metadata 反例及探针隔离；DMG 布局 self-test **9/9** | Windows/Linux 本次 CI/native 证据需单独核对；本机解析器/fixture 测试不能冒充原生安装通过 |
| 图标对齐与 setup 补充回归 | 构建、sidecar、图标、setup 四个脚本套件合并执行 **38/38、452 断言**（开启真实 vendor opt-in，`brand-icon-setup-vendor-final.log`）；默认图标/源码 patch 未改，官方原图摘要不变；31 个原生图标表示 alpha 差异像素为 0。最新圆角图 DMG 已重建，包内 ICNS 与当前 digest 的生成结果逐字节一致；报告 `packaged-mywork-rounded-icon.json` | Windows/Linux 图标 CI 结果待确认；setup 的 4 个 Unix stub 流程测试在 Windows 跳过，不等于 Windows 安装/setup 流程已实际通过 |
| macOS Dock 留白修正 | 默认/MyWork 专用 ICNS 的主体均为 **824/1024**、居中边距100px。新增 helper/真实品牌prepare契约后，九套脚本共 **63/63、920断言**，Rust **185/185**、9包类型检查通过。真实 Cargo dev 二进制完成 **默认→MyWork→默认** 三次编译，每次均在Mach-O中找到当前带留白ICNS、未找到旧全幅默认ICNS（`macos-dev-icon-embedding.json`）；默认ARM64/MyWork Universal新DMG各 **7项**静态验包通过，按Info.plist读取的icon-macos.icns与当前预期文件逐字节相同（`macos-icon-{default,mywork}-dmg.json`） | dev二进制仅编译/检查，未启动当前用户应用；对比预览不是实时Dock截图。Windows/Linux原生运行边界不变，旧dev会话须退出重启以重新准备overlay |
| 依赖冻结与 patch 维护补齐 | 冷缓存/无 node_modules/独立 vendor Git 子仓库的生产 helper 冻结安装 **5067 包通过**，锁 SHA-256 为 `ba3c1519e746a9ee89afd2df716c59aa8d9d1903b63cd0a871d3bced93843e5f` 且安装/编译后不变；原 `4af877d` 实际依赖链接恢复，10 个五目标所需 native optional 包存在；冷副本内嵌 Web UI/Intel sidecar 编译通过。七套构建/图标/setup/冻结/patch/sync 契约 **55/55、662 断言**（真实 vendor opt-in，`dependency-freeze-all-contracts-final.log`），9 包 typecheck、工作区 13 任务、Rust **185/185** 通过 | 五目标编译覆盖 macOS ARM64/Intel、Windows x64、Linux x64/ARM64，报告 `dependency-freeze-builds.json`；Windows/Linux 不可在本机执行，新增三平台真实 vendor-build CI 尚未触发 |
| 冻结依赖后的最新 macOS 包 | 默认 ARM64/MyWork Universal DMG 均按冻结构建重打；布局、包内 ad-hoc deep/strict 签名、中文/空格路径搬迁、269 个文本资源无 checkout 依赖、五个 Mach-O 依赖检查通过（`dependency-freeze-{default,mywork}-dmg.json`）。最新包的原生双宿主 **9 项**与 Universal 包内真实单 Agent/Team/Pipeline/MCP/重启工具循环 **12 项**复验通过（`dependency-freeze-native-macos.json`、`dependency-freeze-sidecars-models.json`），自有进程完成回收 | 本机执行 ARM64；Intel 运行、正式签名/公证、系统权限和跨版本安装器升级仍未验收。原生互斥负例使用此前基础 identifier 的 MyWork.app，只验证其在数据租约前阻断 |
| macOS ARM64 native sidecars | 8 个真实服务同 HOME/XDG/workspace、同密码并行；错密码 401，真实 HTTP/配置/数据库隔离，停默认后 MyWork 健康，finally 全回收。源码二进制及搬迁包内二进制均通过 | 不代表真实 IM/远程知识源或外部模型服务已通过 |
| macOS 原生双宿主 | 最新修复包在独立临时中文/空格 HOME（`客户 Home`）与 XDG、`LC_ALL=C` 下完成 literal 中文路径、8 端口并行、重复 identifier、同 namespace Dev/基础身份互斥、崩溃/重启回收、JSONC 全局配置/受管 MCP 重启恢复及退出互不干扰，**9 项通过**；报告 `native-hosts-final-macos.json` 的 succeeded 为 true。新增 JSONC 检查在旧包上先真实检出缺陷（`native-jsonc-negative-control.log`），最新包保留用户字段、移除旧受管 environment，Knowledge/delegate 均 connected | 正式签名权限、托盘交互和跨版本升级不由此推导 |
| 单 Agent / Team / Pipeline | 两品牌单 ACP＋Knowledge MCP、Leader/Member delegate、成员权限、Pipeline/worktree/产物持久化及 ACP 重启恢复通过；真实 OpenCode 由本地 SSE fixture 驱动单 Agent 与 Team 工具循环通过。最新 Universal 包内复跑 **12 项通过**，报告 `sidecars-models-universal-final.json`（ARM64 执行）；delegate 动态路由套件 **33/33、96 断言**，品牌 integration **3/3** | ACP Agent 和模型使用确定性本地 fixture，真实第三方产品、账号和模型质量另验 |
| 旧默认构建的数据前向读取 | 已安装 0.3.9 的真实 sidecar 写入配置、会话、渠道、Agent、知识源 fixture，当前默认构建（同为 0.3.9）经五类 HTTP API 全部读回；同 HOME/workspace 下 MyWork 不暴露默认记录。独立文件写入沙箱正负控制通过，12 个进程全部退出且 cleanupErrors 为空；报告 `legacy-default-data-forward.json` | 只证明该已安装构建→当前构建的受测数据前向读取，不是跨版本安装器升级、降级或真实账号验收 |
| Desktop / 类型检查 | Desktop **933** 项测试通过（`all-packages-final.log`），9 包 typecheck 全部通过（`typecheck-final.log`） | 不代表真 WebView 或完整安装链已验收 |
| Rust 宿主复审 | 完整套件 **185/185**（`rust-jsonc-final-review.log`），含 JSONC 严格读取/受管 MCP 重启归一/读写失败不覆写、macOS C locale＋中文路径真实子进程、集中 IPC MockRuntime 真复制命令的阻断/允许对照、数据租约、进程身份及精确回收负例 | Windows 专属进程查询分支及 Windows/Linux 原生启动仍需对应 runner/主机 |
| 品牌浏览器 E2E | Chrome **156.0.8078.74 30/30**、WebKit **26.5 30/30**；报告和截图分别在 `.brand-build/verification/browser-brand-startup/` 与 `browser-brand-startup-webkit/` | 浏览器 shim 不替代原生宿主/系统授权；本轮已消除先前超时与测试正则误判的阻塞 |
| 依赖冻结后的浏览器补充验收 | Chrome **156.0.8078.74**、WebKit **26.5** 各 30 个严格阻断场景通过；正常 Ready 两品牌 × 三语各 **6 流程/30 检查组**通过，Home/About logo 精确作用域与当前素材字节核对，Solo/Team UI切换和草稿保留通过。冻结依赖 ARM sidecar 下 i18n 6 项、Settings 两引擎各 10 项通过；汇总 `dependency-freeze-browser-summary.json` | Ready 的 IPC/HTTP 是明确 fixture；不代表原生 WKWebView、真实模型/账号或系统权限已通过。真正工具循环由包内 sidecar 另验 |
| 既有浏览器业务回归 | 国际化切换/持久化、真实 ACP 计划链路、设置三分区 Chrome/WebKit 走查均通过；`browser-i18n.log`、`browser-plan-acp.log`、`browser-settings-tabs*.log` | 设置/i18n 使用部分后台 fixture 或未启动 sidecar，日志的已知 offline 噪声按原套件边界处理；不宣称所有业务功能零错误 |
| macOS `.app` 公共入口 | `APPLE_SIGNING_IDENTITY=-` 经公共 wrapper **默认 → MyWork → 默认** 三次 app-only 构建均返回 0；默认/MyWork 均通过 `codesign --verify --deep --strict` | 此行只验证包结构，native 生命周期另列；ad-hoc 完整性不等于 Developer ID 正式签名、公证或权限验收 |
| macOS DMG / Universal | JSONC/动态路由修复后，默认 ARM64 DMG、基础 identifier 的 MyWork ARM64 app、MyWork Universal Dev DMG 均重建成功（`default-native-release-final.log`、`mywork-base-native-final.log`、`.brand-build/mywork/universal-release-final.log`）；真实布局 `app.x=180 < Applications.x=480`，导出 hash/大小匹配 manifest，包内 ad-hoc deep/strict 校验通过；MyWork 五个 Mach-O 均含 `x86_64 arm64`。最终报告 `macos-default-dmg.json`、`macos-mywork-universal-dmg.json` | Intel Mac 运行、Developer ID 正式签名、公证、Gatekeeper 和系统权限未验收 |
| 客户路径可移植性 | 最新 DMG 复制到临时中文/空格客户目录后签名不变；269 个包内文本资源无 checkout 路径；5 个 Mach-O 只依赖相对或系统 dylib；搬迁后真实 sidecar 单 Agent/Team/重启循环通过；原生宿主还在中文/空格 HOME 下验证 JSONC/MCP 恢复 | 不承诺所有客户 OS/CPU/第三方运行时均满足，编译诊断中的源码字符串不等于运行依赖 |
| MyWork Windows / Linux | 三平台代码分支和 CI 门禁已配置 | **native 打包、签名、安装、升级、卸载与共存未验收**；本机没有对应 OS/VM，也未触发远端 CI |

此前（Dock留白修正前）连续构建的实际 Info.plist 核对为 `Ultrawork / com.ultrawork.desktop / ultrawork` 与 `MyWork / com.ultrawork.mywork / mywork`（名称 / identifier / 可执行文件）。当时默认 ICNS 的 SHA-256 与源码 `icons/icon.icns` 完全相同，且与 MyWork 不同；两包内技能 `.builtin-version` 也不同，证明品牌后回构未沿用自定义图标或技能包。报告在 `.brand-build/verification/packaged-apps-macos-arm64.json`（ignored）。此前另有 `MyWork Dev.app` 手工 ad-hoc 校验，它同样不属于正式签名验收。

此前仅对齐两品牌圆角时另行重建 MyWork Universal Dev DMG（`.brand-build/mywork/universal-release-icon-aligned.log`），当时搬迁/签名/架构报告为 `macos-mywork-icon-aligned-dmg.json`。包内图标检查按 manifest 的品牌 digest 精确定位生成输入，而非取任意旧 staging；当时 ICNS 为 277157 字节，摘要见 `packaged-mywork-rounded-icon.json`。上述业务与原生生命周期代码未在此次图标/setup 补齐中改变，不把先前报告伪写成新包已重复执行全部场景。

原生包内验证和后台扩展报告均放在忽略目录 `.brand-build/verification/`。此前 DMG 的 Finder `-1712` 和 Chrome 连接超时属于历史尝试，本轮已真实复验通过；没有通过关闭 DMG 布局校验来把失败转成成功。原生双宿主生命周期报告已取得，但不能把它等同于三平台全部原生验收或正式权限授权。本机检查为零个有效 Apple codesigning identity，且未配置公证凭证；正式签名、公证和系统权限不能用 ad-hoc `.dev` 包替代。通过上述测试不能证明所有客户环境或所有输入都不存在缺陷。

本轮还以隔离探针环境尝试 `arch -x86_64 <Intel OpenCode> --version`，返回 `Bad CPU type in executable`，因此本机也无法用 Rosetta 补执行 Intel sidecar；报告 `dependency-freeze-rosetta-smoke.json`。工具路径探测未找到可用 Windows/Linux 虚拟机或容器 CLI，不能把已生成 PE/ELF 文件写成对应系统运行通过。

### 模型身份与技能内容补齐（2026-10-30）

本轮修复以默认 `Ultrawork` 与品牌配置 `MyWork` 为验收对象，保持版权/来源、模型策略、Team 角色、权限及业务路由。vendor 累计 patch 增至 28 个文件，子模块提交不变；stock provider 基座只适配已知身份句，其余逐字保留，8 个家族及合法特殊产品名均有回归测试；身份与丰富输出开关解耦。ACP 的显式 `metaSystemPrompt` 经 API/文件保留，普通编辑不清空，非法类型拒绝。

- 确定性提示词测试检查两品牌、自定义名称、开关组合、坏上下文阻断与原文保留；Python/JS 对 29 组名称及身份案例做真实跨语言对比。DOCX 品牌专测 44 项检查实际元信息、作者优先级及坏上下文。
- 重编本机 ARM64 sidecar 后，`scripts/verify-brand-sidecars.ts --models --keep` 检查两品牌同时运行、数据/鉴权隔离、ACP 单 Agent、Team Leader/成员、Pipeline/worktree、metadata/prefix 身份与重启恢复。真实 OpenCode 对本地 OpenAI-compatible SSE fixture 发起单 Agent 与 Team 工具循环；fixture 校验**实际 HTTP system 提示中的品牌身份**，不能用预设回答代替该检查。汇总日志 `.brand-build/verification/identity-sidecars-models.log`，报告另存 `identity-sidecars-models.json`。
- Chrome 156.0.8078.79 与 WebKit 26.5 各通过两品牌 × 三语的 6 条 Ready 流程 / 30 项 UI 检查，包含 Solo/Team 切换；IPC/HTTP 使用显式 fixture。报告与截图目录 `identity-browser-chrome/`、`identity-browser-webkit/`（均位于 `.brand-build/verification/`）。
- 实际重打两品牌技能 ZIP 并解压核对钉钉路径、Windows 指引、中性宿主文案、原作者来源及 runtime helper，报告 `identity-pack-skills.json`。DOCX 全量行为回归 266 条结果、0 失败、5 项环境跳过；本机 bundled LibreOffice 需测试进程指定 `svp` 与临时 Fontconfig，5 项跳过是无法制造无中文字体环境的 tofu 负向控制，不能标成通过。报告 `identity-docx-selftest.json`。

本地模型/ACP fixture 验证协议内容与工具流程，不证明在线模型每次自称正确，也不替代 Claude/Codex/Gemini 等真实第三方账号和 adapter 的抽样。prefix-only adapter 自行压缩历史后若丢弃首轮提示，ACP 协议没有统一的永久 system append 保证；支持 metadata 的 adapter 在 load 时重新追加。Windows/Linux 原生执行、安装/升级和签名发行仍须对应宿主或 CI 验证，不能用 macOS 本机测试替代。上述修复未自动变成已有 `v0.3.11` 安装包的内容，需另行发布版本。

### 追加独立 review 与客户路径验收（2026-10-30）

追加 review 找到并修复三项构建边界：品牌技能中断缓存可能被复用、同协议旧 sidecar 可经跳过编译打包、直接 Tauri Linux 安装布局检查未等待完成。业务模型路由、权限、Team 委派和运行数据格式没有改动。新增 staging 完成标记与原子发布；四 builder 的 `--check` 复用原有 hash 规则，公共入口在资源/签名前校验新鲜度；构建与打包脚本加入三平台严格类型检查。

- 独立复跑身份 98/98、ACP 身份恢复 18/18；构建相关八套回归 71 通过、0 失败，4 项本机不具备 Linux 工具的场景按环境跳过，由对应 CI 执行。完整品牌构建 opt-in 套件 29/29；完成标记不进入技能 ZIP。Windows 回归使用异步子进程并发读取 stdout/stderr，入口多案例按实际调用量设置测试预算，保留每个子进程独立超时及错误诊断。
- 当前四个真实 sidecar 复制到源码目录外的中文/空格路径、全新 HOME 后，单 Agent、Team、Pipeline、重启及实际模型 system 身份 13 组通过。Chrome/WebKit 各重新通过两品牌三语 6 流程/30 检查。日志前缀均为 `.brand-build/verification/identity-recheck-`。
- 实际构建默认与 MyWork 两个 ARM64 Dev DMG，后者使用新鲜 sidecar 的 `--skip-sidecar` 正向路径。两包均通过 7 项 DMG 哈希、包名/identifier、图标字节、深度签名、中文/空格搬迁、269 个包内文本无 checkout 引用、5 个 Mach-O 仅依赖系统或相对库检查。报告 `identity-recheck-package-default.json` / `identity-recheck-package-mywork.json`。
- 两个搬迁后的真实 `.app` 在中文 HOME、C locale 下通过原生宿主 8 项启动/隔离/互斥及 MCP 重启检查；从两份 DMG 内实际 sidecar 分别跑两品牌工具循环，各 13 组通过，所有自建子进程已回收。报告 `identity-recheck-native-hosts.json`，日志 `identity-recheck-packaged-default-sidecars.log` / `identity-recheck-packaged-mywork-sidecars.log`。

以上是 ad-hoc 签名的本机 ARM64 验收，不是 Developer ID、公证、Gatekeeper/权限或其它 OS 安装升级结论。跨 checkout 的已有二进制因原 hash 包含路径标签可能需要重编，这只影响构建缓存，客户运行不执行该构建门禁。真实模型和第三方 ACP、prefix 历史压缩边界仍同上节，不能承诺任何客户环境绝对无缺陷。

### 追加真实在线模型与外部 ACP 抽样（2026-10-30）

真实在线模型抽样发现，仅在 system 末尾追加品牌身份，仍可能被上游预置基座的 `You are opencode` 首句干扰。因此追加在 provider 选择阶段适配八类 stock prompt 的已知身份首句，其他策略/来源和用户、Team、自定义提示保持原文；累计 vendor patch 为 28 个文件，submodule 提交不变。提示词纯测试 120 项、品牌包 38 项及工作区 13 个测试任务通过，独立 review 未发现新增阻断缺陷。

使用现有模型服务配置、隔离 HOME/XDG/中文工作区和当前四个原生 sidecar，实际调用 `qwen3.7-flash`，两品牌的中英文单 Agent、Team Leader 和两个独立 OpenCode 子会话共 12 条身份回答均命中正确品牌；单 Agent 和成员的真实文件写读均完成。报告 `.brand-build/verification/identity-live-headless-report.json` 保留完整结果：Ultrawork 两个子会话还主动附带底层模型名，因此严格的“不得披露模型名”检查仍失败，整套退出码为 1，不能写成全部通过。Team 的两个成员为同一 OpenCode backend 下的独立会话，不代表 UI 自定义 persona 的验收。

真实外部 Agent 抽样使用官方 `codex-acp 2.5.0`、其配套 Codex 及当前 ACP sidecar；两品牌单 Agent 与 Team 的自然自介均通过，另行追问执行 Agent 时保留 Codex 身份。Team 成员收到逐字自然问句且无品牌提示，真实 delegate、ownerSessionId 与成员交付均核对。临时登录去除 refresh token，原始登录文件前后校验一致，运行结束删除临时凭证。结果分别保存为 `identity-real-acp-solo.json`、`identity-real-acp-team.json`。发现新桥接的 MCP 权限在当前 UI 被归类为 `bash/exec-UUID` 的显示瑕疵；本轮未改产品分类，测试仅在核对同一 tool call 的真实 `mcp.orchestrator.delegate`、成员 ID 和本轮工作区后精确允许，未笼统放行 shell。

补充 Chrome + Vite 在线验收的入口在忽略目录 `identity-live-browser.ts`，报告/截图位于 `identity-live-browser/`。其 HTTP、SSE、模型及文件工具走当前真实 sidecar，只有 Tauri IPC 使用显式测试适配；Team 经真实 REST 创建后打开 UI，不能表述成已经覆盖 Home 的成员选择创建流程。验收还须等待新 user 对应的最终 assistant 正文以及 UI 的 SSE idle，不能用上一轮回复、工具步骤叙述或侧栏品牌名称代替模型回答。具体通过与失败以报告为准；首轮 harness 误判报告保留供追溯。

上述测试不修改真实业务配置，不证明全部模型/第三方 adapter 的输出都确定，也不替代 Windows/Linux/Intel Mac 原生安装、正式签名、公证和系统权限验收。当前已发布安装包仍须新发行才包含这些修改。

### 身份稳定性与 Codex MCP 授权显示收敛（2026-10-30）

移除系统环境中主动声明 `You are powered by ... exact model ID ...` 的冲突句，实际模型选择仍沿用既有请求参数、Agent 配置和默认配置。Anthropic/Codex 的第二句 stock CLI 自称定向适配为中性编码职责；其余编辑、工具和来源信息保留。宿主身份指导限定为自我描述，不给普通任务、文件和工具参数增加简介。独立 review 以 32 组基座、LF/CRLF 和特殊品牌名验证非目标正文保持完整。

Codex 的 MCP `request_permission` 可能只有 `execute/exec-UUID`，同一调用更早的通知才有 server/tool/arguments。显示解析现在只借用当前会话、当前轮次、同一 ID 且无冲突的信息：有意义的新标题、显式 kind 冲突、跨会话/跨轮次及封口后的旧缓存均不复用；无结构化证据的 opaque execute 显示中性 Tool Action。MCP 权限展示工具名和多行 JSON 参数，单 Agent、Team 子权限及 Pipeline 权限区均可换行滚动。授权 optionId、once/always/reject 映射、路由、超时和默认拒绝没有变化。若详情在权限 RPC 之后才到达，本实现不等待或猜测未来信息，也不重发授权事件。

回归包括提示词 120 项、wire 4 项、品牌包 38 项、ACP 全量 181 项，以及真实 stdio 的授权前阻塞、三个原始 optionId 映射和真实 shell 不误归为 MCP。新权限合同和两个 renderer 权限套件纳入显式三平台 CI（Windows 既有全 workspace 跳过不再遗漏这些合同）。完整工作区 13 个测试任务与 9 个 typecheck 任务通过。

真实测试分离身份和业务任务，固定轮数，不把文件完成回复必须带品牌作为产品契约，不重试至绿。两品牌 × 两轮共 28 条单 Agent、Leader、直接真实成员自然问句中 27 条通过，MyWork 一次回答仅为 `4`（未串品牌或泄露模型名），失败保留在 `identity-stability-headless-report.json`；两品牌的 4 组真实文件/委派业务任务均通过，内容精确且无简介污染。Chrome 两品牌各 6 项流程通过，包含真实问答、读写、历史、Leader/工具后自介和真实两子会话文件任务；浏览器 IPC 为显式适配，HTTP/模型/SSE 为真实服务。报告 `identity-stability-browser/report.json`。

真实 Codex ACP 的两品牌单 Agent、Team 拒绝、Team 仅此次允许分别通过；权限必须从实际 SSE 显示的 `mcp`、工具名、JSON 与 metadata 核对范围，不再靠旧工具历史补偿错误显示。拒绝案例未产生 delegate，允许案例才真实执行；原登录文件校验未变，临时凭证不含 refresh token 且运行后删除。报告 `identity-stability-acp-solo.json`、`identity-stability-acp-team-reject.json`、`identity-stability-acp-team-once.json`。另行固定 8 次 wire 诊断均正确，检查了实际 system 品牌/无冲突声明、上游内容增量和最终 API 正文一致；未记录凭证或真实 endpoint，报告 `identity-stability-wire-diagnostic.json`。该轮未复现 `4`，原异常缺少 wire 证据，不能确定归因为服务端或软件整形；不能把新 8 次正确作为抹去原失败的依据。捕获真实事件后的 Chrome 权限显示报告位于同一忽略验收目录；这些结果与环境边界须分别陈述，不能宣称任意模型始终遵循所有指令。

上轮浏览器“漏自介”的实际 delegate task 没有转交自介要求，不能归因于成员丢失品牌上下文；另一次文件混入简介是 Leader 把子任务改成了“在文件中介绍软件”。原始报告仍保留，新测试以无品牌提示的独立身份问题及中性文件标记避免跨层误判。以上软件合同和真实协议验收不替代后续正式签名、系统授权弹窗及其他 OS 的原生安装升级验收。

### 发行包的原生场景验收

以下场景需在对应系统补齐；Release CI 的构建结果不能替代其通过证据。

在 macOS、Windows、Linux 各自宿主上构建并安装默认 Ultrawork 与 MyWork，核对程序名、应用/托盘图标、identifier/包名、快捷方式和实际路径。两个品牌同时运行时分别发送消息、写入渠道/知识库/历史，再重启确认隔离；同品牌 Dev/正式版应互斥。缺/坏上下文、旧 registry、错误身份标记或已被占用的数据租约应阻断且不启动业务。

针对同品牌新旧版本验证升级保留自己的数据，卸载/重装不会修改另一品牌；对 Windows MSI/NSIS、Linux deb/rpm 逐项核对。macOS 的权限验收须使用已正式签名的品牌包，分别检查屏幕录制、通知、Gatekeeper、公证与 DMG 布局；ad-hoc `.dev` 包的结果不能作为正式包权限结论。

### 需要人工配合的真机验收方法

常规品牌界面、数据隔离和本地模型工具循环已有自动化，不要求再手点一遍代替测试。以下用于补齐正式发行、其他 OS 与真实账号边界；建议使用独立系统测试账号和新建工作区，分别安装默认与 MyWork 的正式签名包。

1. 从系统启动器打开两个品牌，检查名称、圆角图标、About、托盘/菜单栏和三个语言。分别首次配置模型/外部 Agent，确认配置和历史不会出现在另一品牌。
2. 单 Agent 在新工作区输入：`只在当前工作区新建 brand-single-smoke.txt，内容为 SINGLE_AGENT_OK。然后读取该文件，报告完整路径和内容。不要访问网络。` 检查正文、工具过程和产物预览，重启后确认记录与文件仍可读。
3. 配置两名可用成员并选择 Team，输入：`请使用团队协作：成员 A 新建 team-a.txt，内容 TEAM_A_OK；成员 B 新建 team-b.txt，内容 TEAM_B_OK；Leader 读取两份文件，新建 team-summary.md 汇总完整路径和内容。仅在当前工作区操作，无需联网。` 检查成员状态、委托权限、文件和汇总，重启后确认 Team 绑定与历史仍在。
4. 执行任务时关闭主窗口，确认托盘/菜单栏常驻、任务继续；从托盘恢复后再显式退出，确认另一个品牌仍正常。正式签名包中验证通知授权、后台通知与截图按钮：首次拒绝、再次授权、Esc 取消、成功添加附件；系统权限弹窗需要用户本人确认。
5. 各品牌用更新版本安装器覆盖升级，再卸载/重装其中一个，确认自己的数据按预期保留、另一品牌文件/数据未变。Windows 分别验 MSI/NSIS，Linux 分别验 deb/rpm；未实际执行升级前不能写成通过。

补齐这些边界需要对应 Windows/Linux/Intel Mac 测试环境、正式签名/公证配置，以及需要验证的真实模型/外部 Agent/渠道账号。凭证应放在本机或 CI 的安全配置中，不写入仓库或测试报告。
