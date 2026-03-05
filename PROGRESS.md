# Ultrawork 开发进度

## 📊 总体状态

```
Phase 1 MVP: ✅ 完成
TypeCheck:   ✅ 全部通过 (3/3 packages)
Commits:     20+
Packages:    3 (全部实现)
```

---

## ✅ Milestone 1: OpenCode API 调研 (2026-03-05)

### 调研成果
- ✅ 分析 OpenCode 源码 (Hono 框架 + Basic Auth)
- ✅ 发现 api-client 的 4 个实现错误并全部修复
- ✅ 创建详细调研文档 (OPENCODE-API-FINDINGS.md)

### 关键发现
| 问题 | 原始实现 | 正确实现 |
|------|---------|---------|
| 认证方式 | Bearer token | Basic Auth |
| API 路径 | `/api/session` | `/session` |
| 发送消息 | `POST /prompt` | `POST /message` |
| 事件订阅 | per-session `/events` | 全局 `/event` |

---

## ✅ Milestone 2: OpenCode 编译和 Sidecar 集成 (2026-03-05)

- ✅ 创建 `scripts/build-opencode.ts` 编译脚本
- ✅ 处理平台特定命名 (e.g. `opencode-server-aarch64-apple-darwin`)
- ✅ 配置 Tauri `externalBin` sidecar
- ✅ 配置 Rust 侧 sidecar 自动启动 (`lib.rs`)

### 踩坑记录
| 问题 | 原因 | 解决方式 |
|------|------|---------|
| 二进制名称不匹配 | Tauri 要求带平台后缀 | 生成 `opencode-server-{target}` 格式 |
| 图标文件缺失 | 空的 icons 目录 | 用 `tauri icon` 命令生成 |
| main.rs 缺失 | git restore 未包含此文件 | 手动创建 |
| `--password` 无效 | OpenCode 不接受 CLI 密码参数 | 改用 `OPENCODE_SERVER_PASSWORD` 环境变量 |

---

## ✅ Milestone 3: 基础聊天 UI (2026-03-05)

- ✅ 消息列表 (用户消息右对齐蓝色, 助手消息左对齐白色)
- ✅ 输入框 + 发送按钮
- ✅ Enter 键发送
- ✅ Tailwind CSS 样式

---

## ✅ Milestone 4: 端到端集成 (2026-03-05)

- ✅ Sidecar 自动启动 OpenCode Server
- ✅ 连接重试 (10 次, 每次 2 秒间隔)
- ✅ Session 创建
- ✅ 消息发送和接收

### 踩坑记录
| 问题 | 原因 | 解决方式 |
|------|------|---------|
| Connection failed | 服务启动需要 ~7 秒 | 添加重试逻辑 |
| 消息无回复 | 请求体格式错误 (`prompt` → `parts`) | 改用 `{ parts: [{ type: "text", text }] }` |
| 无 AI 响应 | 未配置 AI Provider | 配置 OpenCode Zen + Big Pickle 模型 |

---

## ✅ 代码质量优化 (2026-03-05)

- ✅ `@agent/api-client` 类型与实际 API 对齐
  - 更新 `SessionCreateResponse` 匹配真实响应
  - 新增 `MessagePart`, `SendMessageRequest`, `SendMessageResponse` 类型
  - `sendMessage()` 使用 parts 数组格式
- ✅ `@agent/server-manager` 密码传递修复 (CLI → 环境变量)
- ✅ `App.tsx` 使用 `@agent/api-client` 包代替直接 fetch
- ✅ 新增 UI 功能：自动滚动、loading 指示、空状态占位、输入禁用

---

## 📁 代码统计

```
packages/core/api-client/
├── src/types.ts      (81 lines) - API 类型定义
├── src/client.ts     (88 lines) - REST 客户端
└── src/index.ts      (16 lines) - 导出

packages/core/server-manager/
├── src/types.ts      (16 lines) - 配置和状态类型
├── src/manager.ts    (98 lines) - 进程管理器
└── src/index.ts      (3 lines)  - 导出

packages/client/desktop/
├── src/App.tsx       (150 lines) - 聊天 UI + API 集成
├── src/main.tsx      (11 lines)  - React 入口
├── src/index.css     (2 lines)   - Tailwind 导入
└── src-tauri/
    ├── src/lib.rs    (31 lines)  - Sidecar 启动
    └── src/main.rs   (4 lines)   - Rust 入口

scripts/
└── build-opencode.ts (42 lines) - 编译脚本

Total: ~542 lines of implementation code
```

---

## 🎯 Phase 2: 体验优先 + WorkAny UI 1:1 还原

**方向**: 体验优先 (A)
**UI 参考**: WorkAny 1:1 还原
**执行顺序**: 2.1 → 2.2 → 2.5 → 2.3 → 2.4 → 2.6

### Iteration 2.1: UI 基础设施 + 布局骨架 (3-4h)
- [ ] 安装依赖: lucide-react, react-router-dom, @radix-ui/*, cva, clsx, tailwind-merge
- [ ] 创建 `cn()` 工具函数
- [ ] 搬入 shadcn/ui 基础组件: Button, Dialog, DropdownMenu, Tooltip
- [ ] 三栏布局骨架: LeftSidebar + MainContent + (预留 RightSidebar)
- [ ] SidebarProvider/Context (展开/折叠)
- [ ] 路由: `/` (Home) + `/session/:id` (Chat)

### Iteration 2.2: 左侧栏 + Session 管理 (3-4h)
- [ ] LeftSidebar 完整实现 (展开态 w-72 / 折叠态 w-14)
- [ ] Logo + App 名称 + 折叠按钮
- [ ] "New Chat" 按钮
- [ ] Session 列表 (从 OpenCode API 获取)
- [ ] Session 项: 图标 + 标题 + 三点菜单 (Delete)
- [ ] 折叠态: 图标 + hover popup
- [ ] 底部用户头像 + Settings 入口

### Iteration 2.5: ChatInput 组件 (2-3h)
- [ ] 统一 ChatInput, 支持 home/reply 两种 variant
- [ ] Textarea 自动伸缩
- [ ] Shift+Enter 换行, Enter 发送
- [ ] 中文输入法 composing 处理
- [ ] 底部: + 按钮 + 圆形发送/停止按钮
- [ ] Home 页: 居中大标题 + ChatInput(home variant)

### Iteration 2.3: Markdown 渲染 + 消息显示 (3-4h)
- [ ] 安装 react-markdown + remark-gfm + @tailwindcss/typography
- [ ] UserMessage 组件 (右对齐, bg-accent/50)
- [ ] AI 消息: Markdown + 代码块 + 表格 + 链接
- [ ] 代码块语法高亮
- [ ] RunningIndicator (spinner + 活动描述)
- [ ] 自动滚动 + 手动暂停 + "滚到底部"按钮

### Iteration 2.4: SSE 流式响应 (4-5h)
- [ ] SSE 客户端连接 `/event`
- [ ] 解析事件类型 (message.text, tool.call, tool.result 等)
- [ ] 流式拼接文本, 逐字显示
- [ ] 工具调用事件显示
- [ ] 断线重连
- [ ] api-client `subscribeToEvents()` 支持 Basic Auth

### Iteration 2.6: 设置面板 + 配置管理 (2-3h)
- [ ] SettingsModal 组件 (Dialog 弹窗)
- [ ] 配置项: Server 地址, 密码, 端口
- [ ] 配置持久化 (localStorage / Tauri store)
- [ ] 连接状态指示

### Phase 2 Scope Out (→ Phase 3)
- ❌ RightSidebar (Artifacts/文件树/工具历史)
- ❌ 预览面板 (HTML/代码/文档预览)
- ❌ 附件/图片上传
- ❌ i18n 多语言
- ❌ PlanApproval / QuestionInput
- ❌ Library 页面 / Setup 引导页
- ❌ 暗色模式
- ❌ @agent/connector, workspace, notifier

---

**最后更新**: 2026-03-05
**当前阶段**: Phase 2 开发中 → Iteration 2.1
