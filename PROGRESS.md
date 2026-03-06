# Ultrawork 开发进度

## 📊 总体状态

```
Phase 1 MVP: ✅ 完成
Phase 2 UI:  ✅ 完成 (2.1-2.9 全部完成)
Phase 2.7:   ✅ 关键 Bug 修复
Phase 2.8:   ✅ 设置面板升级
Phase 2.9:   ✅ Session 管理增强
Phase 2.10:  ✅ 用户测试修复
TypeCheck:   ✅ 全部通过
Vite Build:  ✅ 通过 (612 KB, gzipped: 192 KB)
测试状态:    ✅ 桌面应用运行正常
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

### Phase 2 Scope Out (→ Phase 3)
- ❌ RightSidebar / 预览面板 / 附件上传
- ❌ PlanApproval / Library 页面 / Setup 引导页

---

## Phase 3: 功能扩展 (🔜 待开始)

### Phase 3.1: 工具调用展示
- 解析 SSE 中的 tool_use/tool_result 事件
- 折叠式工具组（类似 WorkAny）
- 文件操作可视化（Read/Write/Edit diff）
- Bash 工具调用显示终端输出

### Phase 3.2: 右侧边栏 + Artifact
- 文件树面板
- Artifact 系统（代码/HTML 预览）
- 语法高亮

### Phase 3.3: 文件附件
- 图片上传 + 预览
- 文件拖拽上传
- 粘贴板图片支持

### Phase 3.4: 核心包实现
- @agent/connector（本地/远程连接抽象）
- @agent/workspace（~/.ultrawork/ 目录管理）
- @agent/notifier（通知分发）
- @agent/ui（共享 UI 组件库）

### Phase 3.5: 智能体验
- Smart Scroll（"滚到底部" FAB 按钮）
- 计划审批流程
- Clarification 交互
- 错误恢复
- 键盘快捷键

### Phase 3.6: 主动服务
- Heartbeat 服务（后台进度监控）
- Cron 任务（定时 LLM 任务）
- 通知推送

---

**最后更新**: 2026-03-06
**当前阶段**: Phase 2 完成 ✅ → 准备 Phase 3
