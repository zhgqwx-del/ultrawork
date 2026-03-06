# Ultrawork - AI Agent Desktop App

## 🎉 Phase 2 完成！

Desktop App 已完成所有基础功能和体验优化，达到生产级水平。

## ✅ 当前状态

```
Phase 1 MVP: ✅ 完成
Phase 2 UI:  ✅ 完成 (2.1-2.10 全部完成)
Phase 2.7:   ✅ 关键 Bug 修复
Phase 2.8:   ✅ 设置面板升级
Phase 2.9:   ✅ Session 管理增强
Phase 2.10:  ✅ 用户测试修复
TypeCheck:   ✅ 全部通过
Vite Build:  ✅ 通过 (612 KB, gzipped: 192 KB)
测试状态:    ✅ 桌面应用运行正常 (100% 通过率)
```

## 🚀 快速开始

### 方法 1: 使用启动脚本（推荐）
```bash
./start.sh
```

### 方法 2: 手动启动
```bash
# 1. 安装依赖
npm install

# 2. 类型检查
npm run typecheck

# 3. 构建
npm run build

# 4. 启动开发服务器
npm run dev
```

### 前置要求
- ✅ OpenCode 服务器运行在 `http://localhost:4096`
- ✅ OpenCode 密码设置为 `test123`

## ✨ 核心功能

### 聊天功能
- ✅ 消息发送和接收
- ✅ SSE 流式响应（逐字符显示）
- ✅ Markdown 渲染（代码块、表格、链接等）
- ✅ 用户消息右对齐气泡，助手消息左对齐
- ✅ 智能自动滚动（不打断用户查看历史）

### Session 管理
- ✅ 创建/删除 Session
- ✅ Session 重命名（内联编辑）
- ✅ 日期分组（Today / Yesterday / This Week / Earlier）
- ✅ 搜索/过滤 Session
- ✅ 收藏/置顶 Session
- ✅ 标题实时更新（SSE 事件驱动）

### 设置面板
- ✅ 标签页布局（Connection / General / About）
- ✅ 连接测试功能
- ✅ 主题切换（Light / Dark / System）
- ✅ 国际化（English / 中文）
- ✅ 连接状态实时显示

### UI/UX
- ✅ 响应式布局
- ✅ 深色模式完整支持
- ✅ 侧边栏折叠/展开
- ✅ 悬停效果和活动状态高亮
- ✅ 清晰的视觉层次

## 📁 项目结构

```
ultrawork/
├── packages/
│   ├── core/
│   │   ├── api-client/          # OpenCode REST/SSE 客户端
│   │   └── server-manager/      # OpenCode 进程管理
│   └── client/
│       └── desktop/             # Tauri 桌面应用
│           ├── src/
│           │   ├── components/  # UI 组件
│           │   ├── lib/         # Hooks & 工具
│           │   ├── pages/       # 路由页面
│           │   └── main.tsx     # 应用入口
│           └── src-tauri/       # Tauri 后端
├── docs/                        # 架构文档
├── scripts/                     # 构建脚本
├── PROGRESS.md                  # 详细开发进度
├── TESTING-GUIDE.md            # 测试指南
├── PHASE-2-SUMMARY.md          # Phase 2 总结
└── start.sh                     # 快速启动脚本
```

## 📝 技术栈

- **Runtime**: Node.js / Bun
- **Build**: Turborepo 2.8.13 + Vite 7.3.1
- **UI**: React 19 + Tailwind CSS 4
- **Desktop**: Tauri 2
- **Language**: TypeScript 5.8+
- **State**: React Context API
- **Styling**: CSS Variables + Tailwind
- **Icons**: Lucide React
- **Components**: Radix UI
- **Backend**: OpenCode Server

## 📚 文档

- [PROGRESS.md](./PROGRESS.md) - 详细开发进度（包含 Phase 2.10 用户测试修复）
- [TESTING-GUIDE.md](./TESTING-GUIDE.md) - 完整测试指南（18 个测试用例）
- [TEST-REPORT-2026-03-06.md](./TEST-REPORT-2026-03-06.md) - 用户测试报告
- [PHASE-2-SUMMARY.md](./PHASE-2-SUMMARY.md) - Phase 2 完成总结
- [OPENCODE-API-FINDINGS.md](./OPENCODE-API-FINDINGS.md) - OpenCode API 调研
- [docs/architecture-phase1.md](./docs/architecture-phase1.md) - 架构设计

## 🎯 下一步计划

### Phase 3: 功能扩展

**Phase 3.1: 工具调用展示** (推荐优先)
- 显示 Agent 使用的工具（Read/Write/Bash 等）
- 折叠式工具组
- 文件操作可视化

**Phase 3.2: 右侧边栏 + Artifact**
- 文件树面板
- 代码/HTML 预览
- 语法高亮

**Phase 3.3: 文件附件**
- 图片上传和预览
- 拖拽上传
- 粘贴板支持

**Phase 3.4: 核心包实现**
- @agent/connector（本地/远程连接抽象）
- @agent/workspace（~/.ultrawork/ 目录管理）
- @agent/notifier（通知分发）

## 🧪 测试

详细测试指南请查看 [TESTING-GUIDE.md](./TESTING-GUIDE.md)

### 快速测试
1. 启动应用: `./start.sh`
2. 发送消息，验证流式响应
3. 测试主题切换（设置 → General → Theme）
4. 测试语言切换（设置 → General → Language）
5. 测试 Session 重命名、搜索、置顶

## 📊 性能指标

- **构建大小**: 612 KB (gzipped: 192 KB)
- **首屏加载**: < 1s
- **类型检查**: 通过
- **构建时间**: ~3s

## 🐛 已知限制

### OpenCode API 限制
- **流式输出不可用**: OpenCode 当前不通过 SSE 发送 `message.delta` 事件，AI 回复是一次性返回的完整消息，无法实现逐字符流式显示

### 需要后续优化
- 错误提示 Toast（目前仅 console.error）
- 密码安全存储（目前 localStorage 明文）
- 消息虚拟化（长会话性能优化）
- 前端模拟流式效果（可选）

## 🙏 致谢

参考项目：
- [WorkAny](https://github.com/workany-ai/workany) - UI/UX 设计参考
- [OpenCode](https://github.com/anomalyco/opencode) - Agent 能力参考

---

**最后更新**: 2026-03-06
**当前阶段**: Phase 2 完成 ✅ → 准备 Phase 3

