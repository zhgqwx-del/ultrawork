# Ultrawork 开发进度

## 📊 总体状态

```
Phase 1 MVP: ✅ 完成
Phase 2 UI:  🔧 进行中 (2.1 ✅ · 2.2 ✅ · 2.5 ✅ · 2.3 ✅ → 下一步 2.4)
TypeCheck:   ✅ 全部通过
Vite Build:  ✅ 通过
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

## Phase 2: 体验优先 + WorkAny UI 1:1 还原 (🔧 进行中)

**执行顺序**: 2.1 ✅ → 2.2 ✅ → 2.5 ✅ → 2.3 ✅ → **2.4** → 2.6

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

### Iteration 2.4: SSE 流式响应 (4-5h) ← 下一步
- [ ] SSE 客户端 `/event` + 事件解析
- [ ] 流式逐字显示 + 工具调用事件
- [ ] 断线重连 + Basic Auth 支持

### Iteration 2.6: 设置面板 + 配置管理 (2-3h)
- [ ] SettingsModal + 配置持久化 + 连接状态指示

### Phase 2 Scope Out (→ Phase 3)
- ❌ RightSidebar / 预览面板 / 附件上传
- ❌ i18n / 暗色模式 / PlanApproval
- ❌ Library 页面 / Setup 引导页

---

**最后更新**: 2026-03-06
**当前阶段**: Phase 2 → Iteration 2.4
