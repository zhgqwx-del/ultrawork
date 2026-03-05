# Ultrawork 开发进度

## 📊 总体状态

```
Phase 1 MVP: ✅ 完成
Phase 2 UI:  🔧 进行中 (2.1 ✅ → 下一步 2.2)
TypeCheck:   ✅ 全部通过
Vite Build:  ✅ 通过
```

---

## Phase 1: MVP (✅ 已完成)

### ✅ Milestone 1: OpenCode API 调研
- 分析 OpenCode 源码 (Hono 框架 + Basic Auth)
- 发现 api-client 的 4 个实现错误并全部修复
- 创建详细调研文档 (OPENCODE-API-FINDINGS.md)

| 问题 | 原始实现 | 正确实现 |
|------|---------|---------|
| 认证方式 | Bearer token | Basic Auth |
| API 路径 | `/api/session` | `/session` |
| 发送消息 | `POST /prompt` | `POST /message` |
| 事件订阅 | per-session `/events` | 全局 `/event` |

### ✅ Milestone 2: OpenCode 编译和 Sidecar 集成
- `scripts/build-opencode.ts` 编译脚本
- 平台特定命名 (`opencode-server-aarch64-apple-darwin`)
- Tauri `externalBin` sidecar 配置
- Rust 侧 sidecar 自动启动 (`lib.rs`)

### ✅ Milestone 3: 基础聊天 UI
- 消息列表、输入框、Enter 键发送、Tailwind CSS

### ✅ Milestone 4: 端到端集成
- Sidecar 自动启动、连接重试、Session 创建、消息收发

### ✅ 代码质量优化
- api-client 类型对齐、server-manager 密码修复、自动滚动/loading 指示

---

## Phase 2: 体验优先 + WorkAny UI 1:1 还原 (🔧 进行中)

**方向**: 体验优先
**UI 参考**: WorkAny 1:1 还原
**执行顺序**: 2.1 → 2.2 → 2.5 → 2.3 → 2.4 → 2.6

### ✅ Iteration 2.1: UI 基础设施 + 布局骨架
- [x] 依赖: lucide-react, react-router-dom, @radix-ui/*, cva, clsx, tailwind-merge
- [x] `cn()` 工具函数 (`lib/utils.ts`)
- [x] shadcn/ui 组件: Button, Dialog, DropdownMenu, Tooltip + barrel export
- [x] RootLayout: SidebarProvider + LeftSidebar + Outlet (共享 sidebar 状态)
- [x] 三栏布局骨架: LeftSidebar (w-72/w-14) + MainContent + (预留 RightSidebar)
- [x] 路由: `/` (Home) + `/session/:id` (Session)
- [x] CSS 变量: WorkAny-style design tokens (`index.css`)
- [x] Review 修复: 删除孤立 App.tsx、修复 editor-default typo、aria-labels (9处)

**新增文件**:
```
src/
├── lib/utils.ts                         - cn() 工具
├── components/
│   ├── ui/
│   │   ├── index.ts                     - barrel export
│   │   ├── button.tsx                   - Button (6 variant × 4 size)
│   │   ├── dialog.tsx                   - Dialog 弹窗
│   │   ├── dropdown-menu.tsx            - 下拉菜单
│   │   └── tooltip.tsx                  - 工具提示
│   └── layout/
│       ├── index.ts                     - barrel export
│       ├── sidebar-context.tsx          - SidebarProvider + useSidebar
│       ├── left-sidebar.tsx             - 展开/折叠双态侧边栏
│       └── root-layout.tsx              - 共享布局 (Sidebar + Outlet)
├── pages/
│   ├── index.ts                         - barrel export
│   ├── Home.tsx                         - 居中标题 + 输入占位
│   └── Session.tsx                      - 聊天页面骨架
├── router.tsx                           - 路由配置
├── main.tsx                             - RouterProvider 入口
└── index.css                            - design tokens + 滚动条样式
```

### Iteration 2.2: 左侧栏 + Session 管理 (3-4h)
- [ ] Session 列表 (从 OpenCode API `/session` 获取)
- [ ] Session 项: 图标 + 标题 + 三点菜单 (Delete)
- [ ] 折叠态: hover popup 显示 session 列表
- [ ] 底部用户头像打开 Settings 入口
- [ ] Home 页输入框创建 session 并跳转

### Iteration 2.5: ChatInput 组件 (2-3h)
- [ ] 统一 ChatInput, 支持 home/reply 两种 variant
- [ ] Textarea 自动伸缩
- [ ] Shift+Enter 换行, Enter 发送
- [ ] 中文输入法 composing 处理
- [ ] 底部: + 按钮 + 圆形发送/停止按钮

### Iteration 2.3: Markdown 渲染 + 消息显示 (3-4h)
- [ ] react-markdown + remark-gfm + @tailwindcss/typography
- [ ] UserMessage 组件 + AI 消息 Markdown 渲染
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
- ❌ @agent/connector, workspace, notifier

---

**最后更新**: 2026-03-06
**当前阶段**: Phase 2 → Iteration 2.2
