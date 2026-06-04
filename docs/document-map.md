# Ultrawork 文档地图

> 全部文档约 63 个 Markdown 文件，按用途分五层：入口层、功能层、决策层、讨论层、归档层。

## 目录树

```
ultrawork/
│
├── README.md                          # 项目入口：架构概览、技术栈、快速开始、功能列表
├── AGENTS.md                          # AI Agent 上下文：供 Claude Code / Copilot 等 AI 工具快速理解项目
├── CLAUDE.md                          # Claude Code 指令：任务收尾流程、模式记录规则、通用约定
├── CHANGELOG.md                       # 变更日志：Keep a Changelog 格式，按版本倒序
│
├── docs/                              # ═══ 功能文档层 ═══
│   ├── getting-started.md             #   快速上手：依赖安装、Clone、启动、FAQ、AI 协作工作流
│   ├── architecture-phase1.md         #   架构设计：Phase 1 系统架构图、模块职责、数据流（含架构图）
│   ├── architecture-full.md           #   完整架构设计：含 Control Plane、多端、企业管理（暂未纳入开发索引）
│   ├── build-and-deploy.md            #   构建部署：Sidecar 编译、Tauri 打包、签名、跨平台
│   ├── api-reference.md               #   API 参考：OpenCode Server 全部端点、请求/响应格式、认证
│   ├── conventions.md                 #   开发规范：代码约定、状态管理模式、SSE 处理、组件模式（从 MEMORY.md 提炼）
│   ├── testing.md                     #   测试策略：测试框架、用例设计、手动测试清单
│   ├── requirements.md                #   需求文档：产品功能需求与验收标准
│   ├── knowledge-base-replication-guide.md  # 知识库能力复制指南：组件清单 + 触发/噪音控制 + 启动方式 + 目标 Agent prompt
│   ├── mcp-technical-flow.md          #   MCP 技术流程：MCP 配置/连接/工具调用的端到端链路
│   ├── test-config-isolation.md       #   配置隔离测试说明（ADR-020 验证）
│   ├── document-map.md                #   本文件：文档树 + 功能说明索引
│   │
│   ├── decisions/                     # ═══ 架构决策层 (ADR) ═══
│   │   ├── README.md                  #   ADR 索引：模板说明 + 27 条决策一览表（权威索引）
│   │   ├── 001..017                   #   Phase 1 → Round 17 早期决策（Tauri/Sidecar/消息渲染/Dock/模型/工作区/SSE/MCP/暗色模式/Browser MCP 等）
│   │   ├── 018-wechat-channel-ilink.md       # 微信 Channel ilink 协议接入（2026-03-24）
│   │   ├── 019-knowledge-base-integration.md # 知识库集成方案（Withdrawn）
│   │   ├── 020-config-isolation.md           # Ultrawork 与 OpenCode 配置隔离
│   │   ├── 021-long-session-performance.md   # 长对话性能优化
│   │   ├── 022-model-switch-side-effects.md  # 运行时模型切换副作用修复
│   │   ├── 023-titlebar-overlay.md           # macOS 标题栏 Overlay 模式
│   │   ├── 024-workspace-path-display.md     # 工作目录路径展示优化
│   │   ├── 025-window-layout-symmetry.md     # 窗口布局对称性修复
│   │   ├── 026-knowledge-base-architecture.md # 知识库能力架构（本地 RAG + IMA + 自定义 API）
│   │   └── 028-release-readiness-hardening.md # 发布前 readiness 硬化（ADR-027 由 feat/acp-support 分支预留）
│   │
│   ├── discussions/                   # ═══ 讨论层（探索阶段，可能演变为 ADR）═══
│   │   ├── README.md                  #   讨论索引
│   │   ├── 001-mobile-relay.md        #   移动端与桌面端通信 — Relay Server 方案
│   │   ├── 003-sidecar-sharing.md     #   OpenCode Sidecar 能力共享 — 多进程复用
│   │   ├── 004-opencode-multi-agent.md  # OpenCode 多 Agent 机制调研
│   │   ├── 005-permission-question-dock.md  # Permission/Question Dock 机制调研
│   │   ├── 006-custom-llm-provider.md #   自定义 LLM Provider 机制调研
│   │   ├── 007-opencode-builtin-tools.md  # OpenCode 内置工具全景调研
│   │   ├── 008-opencode-builtin-agents-orchestration.md  # 内置 Agent 全景与 runLoop 引擎
│   │   └── 009-tauri-vs-electron.md     #   桌面端框架调研 — Tauri vs Electron 迁移评估
│   │
│   └── archive/                       # ═══ 历史归档层 ═══
│       ├── progress-raw.md            #   完整开发进度（Phase 1 → Round 15 全部记录）
│       ├── initial-monorepo-plan.md   #   项目初始化计划（原根目录 .plan.md，归档）
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
└── (Claude Code auto-memory)          # ═══ AI 工作记忆（本地，不入 git）═══
    │  实际位置：~/.claude/projects/<project-hash>/memory/（非项目内 .claude/memory/）
    ├── MEMORY.md                      #   Claude 跨 session 记忆（环境/API/状态索引）
    ├── dingtalk-channel-plan.md       #   钉钉渠道方案详细记录
    ├── vendor-patches.md              #   Vendor 补丁记录
    └── project_sidecar_process_cleanup.md  # Sidecar 进程清理方案记录
```

## 按角色的阅读路径

### 新成员入职
```
README.md → docs/getting-started.md → docs/architecture-phase1.md → docs/conventions.md
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
| **入口层** | 根目录 | 4 | 所有人 | 每次任务结束 |
| **功能层** | `docs/*.md` | 12 | 开发者 | 按需更新 |
| **决策层** | `docs/decisions/` | 28 (README + 27 ADR) | 架构师/新成员 | 有重大决策时新增 |
| **讨论层** | `docs/discussions/` | 9 (README + 8) | 架构师 | 探索阶段记录 |
| **归档层** | `docs/archive/` | 9 | 考古/追溯 | 只追加不修改 |
| **设计层** | `design/` | 4+ | 产品/设计 | 需求变更时 |
| **AI 记忆** | auto-memory (本地) | 4 | Claude Code | 每次 session |

## 维护规则

1. **根目录只保留 4 个 .md**：README、AGENTS、CLAUDE、CHANGELOG
2. **新功能文档**放 `docs/`，新决策放 `docs/decisions/NNN-*.md`
3. **任务收尾**更新 CHANGELOG → 同步 conventions.md → 如有 ADR 则新建（详见 CLAUDE.md）
4. **归档只追加不修改**，保证历史可追溯
5. **设计资料**不入 git 主仓（`.gitignore` 排除 .fig 和 prototype/node_modules）
6. **`.claude/memory/`** 是 Claude Code 本地工作记忆，不入版本控制（已在 `.gitignore` 中排除）。GitHub 上看不到此目录
