# Ultrawork 开发进度

## 📊 总体状态

```
Phase 1 MVP:  ✅ 完成
Phase 2 UI:   ✅ 完成 (2.1-2.10 全部完成)
Round 0 加固: ✅ 完成 (Error Boundary, Toast, 环境修复)
Round 1 重构: ✅ 完成 (UI 架构对齐设计稿, 17 个文件变更)
Review 修复:  ✅ 完成 (6 个问题: health路径/reset bug/i18n/sidebar state/日期分组/链接)
Round 2:      ✅ 完成 (4 Steps: 结构化消息/执行状态/进度面板/产物)
Round 3:      ✅ 完成 (Permission & Question Dock + 10 个联调修复)
Round 4:      ✅ 完成 (3 Steps: 模型管理/MCP命令/文件产物预览)
Round 4 Review: ✅ 完成 (28 问题: 2 Critical + 2 High + 11 Medium + 6 Low 修复)
全面代码审查:  ✅ 完成 (36 问题: 3C+7H+14M+12L 发现, 20 个修复, 16 个已知推迟)
手动测试 4.1:  ✅ 完成 (E1-E10 全部通过, E5 bugfix)
手动测试 4.2:  ✅ 完成 (U1-U12 全部通过)
手动测试 4.3:  ✅ 完成 (M1-M4 全部通过, 11 个 bugfix)
手动测试 4.4:  ✅ 完成 (MCP disconnect/reconnect/delete/persist + C1-C4 命令)
Round 5 工作区: ✅ 完成 (工作区选择 + session 子目录隔离 + Review 3 修复)
Round 5 联调:  ✅ 完成 (SSE 全局化 + 产物/文件树/预览 6 bugfix + 死代码清理)
TypeCheck:    ✅ 3/3 通过
Vite Dev:     ✅ 正常启动
Tauri Dev:    ✅ 联调通过
```

---

## Phase 1: MVP (✅ 已完成)

### ✅ Milestone 1: OpenCode API 调研
- 分析 OpenCode 源码 (Hono 框架 + Basic Auth)
- 发现 api-client 的 4 个实现错误并全部修复

### ✅ Milestone 2: OpenCode 编译和 Sidecar 集成
- `scripts/build-opencode.ts` + Tauri `externalBin` + Rust sidecar 自动启动

### ✅ Milestone 3: 基础聊天 UI + Milestone 4: 端到端集成
- 消息收发、连接重试、Session 创建

---

## Phase 2: 体验优先 + WorkAny UI 1:1 还原 (✅ 已完成)

**执行顺序**: 2.1 ✅ → 2.2 ✅ → 2.5 ✅ → 2.3 ✅ → 2.4 ✅ → 2.6 ✅ → 2.7 ✅ → 2.8 ✅ → 2.9 ✅

### ✅ Iteration 2.1: UI 基础设施 + 布局骨架
- [x] 依赖: lucide-react, react-router-dom, @radix-ui/*, cva, clsx, tailwind-merge
- [x] `cn()` 工具函数 + shadcn/ui 组件 (Button, Dialog, DropdownMenu, Tooltip)
- [x] RootLayout → SidebarProvider + SessionsProvider + LeftSidebar + Outlet
- [x] 三栏布局: LeftSidebar (w-72/w-14 双态) + MainContent + 预留 RightSidebar
- [x] 路由: `/` (Home) + `/session/:id` (Session)
- [x] CSS 变量: WorkAny-style design tokens
- [x] Review: 删除孤立 App.tsx、修复 typo、aria-labels (9处)

**文件结构**:
```
src/
├── lib/
│   ├── utils.ts                  - cn()
│   ├── use-api.ts                - 共享 ApiClient 实例
│   ├── use-sessions.ts           - session CRUD + 状态
│   └── sessions-context.tsx      - SessionsProvider (跨路由共享)
├── components/
│   ├── ui/{button,dialog,dropdown-menu,tooltip,index}.tsx
│   └── layout/{sidebar-context,left-sidebar,root-layout,index}.tsx
├── pages/{Home,Session,index}.tsx
├── router.tsx
├── main.tsx
└── index.css
```

### ✅ Iteration 2.2: 左侧栏 + Session 管理
- [x] api-client: `listSessions()` + `deleteSession()` 方法
- [x] Session 列表 (GET /session?roots=true&limit=50) + loading/empty 状态
- [x] Session 项: 图标 + 标题 + 相对时间 + 三点菜单 (Delete)
- [x] New Chat: 创建 session + 跳转 (sidebar + Home 页)
- [x] Home 页: Enter 发送 → 创建 session → 发消息 → 跳转
- [x] 中文输入法 composing 处理 (isComposing)
- [x] 折叠态 Sessions 按钮: 点击展开侧边栏
- [x] Session.tsx: 从 context 显示真实 title

**Review 修复**:
- 删除重复 `SessionCreateResponse` 类型 → 统一用 `Session`
- createSession 乐观更新替代 refresh (修 race condition)
- useEffect cleanup flag (防 unmount setState)
- DropdownMenuContent stopPropagation (防事件冒泡)
- Home.tsx finally block (防 sending 状态卡住)

**已知 Deferred (by-design)**:
| 项目 | 归属迭代 |
|------|---------|
| Session.tsx 加载消息 | 2.3 |
| 用户级错误提示 (toast) | 后续 |
| Error Boundary | 后续 |
| Hardcoded 密码/地址 | 2.6 |
| SSE 重连/cleanup | 2.4 |
| Session 实时更新 | 2.4 |

---

### ✅ Iteration 2.5: ChatInput 组件
- [x] 统一 ChatInput 组件, 支持 `home`/`reply` 两种 variant
- [x] Textarea 自动伸缩 (home: max 200px, reply: max 120px)
- [x] Shift+Enter 换行, Enter 发送
- [x] 中文输入法 composing 处理 (`onCompositionStart/End`)
- [x] 底部工具栏: + 按钮 + 圆形发送/停止按钮
- [x] Home 页: 居中大标题 + ChatInput(home variant)
- [x] Session 页: 替换占位 textarea + 添加 handleSend 逻辑
- [x] Code Review: 修复 2 个问题 (详见 `REVIEW-2.5.md`)

**文件**:
- `components/chat/chat-input.tsx` - 统一输入组件 (146 行)
- `components/chat/index.ts` - barrel export
- `pages/Home.tsx` - 使用 ChatInput(home)
- `pages/Session.tsx` - 使用 ChatInput(reply) + input 状态管理

**关键实现**:
- `useRef` + `useEffect` 实现 textarea 自动调整高度
- `isComposing` state 防止中文输入法 Enter 误触发
- variant 控制样式: home (大字体/大按钮/shadow-lg), reply (小字体/小按钮/shadow-sm)
- 发送按钮: home 用上箭头, reply 用发送图标
- loading 状态显示 Loader2 spinner

**Review 修复**:
- Home.tsx: 发送成功后清空输入 (`setInput("")`)
- ChatInput: overflow 改为 auto (防止内容截断)

---

### ✅ Iteration 2.3: Markdown 渲染 + 消息显示
- [x] api-client: 添加 `getMessages(sessionId)` 方法
- [x] 安装依赖: react-markdown + remark-gfm
- [x] CodeBlock 组件: 代码块 + 语言标签 + 复制按钮
- [x] UserMessage 组件: 用户消息 + 头像
- [x] AssistantMessage 组件: AI 消息 + Markdown 渲染
- [x] MessageList 组件: 消息列表容器 + loading 状态
- [x] Session.tsx: 加载消息 + 显示 + 自动滚动
- [x] Code Review: 修复 2 个问题 (详见 `REVIEW-2.3.md`)

**文件**:
- `api-client/src/client.ts` - 添加 getMessages() 方法
- `components/chat/code-block.tsx` - 代码块组件 (65 行)
- `components/chat/user-message.tsx` - 用户消息 (18 行)
- `components/chat/assistant-message.tsx` - AI 消息 + Markdown (88 行)
- `components/chat/message-list.tsx` - 消息列表 (50 行)
- `pages/Session.tsx` - 集成消息加载和显示

**Markdown 功能**:
- GFM 支持 (表格、任务列表、删除线)
- 自定义样式: 标题、列表、引用、链接、表格
- 代码块: 语言标签 + 复制按钮 + 语法高亮准备
- 内联代码: 背景色 + 圆角
- 流式指示器: 3 点动画 (isStreaming)

**关键实现**:
- useEffect 加载消息 + cleanup flag 防止内存泄漏
- 消息格式转换: SendMessageResponse → 提取 text parts
- 自动滚动: messagesEndRef + scrollIntoView
- 空状态 + loading 状态处理

**Review 修复**:
- CodeBlock: 添加 clipboard API 错误处理
- Session.tsx: 发送消息后刷新列表 (临时方案，2.4 用 SSE 替代)

---

### ✅ Iteration 2.4: SSE 流式响应
- [x] SSEClient 类: 连接 `/event` 端点 + 事件解析
- [x] 自动重连逻辑: 指数退避 (1s → 2s → 4s → 8s → 16s)
- [x] useSSE Hook: React 集成 + cleanup
- [x] ApiClient: 添加 `getBaseUrl()` + `getCredentials()`
- [x] Session.tsx: SSE 事件处理
  - message.delta: 流式追加文本
  - message.completed: 标记消息完成
  - session.updated: 会话标题更新
- [x] MessageList: streamingMessageId 支持
- [x] 乐观 UI: 立即显示用户消息
- [x] 错误处理: 失败时移除乐观消息
- [x] Code Review: 修复 3 个关键问题 (详见 `REVIEW-2.4.md`)

**文件**:
- `lib/sse-client.ts` - SSE 客户端类 (172 行)
- `lib/use-sse.ts` - React Hook (44 行)
- `api-client/src/client.ts` - 添加 getBaseUrl/getCredentials
- `components/chat/message-list.tsx` - 支持 streamingMessageId
- `pages/Session.tsx` - SSE 集成 + 事件处理

**SSE 功能**:
- fetch + ReadableStream 实现 SSE (支持 Basic Auth)
- 自动重连: 最多 5 次，指数退避
- 事件类型: server.connected, server.heartbeat, message.delta, message.completed, session.updated
- 流式文本追加: delta 逐字显示
- 流式指示器: 当前流式消息显示动画

**关键实现**:
- SSEClient 使用 fetch 而非 EventSource (支持自定义 headers)
- 手动解析 SSE 格式: `data: {...}\n\n`
- useSSE Hook 自动连接/断开 + cleanup
- handleSSEEvent 使用 useCallback 防止重复订阅
- 乐观 UI: 发送前添加临时消息，成功后替换 ID
- 不可变状态更新: 使用 spread operators

**Review 修复**:
- SSEClient: EventSource → fetch + ReadableStream (支持 Basic Auth)
- Session.tsx: 修复状态直接修改 (不可变更新)
- Session.tsx: 替换临时用户消息 ID (防止重复)

---

### ✅ Iteration 2.6: 设置面板 + 配置管理
- [x] AppConfig 类型定义 + ConfigStorage 类
- [x] ConfigProvider: React Context 管理配置
- [x] SettingsDialog: 设置面板 UI
  - API Base URL 输入
  - Username 输入 (可选)
  - Password 输入
  - Reset to Default 按钮
  - Save/Cancel 按钮
- [x] ConnectionStatus: 连接状态指示器
  - 监听 SSE 事件
  - 显示连接/断开状态
  - Wifi 图标
  - Tooltip 显示最后事件时间
- [x] 集成到 LeftSidebar
  - 设置按钮 (展开 + 折叠)
  - 连接状态显示
  - 设置对话框

**文件**:
- `lib/config.ts` - 配置类型 + 存储类 (42 行)
- `lib/config-context.tsx` - React Context (36 行)
- `lib/use-api.ts` - 使用配置 (更新)
- `components/settings/settings-dialog.tsx` - 设置面板 (120 行)
- `components/settings/connection-status.tsx` - 连接状态 (42 行)
- `components/layout/left-sidebar.tsx` - 集成设置 (更新)
- `main.tsx` - 添加 ConfigProvider

**配置功能**:
- localStorage 持久化
- 默认配置 fallback
- 实时配置更新
- 表单验证 (基础)
- Reset to Default 功能

**连接状态**:
- 监听 SSE 事件判断连接状态
- 30s 无事件自动断开
- Wifi/WifiOff 图标
- 绿色/灰色状态指示
- Tooltip 显示详细信息

**关键实现**:
- ConfigStorage 使用 localStorage
- ConfigProvider 在 main.tsx 最外层
- use-api.ts 依赖 config 自动更新
- SettingsDialog 表单状态独立管理
- ConnectionStatus 使用 useSSE 监听事件

---

### ✅ Iteration 2.7: 关键 Bug 修复

**修复日期**: 2026-03-06

#### 1. 消息布局分侧显示
- **用户消息**: 右对齐气泡样式（max-w-[85%]，圆角，背景色）
- **助手消息**: 左对齐全宽，移除头像
- **消息列表**: 移除分隔线，添加适当间距

**修改文件**:
- `components/chat/user-message.tsx` - 右对齐气泡布局
- `components/chat/assistant-message.tsx` - 移除头像，左对齐
- `components/chat/message-list.tsx` - 移除 divide-y，添加 space-y-1

#### 2. ConnectionStatus 超时累积 Bug
- 使用 `useRef` 存储超时 ID
- 每次新事件清除旧超时
- 组件卸载时正确清理

**修改文件**:
- `components/settings/connection-status.tsx` - 修复超时清理逻辑

#### 3. 智能自动滚动
- 添加 `isAtBottom` 状态追踪用户滚动位置
- 只在用户位于底部时自动滚动（100px 阈值）
- 用户向上查看历史消息时不会被打断

**修改文件**:
- `pages/Session.tsx` - 添加智能滚动逻辑

#### 4. 消息发送流程优化
- 等待 `api.sendMessage()` 完成后再导航
- 避免竞态条件

**修改文件**:
- `pages/Home.tsx` - await 消息发送

#### 5. SSE 重连逻辑修复
- 添加 `shouldReconnect` 标志
- 手动断开时禁用重连
- 修复错误的重连条件判断

**修改文件**:
- `lib/sse-client.ts` - 添加 shouldReconnect 标志

#### 6. 会话标题实时更新
- 添加 `updateSession` 函数到 sessions context
- SSE `session.updated` 事件触发标题更新
- 侧边栏实时显示新标题

**修改文件**:
- `lib/use-sessions.ts` - 添加 updateSession 方法
- `lib/sessions-context.tsx` - 更新类型定义
- `pages/Session.tsx` - 处理 session.updated 事件

---

### ✅ Iteration 2.8: 设置面板升级

**完成日期**: 2026-03-06

#### 1. 标签页布局
- **Connection 标签页**: API Base URL, Username, Password, Test Connection 按钮
- **General 标签页**: 主题选择器（Light/Dark/System），语言选择器（English/中文）
- **About 标签页**: 版本信息，文档链接，GitHub 链接

**新增文件**:
- `components/ui/tabs.tsx` - Radix UI Tabs 组件

**修改文件**:
- `components/settings/settings-dialog.tsx` - 完全重构为标签页布局

#### 2. 主题切换系统
- 支持三种主题模式：浅色、深色、跟随系统
- 实时切换，无需刷新
- 自动监听系统主题变化
- 完整的深色模式 CSS 变量

**新增文件**:
- `lib/theme-context.tsx` - ThemeProvider 和 useTheme hook

**修改文件**:
- `lib/config.ts` - 添加 theme 字段
- `main.tsx` - 添加 ThemeProvider
- `index.css` - 添加 .dark 类样式

#### 3. 国际化框架
- 支持英文和简体中文
- 完整的翻译字典（覆盖设置面板所有文本）
- `useI18n` hook 提供 `t()` 函数
- 语言切换实时生效

**新增文件**:
- `lib/i18n-context.tsx` - I18nProvider 和 useI18n hook

**修改文件**:
- `lib/config.ts` - 添加 language 字段
- `main.tsx` - 添加 I18nProvider

#### 4. 连接测试功能
- "Test Connection" 按钮
- 实时状态反馈（成功/失败/测试中）
- 视觉指示器（绿色/红色/加载中）

**依赖更新**:
- 添加 `@radix-ui/react-tabs`

---

### ✅ Iteration 2.9: Session 管理增强

**完成日期**: 2026-03-06

#### 1. 会话重命名
- 内联编辑模式（点击下拉菜单 "Rename"）
- 支持 Enter 保存、Escape 取消
- 失焦自动保存
- API 支持（PATCH /session/:id）

**修改文件**:
- `packages/core/api-client/src/client.ts` - 添加 updateSession API 方法
- `lib/use-sessions.ts` - 添加 renameSession hook
- `lib/sessions-context.tsx` - 更新类型定义
- `components/layout/left-sidebar.tsx` - 实现重命名 UI

#### 2. 日期分组
- **Today** - 今天创建的会话
- **Yesterday** - 昨天创建的会话
- **This Week** - 本周内创建的会话
- **Earlier** - 更早的会话

**修改文件**:
- `components/layout/left-sidebar.tsx` - 实现 groupSessionsByDate 函数

#### 3. 搜索/过滤
- 搜索输入框（带搜索图标）
- 实时过滤会话标题
- 无结果时显示 "No matching sessions"

**修改文件**:
- `components/layout/left-sidebar.tsx` - 添加搜索输入和过滤逻辑

#### 4. 收藏/置顶
- 星标按钮（填充/空心图标）
- 置顶会话显示在分组顶部
- 左侧边框视觉指示器
- localStorage 持久化存储

**新增文件**:
- `lib/use-favorites.ts` - useFavorites hook

**修改文件**:
- `components/layout/left-sidebar.tsx` - 集成收藏功能

#### 5. 改进的 UI
- 下拉菜单（Rename/Pin/Delete）
- 悬停效果和活动状态高亮
- 清晰的视觉层次
- 分组标题样式优化

---

### ✅ Iteration 2.10: 用户测试修复

**修复日期**: 2026-03-06

#### 问题 1: SSE 事件格式错误
**现象**: 控制台报错 `TypeError: undefined is not an object (evaluating 'payload.type')`

**原因**: SSE 事件类型定义错误
- 期望格式: `{"payload": {"type": "...", "properties": {...}}}`
- 实际格式: `{"type": "...", "properties": {...}}`

**修复**:
- 更新 `SSEEvent` 类型定义，移除 `payload` 包装层
- 修改事件处理逻辑，直接访问 `event.type` 和 `event.properties`

**修改文件**:
- `lib/sse-client.ts` - 修复类型定义和日志输出
- `pages/Session.tsx` - 修复事件处理逻辑

#### 问题 2: AI 回复覆盖用户消息
**现象**: 发送多条消息时，AI 回复会覆盖上一条用户消息

**原因**: OpenCode API 的 `POST /session/:id/message` 返回的是 assistant 消息，而不是 user 消息
- 代码假设返回的是用户消息，直接替换临时消息
- 实际返回的是 AI 回复，导致用户消息被覆盖

**修复**:
- 检查服务器返回的消息角色（`response.info.role`）
- 如果是 `user` → 替换临时用户消息
- 如果是 `assistant` → 保留用户消息，添加 AI 回复

**修改文件**:
- `pages/Session.tsx` - 添加角色判断逻辑

#### 问题 3: Settings 按钮行为错误
**现象**: Cancel 和 Save Changes 按钮行为不正确

**原因**: `formData` 状态只在组件初始化时设置，后续配置变化（如主题/语言切换）不会同步

**修复**:
- 添加 `useEffect` 监听对话框打开事件
- 对话框打开时自动同步 `formData` 到最新配置
- 修复 `handleReset` 函数，确保重置后正确加载配置

**修改文件**:
- `components/settings/settings-dialog.tsx` - 添加同步逻辑

#### 问题 4: 流式输出指示器不明显
**现象**: 流式输出的点太小，不易察觉

**修复**:
- 圆点从 `size-1` 改为 `size-2`
- 颜色从灰色改为主题色（蓝色）
- 添加 "AI is typing..." 文字提示

**修改文件**:
- `components/chat/assistant-message.tsx` - 增强指示器样式

#### 测试结果
✅ SSE 连接正常（可以看到 `[SSE] Event received` 日志）
✅ 消息不再被覆盖
✅ 用户消息和 AI 回复都正常显示
✅ 消息布局正确（用户右侧气泡，AI 左侧）
✅ Settings 按钮行为正确

#### 已知限制（OpenCode API 行为）

**OpenCode 当前不支持真正的流式输出**:
- `POST /session/:id/message` 返回完整的 AI 回复（同步模式）
- 不通过 SSE 发送 `message.delta` 事件
- AI 回复是一次性显示，不是逐字符流式

**OpenCode 返回的消息结构**:
```json
{
  "info": { "role": "assistant", "id": "msg-xxx", ... },
  "parts": [
    { "type": "step-start", ... },
    { "type": "reasoning", "text": "AI 的思考过程", ... },
    { "type": "text", "text": "实际回复内容", ... },
    { "type": "step-finish", ... }
  ]
}
```

**影响**:
- ❌ 没有真正的流式输出效果
- ❌ 不会显示 "AI is typing..." 指示器（因为没有 streaming 状态）
- ✅ 功能正常工作，只是缺少流式体验

**未来改进方向**:
- 选项 1: 等待 OpenCode 支持真正的 SSE 流式输出
- 选项 2: 在前端模拟流式效果（收到完整回复后逐字符显示）

---

### Phase 2 Scope Out (→ 新设计稿)
- ❌ RightSidebar / 预览面板 / 附件上传
- ❌ PlanApproval / Library 页面 / Setup 引导页

---

## Round 0: 环境修复 + 基础加固 (✅ 已完成)

**完成日期**: 2026-03-06

### ✅ 环境修复
- Node.js v14 不兼容现代语法（??=），改用 `bun run --bun` 全流程运行
- 更新 `start.sh` 使用 bun 替代 npm/node
- TypeCheck 和 Build 均通过

### ✅ React Error Boundary
- 新增 `components/error-boundary.tsx` — 通用 ErrorBoundary 组件
- `root-layout.tsx` — 在 Outlet 外包裹 ErrorBoundary，防止页面崩溃白屏
- `router.tsx` — 添加 RouteErrorFallback（使用 useRouteError），处理路由级异常

### ✅ Toast 通知系统
- 集成 `sonner` 库（v2.0.7）
- `main.tsx` — 添加 ThemedToaster 组件，自动跟随暗色/亮色主题
- 替换 7 处 console.error 为用户可见 toast 通知：
  - `Home.tsx` — 发送消息失败
  - `Session.tsx` — 加载消息失败、发送消息失败
  - `left-sidebar.tsx` — 创建/删除/重命名会话失败
  - `sse-client.ts` — SSE 重连耗尽

### ✅ 消息 ID 碰撞修复
- `Session.tsx` — `temp-${Date.now()}` → `temp-${crypto.randomUUID()}`
- `Session.tsx` — `user-${Date.now()}` → `user-${crypto.randomUUID()}`

### ✅ Review 修复（第二轮）
- `router.tsx` — 修复 errorElement，使用 useRouteError + 独立 RouteErrorFallback 组件
- `main.tsx` — Toaster 适配暗色主题（抽取 ThemedToaster 组件使用 useTheme）
- `Session.tsx` — 修复 message.completed 处理中的可变状态更新（直接赋值 → 不可变 map）
- `Session.tsx` — handleSSEEvent 参数类型从 `any` 改为 `SSEEvent`

**修改文件清单**:
- `start.sh` — 改用 bun
- `src/components/error-boundary.tsx` — 新建
- `src/components/layout/root-layout.tsx` — 添加 ErrorBoundary
- `src/router.tsx` — 添加 RouteErrorFallback
- `src/main.tsx` — 添加 ThemedToaster
- `src/pages/Home.tsx` — toast 通知
- `src/pages/Session.tsx` — toast + UUID + 类型修复 + 不可变更新
- `src/components/layout/left-sidebar.tsx` — toast 通知
- `src/lib/sse-client.ts` — toast 通知

**修复: 默认配置**:
- `config.ts` — 默认密码从 `test123` 改为空字符串（匹配 OpenCode 无密码模式）

**构建验证**: TypeCheck 3/3 ✅ | Build 649 KB (gzip: 203 KB) ✅

### ✅ 端到端测试验证

**OpenCode 服务端**:
- 二进制: `src-tauri/binaries/opencode-server-aarch64-apple-darwin`
- 启动命令: `opencode serve --port 4096`
- Health: `GET /global/health` → `{"healthy":true}`
- 配置文件: `~/.config/opencode/opencode.json`

**LLM Provider 配置**:

| 场景 | 可用模型 | 说明 |
|------|---------|------|
| 无 API key | 3 个免费模型 (big-pickle, gpt-5-nano, minimax-m2.5-free) | 自动使用 `apiKey: "public"` |
| 有 API key | 35 个模型 (Claude/GPT/Gemini/GLM/Kimi 全系列) | 付费模型需账户有余额 |
| 当前默认 | `opencode/big-pickle` (免费) | 通过配置文件指定 |

OpenCode API key 通过 `~/.config/opencode/opencode.json` 配置：
```json
{
  "provider": {
    "opencode": {
      "options": {
        "apiKey": "sk-xxx..."
      }
    }
  },
  "model": "opencode/big-pickle"
}
```

**API 端到端测试结果**:

| 测试项 | 结果 | 说明 |
|--------|------|------|
| Bun 环境 | ✅ | bun v1.3.10，`bun run --bun` 全流程运行 |
| TypeCheck | ✅ | 3/3 包通过 |
| Vite Build | ✅ | 649 KB (gzip 203 KB) |
| Dev Server | ✅ | localhost:1420，267ms 启动 |
| 模块编译 | ✅ | main.tsx / router.tsx / error-boundary.tsx 无编译错误 |
| OpenCode 启动 | ✅ | health check 通过 |
| POST /session (创建会话) | ✅ | 正常返回 session ID |
| GET /session (列表会话) | ✅ | 正常返回列表 |
| GET /event (SSE) | ✅ | 返回 `server.connected` 事件 |
| POST /session/:id/message (发消息) | ✅ | big-pickle 模型正常回复中文 |
| GET /session/:id/message (获取消息) | ✅ | 返回 user + assistant 消息 |
| DELETE /session/:id (删除会话) | ✅ | 正常删除 |
| CORS (localhost:1420 → :4096) | ✅ | `Access-Control-Allow-Origin` 已允许 |
| Auth (无密码模式) | ✅ | 带/不带 auth header 均可访问 |

**消息格式验证** — OpenCode 返回的 assistant 消息包含 4 种 part 类型：
```
[step-start] → [reasoning] 思考过程 → [text] 正式回复 → [step-finish] reason=stop
```
当前前端仅提取 `text` 类型显示，`reasoning` 和 `step-start/finish` 将在 Round 2 实现。

**发现的注意事项（非阻断）**:
1. `server-manager` 中 health 路径为 `/health`，实际应为 `/global/health`（当前未使用，后续修复）
2. 付费模型 (如 gemini-3-pro) 在 API key 无余额时返回 `CreditsError`，免费模型不受影响
3. OpenCode 的消息 API 是同步返回完整回复（非真正流式），SSE 仅用于事件通知

---

## 新设计稿对齐计划

> 基于 `product-uxd-design/` 中的设计稿和功能清单（第一版本），在当前 Phase 2 基础上重构 UI。
> Phase 1/2 遗留问题在重构过程中一并修复。原 Phase 3 规划内容自然融入新设计稿实现。

### Round 1: UI 架构重构 - 对齐设计稿布局 (✅ 已完成)

**完成日期**: 2026-03-06

#### 环境修复
- **tauri:dev 启动失败**: 系统 Node.js v14 不支持 `node:fs` 前缀，`@tauri-apps/cli@2.10.x` 无法加载
- **修复**: 所有 tauri 脚本改用 `bun run --bun tauri dev`，绕过系统 Node.js
- **修改文件**: `package.json`, `packages/client/desktop/package.json`, `start.sh`

#### Step 1: 设计令牌更新
- 新增 `--color-brand: #ea580c` (橙色 CTA)
- 新增 `--color-brand-gradient: linear-gradient(135deg, #7c3aed, #2563eb)` (Logo 渐变)
- 新增 `--color-bg-subtle` (卡片背景)
- 侧边栏背景: light=`#ffffff`, dark=`#000000` (纯黑白)
- **修改文件**: `src/index.css`

#### Step 2: 共享 TopBar 组件 (NEW)
- 左侧: 侧栏切换按钮 + 可选前进/后退 (disabled 占位)
- 中间: 标题 (prop 驱动)
- 右侧: 可选操作插槽 + 关闭按钮
- **新建文件**: `src/components/layout/top-bar.tsx`

#### Step 3: 左侧栏重设计
- **品牌**: 渐变 Sparkles 图标 + "无影 UltraWork" 文字
- **操作按钮**: 新建任务 / 搜索 / 定时任务(占位) / 自定义(占位) — 4 个图标按钮
- **搜索**: 点击搜索按钮切换搜索输入框 (autoFocus)
- **任务状态指示器**: 30s 内活跃=旋转橙色 Loader，有内容=绿色 Check，其他=MessageSquare
- **底部**: 用户头像 "Y" + 用户名 + Settings 图标 → 触发 SettingsPopover
- **折叠态**: `w-12` (48px)，品牌渐变图标 + 新建 + Sessions + 头像
- **修改文件**: `src/components/layout/left-sidebar.tsx`

#### Step 3b: SettingsPopover (NEW)
- 基于 DropdownMenu 的弹出菜单
- 菜单项: 通用设置(→/settings) / 语言 / 模型管理 / 工作区 / 渠道 / 远程服务 / 帮助文档 / 关于
- 仅"通用设置"可点击导航，其余 disabled 占位
- **新建文件**: `src/components/settings/settings-popover.tsx`

#### Step 4: Home 页重设计
- TopBar (侧栏切换)
- 标题: "聊天办公，简单轻松" + 副标题
- **能力卡片**: 3 列网格 — 文件整理 / 内容创作 / 文档处理
  - 每张卡片: 图标(橙色) + 标题 + 描述，点击填充示例 prompt
- ChatInput 新增橙色 "马上开始" CTA 按钮 (home variant)
- **修改文件**: `src/pages/Home.tsx`, `src/components/chat/chat-input.tsx`

#### Step 5: Settings 全页路由 (NEW)
- TopBar 标题 "设置" + 关闭(X)按钮 → navigate("/")
- 两栏布局: 左侧导航 (通用/隐私/能力配置) + 右侧内容面板
- **GeneralSection**: 主题切换 + 语言选择 (从 dialog 迁移)
- **PrivacySection**: 占位 ("Coming soon")
- **CapabilitiesSection**: 连接设置 (API URL / 用户名 / 密码 / 测试连接)
- **新建文件**: `src/pages/Settings.tsx`
- **修改文件**: `src/router.tsx` (添加 `/settings` 路由)

#### Step 6: Session 页右侧栏骨架
- 右侧栏切换按钮 (PanelRight 图标在 TopBar)
- `w-80` 展开面板，border-left 分隔
- 5 个折叠区段: 计划执行进度 / 工作区 / 产物 / MCP服务 / 技能
- 每个区段可点击展开/折叠 (ChevronRight/Down)
- 内容占位 "Coming in Round 2"
- **修改文件**: `src/pages/Session.tsx`

#### Step 7: 路由 & 导航更新
- sidebar-context: 新增 `rightOpen` / `toggleRight` / `setRightOpen`
- 路由: 添加 `/settings` → `SettingsPage`
- 导出: 更新 `pages/index.ts`, `layout/index.ts`, `settings/index.ts`
- **修改文件**: `src/components/layout/sidebar-context.tsx`, `src/router.tsx`, 各 index.ts

#### i18n 扩展
- 新增 ~40 个翻译键 (中英双语)
- 覆盖: 品牌、侧栏、设置弹窗、首页、设置页、右侧栏
- **修改文件**: `src/lib/i18n-context.tsx`

#### Review 修复 (3 个问题)
1. **StatusIcon 逻辑修正**: 原 `updated > created + 1000` 几乎所有会话都满足 → 改为 `age < 30s = running, updated - created > 5s = completed`
2. **Session TopBar 布局**: children 内 `flex-1` 在 `gap-1` 容器不生效 → 改为 `title` prop
3. **Settings 关闭导航**: `navigate(-1)` 无历史时离开应用 → 改为 `navigate("/")`

#### 文件变更清单

| 文件 | 操作 |
|------|------|
| `src/index.css` | 更新 - 设计令牌 |
| `src/components/layout/top-bar.tsx` | **新建** - 共享导航栏 |
| `src/components/layout/left-sidebar.tsx` | 重构 - 品牌/操作/状态/头像 |
| `src/components/layout/sidebar-context.tsx` | 更新 - 右侧栏状态 |
| `src/components/layout/index.ts` | 更新 - 导出 TopBar |
| `src/components/settings/settings-popover.tsx` | **新建** - 弹出菜单 |
| `src/components/settings/index.ts` | 更新 - 导出 SettingsPopover |
| `src/components/chat/chat-input.tsx` | 更新 - CTA 按钮 |
| `src/pages/Home.tsx` | 重构 - 能力卡片/标题 |
| `src/pages/Settings.tsx` | **新建** - 全页设置 |
| `src/pages/Session.tsx` | 更新 - 右侧栏骨架 |
| `src/pages/index.ts` | 更新 - 导出 SettingsPage |
| `src/router.tsx` | 更新 - /settings 路由 |
| `src/lib/i18n-context.tsx` | 更新 - 新翻译键 |
| `package.json` (root) | 更新 - tauri 脚本 |
| `packages/client/desktop/package.json` | 更新 - tauri 脚本 |
| `start.sh` | 更新 - cargo PATH |

**验证**: TypeCheck 3/3 ✅ | Vite Dev ✅ | Review 3/3 修复 ✅

---

### Round 2: 核心体验 - 任务执行过程展示 (✅ 已完成)

> **目标**: 将 OpenCode 返回的结构化消息（12 种 Part 类型）从当前的 "只提取 text" 升级为可视化执行过程展示，对齐设计稿 ChatDetail 交互。

#### 背景: OpenCode MessagePart 类型 (12 种)

| Part 类型 | Round 2 优先级 | 说明 |
|-----------|---------------|------|
| `text` | ✅ 已有 | 文本内容 (Markdown) |
| `reasoning` | **高** | AI 思考过程，设计稿 "Thought process" 折叠区 |
| `tool` | **高** | 工具调用，有 pending/running/completed/error 4 种状态 |
| `step-start` | **高** | 执行步骤开始标记 |
| `step-finish` | **高** | 执行步骤结束 + token/cost 统计 |
| `file` | 中 | 文件附件（图片/PDF），产物来源 |
| `patch` | 中 | 文件变更 diff，产物来源 |
| `subtask` | 低→Round 3 | 子任务（agent 调度） |
| `agent` | 低 | agent 引用，暂不渲染 |
| `compaction` | 低 | 消息压缩标记，暂不渲染 |
| `retry` | 低 | 重试记录，暂不渲染 |
| `snapshot` | 低 | 状态快照，暂不渲染 |

#### 当前差距

- `message-list.tsx`: 仅 `.filter(p => p.type === "text")` 提取文本，丢弃所有其他 part
- `assistant-message.tsx`: 接收 flat `content: string`，纯 Markdown 渲染
- `api-client/types.ts`: `MessagePart` 是松散类型 `{ type: string; [key: string]: any }`
- 右侧栏: Round 1 仅有折叠区段骨架，无真实数据

#### Step 2.1: API 类型补全 + 结构化消息渲染

**目标**: 重构消息渲染管线，按 part 类型分别渲染

**类型更新** (`packages/core/api-client/src/types.ts`):
- 新增具体 Part 类型: `TextPart`, `ReasoningPart`, `ToolPart`, `StepStartPart`, `StepFinishPart`, `FilePart`, `PatchPart`
- `ToolPart` 包含 `ToolState` 联合类型: `pending | running | completed | error`
- 保留 `[key: string]: any` 兼容性，逐步收紧

**消息渲染重构**:
- `message-list.tsx`: 传递完整 `parts` 数组给 `AssistantMessage`（不再 join text）
- `assistant-message.tsx`: 改为接收 `parts: MessagePart[]`，遍历渲染:
  - `TextPart` → 现有 `ReactMarkdown` 渲染
  - `ReasoningPart` → 新组件 `ReasoningBlock`
  - `ToolPart` → 新组件 `ToolCallBlock`
  - `StepStartPart` / `StepFinishPart` → 新组件 `StepIndicator`
  - 其他类型 → 不渲染 (skip)

**新组件**:
- `components/chat/reasoning-block.tsx` — 可折叠 "思考过程" 区块
  - 默认折叠，ChevronRight 切换展开
  - 展开后显示 reasoning 文本（淡色/斜体样式）
- `components/chat/tool-call-block.tsx` — 工具调用卡片
  - 显示: 工具名 + 标题 + 状态图标 (pending=灰色, running=旋转橙色, completed=绿色, error=红色)
  - 可折叠: 展开显示 input/output 详情
  - completed: 显示输出摘要 (截断)
  - error: 显示错误信息 (红色)
- `components/chat/step-indicator.tsx` — 步骤分隔线
  - `step-finish`: 显示 token 统计 (input/output/reasoning) + cost

**文件变更**:
| 文件 | 操作 |
|------|------|
| `packages/core/api-client/src/types.ts` | 更新 - 补全 Part 类型 |
| `src/components/chat/assistant-message.tsx` | 重构 - 接收 parts 数组 |
| `src/components/chat/message-list.tsx` | 更新 - 传递 parts |
| `src/components/chat/reasoning-block.tsx` | **新建** |
| `src/components/chat/tool-call-block.tsx` | **新建** |
| `src/components/chat/step-indicator.tsx` | **新建** |
| `src/components/chat/index.ts` | 更新 - 导出新组件 |

#### Step 2.2: 执行状态显示 + 停止按钮

**目标**: 在消息区域显示执行状态栏，对齐设计稿交互

**执行状态栏** (在 assistant 消息末尾):
- Streaming 中: `Loader2` 旋转橙色 + "Working on it..." + "停止执行" 按钮
- 完成: `Check` 绿色 + "执行完成"
- 错误: `XCircle` 红色 + 错误信息

**停止按钮**:
- 需确认 OpenCode API 是否有 cancel endpoint (`DELETE /session/:id/message` 或类似)
- 如无 cancel API: 前端断开 SSE + 标记为已停止（视觉状态）
- 如有 cancel API: 调用 API 真正中断后端执行

**文件变更**:
| 文件 | 操作 |
|------|------|
| `src/components/chat/execution-status.tsx` | **新建** - 执行状态栏 |
| `src/pages/Session.tsx` | 更新 - 集成执行状态 |
| `packages/core/api-client/src/client.ts` | 更新 - 添加 cancelMessage API (如有) |

#### Step 2.3: 右侧栏 - 计划执行进度

**目标**: 从消息 parts 中提取 tool 调用列表，在右侧栏显示步骤进度

**数据提取**:
- 遍历当前 session 所有 assistant 消息的 parts
- 提取 `type === "tool"` 的 parts，构建步骤列表
- 每个步骤: 状态图标 + 工具名 + 标题 + 时间

**进度面板**:
- 标题栏: "计划执行进度" + 进度计数 "3 of 5"
- 步骤列表:
  - `completed` → Check 绿色 + 工具名
  - `running` → Loader2 旋转橙色 + 工具名
  - `pending` → Circle 灰色 + 工具名
  - `error` → XCircle 红色 + 工具名 + 错误摘要

**文件变更**:
| 文件 | 操作 |
|------|------|
| `src/components/session/progress-panel.tsx` | **新建** - 进度面板组件 |
| `src/pages/Session.tsx` | 更新 - 替换右侧栏占位内容 |

#### Step 2.4: 右侧栏 - 产物 & 工作区

**目标**: 从消息中提取文件产物，显示在右侧栏

**产物列表** (从消息 parts 提取):
- `type === "file"` → 文件附件 (图片/PDF/etc)
- `type === "patch"` → 变更的文件列表
- 显示: 文件图标 + 文件名，可点击

**工作区**:
- 显示 session 的 `directory` (工作目录)
- 文件树占位 (Round 3 完善)

**产物预览** (点击产物时):
- 主区域分屏 50/50: 左=对话, 右=预览
- Markdown 文件: 渲染 Markdown
- 代码文件: 语法高亮
- 图片: 图片查看器
- 关闭按钮恢复全宽对话

**注意**: 产物预览分屏是较大的布局变更，如时间紧张可只做产物列表，预览推到 Round 3。

**文件变更**:
| 文件 | 操作 |
|------|------|
| `src/components/session/artifacts-panel.tsx` | **新建** - 产物列表 |
| `src/components/session/workspace-panel.tsx` | **新建** - 工作区面板 |
| `src/components/session/artifact-preview.tsx` | **新建** - 产物预览 (可选) |
| `src/pages/Session.tsx` | 更新 - 集成产物/工作区面板 |

#### Scope 决策

| 功能 | 归属 | 说明 |
|------|------|------|
| 结构化消息渲染 | ✅ Step 2.1 | 核心功能 |
| 思考过程折叠 | ✅ Step 2.1 | 设计稿核心交互 |
| 工具调用卡片 | ✅ Step 2.1 | 设计稿核心交互 |
| 执行状态栏 | ✅ Step 2.2 | 设计稿核心交互 |
| 停止按钮 | ✅ Step 2.2 | 需确认 API 支持 |
| 右侧栏进度 | ✅ Step 2.3 | 设计稿核心交互 |
| 右侧栏产物列表 | ✅ Step 2.4 | 设计稿核心交互 |
| 产物预览分屏 | ❌ → Round 3 | 布局复杂，推迟 |
| 文件上传 | ❌ → Round 3 | 需 Tauri 文件选择器 + multipart API |
| MCP/Skills 面板 | ❌ → Round 3 | 需后端 API 支持 |

#### 完成日期: 2026-03-07

#### 实现总结

**Step 2.1: API 类型补全 + 结构化消息渲染**
- `api-client/types.ts`: 新增 7 个具体 Part 类型 (TextPart, ReasoningPart, ToolPart, StepStartPart, StepFinishPart, FilePart, PatchPart) + ToolState 联合类型
- `assistant-message.tsx`: 重构为接收 `parts: MessagePart[]`，按类型分发渲染
- `message-list.tsx`: assistant 消息传递完整 parts 数组（不再 join text）
- 新建组件:
  - `reasoning-block.tsx` — 可折叠"思考过程"区块（Brain 图标 + 紫色）
  - `tool-call-block.tsx` — 工具调用卡片（状态图标 + 可展开 input/output/error）
  - `step-indicator.tsx` — 步骤分隔线 + token/cost 统计

**Step 2.2: 执行状态显示 + 停止按钮**
- 新建 `execution-status.tsx`: 4 种状态 (working/done/error/stopped)
- Session.tsx: AbortController 支持取消请求 + 错误状态追踪
- 停止按钮: abort fetch（OpenCode 无 cancel API，前端中断）

**Step 2.3: 右侧栏 - 计划执行进度面板**
- 新建 `session/progress-panel.tsx`: 从消息提取 tool parts → 步骤列表
- 显示: 完成计数 + 状态图标 (pending/running/completed/error)
- 替换右侧栏 "Plan Progress" 占位内容

**Step 2.4: 右侧栏 - 产物 & 工作区面板**
- 新建 `session/artifacts-panel.tsx`: 从消息提取 file/patch → 产物列表 (去重)
- 新建 `session/workspace-panel.tsx`: 显示 session 工作目录
- RightSidebarSection 支持 children prop

#### 文件变更清单

| 文件 | 操作 |
|------|------|
| `packages/core/api-client/src/types.ts` | 更新 - 7 个 Part 类型 + ToolState |
| `packages/core/api-client/src/index.ts` | 更新 - 导出新类型 |
| `src/components/chat/assistant-message.tsx` | 重构 - parts 数组渲染 |
| `src/components/chat/message-list.tsx` | 更新 - 传递 parts |
| `src/components/chat/reasoning-block.tsx` | **新建** |
| `src/components/chat/tool-call-block.tsx` | **新建** |
| `src/components/chat/step-indicator.tsx` | **新建** |
| `src/components/chat/execution-status.tsx` | **新建** |
| `src/components/chat/index.ts` | 更新 - 导出新组件 |
| `src/components/session/progress-panel.tsx` | **新建** |
| `src/components/session/artifacts-panel.tsx` | **新建** |
| `src/components/session/workspace-panel.tsx` | **新建** |
| `src/components/session/index.ts` | **新建** |
| `src/pages/Session.tsx` | 更新 - 执行状态 + 右侧栏集成 |
| `src/lib/i18n-context.tsx` | 更新 - 新增 ~16 个翻译键 |

**验证**: TypeCheck 3/3 ✅

#### Round 2 Review 修复 (2026-03-07)

> 对照 OpenCode 上游 (anomalyco/opencode) 源码 review，发现并修复 13 个问题。

**🔴 P0: 类型对齐 OpenCode 上游 (5 个)**

1. **ToolState 类型完全错误**: 我们用简单字符串，OpenCode 是嵌套判别联合对象 (`{ status, input, output, title, time, error }`)
2. **ToolPart 字段映射错误**: `title/input/output/error/duration` 不在顶层，嵌套在 `state` 内
3. **SSE 事件类型不存在**: `message.delta`/`message.completed` 不是 OpenCode 事件。正确: `message.part.updated`/`message.part.delta`/`message.updated`
4. **PatchPart 字段错误**: OpenCode 用 `hash` + `files: string[]`，不是 `path`/`content`/`operations`
5. **FilePart 字段错误**: OpenCode 用 `mime`/`url`，不是 `mediaType`/`path`

**🟡 P1: 功能缺陷 (4 个)**

6. **缺少服务端 abort**: 新增 `POST /session/{id}/abort` API 调用
7. **AbortController signal 未传递**: `sendMessage()` 现在接受 `{ signal }` 参数
8. **ExecutionStatus 不显示 done**: 添加 `showDone` 状态 + 2s 自动消失
9. **sendError 持续残留**: 添加 5s 自动清除 timer

**🟢 P2: 代码质量 (4 个)**

10. **PartBase 缺失**: 所有 Part 类型补全 `id/sessionID/messageID`
11. **StepFinishPart.tokens 缺 cache**: 补全 `cache: { read, write }`
12. **进度/产物面板不安全类型断言**: 改为使用正确的 ToolPart/FilePart/PatchPart 类型
13. **file/patch 未渲染**: assistant-message 添加 FileBlock 和 PatchBlock 组件

**文件变更清单**:

| 文件 | 修复 |
|------|------|
| `api-client/src/types.ts` | 重写 — PartBase/ToolState 嵌套/PatchPart(hash+files)/FilePart(mime+url)/StepFinish tokens.cache |
| `api-client/src/index.ts` | 导出新类型 (PartBase, ToolState*, etc.) |
| `api-client/src/client.ts` | 新增 abortSession() + sendMessage signal 参数 |
| `chat/tool-call-block.tsx` | 重写 — 从嵌套 state 对象提取 status/title/input/output/error/duration |
| `chat/assistant-message.tsx` | 添加 FileBlock/PatchBlock 渲染 + ToolPart 正确传参 |
| `chat/step-indicator.tsx` | 补全 cache tokens 显示 |
| `chat/message-list.tsx` | 类型窄化 type guard fix |
| `session/progress-panel.tsx` | 从 state.status 读取状态 + state.title 读取标题 |
| `session/artifacts-panel.tsx` | 使用 FilePart(mime/filename) + PatchPart(files) |
| `lib/sse-client.ts` | 重写事件类型 — message.part.updated/delta/removed + message.updated + session.status |
| `pages/Session.tsx` | SSE handler 全面重写 + abort + signal + ExecutionStatus 生命周期 |

**验证**: TypeCheck 3/3 ✅

---

### Round 3: Permission & Question Dock + 联调修复 (✅ 已完成)

**完成日期**: 2026-03-07

> **背景**: Agent 执行过程中向用户提问（确认文件保存位置等）或请求权限（bash/文件操作），但 UI 仅显示 "working..." 状态，没有渲染交互界面，导致双方死锁。
> OpenCode 服务端通过 `permission.asked` / `question.asked` SSE 事件触发阻塞式交互，客户端需通过 REST API 回复。

#### Step 1: API 类型 + 客户端方法

**新增类型** (`packages/core/api-client/src/types.ts`):
- `PermissionRequest`: `{ id, sessionID, permission, patterns, metadata, always, tool? }`
- `QuestionRequest`: `{ id, sessionID, questions: QuestionInfo[], tool? }`
- `QuestionInfo`: `{ question, header, options: QuestionOption[], multiple?, custom? }`
- `QuestionOption`: `{ label, description }`

**新增 API 方法** (`packages/core/api-client/src/client.ts`):
- `listPermissions()` — `GET /permission`
- `replyPermission(requestId, reply)` — `POST /permission/{id}/reply`
- `listQuestions()` — `GET /question`
- `replyQuestion(requestId, answers)` — `POST /question/{id}/reply`
- `rejectQuestion(requestId)` — `POST /question/{id}/reject`

#### Step 2: SSE 事件类型扩展

**新增事件** (`lib/sse-client.ts`):
- `permission.asked` → `PermissionRequest` (properties 直接是请求对象，非嵌套)
- `permission.replied` → `{ sessionID, requestID, reply }`
- `question.asked` → `QuestionRequest`
- `question.replied` → `{ sessionID, requestID, answers }`
- `question.rejected` → `{ sessionID, requestID }`

#### Step 3: Permission Dock 组件

**新建** `components/chat/permission-dock.tsx`:
- 琥珀色主题 (amber-500), Shield 图标
- 显示权限类型标题 + patterns 列表（代码块样式）
- 三个按钮: Reject / Always Allow / Allow Once
- 与 ChatInput 相同的 max-w-[800px] 容器

#### Step 4: Question Dock 组件

**新建** `components/chat/question-dock.tsx`:
- 蓝色主题 (blue-500), HelpCircle 图标
- 多问题导航 (1/N 进度)
- 单选/多选按钮组 + 可选自定义文本输入
- Back / Next / Submit / Dismiss 按钮

#### Step 5: Session.tsx 集成

- SSE handler 新增 5 个 case: `permission.asked/replied`, `question.asked/replied/rejected`
- 底部区域条件渲染: Question Dock > Permission Dock > ChatInput (优先级)
- handler 函数调用 API 回复并清除状态

#### Step 6: i18n 翻译

- 新增 12 个翻译键 (en + zh): permission.title/description/allowOnce/allowAlways/reject, question.title/submit/dismiss/next/back/customInput

#### 联调测试修复 (10 个问题)

**🔴 P0: SSE 数据结构不匹配**
- **问题**: `permission.asked` 的 properties 直接是 `PermissionRequest`，代码错误解构为 `{ permission: PermissionRequest }`
- **修复**: SSE 类型改为 `properties: PermissionRequest`，handler 直接使用 `event.properties as PermissionRequest`

**🔴 P0: 消息重复 Bug**
- **问题**: `sendMessage` POST 阻塞等待 Agent 完成，期间 SSE 创建真实消息，POST 返回后又替换 temp 消息，导致用户消息显示两次
- **修复**: `handleSend` 改为 fire-and-forget（不 await POST），SSE `message.part.updated` 创建新消息时自动移除所有 `temp-` 前缀的乐观消息
- **文件**: `Session.tsx`

**🔴 P0: 首页发送后不跳转**
- **问题**: `Home.tsx` 的 `handleSend` 中 `await api.sendMessage()` 阻塞，Agent 执行期间（尤其需要 permission 时）POST 不返回
- **修复**: 创建 session 后立即 `navigate()`，`api.sendMessage()` 放后台 fire-and-forget
- **文件**: `Home.tsx`

**🟡 P1: Vite proxy 超时 + 缺少路由**
- **问题**: `/session` proxy 默认 30s 超时，Agent 长时间执行时 POST 超时; 缺少 `/permission`、`/question` proxy 路由
- **修复**: `/session` 超时延长至 300s，新增 `/permission` 和 `/question` proxy
- **文件**: `vite.config.ts`

**🟡 P1: Session 列表状态图标一直转圈**
- **问题**: `StatusIcon` 用 `Date.now() - session.time.updated < 30000` 判断"运行中"，但组件不会在 30 秒后自动重渲染
- **修复**: 添加 `useEffect` + `setTimeout` 在 30s 后强制 re-render
- **文件**: `left-sidebar.tsx`

**🟡 P1: sending 状态不自动清除**
- **问题**: fire-and-forget 后 `setSending(false)` 没有触发点
- **修复**: SSE `session.status: idle` 和 `message.updated` (assistant finish) 时清除 sending
- **文件**: `Session.tsx`

**🟡 P1: Logo 无法回首页**
- **问题**: 品牌 logo 和折叠态图标都没有导航功能
- **修复**: 品牌 logo 按钮 `onClick={() => navigate("/")}`
- **文件**: `left-sidebar.tsx`

**🟢 P2: 发送按钮位置不对**
- **问题**: Reply 模式下发送按钮在单独的工具栏行，没有贴合输入框右下角
- **修复**: Reply 模式用 `absolute bottom-2 right-2.5` 定位; Home 模式简化为单个 CTA 按钮
- **文件**: `chat-input.tsx`

**🟢 P2: 语言选择器样式不一致**
- **问题**: 语言选择用原生 `<select>` 下拉框，与主题选择器的按钮组风格不统一
- **修复**: 改为与主题一致的 `grid grid-cols-2` 按钮组样式
- **文件**: `Settings.tsx`

**🟢 P2: 品牌名称简化**
- **问题**: 中文模式下显示 "无影 UltraWork"，冗余
- **修复**: 统一为 "UltraWork"
- **文件**: `i18n-context.tsx`

#### 文件变更清单

| 文件 | 操作 |
|------|------|
| `packages/core/api-client/src/types.ts` | 更新 - 新增 Permission/Question 类型 |
| `packages/core/api-client/src/client.ts` | 更新 - 新增 5 个 API 方法 |
| `packages/core/api-client/src/index.ts` | 更新 - 导出新类型 |
| `src/lib/sse-client.ts` | 更新 - 新增 5 个 SSE 事件类型 |
| `src/components/chat/permission-dock.tsx` | **新建** - 权限确认 Dock |
| `src/components/chat/question-dock.tsx` | **新建** - 问题回答 Dock |
| `src/components/chat/chat-input.tsx` | 更新 - 发送按钮定位优化 |
| `src/components/chat/index.ts` | 更新 - 导出新组件 |
| `src/pages/Session.tsx` | 更新 - SSE 集成 + Dock 条件渲染 + 消息去重 + sending 状态 |
| `src/pages/Home.tsx` | 更新 - fire-and-forget 发送 + 即时导航 |
| `src/pages/Settings.tsx` | 更新 - 语言选择器按钮组 |
| `src/lib/i18n-context.tsx` | 更新 - 新增 12 个翻译键 + 品牌名简化 |
| `src/components/layout/left-sidebar.tsx` | 更新 - Logo 导航 + 状态图标自动刷新 |
| `vite.config.ts` | 更新 - proxy 超时 + 新路由 |

**验证**: TypeCheck 3/3 ✅ | Tauri Dev 联调通过 ✅

---

### Round 4: 模型管理 + 扩展能力 + 文件系统 (✅ 完成)

> **目标**: 基于 API 调研结果，实现模型切换、MCP 管理、文件浏览/预览等核心能力，覆盖设计稿"第一版本"要求。

#### API 调研结果 (2026-03-07)

已确认可用但尚未使用的 OpenCode 端点:

| 分类 | 端点 | 说明 |
|------|------|------|
| **配置** | `GET /config`, `PATCH /config` | 完整配置读写（含模型切换） |
| **Provider** | `GET /provider` | 98 个 Provider + 全部模型信息 + `connected` 状态 |
| **Provider Auth** | `GET /provider/auth`, `PUT /auth/:id` | 认证方式 + 设置 API Key |
| **MCP** | `GET /mcp`, `POST /mcp`, `POST /mcp/:name/connect\|disconnect` | MCP 服务 CRUD |
| **Agent** | `GET /agent` | 7 个 Agent 定义 (build/plan/general/explore 等) |
| **Skill** | `GET /skill` | 技能列表 |
| **Command** | `GET /command` | 斜杠命令 (init, review) |
| **工具** | `GET /experimental/tool/ids` | 所有可用 Tool ID |
| **文件** | `GET /file?path=`, `GET /file/content?path=`, `GET /file/status` | 文件树/内容/Git 状态 |
| **异步发送** | `POST /session/:id/prompt_async` | 立即返回 204，替代 fire-and-forget |
| **Diff** | `GET /session/:id/diff?messageID=` | 文件变更 diff |
| **Project** | `GET /project` | 项目列表 + 工作区信息 |

#### Step 4.1: 模型管理 + 消息发送升级 (✅ 已完成)

**完成日期**: 2026-03-07

##### 实现总结

**1. API Client 扩展** (`packages/core/api-client/`):
- `types.ts`: 新增 6 个类型 — `Provider`, `ProviderModel`, `ProviderAuthInfo`, `OpenCodeConfig`, `Agent`, `PromptAsyncRequest`
- `client.ts`: 新增 7 个方法 — `getConfig()`, `patchConfig()`, `getProviders()`, `getProviderAuth()`, `putProviderAuth()`, `getAgents()`, `promptAsync()`
- `promptAsync()` 使用 raw fetch (返回 204 No Content，不走 `this.request<T>` JSON 解析)

**2. Vite 代理配置** (`vite.config.ts`):
- 新增 9 个代理路由: `/config`, `/provider`, `/auth`, `/agent`, `/mcp`, `/skill`, `/command`, `/file`, `/project`, `/experimental`

**3. UI 组件**:
- **Popover** (`ui/popover.tsx`): 基于 `@radix-ui/react-popover`，与 Dialog 风格一致
- **ModelSelector** (`chat/model-selector.tsx`): ChatInput 内嵌 Popover
  - 显示当前模型名称 + Cpu 图标
  - 点击弹出已连接模型列表 (按 Provider 分组)
  - "管理模型" 链接打开 ModelDialog
  - 实时从 `GET /provider` 加载 (按需，打开时才请求)
- **ModelDialog** (`settings/model-dialog.tsx`): 完整模型管理弹窗
  - 搜索过滤 Provider/模型
  - Provider 卡片: 展开显示模型列表 + API Key 状态
  - 选中模型写入配置 (`PATCH /config`)
  - 底部 "添加新供应商" 按钮
- **AddProviderDialog** (嵌套在 model-dialog.tsx 内): 自定义 Provider 创建
  - 双栏表单: 显示名称 / Provider ID / Base URL / API Key
  - 可添加多个模型 (Model ID + Display Name)
  - 验证 + 提交 (`PUT /auth/:id` + `PATCH /config`)

**4. prompt_async 升级**:
- `Session.tsx` `handleSend()`: `api.sendMessage()` → `api.promptAsync()` (返回 204，不阻塞)
- `Home.tsx` `handleSend()`: 同步升级
- 不再需要 fire-and-forget workaround，SSE 仍负责所有 UI 更新

**5. 模型切换集成**:
- `Session.tsx`: 加载时从 `GET /config` 读取当前模型，切换通过 `PATCH /config`
- `Home.tsx`: 同上
- `SettingsPopover`: "模型管理" 菜单项从 `disabled` → 可点击打开 ModelDialog

**6. i18n 翻译**:
- 新增 25 个翻译键 (en + zh): model.selectModel, model.manage, model.dialogTitle, model.addProvider 等

##### 文件变更清单

| 文件 | 操作 |
|------|------|
| `packages/core/api-client/src/types.ts` | 更新 - 6 个新类型 |
| `packages/core/api-client/src/client.ts` | 更新 - 7 个新方法 |
| `packages/core/api-client/src/index.ts` | 更新 - 导出新类型 |
| `packages/client/desktop/vite.config.ts` | 更新 - 9 个新代理路由 |
| `src/components/ui/popover.tsx` | **新建** - Radix Popover |
| `src/components/ui/index.ts` | 更新 - 导出 Popover |
| `src/components/chat/model-selector.tsx` | **新建** - 模型快速选择器 |
| `src/components/chat/chat-input.tsx` | 更新 - 新增 leftSlot prop |
| `src/components/chat/index.ts` | 更新 - 导出 ModelSelector |
| `src/components/settings/model-dialog.tsx` | **新建** - ModelDialog + AddProviderDialog |
| `src/components/settings/settings-popover.tsx` | 更新 - 激活模型管理 |
| `src/components/settings/index.ts` | 更新 - 导出 ModelDialog |
| `src/pages/Session.tsx` | 更新 - promptAsync + ModelSelector + ModelDialog |
| `src/pages/Home.tsx` | 更新 - promptAsync + ModelSelector + ModelDialog |
| `src/lib/i18n-context.tsx` | 更新 - 25 个新翻译键 |

**验证**: TypeCheck 3/3 ✅

##### 注意: Agent 选择推迟
- Agent 选择 (build/plan/general 等) 的 UI 推迟到 Step 4.2
- `promptAsync()` 已支持 `options.agent` 参数，UI 侧待实现

##### Step 4.1 Review 修复 (✅ 已完成)

**完成日期**: 2026-03-07

**P1 问题 (已修复)**:

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| P1-1 | `promptAsync()` 内联重复 auth 逻辑 | 提取 `buildHeaders()` 私有方法，`request()` 和 `promptAsync()` 共用 | `api-client/src/client.ts` |
| P1-2 | ModelSelector 每次打开都请求 ~2.1MB Provider 数据 | 添加 `hasFetched` 缓存标志，仅首次打开时请求 | `chat/model-selector.tsx` |
| P1-3 | 模型状态在 3 处独立管理 (Session/Home/SettingsPopover) | 新建 `ModelProvider` 共享 Context，3 处统一用 `useModel()` | `lib/model-context.tsx` (**新建**), `main.tsx`, `Session.tsx`, `Home.tsx`, `settings-popover.tsx` |
| P1-4 | ModelDialog 选中模型后不自动关闭 | `handleSelectModel` 末尾添加 `onOpenChange(false)` | `settings/model-dialog.tsx` |
| P1-5 | `abortControllerRef` 升级 promptAsync 后成为死代码 | 移除 ref，`handleStop` 仅调用 `api.abortSession()` | `pages/Session.tsx` |

**P2 问题 (已知，推迟修复)**:

| # | 问题 | 说明 |
|---|------|------|
| P2-6 | AddProviderDialog 模型数据未持久化 | `handleCreate` 仅写 provider options，用户添加的模型列表未写入配置 |
| P2-7 | ModelDialog 搜索行为不一致 | 搜索时显示未连接 Provider，清空搜索后隐藏 — 行为不统一 |

**新增文件**:
- `src/lib/model-context.tsx` — 共享模型状态 Context (currentModel, setModel, modelDialogOpen)

**额外修改文件**:
- `src/main.tsx` — 添加 `<ModelProvider>` 包裹

**验证**: TypeCheck 3/3 ✅

#### Step 4.2: MCP + 工具 + 命令面板 (✅ 已完成)

**完成日期**: 2026-03-07

##### API 层扩展

| 文件 | 变更 |
|------|------|
| `api-client/src/types.ts` | 新增 `MCPConfigLocal`, `MCPConfigRemote`, `MCPConfig`, `MCPStatus`, `MCPStatusMap`, `Command`, `Skill` 类型 |
| `api-client/src/client.ts` | 新增 7 个方法: `getMCP()`, `createMCP()`, `connectMCP()`, `disconnectMCP()`, `getToolIds()`, `getSkills()`, `getCommands()` |
| `api-client/src/index.ts` | 导出全部新类型 |

##### MCP 面板 (`session/mcp-panel.tsx`)

- [x] 从 `GET /mcp` 获取真实 MCP 服务状态 (connected/disabled/failed/needs_auth)
- [x] 每个服务显示名称、状态、彩色图标 (绿=已连接, 红=失败, 灰=禁用)
- [x] 连接/断开按钮 (调用 `POST /mcp/:name/connect|disconnect`)
- [x] 添加新 MCP 服务表单 (支持 remote/local 两种类型)
- [x] Loading 状态 + 操作中 spinner

##### Skills/Commands 面板 (`session/skills-panel.tsx`)

- [x] 并发获取 `GET /command` + `GET /skill`
- [x] 命令卡片: `/<name>` + 描述 (Terminal 图标)
- [x] 技能卡片: `name` + 描述 (Sparkles 图标)
- [x] 空状态提示

##### 斜杠命令选择器 (`chat/command-selector.tsx`)

- [x] ChatInput 输入 `/` 自动弹出命令列表
- [x] 模糊搜索过滤 (名称 + 描述)
- [x] 键盘导航 (↑↓ 选择, Tab/Enter 确认)
- [x] 选中后填入 `/<command> ` 格式到输入框

##### 集成

| 文件 | 变更 |
|------|------|
| `chat/chat-input.tsx` | 集成 CommandSelector 弹出层 + 键盘事件协调 |
| `chat/index.ts` | 导出 CommandSelector |
| `session/index.ts` | 导出 MCPPanel, SkillsPanel |
| `pages/Session.tsx` | 右侧栏 MCP/Skills 占位替换为真实面板 |
| `lib/i18n-context.tsx` | 新增 13 个中英翻译键 (mcp.*, skills.*, command.*) |

**验证**: TypeCheck 3/3 ✅, Vite Build ✅

##### Step 4.2 Review 修复 (✅ 已完成)

**完成日期**: 2026-03-07

| # | 级别 | 问题 | 修复方案 | 涉及文件 |
|---|------|------|---------|---------|
| P1-1 | 🔴 P1 | `showCommandSelector` 条件过宽 — 选中命令后输入参数 (如 `/review some code`) 时弹窗仍在，Enter 被 CommandSelector 拦截导致无法发送消息 | 添加 `!value.includes(" ")` 条件，只在输入命令名阶段显示弹窗 | `chat/chat-input.tsx` |
| P1-2 | 🔴 P1 | `needs_auth` / `needs_client_registration` 状态无 i18n 标签 — UI 直接显示原始字符串 `"needs_auth"` | 添加 `needsAuth` 布尔判断 + `mcp.needsAuth` 翻译键 (中英) + 琥珀色图标/文字 | `session/mcp-panel.tsx`, `lib/i18n-context.tsx` |
| P2-1 | 🟡 P2 | `MCPServerItem.status` prop 为松散的 `{ status: string; error?: string }` — 失去 discriminated union 类型安全 | prop 类型改为 `MCPStatus`，错误信息用 `"error" in status` 类型收窄安全取值 | `session/mcp-panel.tsx` |
| TS-fix | 🔴 编译 | `status.status` 在穷尽 5 种 union 后类型收窄为 `never`，TS 报错 | fallback 分支改为 `t("mcp.disabled")` (逻辑上不可达，仅满足类型检查) | `session/mcp-panel.tsx` |

**验证**: TypeCheck 3/3 ✅

#### Step 4.3: 文件能力 + 产物预览 (✅ 已完成)

**完成日期**: 2026-03-07

##### API 层扩展

| 文件 | 变更 |
|------|------|
| `api-client/src/types.ts` | 新增 `FileEntry`, `FileStatusEntry`, `FileContentResponse` 类型 |
| `api-client/src/client.ts` | 新增 4 个方法: `getFileTree()`, `getFileContent()`, `getFileStatus()`, `getSessionDiff()` |
| `api-client/src/index.ts` | 导出新类型 |

##### ArtifactPreview 组件 (`session/artifact-preview.tsx`)

- [x] 根据文件类型渲染不同预览内容
  - **代码文件** → 语法高亮 (复用 CodeBlock，自动检测语言)
  - **Markdown** → ReactMarkdown 渲染
  - **图片** → `<img>` 标签
  - **Diff/Patch** → 彩色 unified diff (绿色+/红色-/蓝色@@)
  - **其他文本** → 原始文本
- [x] 顶部文件名 + 路径 breadcrumb + 复制按钮 + 关闭按钮
- [x] Loading/Error/Empty 状态处理
- [x] 通过 `getFileContent` API 获取文件内容，Patch 通过 `getSessionDiff` 获取

##### Session.tsx 50/50 分屏布局

- [x] `selectedArtifact` 状态管理
- [x] 无选中: 原有布局不变 (chat + right sidebar)
- [x] 有选中: 左右 50/50 分屏 (左=ArtifactPreview, 右=chat)
- [x] `handleArtifactClick` + `handleClosePreview` 回调

##### ArtifactsPanel 点击集成

- [x] 接收 `onArtifactClick` + `selectedPath` props
- [x] 产物项 cursor-pointer + onClick
- [x] 选中项 bg 高亮

##### AssistantMessage 点击集成

- [x] FileBlock + PatchBlock 接收 onClick prop
- [x] cursor-pointer + hover border 样式
- [x] 通过 MessageList → AssistantMessage 传递 onArtifactClick

##### WorkspacePanel 文件树 + Git 状态

- [x] 调用 `getFileTree(".")` 获取根目录文件列表
- [x] 调用 `getFileStatus()` 获取 git 修改状态
- [x] 可展开文件树 (递归 FileTreeItem，点击目录加载子目录)
- [x] Git 状态标记: Modified=黄色, Added=绿色, Deleted=红色
- [x] 文件夹/文件图标 + 展开/折叠箭头
- [x] 保留顶部工作目录显示 + 刷新按钮
- [x] Git 变更数量摘要

##### i18n

- [x] 新增 ~13 个翻译键 (artifact.preview/close/loading/loadError/noContent/diff + workspace.fileTree/gitModified/gitAdded/gitDeleted/loadError/emptyDir/filesChanged)

##### 文件变更清单

| 文件 | 操作 |
|------|------|
| `api-client/src/types.ts` | 更新 - 3 个新类型 |
| `api-client/src/client.ts` | 更新 - 4 个新方法 |
| `api-client/src/index.ts` | 更新 - 导出新类型 |
| `src/components/session/artifact-preview.tsx` | **新建** - 产物预览组件 |
| `src/components/session/artifacts-panel.tsx` | 更新 - 点击回调 + 选中高亮 |
| `src/components/session/workspace-panel.tsx` | 更新 - 文件树 + git 状态 |
| `src/components/session/index.ts` | 更新 - 导出 ArtifactPreview |
| `src/components/chat/assistant-message.tsx` | 更新 - FileBlock/PatchBlock 点击 |
| `src/components/chat/message-list.tsx` | 更新 - 传递 onArtifactClick |
| `src/pages/Session.tsx` | 更新 - 分屏布局 + artifact 状态 |
| `src/lib/i18n-context.tsx` | 更新 - 13 个新翻译键 |

##### 不做的事项 (推迟)

- **文件上传** (Tauri file picker) — 需 Tauri Rust 侧支持 + multipart API
- **PDF 预览** — 需额外库
- **语法高亮** — 复用已有 CodeBlock

**验证**: TypeCheck 3/3 ✅

##### Step 4.3 Review 修复 (✅ 已完成)

**完成日期**: 2026-03-07

**P1 问题 (已修复)**:

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| P1-1 | `GitStatusDot` title 属性硬编码英文 `"Added/Deleted/Modified"` — 已有 `workspace.gitAdded` 等 i18n 键但未使用 | 改用 `t("workspace.gitAdded")` / `t("workspace.gitDeleted")` / `t("workspace.gitModified")` | `session/workspace-panel.tsx` |
| P1-2 | 预览面板容器 `flex w-1/2` — 多余的 `flex` 可能导致子元素无法正确填满高度 | 移除 `flex`，改为 `w-1/2 shrink-0 overflow-hidden` | `pages/Session.tsx` |
| P1-3 | `gitStatusMap` 在函数体内 `new Map()` 每次渲染重建，传递给子组件导致不必要的重渲染 | 用 `useMemo(() => ..., [gitStatus])` 缓存 | `session/workspace-panel.tsx` |

**P2 问题 (已知，可接受)**:

| # | 问题 | 说明 |
|---|------|------|
| P2-1 | DiffView 对 `string[]` 先 `join("\n")` 再 `split("\n")` 有一次冗余 | 不影响正确性，API 返回的 diff 数组规模通常不大 |
| P2-2 | PatchBlock 点击取 `pp.files[0]` 作为路径标识 | ArtifactPreview 实际通过 `getSessionDiff` 获取整个 session 的 diff，取第一个文件路径仅用于 sidebar 高亮标识，功能正确 |
| P2-3 | `Artifact` 类型定义在 `artifact-preview.tsx` 并导出 | `artifacts-panel.tsx` 和 `assistant-message.tsx` 均 import 引用，单一来源合理 |

**验证**: TypeCheck 3/3 ✅

#### Round 4 整体 Review (✅ 已完成)

**完成日期**: 2026-03-07

> 对 Round 4 全部 3 个 Step (4.1 模型管理+promptAsync、4.2 MCP+命令、4.3 文件+产物预览) 进行跨步骤整体 Review，检查代码质量、类型安全、i18n 完整性、组件间一致性及交叉问题。4 个并行 Agent 分别审查 4.1 文件组、4.2 文件组、4.3 文件组、跨切面（api-client/i18n/barrel exports/provider 嵌套/vite proxy），共发现 28 个问题并全部修复。

##### 发现问题分布

| 严重度 | 数量 | 描述 |
|--------|------|------|
| Critical | 2 | 可见功能 Bug（图片渲染崩溃、文件树不刷新） |
| High | 3 | 功能 Bug / 潜在崩溃（sending 卡死、死 UI、数组越界） |
| Medium | 15 | 代码质量 / UX 问题（i18n、单例、键盘交互、错误状态等） |
| Low | 13 | 最佳实践 / 细节优化 |

##### 已修复问题清单

**Critical (2)**:

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| C1 | 图片 artifact `<img src>` 使用服务器文件路径，浏览器无法加载 | 改用已获取的 content 构建 `data:${mime};base64,${content}` data URL | `session/artifact-preview.tsx` |
| C2 | `WorkspacePanel.loadData()` 硬编码 `getFileTree(".")`，忽略 `directory` prop，切换 session 后文件树不刷新 | 改为 `getFileTree(directory \|\| ".")`，将 `directory` 加入 `useCallback` 依赖 | `session/workspace-panel.tsx` |

**High (2 of 3 修复，H2 为已知推迟)**:

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| H1 | `promptAsync` 失败时 `sending` 状态永久卡死，输入框永久禁用 | catch 中添加 `setSending(false)` + `toast.error()` | `pages/Session.tsx` |
| H3 | `CommandSelector` `selectedIndex` 可超出 `filtered.length-1`，导致 `onSelectCommand(undefined)` 崩溃 | 使用 `Math.min(selectedIndex, filtered.length - 1)` 防护 | `chat/command-selector.tsx` |

**Medium (11 修复)**:

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| M1 | 20+ 硬编码英文字符串未走 `t()` | 新增 22 个 i18n key (en+zh)，所有 placeholder/toast/aria-label/label 改用 `t()` | `i18n-context.tsx` + 7 个文件 |
| M2 | `ModelDialog` 在 Session/Home/SettingsPopover 渲染 3 个实例 | 移至 `main.tsx` `ModelDialogSingleton` 组件（单例），从 3 处移除 | `main.tsx`, `Session.tsx`, `Home.tsx`, `settings-popover.tsx` |
| M3 | `closeModelDialog: () => void` 传给 `onOpenChange: (open: boolean) => void` 类型不匹配 | 单例中使用 `(open) => { if (!open) closeModelDialog() }` 包装 | `main.tsx` |
| M4 | CommandSelector Escape 键是空操作，用户无法通过键盘关闭弹窗 | 新增 `onClose` prop，Escape 触发 `onClose()` 清空输入 | `chat/command-selector.tsx`, `chat/chat-input.tsx` |
| M5 | 输入 `/xxx` 无匹配命令时按 Enter 插入换行而非发送 | 将 Escape 加入 ChatInput passthrough 列表 | `chat/chat-input.tsx` |
| M6 | ModelSelector `hasFetched` 缓存永不失效 | 每次 Popover 打开时重置 `hasFetched` 为 false | `chat/model-selector.tsx` |
| M7+M8 | MCP/Skills 面板无错误反馈、加载失败显示"无数据" | 新增 error 状态 + toast.error 提示 | `session/mcp-panel.tsx`, `session/skills-panel.tsx` |
| M10 | `extractArtifacts` 每次 render 重算 | `useMemo(() => ..., [messages])` | `session/artifacts-panel.tsx` |
| M14 | `handleModelChange` try-catch 包装重复 3 处 | 错误处理集成到 `ModelProvider.setModel`，消除包装 | `lib/model-context.tsx`, 3 个页面 |

**Low (6 顺带修复)**:

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| L4+L5 | 文件树未排序 | 目录优先 + 字母排序（根+子目录） | `session/workspace-panel.tsx` |
| L7 | artifacts 列表用 array index 做 key | 改用 `artifact.path` | `session/artifacts-panel.tsx` |
| L8 | "diff" badge 硬编码 | 改用 `t("artifact.diff")` | `session/artifacts-panel.tsx` |
| L11 | `ModelContext.Provider` value 每次 render 新建 | `useMemo()` 缓存 | `lib/model-context.tsx` |
| L15 | Refresh aria-label 硬编码 | 新增 `workspace.refresh` i18n key | `workspace-panel.tsx`, `i18n-context.tsx` |

##### 已知推迟 (不修)

| # | 问题 | 说明 |
|---|------|------|
| H2 | AddProviderDialog models 数据未写入 config | Step 4.1 Review 已记录 (P2-6)，Provider 创建可工作 |
| L1 | `ArtifactIcon` + `basename` 重复定义 | 尺寸和条件略有差异，暂不抽取 |
| L3 | 每个 `FileTreeItem` 调用 `useApi()` / `useI18n()` | Context hook 开销极小，暂可接受 |
| L12 | `sendMessage()` 已是死代码 | 保留向后兼容 |
| L13 | 附件按钮无 onClick | 功能待实现（需 Tauri 文件选择器） |

##### 文件变更清单

| 文件 | 操作 |
|------|------|
| `src/lib/model-context.tsx` | 更新 — setModel 内部错误处理 + useMemo context value |
| `src/lib/i18n-context.tsx` | 更新 — 新增 22 个翻译键 (en+zh) |
| `src/main.tsx` | 更新 — 新增 ModelDialogSingleton 单例渲染 |
| `src/pages/Session.tsx` | 更新 — 移除 ModelDialog/handleModelChange + i18n 替换 6 处 |
| `src/pages/Home.tsx` | 更新 — 移除 ModelDialog/handleModelChange + i18n 替换 3 处 |
| `src/components/settings/settings-popover.tsx` | 更新 — 移除 ModelDialog/handleModelChange，精简为纯菜单 |
| `src/components/settings/model-dialog.tsx` | 更新 — Base URL / API Key 标签 i18n |
| `src/components/chat/chat-input.tsx` | 更新 — 导入 useI18n + aria-label i18n + onClose + loading 条件 |
| `src/components/chat/command-selector.tsx` | 更新 — 新增 onClose prop + selectedIndex 防护 + Escape 处理 |
| `src/components/chat/model-selector.tsx` | 更新 — hasFetched 每次打开重置 |
| `src/components/session/artifact-preview.tsx` | 更新 — 图片改用 data URL |
| `src/components/session/artifacts-panel.tsx` | 更新 — useMemo + path 做 key + diff i18n |
| `src/components/session/workspace-panel.tsx` | 更新 — directory prop + 文件排序 + refresh i18n |
| `src/components/session/mcp-panel.tsx` | 更新 — error 状态 + toast 反馈 |
| `src/components/session/skills-panel.tsx` | 更新 — error 状态 |

**验证**: TypeCheck 3/3 ✅

#### Scope 决策

| 功能 | 归属 | 说明 |
|------|------|------|
| 模型选择器 + Provider 管理 | ✅ Step 4.1 | 设计稿有完整弹窗设计 |
| prompt_async 升级 | ✅ Step 4.1 | 替代 fire-and-forget，更可靠 |
| MCP 真实数据 | ✅ Step 4.2 | 替换占位 |
| 斜杠命令 | ✅ Step 4.2 | 设计稿有 |
| 产物预览分屏 | ✅ Step 4.3 | 设计稿标注"第一版本" |
| 文件上传 | ✅ Step 4.3 | 需 Tauri 文件选择器 |
| 引导页 (Onboarding) | ❌ → Round 5 | 非核心，推迟 |
| 定时任务 | ❌ → Round 5+ | 需新包 @agent/proactive-cron |
| 通道集成 (钉钉等) | ❌ → Round 5+ | 需新包 @agent/channel-gateway |

### 全面代码审查 (✅ 已完成)

**完成日期**: 2026-03-07

> 对 Phase 1 ~ Round 4 全部已完成内容进行系统性全面代码审查。3 个并行 Agent 分别审查 UI 核心组件、Session/Settings 组件、API Client/Lib 层，共发现 36 个问题，修复 20 个。

#### 审查范围

| 审查组 | 覆盖文件 |
|--------|----------|
| UI 核心 | Session.tsx, Home.tsx, assistant-message.tsx, message-list.tsx, chat-input.tsx, command-selector.tsx, model-selector.tsx |
| Session/Settings | artifacts-panel.tsx, workspace-panel.tsx, mcp-panel.tsx, skills-panel.tsx, artifact-preview.tsx, settings-popover.tsx, model-dialog.tsx |
| API/Lib | api-client/client.ts, api-client/types.ts, sse-client.ts, use-sse.ts, i18n-context.tsx, model-context.tsx, main.tsx |

#### 发现问题分布

| 严重度 | 发现 | 修复 | 推迟 |
|--------|------|------|------|
| 🔴 Critical | 3 | 3 | 0 |
| 🟠 High | 7 | 7 | 0 |
| 🟡 Medium | 14 | 10 | 4 |
| 🟢 Low | 12 | 0 | 12 |
| **合计** | **36** | **20** | **16** |

#### 🔴 Critical 修复 (3)

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| C1 | `request<T>` 对 204/空 body 响应调 `.json()` 抛 SyntaxError — 影响 `replyPermission`/`replyQuestion`/`rejectQuestion`/`abortSession`/`deleteSession` 5 个方法 | 检查 `response.status === 204` 和 `content-length === "0"`，改用 `text() + JSON.parse` 安全解析 | `api-client/client.ts` |
| C2 | ModelDialog `open={open && !addProviderOpen}` 打开 AddProvider 时触发 `onOpenChange(false)` → `closeModelDialog()`，关闭 AddProvider 后主 Dialog 永久无法打开 | `onOpenChange` 增加 `if (!addProviderOpen)` 守卫，阻止嵌套 Dialog 关闭传播 | `settings/model-dialog.tsx` |
| C3 | Session 切换时 `pendingPermission`/`pendingQuestion`/`streamingMessageId`/`sending`/`selectedArtifact` 状态残留，导致 A 会话的权限 Dock 在 B 会话显示 | 新增 `useEffect([id])` 重置 5 个 session 级状态 | `pages/Session.tsx` |

#### 🟠 High 修复 (7)

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| H1 | SSE `message.part.updated` 创建新消息时硬编码 `role: "assistant"` — 服务器对 user 消息的 part update 会创建 ghost assistant 消息 | 检测是否有 `temp-` 前缀的乐观消息，若有且 part 为 text 类型则推断 `role: "user"` | `pages/Session.tsx` |
| H2 | `promptAsync` 失败后临时消息残留 — 用户看到"已发送"的消息实际未发出 | catch 中按 `tempId` 移除临时消息 | `pages/Session.tsx` |
| H3 | Home 页 `promptAsync` 失败仅 `console.error` — 用户看到空 session 无任何提示 | 添加 `toast.error(t("error.sendMessage"))` | `pages/Home.tsx` |
| H4 | CommandSelector Escape 清空全部输入 — 用户输入 `/rev` 按 Escape 丢失所有文字 | 仅去掉 `/` 前缀，保留后续文字 | `chat/chat-input.tsx` |
| H5 | CommandSelector 打开时 ArrowDown/ArrowUp/Tab 缺少 `preventDefault` — 同时移动 textarea 光标、转移焦点 | 添加 `e.preventDefault()` | `chat/chat-input.tsx` |
| H6 | `permission.replied`/`question.replied`/`question.rejected` 未按 sessionID 过滤 — 并发 session 时一个 session 的回复事件会清掉另一个 session 的 Dock | 添加 `sessionID` 检查，仅当事件 sessionID 匹配或缺失时清除 | `pages/Session.tsx` |
| H7 | Reply 模式发送按钮 `aria-label` 在 loading 时显示 "Stop Generating" 但点击无停止功能 | 统一为 `t("aria.sendMessage")`，停止功能由 `ExecutionStatus` 组件提供 | `chat/chat-input.tsx` |

#### 🟡 Medium 修复 (10)

| # | 问题 | 修复方案 | 涉及文件 |
|---|------|---------|---------|
| M1 | `I18nProvider` 的 `t` 函数和 `value` 对象未 memoize — 每次渲染新引用，连锁导致所有 `useI18n()` 消费者和 `ModelProvider.setModel` 的 `useCallback` 失效 | `t` 用 `useCallback([language])`，value 用 `useMemo`，`setLanguage` 用 `useCallback` | `lib/i18n-context.tsx` |
| M2 | i18n `{n}` 占位符无插值支持 — `t("time.mAgo")` 返回字面 `"{n}m ago"` | `t()` 新增 `params?: Record<string, string \| number>` 参数，遍历替换 `{key}` 占位符 | `lib/i18n-context.tsx` |
| M3 | Permission/Question Dock 乐观清除状态 — API 失败时 Dock 已消失，用户无法重试 | catch 中恢复原始 Dock 状态 (`setPendingPermission(perm)`) + toast 提示 | `pages/Session.tsx` |
| M7 | `artifacts-panel.tsx` 遍历 `msg.parts` 时未检查 undefined — SSE 流式中 parts 尚未到达时 `for...of` 抛 TypeError | 添加 `!msg.parts` 守卫跳过 | `session/artifacts-panel.tsx` |
| M8 | `CommandSelector` document listener 每次渲染重注册 — `filtered` 每次渲染新数组触发 `useEffect` 卸载/注册 | `filtered` 改用 `useMemo([commands, query])` 稳定引用 | `chat/command-selector.tsx` |
| M9 | `ModelProvider` config 加载无取消机制 — 快速切换 config 时旧请求覆盖新请求 | 添加 `cancelled` flag + cleanup | `lib/model-context.tsx` |
| M11 | ModelDialog cost 显示 `$undefined/M` — `cost.input?.toFixed(2)` 在 input 为 undefined 时模板显示 `$undefined` | 改为 `(cost.input ?? 0).toFixed(2)` | `settings/model-dialog.tsx` |
| M13 | 文件树快速展开/折叠无请求取消 — 旧请求结果覆盖新请求 | 添加 `fetchIdRef` 计数器，旧请求完成时跳过 setState | `session/workspace-panel.tsx` |
| M14a | "AI is typing..." 硬编码英文 | 新增 `message.aiTyping` i18n 键 (en: "AI is typing...", zh: "AI 正在输入...") | `chat/assistant-message.tsx`, `i18n-context.tsx` |
| M14b | "Loading messages..." 硬编码英文 | 新增 `message.loadingMessages` i18n 键 + 使用 `t()` | `chat/message-list.tsx`, `i18n-context.tsx` |
| M14c | PatchBlock "files changed" 硬编码英文 | 改用已有 `t("workspace.filesChanged")` | `chat/assistant-message.tsx` |

#### 🟡 Medium 推迟 (4)

| # | 问题 | 推迟原因 |
|---|------|---------|
| M4 | ModelSelector 每次打开拉 ~2.1MB `/provider` | 需要设计缓存策略（Round 4 Review M6 的修复导致每次打开重置 hasFetched） |
| M5 | SSE 无心跳超时检测 — 半开 TCP 连接永不重连 | 需整体 SSE 架构调整 |
| M10 | ModelDialog 搜索行为不一致 — 搜索时显示未连接 Provider，清空后隐藏 | 已在 Round 4 Review P2-7 记录，UX 优化 |
| M12 | MCP 命令字符串分割不支持引号参数 | 边缘场景，需设计引号解析逻辑 |

#### 🟢 Low 推迟 (12)

| # | 问题 | 说明 |
|---|------|------|
| L1 | `subscribeToEvents` 使用 EventSource 无法传 auth header | 死代码，实际用 `sse-client.ts` |
| L2 | `Session.messages` 类型定义为 `Message[]` 而非 `SendMessageResponse[]` | 类型不匹配但不影响运行 |
| L3 | `MessagePart` 尾部 catch-all 削弱类型收窄 | 设计上为兼容未知 part 类型 |
| L4 | `listSessions` falsy check 丢弃 `start=0` / `limit=0` | 实际无人传 0 |
| L5 | SkillsPanel commands/skills key 可能碰撞 | 极低概率 |
| L6 | SkillsPanel 无 retry/refresh 机制 | 需重新挂载组件 |
| L7 | assistant-message parts 用 array index 做 key | SSE 动态更新可能导致 React reuse 问题 |
| L8 | `react-markdown` inline code 检测依赖已弃用 `inline` prop | 依赖版本兼容 |
| L9 | 缺少 `mcp.needsClientRegistration` i18n 键 | 当前用 `mcp.needsAuth` 覆盖 |
| L10 | MCP 面板无删除服务功能 | 功能缺失，待设计 |
| L11 | AddProviderDialog 模型数据未写入 config | 已在 Round 4 Review P2-6 记录 |
| L12 | SettingsPopover 5/7 菜单项 disabled 无说明 | 待功能实现时启用 |

#### 文件变更清单

| 文件 | 操作 |
|------|------|
| `packages/core/api-client/src/client.ts` | 更新 — `request<T>` 空 body 安全处理 |
| `src/pages/Session.tsx` | 更新 — session 状态重置 + 角色推断 + 临时消息清理 + 权限/问题 sessionID 过滤 + Dock 失败恢复 |
| `src/pages/Home.tsx` | 更新 — promptAsync 失败 toast |
| `src/components/settings/model-dialog.tsx` | 更新 — AddProvider 嵌套 Dialog 生命周期 + cost undefined 防护 |
| `src/components/chat/chat-input.tsx` | 更新 — Escape 保留文字 + preventDefault + aria-label 修正 |
| `src/components/chat/command-selector.tsx` | 更新 — filtered useMemo |
| `src/components/chat/assistant-message.tsx` | 更新 — PatchBlock/streaming i18n |
| `src/components/chat/message-list.tsx` | 更新 — loading i18n |
| `src/components/session/artifacts-panel.tsx` | 更新 — parts undefined 守卫 |
| `src/components/session/workspace-panel.tsx` | 更新 — 文件树请求竞态防护 |
| `src/lib/i18n-context.tsx` | 更新 — t/value memoize + 插值支持 + 4 个新 i18n 键 |
| `src/lib/model-context.tsx` | 更新 — config 加载取消机制 |

**验证**: TypeCheck 3/3 ✅

---

### 后续迭代 (📋 规划中)
- 引导页（首次安装设置向导）
- 定时任务系统 (@agent/proactive-cron)
- 通道集成 — 钉钉/飞书/Slack (@agent/channel-gateway)
- 数据导入/导出
- 记忆管理
- 键盘快捷键
- 性能优化（消息虚拟化、代码分割）
- @agent/workspace — ~/.ultrawork/ 工作区管理
- @agent/connector — 连接抽象层
- @agent/notifier — 通知调度

---

### Review 修复 (✅ 已完成)

**完成日期**: 2026-03-07

> 对 Phase 1 ~ Round 1 全部已完成内容进行代码 review，发现并修复 6 个问题。

#### 🔴 P0: Test Connection 健康检查路径错误
- **问题**: `settings-dialog.tsx` 和 `Settings.tsx` 中 Test Connection 使用 `/api/health`，OpenCode 实际端点为 `/global/health`
- **影响**: 测试连接永远 404，用户误以为连接失败
- **修复**: 两处路径改为 `/global/health`
- **文件**: `settings-dialog.tsx`, `Settings.tsx`

#### 🔴 P0: handleReset 闭包 Bug
- **问题**: `settings-dialog.tsx` 的 `handleReset` 中 `setTimeout(() => setFormData(config), 0)` 读取的是闭包中的旧 `config`（reset 前的值），不是 DEFAULT_CONFIG
- **影响**: 点击 Reset 后表单数据不会正确更新
- **修复**: 去掉 setTimeout，直接 `setFormData(DEFAULT_CONFIG)`
- **文件**: `settings-dialog.tsx` (+ 新增 `DEFAULT_CONFIG` 导入)

#### 🟡 P1: i18n 硬编码字符串补全 (~30 处)
- **问题**: 多处 UI 文字硬编码英文，切换中文时仍显示英文
- **涉及**:
  - 日期分组标签: Today/Yesterday/This Week/Earlier
  - Session 菜单项: Pin/Unpin/Rename/Delete
  - ConnectionStatus: Connected/Disconnected
  - formatTime: just now/m ago/h ago/d ago
  - 右侧栏占位: "Coming in Round 2"
  - Settings 隐私占位: "More privacy settings coming soon."
  - MessageList 空状态: "Send a message to start chatting"
- **修复**: 新增 ~30 个中英翻译键，替换所有硬编码字符串
- **文件**: `i18n-context.tsx`, `left-sidebar.tsx`, `connection-status.tsx`, `Session.tsx`, `Settings.tsx`, `message-list.tsx`

#### 🟡 P1: 右侧栏 state 未使用全局 context
- **问题**: `Session.tsx` 自行管理 `rightOpen` state，未使用 `sidebar-context.tsx` 中已定义的 `rightOpen`/`toggleRight`
- **影响**: 右侧栏状态不在全局管理中，无法从其他组件控制
- **修复**: 改为使用 `useSidebar()` 的 `rightOpen`/`toggleRight`
- **文件**: `Session.tsx`

#### 🟡 P2: 日期分组逻辑不精确
- **问题**: 使用简单时间差 (24h/48h/7d) 而非日历日期判断
- **影响**: 晚上 23:59 创建的 session，凌晨 0:01 就变成 "Yesterday"
- **修复**: 改为基于 `startOfDay` 计算，使用精确日历日期边界
- **文件**: `left-sidebar.tsx` (groupSessionsByDate 重写)

#### 🟢 P3: About 页占位链接
- **问题**: GitHub 链接为 `https://github.com/your-repo/ultrawork`，文档链接为 `https://docs.ultrawork.dev`（均不存在）
- **修复**: 替换为真实链接 — OpenCode GitHub + OpenCode 文档
- **文件**: `settings-dialog.tsx`

#### 环境修复 (附带)
- **Vite Proxy**: 添加 dev proxy 解决 CORS (localhost:1420 → localhost:4096)
- **默认密码**: config 默认密码改为 `test123` + `opencode`，匹配 sidecar 启动配置
- **localStorage 旧配置兼容**: 加载时空密码/用户名自动回退到默认值
- **SSE 相对路径**: dev 模式下 SSE 和 API 使用相对 URL，走 Vite proxy
- **文件**: `vite.config.ts`, `config.ts`, `use-api.ts`, `sse-client.ts`

#### 文件变更清单

| 文件 | 操作 |
|------|------|
| `vite.config.ts` | 更新 - 添加 dev proxy |
| `src/lib/config.ts` | 更新 - 默认密码/用户名 + 旧配置兼容 |
| `src/lib/use-api.ts` | 更新 - dev 模式强制空 baseUrl |
| `src/lib/sse-client.ts` | 更新 - 兼容空 baseUrl |
| `src/lib/i18n-context.tsx` | 更新 - 新增 ~30 个翻译键 |
| `src/components/settings/settings-dialog.tsx` | 更新 - health 路径 + reset bug + DEFAULT_CONFIG 导入 + About 链接 |
| `src/components/settings/connection-status.tsx` | 更新 - i18n |
| `src/components/layout/left-sidebar.tsx` | 更新 - 日期分组重写 + formatTime/菜单 i18n |
| `src/components/chat/message-list.tsx` | 更新 - 空状态 i18n |
| `src/pages/Session.tsx` | 更新 - 全局 sidebar context + 占位 i18n |
| `src/pages/Settings.tsx` | 更新 - health 路径 + 隐私占位 i18n |

**验证**: TypeCheck 3/3 ✅

---

---

### 手动测试 — 4.1 E2E + 4.2 UI 交互 (2026-03-07)

**测试结果**: 全部通过 ✅ (E1-E10 + U1-U12 = 22 项)

#### E5 停止执行 — Bugfix

**问题**: 流式中点击停止后，AI 部分回复消失；发送新消息后收到旧问题的回答。

**根因**: SSE 事件泄漏竞态
1. `session.status: idle` 过早清除 `stopped` → 服务器后续清理事件（`message.part.removed` 等）生效 → 消息消失
2. 清除 `stopped` 后，TCP 缓冲中旧交互的 SSE 事件涌入 → 旧回答覆盖新交互
3. 无 `revertSession` → 服务器会话历史含脏数据 → 下次回复上下文混乱

**修复方案**: 冻结消息 ID 机制（`frozenMessageIdsRef`）
- `handleStop`: 记录所有当前消息 ID 到冻结集合；temp 消息重命名为 `stopped-*` 防被 dedup 清除
- SSE 处理器: `stopped=true` 时全量阻断；`stopped=false` 后仍阻断冻结 ID 对应的事件
- `session.status: idle`: 不再清除 `stopped`（改由 `handleSend` 在发新消息时清除）
- 恢复 `revertSession`: 有冻结 ID 保护后，revert 清理事件被安全拦截
- MessageList: 用户消息也支持显示 `■ 执行已中断` 指示器

**文件变更**:
| 文件 | 操作 |
|------|------|
| `src/pages/Session.tsx` | 更新 - frozenMessageIdsRef + handleStop 重写 + SSE 冻结检查 + session.status 修复 |
| `src/components/chat/message-list.tsx` | 更新 - 用户消息也渲染 stopped 指示器 |

**验证**: TypeCheck 通过 ✅，E5 场景测试通过 ✅

---

---

### 手动测试 — 4.3 模型管理 (2026-03-07)

**测试结果**: 全部通过 ✅ (M1-M4 = 4 项)

#### 发现并修复的问题

| # | 问题 | 严重度 | 修复 |
|---|------|--------|------|
| 1 | ModelDialog 白屏: `providers.filter is not a function` | Critical | `getProviders()` 转换 API 响应 (`{ all, connected }` → `Provider[]`) |
| 2 | Dialog/Popover/DropdownMenu 全部透明 | Critical | Tailwind v4: `[--color-*]` → `[var(--color-*)]` (30+ 文件) |
| 3 | 搜索结果排序不合理 | Medium | connected 优先 + 名称匹配优先 + 字母排序 |
| 4 | ModelSelector Popover 缺少搜索 | Medium | 添加搜索框，支持模型名/供应商名/ID 过滤 |
| 5 | 创建按钮不可见 (透明背景 + 白色文字) | High | 同 #2 Tailwind var() 修复 |
| 6 | `PUT /auth/{id}` 400 错误 | High | body 从 `{ apiKey }` 改为 `{ type: "api", key }` |
| 7 | 「添加供应商」流程不匹配 OpenCode 架构 | Medium | 重构为「配置供应商」两步式 (选择注册表供应商 → 配置 Key/URL) |
| 8 | 嵌套 Dialog 冲突: 创建后两个 Dialog 都关闭 | High | 改为同一 Dialog 内视图切换 (`"list"` / `"configure"`) |
| 9 | `PATCH /config` 触发 Vite HMR → 页面崩溃显示原始 JSON | Critical | Vite watch 忽略 `config.json` + `/session` proxy bypass HTML 请求 |
| 10 | `config.json` 是运行时产物，不应提交 | Low | 加入 `.gitignore` |
| 11 | 模型切换不生效: `PATCH /config` 只写磁盘不更新运行时 | Critical | `prompt_async` 传 `model: { providerID, modelID }` 参数实现运行时切换 |

#### 文件变更

| 文件 | 操作 |
|------|------|
| `packages/core/api-client/src/types.ts` | 更新 - 新增 ProviderResponse/RawProvider/ProviderAuthResponse/ModelOverride 类型 |
| `packages/core/api-client/src/client.ts` | 更新 - getProviders/getProviderAuth/putProviderAuth 修复 + promptAsync 添加 model 参数 |
| `packages/core/api-client/src/index.ts` | 更新 - 导出新类型 |
| `packages/core/api-client/src/__tests__/client.test.ts` | 更新 - 测试对齐真实 API 响应格式 |
| `packages/client/desktop/vite.config.ts` | 更新 - watch 忽略 config.json + /session proxy bypass |
| `packages/client/desktop/src/components/settings/model-dialog.tsx` | 重写 - 视图切换 + 配置供应商两步式 |
| `packages/client/desktop/src/components/chat/model-selector.tsx` | 更新 - 添加搜索框 |
| `packages/client/desktop/src/components/ui/dialog.tsx` | 更新 - var(--color-*) 修复 |
| `packages/client/desktop/src/components/ui/popover.tsx` | 更新 - var(--color-*) 修复 |
| `packages/client/desktop/src/components/ui/dropdown-menu.tsx` | 更新 - var(--color-*) 修复 |
| `packages/client/desktop/src/components/ui/tooltip.tsx` | 更新 - var(--color-*) 修复 |
| `packages/client/desktop/src/lib/i18n-context.tsx` | 更新 - 配置供应商相关 i18n 键 (中英文) |
| `packages/client/desktop/src/__tests__/lib/sse-client.test.ts` | 更新 - 修复未使用变量 |
| `.gitignore` | 更新 - 忽略 OpenCode 运行时 config.json |
| `packages/client/desktop/src/pages/Session.tsx` | 更新 - promptAsync 传入 currentModel |
| `packages/client/desktop/src/pages/Home.tsx` | 更新 - promptAsync 传入 currentModel |
| 30+ .tsx 文件 | 更新 - 全局 `[--color-*]` → `[var(--color-*)]` Tailwind v4 修复 |

**验证**: TypeCheck 3/3 ✅，M1-M4 测试通过 ✅ (含运行时模型切换验证)

---

### 手动测试 4.4: MCP & 命令 (2026-03-08)

#### MCP 面板修复 (4 项 bugfix + 1 新功能)

| # | 问题 | 修复 |
|---|------|------|
| 1 | Disconnect 后 server 从列表消失 | 本地设 `disabled` 状态，不依赖后端 `GET /mcp` 返回 |
| 2 | 已断开 server 点 Connect 无反应 | 存储 `configMap`，reconnect 时用 `createMCP` 重新注册 |
| 3 | 重启应用后 MCP 列表清空 | `configMap` 持久化到 `localStorage`，启动时合并后端+本地数据 |
| 4 | 已删除 server 在操作其他 MCP 后复活 | 新增 `hiddenSet` (localStorage) + `filterHidden()` 过滤所有后端响应 |
| 5 | 无法删除失败/不需要的 MCP server | 新增 Trash2 删除按钮 (非连接状态显示) |

#### 斜杠命令测试 (C3/C4)

- `/` 触发 CommandSelector 弹出 ✅
- 过滤搜索、↑↓ 键盘导航、Enter/Tab/鼠标选择 ✅
- Escape 关闭（移除 `/` 前缀）✅
- 空格后不弹出 ✅
- 命令发送到 agent 正常执行 ✅

#### 文件变更

| 文件 | 操作 |
|------|------|
| `packages/client/desktop/src/components/session/mcp-panel.tsx` | 重写 — disconnect/connect/remove/持久化逻辑 |
| `packages/client/desktop/src/lib/i18n-context.tsx` | 更新 — 新增 `mcp.remove` 中英文 |

**验证**: C1-C4 手动测试全部通过 ✅

---

---

## Round 5: 工作区管理 (✅ 已完成)

### 背景与目标

当前 OpenCode sidecar 启动后默认使用进程 cwd（`packages/client/desktop`）作为工作目录，所有 session 产物混在一起。Round 5 目标：

1. **启动时选择工作区**：每次启动 App 先进入工作区选择页面
2. **Session 级产物隔离**：每个 session 在工作区下拥有独立子目录（`workspace/<shortId>/`）
3. **不重启 server**：通过 `x-opencode-directory` header 传递目录（OpenCode server 原生支持）

### 技术调研结论

- OpenCode server `server.ts:200` 全局中间件：`c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()`
- `Instance.provide()` 按 directory 做 lazy 初始化 + 缓存，切换目录无需重启 server
- 项目配置（opencode.json、.opencode/）会跟随 directory 自动加载
- Tauri Shell 插件 Command 支持 `.current_dir()` 但本方案不需要改 sidecar
- `SessionCreateRequest.workingDirectory` 已定义，API 已支持

### 整体架构

```
App 启动
  ↓
始终先进入 WorkspaceSelector 页面
  ↓
├── 有历史路径 → 显示当前路径 + [继续使用] + 最近列表 + [选择新文件夹]
└── 无历史路径 → 显示 [选择文件夹]
  ↓
确认工作区 → workspace_path 注入 ApiClient
  ↓
所有 API 请求带 x-opencode-directory header
  ↓
进入 Home，正常使用
```

### 关键决策

| 决策项 | 结论 | 原因 |
|--------|------|------|
| 工作区数量 | 一次一个，重启才能换 | 简化逻辑 |
| 目录传递方式 | `x-opencode-directory` header | server.ts:200 原生支持 |
| Server 改动 | 不改 lib.rs / sidecar | header 方式无需后端改动 |
| Server 重启 | 不需要 | Instance.provide() 按 directory lazy 初始化 |
| Session 隔离 | `workspace/<shortId>/` 子目录 | WorkspacePanel 天然只显示该目录 |
| shortId 生成 | 客户端 nanoid(8) 预生成 | 绕过鸡生蛋问题 |
| 启动流程 | 每次启动都过 WorkspaceSelector | 避免路径锁死，一键继续不增负担 |

### 文件系统结构

```
~/my-workspace/                          ← 用户选择的工作区根目录
├── a8k2m9p4/                            ← session A (shortId)
│   ├── app.py
│   └── utils.py
├── b3x7n1q5/                            ← session B (shortId)
│   └── server.py
├── opencode.json                        ← 可选：工作区级配置（server 自动识别）
└── .opencode/                           ← 可选：工作区级 agents/commands
```

### 流程设计

#### 启动流程

```
App 启动 → 始终进入 WorkspaceSelector
  ↓
┌────────────────────────────────────────┐
│  选择工作区                              │
│  所有会话产物将保存在此目录                │
│                                         │
│  (有历史路径时显示)                       │
│  当前: ~/Documents/ai-workspace         │
│         [ ✓ 继续使用 ]                   │
│                                         │
│  ───────────────────────                │
│  最近使用                                │
│  ├── ~/Documents/ai-workspace   ✕      │
│  ├── ~/projects/demo            ✕      │
│                                         │
│         [ 📁 选择新文件夹 ]              │
└────────────────────────────────────────┘
```

#### 发送消息（创建 session）

```
Home.tsx handleSend()
  ↓
1. shortId = nanoid(8)
2. sessionDir = `${workspacePath}/${shortId}`
3. await mkdir(sessionDir)                           // Tauri FS API
4. session = await createSession({ workingDirectory: sessionDir })
5. localStorage 存映射: session.id → shortId
6. navigate(`/session/${session.id}`)
7. promptAsync(session.id, text)                     // fire-and-forget
```

#### Session 页面

```
Session.tsx
  ↓
session.directory = "~/my-workspace/x7k2m9p4"       ← createSession 时已设好
  ↓
WorkspacePanel directory={session.directory}
  ↓
├── agent 未开始工作 → 显示"等待 Agent 生成文件..."（友好空状态）
└── agent 工作中/完成 → 显示该子目录下的文件树
```

### 改动清单

#### 新增文件（2 个）

| 文件 | 说明 | 预估 |
|------|------|------|
| `src/pages/WorkspaceSelector.tsx` | 启动选择页：当前路径 + 继续使用 + 最近列表 + 选择新文件夹 | ~100 行 |
| `src/lib/workspace-context.tsx` | WorkspaceProvider：path state + localStorage + 最近路径列表 | ~70 行 |

#### 修改文件（9 个）

| 文件 | 改动内容 | 预估 |
|------|---------|------|
| `api-client/src/types.ts` | `ApiClientConfig` 加 `workingDirectory?: string` | ~2 行 |
| `api-client/src/client.ts` | `buildHeaders()` 加 `x-opencode-directory` header | ~5 行 |
| `src/main.tsx` | Provider 层加 `WorkspaceProvider` | ~5 行 |
| `src/router.tsx` | 加 `/workspace` 路由 | ~5 行 |
| `src/components/layout/root-layout.tsx` | 未确认 workspace 时 redirect 到 `/workspace` | ~10 行 |
| `src/lib/config-context.tsx` | ApiClient 实例化时传入 workingDirectory | ~5 行 |
| `src/pages/Home.tsx` | handleSend 中加 shortId + mkdir + workingDirectory | ~15 行 |
| `src/components/session/workspace-panel.tsx` | 空目录提示改为"等待 Agent 生成文件..." | ~5 行 |
| `src/lib/i18n-context.tsx` | 新增约 12 个 i18n key（中英文） | ~24 行 |

#### 不需要改的

| 文件 | 原因 |
|------|------|
| `src-tauri/src/lib.rs` | 不改 sidecar，用 header |
| `artifacts-panel.tsx` | 数据来自 messages，天然按 session 隔离 |
| `artifact-preview.tsx` | 无改动 |
| OpenCode server | 原生支持 `x-opencode-directory` |

### 实施步骤

| 步骤 | 内容 | 依赖 |
|------|------|------|
| **Step 0** | 检查 Tauri 插件：确认 `tauri-plugin-dialog` 和 `tauri-plugin-fs` | 无 |
| **Step 1** | `api-client` 改造：`ApiClientConfig.workingDirectory` + `buildHeaders()` 加 header | 无 |
| **Step 2** | `workspace-context.tsx`：WorkspaceProvider + localStorage + 最近路径列表 | 无 |
| **Step 3** | `WorkspaceSelector.tsx`：页面 UI + Tauri dialog + 继续使用/最近列表/选择 | Step 2 |
| **Step 4** | 串联：router 加路由、main.tsx 加 Provider、root-layout redirect、config-context 传参 | Step 1+2 |
| **Step 5** | Session 创建改造：Home.tsx 中 shortId + mkdir + workingDirectory | Step 1+2 |
| **Step 6** | WorkspacePanel 空状态优化 + i18n 补全 | Step 3-5 |
| **Step 7** | 联调测试 | 全部 |

### Tauri 依赖

| 插件 | 用途 | 状态 |
|------|------|------|
| `tauri-plugin-dialog` | 文件夹选择对话框 | 需 Step 0 确认 |
| `tauri-plugin-fs` | mkdir 创建 session 子目录 | 需 Step 0 确认 |
| `tauri-plugin-shell` | sidecar 启动 | 已安装 ✅ |

### localStorage 数据结构

```
workspace_path    = "/Users/xxx/my-workspace"           // 当前工作区
workspace_recent  = ["/Users/xxx/my-workspace", ...]    // 最近列表（最多 5 条）
session_dir_map   = { "sess_abc123": "a8k2m9p4", ... }  // session → shortId 映射
```

### 风险与应对

| 风险 | 应对 |
|------|------|
| Tauri dialog/fs 插件未装 | Step 0 检查并安装 |
| shortId 碰撞 | nanoid(8) ≈ 2^40 组合，不会碰撞 |
| 旧 session 无 shortId | 兼容：直接用 session.directory 原值 |
| 路径含特殊字符 | server 已有 decodeURIComponent |
| 工作区路径被删/移动 | WorkspaceSelector 启动时校验，不存在则提示重新选择 |
| 最近列表路径失效 | 灰色标记不可点击，或自动清理 |

### 实施结果 (2026-03-08)

#### 新增文件（3 个）

| 文件 | 说明 |
|------|------|
| `src/pages/WorkspaceSelector.tsx` | 启动工作区选择页（继续使用 / 最近列表 / 选择新文件夹） |
| `src/lib/workspace-context.tsx` | WorkspaceProvider（path + confirmed + recent + sessionMap） |
| `src-tauri/capabilities/default.json` | Tauri 插件权限声明（dialog + fs + shell） |

#### 修改文件（13 个）

| 文件 | 改动 |
|------|------|
| `api-client/src/types.ts` | `ApiClientConfig` 加 `workingDirectory` |
| `api-client/src/client.ts` | `buildHeaders()` 加 `x-opencode-directory` header + SSE 加 `directory` query |
| `src-tauri/Cargo.toml` | 加 `tauri-plugin-dialog` + `tauri-plugin-fs` |
| `src-tauri/src/lib.rs` | 注册 dialog + fs 插件 |
| `src/main.tsx` | 加 `WorkspaceProvider` |
| `src/router.tsx` | 加 `/workspace` 路由（顶层，不在 RootLayout 内） |
| `src/components/layout/root-layout.tsx` | 未确认 workspace 时 redirect 到 `/workspace` |
| `src/lib/use-api.ts` | ApiClient 传入 `workingDirectory` |
| `src/lib/use-sse.ts` | SSEClient 传入 `workingDirectory` |
| `src/lib/sse-client.ts` | SSE 连接加 `x-opencode-directory` header + query param |
| `src/pages/Home.tsx` | shortId 生成 + mkdir + workingDirectory 参数 |
| `src/lib/use-sessions.ts` + `sessions-context.tsx` | `createSession` 接受 `workingDirectory` |
| `src/lib/i18n-context.tsx` | 新增 8 个工作区 i18n key（中英文） |
| `src/components/session/workspace-panel.tsx` | 空目录提示改为"等待 Agent 生成文件..." |
| `src/pages/index.ts` | 导出 `WorkspaceSelectorPage` |

#### Review 修复（3 项）

| # | 严重度 | 问题 | 修复 |
|---|--------|------|------|
| 1 | 高 | SSE client 缺 `workingDirectory`，SSE 连接没有 directory context | `sse-client.ts` 加 header + query；`use-sse.ts` 传入 workspacePath |
| 2 | 中 | WorkspaceSelector Tauri dialog 无 try-catch | 加 try-catch 防止浏览器 dev 模式崩溃 |
| 3 | 低 | mkdir 静默失败无日志 | 改为 console.warn |

**验证**: TypeCheck 3/3 ✅，Cargo check ✅，Vite dev ✅

### 手动测试修复（2 项）

#### 5.1 设置菜单工作区按钮启用

`settings-popover.tsx` 中"工作区"菜单项从 `disabled` 改为 `onClick={() => navigate("/workspace")}`，用户可在应用内随时切换工作区。

#### 5.2 Session 列表按工作区隔离

**问题**：切换工作区后 session 列表互通，workspace1 的 session 在 workspace2 中可见。

**根因分析**：
- OpenCode server `routes/session.ts` 的 `GET /session` handler 只从 query param 取 `directory`，不读 middleware 设置的 Instance context
- `Session.list()` 对 directory 做精确匹配（`eq`），而 session 目录是 `/workspace/shortId` 子目录，传工作区根路径无法匹配
- 即使改 server（vendor 不可改）也无法用前缀匹配

**方案决策**：保持子目录隔离 + 客户端过滤（方案 A），放弃去掉子目录方案（方案 B 会丢失 per-session 文件隔离）

**修复**：`use-sessions.ts` 加 `filterByWorkspace()` 函数，用 `startsWith` 过滤只保留 `session.directory` 属于当前工作区的 session。

**改动文件**：
- `src/components/settings/settings-popover.tsx` — 启用工作区按钮
- `src/lib/use-sessions.ts` — 加 `filterByWorkspace` + `useWorkspace` 依赖

**验证**: TypeCheck 3/3 ✅

---

## Round 5 联调: SSE 全局化 + 产物/文件树/预览修复 (✅ 已完成)

### 背景

Round 5 工作区功能完成后，手动联调发现 3 类关键问题：
1. Write 工具执行卡住（PermissionDock 不弹出）— SSE 竞态
2. 产物列表/文件树始终为空
3. 子目录隔离死代码残留

### Part A: SSE 全局化（修复工具卡住）

**问题**: SSE 连接原本在 Session.tsx mount 时创建。Home.tsx 先调 `promptAsync`（fire-and-forget），再 `navigate` 到 Session 页。Server 发出 `permission.asked` 时，Session 页 SSE 尚未建连，事件丢失。

**修复**:
- **新建** `src/lib/sse-context.tsx` — `SSEProvider` + `useSSESubscribe` + `useSSEConnected`
  - Provider 在 app 级别维护单一 SSEClient，通过 `handlersRef: Set<SSEEventHandler>` 分发
  - `workspacePath` 变化时自动重连，订阅者无需重新注册
  - 30s heartbeat timeout 追踪连接状态
  - `useSSESubscribe` 用 ref 模式保持 handler 最新，依赖 `[subscribe]` 而非 `[ctx]` 避免 heartbeat 引发重订阅
- **修改** `src/main.tsx` — 插入 SSEProvider: `WorkspaceProvider > SSEProvider > ModelProvider`
- **修改** `src/pages/Session.tsx` — `useSSE` → `useSSESubscribe`
- **修改** `connection-status.tsx` — 简化为 `useSSEConnected()` 读全局状态
- **删除** `src/lib/use-sse.ts` — 不再需要

### Part B: Permission/Question 轮询兜底

**修复**: Session.tsx 新增 `useEffect`，当 `isAgentActive = sending || streamingMessageId !== null` 且无 pending 权限/问题时，每 3s 并行轮询 `GET /permission` 和 `GET /question`。

Home.tsx 用 `navigate(url, { state: { sending: true } })` 传递 sending 状态，Session.tsx 在 reset effect 中读取。

### Part C: 清理子目录隔离死代码

| 文件 | 改动 |
|------|------|
| `api-client/types.ts` | `SessionCreateRequest` 移除 `workingDirectory` 字段 |
| `api-client/__tests__/client.test.ts` | 测试去掉 `workingDirectory` 断言 |
| `workspace-context.tsx` | 删除 `getSessionShortId`/`setSessionShortId`/`loadSessionMap`/`saveSessionMap` |
| `sessions-context.tsx` | `createSession` 签名去掉 `options` 参数 |
| `use-sessions.ts` | `filterByWorkspace` 精确匹配, `createSession` 去掉 options, `listSessions` 加 `directory` 参数 |
| `Home.tsx` | 删除 `nanoid`/`mkdir`/`useWorkspace` 导入及 shortId/sessionDir/mkdir 逻辑 |

### Part D: 产物列表 + 文件树 + 预览修复（6 个 bug）

#### D.1 产物列表显示"暂无产物"

**根因**: `extractArtifacts()` 只检查 `FilePart` (type="file") 和 `PatchPart` (type="patch")，不处理 Write/Edit 工具产生的 `ToolPart` (type="tool")。

**修复**: 增加 `type === "tool"` 分支，从 `state.input.filePath` 提取路径。

#### D.2 ToolPart 输入键名不匹配

**根因**: OpenCode Write/Edit/Read 工具统一用 **`filePath`（camelCase）**，代码检查的是 `file_path`/`path`/`filepath`，全部不匹配。

**修复**: 改为 `input.filePath || input.file_path || input.path`。

#### D.3 绝对路径导致 API 返回空

**根因**: OpenCode `/file?path=` 和 `/file/content?path=` 用 `path.join(Instance.directory, dir)` 解析路径。传绝对路径会 join 出错误路径，返回空数组/空内容。

**修复**:
- `WorkspacePanel`: `getFileTree(".")` 固定传相对路径，由 `x-opencode-directory` header 指定根
- `ArtifactsPanel`: `toRelative()` 函数去掉工作区前缀，将绝对路径转为相对路径
- 新增 `directory` prop 从 Session.tsx 传入工作区根路径

#### D.4 文件树无自动刷新

**根因**: `WorkspacePanel` 仅在 mount 时加载一次，agent 创建文件后不刷新。

**修复**: 新增 `refreshKey` prop，Session.tsx 传入已完成工具调用计数（`workspaceRefreshKey` useMemo），工具完成时自动触发重新加载。

#### D.5 预览面板位置错误

**根因**: ArtifactPreview 渲染在 Chat 之前（HTML 顺序），导致预览在左、聊天在右，位置反了。

**修复**: 调整 DOM 顺序为 ArtifactPreview（左 w-1/2, border-r）→ Chat（右 w-1/2）→ Sidebar。

#### D.6 图片产物图标缺扩展名兜底

**根因**: ToolPart 提取的产物无 `mime` 字段，图片文件无法通过 `mime?.startsWith("image/")` 匹配，显示灰色图标。

**修复**: 增加 `IMAGE_EXTS` 正则（`.png/.jpg/.gif/.svg/.webp` 等）扩展名兜底检测 + hover 高亮改用 `cn()` + `transition-colors`。

### 补充: FileContentResponse 类型补全

`api-client/types.ts` 的 `FileContentResponse` 补充 `diff?`, `encoding?`, `mimeType?` 字段，对齐服务端返回。

### 改动文件清单

| 文件 | 操作 |
|------|------|
| `src/lib/sse-context.tsx` | 新建 |
| `src/lib/use-sse.ts` | 删除 |
| `src/main.tsx` | 修改 |
| `src/pages/Session.tsx` | 修改 |
| `src/pages/Home.tsx` | 修改 |
| `src/components/settings/connection-status.tsx` | 修改 |
| `src/components/session/artifacts-panel.tsx` | 修改 |
| `src/components/session/workspace-panel.tsx` | 修改 |
| `src/components/session/artifact-preview.tsx` | 修改 |
| `src/lib/workspace-context.tsx` | 修改 |
| `src/lib/sessions-context.tsx` | 修改 |
| `src/lib/use-sessions.ts` | 修改 |
| `api-client/src/types.ts` | 修改 |
| `api-client/src/__tests__/client.test.ts` | 修改 |

**验证**: TypeCheck 3/3 ✅, 手动联调 ✅

---

**最后更新**: 2026-03-08
**当前阶段**: Round 5 联调 ✅ 完成（SSE 全局化 + 产物/文件树/预览修复 + 死代码清理）
