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

### Round 4: 模型和扩展能力 (📋 规划中)
- [ ] 多模型支持（Provider 管理 + 模型切换 + 思考模式）
- [ ] MCP 服务管理（列表 / 开关 / 搜索 / 管理入口）
- [ ] Skills 管理
- [ ] Plugins 管理
- [ ] 消息通道（钉钉配置入口）

### 后续迭代 (📋 规划中)
- 引导页（首次安装后展示）
- 定时任务系统
- 数据导入/导出
- 记忆管理
- 键盘快捷键
- 性能优化（消息虚拟化、代码分割）

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

**最后更新**: 2026-03-07
**当前阶段**: Round 2 完成 ✅ → Round 3 规划中
