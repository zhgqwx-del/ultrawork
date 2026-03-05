# Ultrawork 开发进度

## 📊 总体状态

```
Phase 1 MVP: ✅ 完成
Phase 2 UI:  🔧 进行中 (2.1 ✅ · 2.2 ✅ → 下一步 2.5)
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

**执行顺序**: 2.1 ✅ → 2.2 ✅ → **2.5** → 2.3 → 2.4 → 2.6

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

### Iteration 2.5: ChatInput 组件 (2-3h) ← 下一步
- [ ] 统一 ChatInput, 支持 home/reply 两种 variant
- [ ] Textarea 自动伸缩
- [ ] Shift+Enter 换行, Enter 发送
- [ ] 中文输入法 composing 处理
- [ ] 底部: + 按钮 + 圆形发送/停止按钮
- [ ] Home 页: 居中大标题 + ChatInput(home variant)

### Iteration 2.3: Markdown 渲染 + 消息显示 (3-4h)
- [ ] react-markdown + remark-gfm + @tailwindcss/typography
- [ ] UserMessage + AI Markdown 消息
- [ ] 代码块语法高亮
- [ ] RunningIndicator + 自动滚动

### Iteration 2.4: SSE 流式响应 (4-5h)
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
**当前阶段**: Phase 2 → Iteration 2.5
