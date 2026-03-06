# Ultrawork 测试指南

## 🚀 环境准备

### 前置条件

| 工具 | 最低版本 | 说明 |
|------|---------|------|
| Bun | v1.3.10 | 包管理和运行时（`curl -fsSL https://bun.sh/install \| bash`） |
| Node.js | v14+（仅 tsc） | TypeScript 编译器使用，Vite 通过 bun 运行 |

> **注意**: Node.js v14 不支持现代语法（`??=` 等），所有构建和 dev 命令必须通过 `bun run --bun` 执行。

### 1. 启动 OpenCode 服务器

```bash
# 方式一：无密码模式（开发推荐）
./packages/client/desktop/src-tauri/binaries/opencode-server-aarch64-apple-darwin serve --port 4096

# 方式二：带 API key（解锁更多模型）
export OPENCODE_API_KEY="sk-xxx..."
./packages/client/desktop/src-tauri/binaries/opencode-server-aarch64-apple-darwin serve --port 4096
```

**LLM 模型配置**（`~/.config/opencode/opencode.json`）：
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

| 场景 | 可用模型 | 说明 |
|------|---------|------|
| 无 API key | 3 个免费模型 (big-pickle, gpt-5-nano, minimax-m2.5-free) | 自动使用 `apiKey: "public"` |
| 有 API key | 35 个模型 (Claude/GPT/Gemini/GLM/Kimi 全系列) | 付费模型需账户有余额 |

### 2. 启动 Ultrawork Desktop

```bash
# 快速启动（推荐）
./start.sh

# 手动启动
export BUN_INSTALL="$HOME/.bun" && export PATH="$BUN_INSTALL/bin:$PATH"
bun install
bun run --bun turbo run typecheck
cd packages/client/desktop && bun run --bun vite dev
```

访问: http://localhost:1420

---

## ✅ Round 0 测试清单（环境修复 + 基础加固）

### 测试 R0-1: 构建流程
1. 运行 `bun run --bun turbo run typecheck`
2. **预期**: 3/3 包全部通过
3. 运行 `bun run --bun turbo run build`
4. **预期**: 构建成功，`dist/` 目录有 index.html + assets

### 测试 R0-2: Dev Server
1. 运行 `cd packages/client/desktop && bun run --bun vite dev`
2. **预期**: 在 200ms 内启动，监听 localhost:1420
3. 浏览器打开 http://localhost:1420
4. **预期**: 页面正常渲染，无白屏

### 测试 R0-3: Error Boundary
1. 在代码中故意引入一个组件渲染错误
2. **预期**: 显示 "Something went wrong" 错误页面 + Retry 按钮
3. **预期**: 不会白屏崩溃

### 测试 R0-4: Toast 通知
1. 断开 OpenCode 服务器
2. 在首页尝试发送消息
3. **预期**: 右上角出现红色 toast 通知 "Failed to send message"
4. 在侧栏尝试创建新会话
5. **预期**: 出现 toast 通知 "Failed to create session"

### 测试 R0-5: 暗色主题 Toast
1. 切换到暗色主题
2. 触发一个错误 toast
3. **预期**: Toast 样式适配暗色主题（不是白色背景）

### 测试 R0-6: API 连通性
1. 启动 OpenCode 服务器
2. 打开前端，检查侧栏会话列表
3. **预期**: 正常加载会话列表（可能为空）
4. 创建新会话并发送消息
5. **预期**: 消息成功发送，AI 回复正常显示

---

## ✅ Phase 2.7-2.9 功能测试清单

### Phase 2.7: 关键 Bug 修复

#### 测试 1: 消息布局分侧显示
1. 发送一条消息
2. **预期**: 用户消息显示在右侧，带圆角气泡和背景色
3. **预期**: 助手消息显示在左侧，全宽，无头像
4. **预期**: 消息之间有适当间距，无分隔线

#### 测试 2: 消息立即显示
1. 在首页输入消息并发送
2. **预期**: 立即跳转到会话页面
3. **预期**: 用户消息立即显示在聊天区域
4. **预期**: 不需要切换会话就能看到发送的消息

#### 测试 3: 智能自动滚动
1. 发送多条消息，让聊天区域有足够的内容可以滚动
2. 向上滚动查看历史消息
3. 发送新消息或等待助手回复
4. **预期**: 滚动位置保持不变，不会被强制滚到底部
5. 手动滚动到底部附近（100px 内）
6. 发送新消息
7. **预期**: 自动滚动到底部显示新消息

#### 测试 4: 会话标题实时更新
1. 创建新会话并发送消息
2. 观察左侧边栏
3. **预期**: 会话标题从 "New Chat" 自动更新为服务器生成的标题

---

### Phase 2.8: 设置面板升级

#### 测试 5: 标签页布局
1. 点击左下角设置图标
2. **预期**: 设置对话框打开，显示三个标签页：Connection, General, About
3. 点击每个标签页，**预期**: 切换流畅，内容正确

#### 测试 6: 连接测试
1. 打开设置 → Connection 标签页
2. 点击 "Test Connection" 按钮
3. **预期**: 测试成功显示绿色勾号和 "Connection successful!"
4. 修改 API Base URL 为错误地址
5. **预期**: 显示红色叉号和 "Connection failed"

#### 测试 7: 主题切换
1. 打开设置 → General 标签页
2. 切换 Light / Dark / System
3. **预期**: 应用立即切换主题，刷新后设置保留

#### 测试 8: 语言切换
1. 打开设置 → General 标签页
2. 切换 English / 中文
3. **预期**: 设置对话框所有文本立即切换

---

### Phase 2.9: Session 管理增强

#### 测试 9: 会话重命名
1. 点击任意会话的三点菜单 → "Rename"
2. **预期**: 内联编辑模式，Enter 保存，Escape 取消

#### 测试 10: 日期分组
1. 创建多个会话
2. **预期**: 按 Today / Yesterday / This Week / Earlier 分组显示

#### 测试 11: 搜索/过滤
1. 在搜索框输入关键词
2. **预期**: 会话列表实时过滤

#### 测试 12: 收藏/置顶
1. 点击会话的星标图标
2. **预期**: 会话置顶到所在分组顶部，刷新后保留

---

## 🔍 API 端到端测试结果（2026-03-06）

| 测试项 | 结果 | 说明 |
|--------|------|------|
| Bun 环境 | ✅ | bun v1.3.10 正常 |
| TypeCheck | ✅ | 3/3 包通过 |
| Vite Build | ✅ | 649 KB (gzip 203 KB) |
| Dev Server | ✅ | localhost:1420，267ms 启动 |
| 模块编译 | ✅ | 所有 tsx 文件无编译错误 |
| OpenCode 启动 | ✅ | health check 通过 |
| POST /session | ✅ | 创建会话正常 |
| GET /session | ✅ | 列表会话正常 |
| GET /event (SSE) | ✅ | 返回 `server.connected` 事件 |
| POST /session/:id/message | ✅ | big-pickle 模型回复正常 |
| GET /session/:id/message | ✅ | 返回 user + assistant 消息 |
| DELETE /session/:id | ✅ | 正常删除 |
| CORS | ✅ | localhost:1420 → :4096 已允许 |
| Auth (无密码模式) | ✅ | 带/不带 auth 均可访问 |

**消息格式**：OpenCode 返回的 assistant 消息包含 4 种 part 类型：
```
[step-start] → [reasoning] 思考过程 → [text] 正式回复 → [step-finish] reason=stop
```

---

## 🐛 已知问题

### 不影响使用
- 构建警告：chunk 大小超过 500 KB（可通过代码分割优化）
- server-manager 包没有输出文件（turbo.json 配置问题）
- `server-manager` 中 health 路径为 `/health`，实际应为 `/global/health`（当前未使用）
- OpenCode 消息 API 是同步返回完整回复（非真正流式），SSE 仅用于事件通知

### 需要后续优化
- 密码安全存储（目前 localStorage 明文）
- 消息虚拟化（长会话性能优化）
- 消息去重（理论上可能重复）

---

## 🎯 下一步

Round 1: UI 架构重构 - 对齐设计稿布局
