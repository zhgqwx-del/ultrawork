# Ultrawork 文档地图

> 全部文档 41 个 Markdown 文件，按用途分四层：入口层、功能层、决策层、归档层。

## 目录树

```
ultrawork/
│
├── README.md                          # 项目入口：架构概览、技术栈、快速开始、功能列表
├── AGENTS.md                          # AI Agent 上下文：供 Claude Code / Copilot 等 AI 工具快速理解项目
├── CLAUDE.md                          # Claude Code 指令：轮次收尾流程、模式记录规则、通用约定
├── CHANGELOG.md                       # 变更日志：Keep a Changelog 格式，按版本倒序
│
├── docs/                              # ═══ 功能文档层 ═══
│   ├── getting-started.md             #   快速上手：依赖安装、Clone、启动、FAQ
│   ├── architecture.md                #   架构设计：系统架构图、模块职责、数据流（1788 行，含 Phase 1 全量设计）
│   ├── build-and-deploy.md            #   构建部署：Sidecar 编译、Tauri 打包、签名、跨平台
│   ├── api-reference.md               #   API 参考：OpenCode Server 全部端点、请求/响应格式、认证
│   ├── conventions.md                 #   开发规范：代码约定、状态管理模式、SSE 处理、组件模式（从 MEMORY.md 提炼）
│   ├── testing.md                     #   测试策略：测试框架、用例设计、手动测试清单
│   ├── requirements.md                #   需求文档：产品功能需求与验收标准
│   ├── document-map.md                #   本文件：文档树 + 功能说明索引
│   │
│   ├── decisions/                     # ═══ 架构决策层 (ADR) ═══
│   │   ├── README.md                  #   ADR 索引：模板说明 + 15 条决策一览表
│   │   ├── 001-tauri-react.md         #   Tauri 2 + React 19 技术选型（Phase 1）
│   │   ├── 002-opencode-sidecar.md    #   OpenCode 编译为 Headless Sidecar（Phase 1）
│   │   ├── 003-shadcn-tailwind.md     #   shadcn/ui + Tailwind CSS 4 组件体系（Phase 2）
│   │   ├── 004-structured-message-parts.md  # 结构化消息 7 Part Types 渲染（Round 2）
│   │   ├── 005-permission-question-dock.md  # Permission & Question 底部 Dock 交互（Round 3）
│   │   ├── 006-model-management.md    #   模型管理独立 Dialog + Popover 快速切换（Round 4）
│   │   ├── 007-workspace-isolation.md #   工作区目录隔离 via x-opencode-directory（Round 5）
│   │   ├── 008-sse-global-polling-fallback.md  # SSE 全局化 + 3s 轮询兜底（Round 5）
│   │   ├── 009-artifact-preview-split.md  # 产物预览 50/50 分屏 + CodeMirror（Round 7）
│   │   ├── 010-shared-hook-pattern.md #   共享 Hook 提取模式 useMCPServers/useSkills（Round 10）
│   │   ├── 011-mcp-localstorage-persistence.md  # MCP 状态 localStorage 持久化（Round 11）
│   │   ├── 012-optimistic-message-active-tracking.md  # 乐观消息 + 活跃状态追踪（Round 12）
│   │   ├── 013-channel-gateway-sidecar.md  # Channel Gateway 独立 Sidecar 进程（Round 13）
│   │   ├── 014-dingtalk-stream-sdk.md #   DingTalk Stream SDK 选型（Round 13）
│   │   └── 015-dark-mode-codemirror.md  # 深色模式纯黑 + CodeMirror 6（Round 15）
│   │
│   └── archive/                       # ═══ 历史归档层 ═══
│       ├── progress-raw.md            #   完整开发进度（2982 行，Phase 1 → Round 15 全部记录）
│       ├── reviews/
│       │   ├── review-phase1.md       #   Phase 1 代码审查
│       │   ├── review-2.3-markdown.md #   Phase 2.3 Markdown 渲染审查
│       │   ├── review-2.4-sse.md      #   Phase 2.4 SSE 实现审查
│       │   └── review-2.5-chatinput.md  # Phase 2.5 ChatInput 审查
│       ├── summaries/
│       │   ├── phase-2-summary.md     #   Phase 2 整体总结
│       │   └── phase-2.10-summary.md  #   Phase 2.10 迭代总结
│       └── test-reports/
│           └── test-report-2026-03-06.md  # 2026-03-06 测试报告
│
├── design/                            # ═══ 设计资料 ═══
│   ├── product/                       #   产品设计
│   │   ├── feature-checklist.md       #   功能清单：全部功能点 + 完成状态
│   │   ├── ultrawork.fig              #   Figma 原型图源文件
│   │   └── prototype/                 #   可运行的 HTML 原型（React + Vite）
│   │       ├── index.html
│   │       ├── package.json
│   │       ├── src/                   #   原型源码（app/, main.tsx, styles/）
│   │       ├── guidelines/
│   │       │   └── Guidelines.md      #   UI 设计规范指南
│   │       ├── ATTRIBUTIONS.md        #   第三方素材归属
│   │       └── README.md              #   原型说明
│   └── references/                    #   竞品参考截图
│       ├── qoderwork/                 #   QoderWork 参考（3 张截图）
│       └── workany/                   #   WorkAny 参考（2 张截图）
│
└── .claude/memory/                    # ═══ AI 工作记忆（不入库）═══
    ├── MEMORY.md                      #   Claude 跨 session 记忆（93 行）
    ├── dingtalk-channel-plan.md       #   钉钉渠道方案详细记录
    └── vendor-patches.md              #   Vendor 补丁记录
```

## 按角色的阅读路径

### 新成员入职
```
README.md → docs/getting-started.md → docs/architecture.md → docs/conventions.md
```

### 理解某个技术决策
```
docs/decisions/README.md → 找到对应 ADR → 相关源码
```

### 了解 OpenCode API
```
docs/api-reference.md → docs/conventions.md §4 (API 约定)
```

### 追溯历史变更
```
CHANGELOG.md (摘要) → docs/archive/progress-raw.md (完整记录) → docs/archive/reviews/ (审查详情)
```

### AI Agent 上下文加载
```
CLAUDE.md (指令) → AGENTS.md (快速参考) → .claude/memory/MEMORY.md (工作记忆)
```

### 产品设计对照
```
design/product/feature-checklist.md (功能状态) → design/product/prototype/ (可运行原型)
```

## 文件分层说明

| 层级 | 目录 | 文件数 | 受众 | 更新频率 |
|------|------|--------|------|----------|
| **入口层** | 根目录 | 4 | 所有人 | 每轮结束 |
| **功能层** | `docs/*.md` | 7 | 开发者 | 按需更新 |
| **决策层** | `docs/decisions/` | 16 | 架构师/新成员 | 有重大决策时新增 |
| **归档层** | `docs/archive/` | 8 | 考古/追溯 | 只追加不修改 |
| **设计层** | `design/` | 5+ | 产品/设计 | 需求变更时 |
| **AI 记忆** | `.claude/memory/` | 3 | Claude Code | 每次 session |

## 维护规则

1. **根目录只保留 4 个 .md**：README、AGENTS、CLAUDE、CHANGELOG
2. **新功能文档**放 `docs/`，新决策放 `docs/decisions/NNN-*.md`
3. **轮次收尾**更新 CHANGELOG → 同步 conventions.md → 如有 ADR 则新建（详见 CLAUDE.md）
4. **归档只追加不修改**，保证历史可追溯
5. **设计资料**不入 git 主仓（`.gitignore` 排除 .fig 和 prototype/node_modules）
