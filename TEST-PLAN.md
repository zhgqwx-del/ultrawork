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
| Tauri 集成 | 原生功能 | E2E | ❌ 手动 |
| OpenCode 联调 | 端到端流程 | E2E | ❌ 手动 |

---

## 2. 测试框架与工具

- **测试运行器**: Vitest (与 Vite 原生兼容)
- **DOM 环境**: jsdom
- **React 测试**: @testing-library/react + @testing-library/jest-dom
- **Mock**: vitest 内置 vi.mock / vi.fn / vi.spyOn
- **覆盖率**: vitest 内置 c8/v8

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
| `ConfigStorage.save` | 正确写入 localStorage | P0 |
| `ConfigStorage.reset` | 删除 localStorage 条目 | P0 |

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
| 初始状态 - 有存储 | 从 localStorage 恢复 | P0 |
| `toggleFavorite` - 添加 | 添加到收藏 | P0 |
| `toggleFavorite` - 移除 | 从收藏移除 | P0 |
| `isFavorite` | 查询收藏状态 | P0 |
| 持久化 | 变更后同步到 localStorage | P0 |

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
| SkillsPanel | 命令和技能显示 | P2 |

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

### 4.4 MCP & 命令

| # | 测试场景 | 步骤 | 预期结果 |
|---|---------|------|---------|
| C1 | MCP 列表 | 右侧栏 MCP 面板 | 显示已配置的 MCP 服务 |
| C2 | MCP 连接/断开 | 点击 Connect/Disconnect | 状态正确更新 |
| C3 | 斜杠命令 | 输入 `/` | CommandSelector 弹出, 显示可用命令 |
| C4 | 命令选择 | 选择命令 | 命令内容填入输入框 |

### 4.5 产物与文件

| # | 测试场景 | 步骤 | 预期结果 |
|---|---------|------|---------|
| F1 | 产物列表 | AI 生成文件 | 右侧栏产物面板显示文件列表 |
| F2 | 产物预览 | 点击产物 | 50/50 分屏显示, 代码/MD/图片预览 |
| F3 | 文件树 | 工作区面板 | 显示目录结构 + git 状态 |
| F4 | 关闭预览 | 点击关闭按钮 | 恢复全宽对话 |

### 4.6 错误处理与边界

| # | 测试场景 | 步骤 | 预期结果 |
|---|---------|------|---------|
| X1 | 服务端离线 | 关闭 OpenCode 后发送消息 | Toast 错误提示 |
| X2 | SSE 断连重连 | 网络中断后恢复 | 自动重连, 最多 5 次 |
| X3 | 无效密码 | 设置错误密码 | API 调用失败 + Toast |
| X4 | ErrorBoundary | 组件异常崩溃 | 显示友好错误页面, 不白屏 |
| X5 | 长消息 | 发送极长文本 | 正常渲染, 无截断 |
| X6 | 快速连续发送 | 连续点击发送多次 | 不重复发送, 状态正确 |

### 4.7 手动测试方法

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
5. **P2 - 边缘场景**: ArtifactPreview, MCPPanel, SkillsPanel
6. **手动测试**: 按 4.1-4.6 清单执行
