# Ultrawork 文档地图

> 全部文档约 70 个 Markdown 文件，按用途分五层：入口层、功能层、决策层、讨论层、归档层。
> （计数为约数，非权威；准确性由 `scripts/check-docs.ts` 校验 ADR/路径等可机检项。）

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
│   ├── architecture-phase1.md         #   架构设计：Part I 已实现现状（系统架构图/模块职责/数据流）+ Part II 规划中设计草案
│   ├── architecture-full.md           #   远期愿景架构（Phase 2+）：Control Plane、多端、企业管理、跨端协同（暂未纳入开发索引；已移除与 phase1 的重叠章节）
│   ├── agent-os-target-architecture.md #  Agent OS 目标架构（开发起点）：ADR-027/030/031 + discussions 011-014 收敛；§0 决策基线表 + 渲染统一/connector/orchestrator 分层 + 阶段0-4 路线图
│   ├── agent-os-kickoff.md             #  Agent OS 开发启动指引：换窗口/换电脑/换项目的启动方式 + 首条 prompt（同项目 clone+setup、新项目可移植 vs 专属甄别）
│   ├── build-and-deploy.md            #   构建部署：Sidecar 编译、Tauri 打包、签名、跨平台
│   ├── api-reference.md               #   API 参考：OpenCode Server 全部端点、请求/响应格式、认证
│   ├── conventions.md                 #   开发规范：代码约定、状态管理模式、SSE 处理、组件模式（正向模式）
│   ├── gotchas.md                      #   踩坑清单：OpenCode/MCP/Gateway/IMA/Tauri 反向陷阱 + 上游非直觉契约（SSOT，从 MEMORY 固化）
│   ├── quality-gates.md                #   质量门禁：改动合入/收尾前的完成定义 checklist
│   ├── testing.md                     #   测试策略：测试框架、用例设计、手动测试清单
│   ├── requirements.md                #   需求文档：产品功能需求与验收标准
│   ├── knowledge-base-replication-guide.md  # 知识库能力复制指南：组件清单 + 触发/噪音控制 + 启动方式 + 目标 Agent prompt
│   ├── mcp-technical-flow.md          #   MCP 技术流程：MCP 配置/连接/工具调用的端到端链路
│   ├── test-config-isolation.md       #   配置隔离测试说明（ADR-020 验证）
│   ├── document-map.md                #   本文件：文档树 + 功能说明索引
│   │
│   ├── decisions/                     # ═══ 架构决策层 (ADR) ═══
│   │   ├── README.md                  #   ADR 索引：模板说明 + 31 条决策一览表（权威索引）
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
│   │   ├── 027-acp-multi-agent-backend.md   # ACP 多 Agent 后端支持 — 经 ACP 统一调度多 agent（阶段1 归一化实现章节）
│   │   ├── 028-release-readiness-hardening.md # 发布前 readiness 硬化
│   │   ├── 029-execution-flow-turn-grouping.md # 主对话「执行流程」收纳 — 回合级消息分组与过程/答案分层
│   │   ├── 030-agent-connector-control-layer.md # @agent/connector — 后端无关控制+事件统一层（OpenCode REST + ACP 双 backend）
│   │   └── 031-multi-agent-orchestration.md  # 多 Agent 编排（档2 delegate）— orchestrator + spawn/steer 原语 + 编排模式
│   │
│   ├── discussions/                   # ═══ 讨论层（探索/调研，提案可能演变为 ADR）═══
│   │   ├── README.md                  #   讨论索引（区分「调研记录(权威参考)」vs「讨论中(待定提案)」）
│   │   ├── 001-mobile-relay.md        #   移动端与桌面端通信 — Relay Server 方案
│   │   ├── 002-commercialization.md   #   商业化方案讨论
│   │   ├── 003-sidecar-sharing.md     #   OpenCode Sidecar 能力共享 — 多进程复用
│   │   ├── 004-opencode-multi-agent.md  # OpenCode 多 Agent 机制调研
│   │   ├── 005-permission-question-dock.md  # Permission/Question Dock 机制调研
│   │   ├── 006-custom-llm-provider.md #   自定义 LLM Provider 机制调研
│   │   ├── 007-opencode-builtin-tools.md  # OpenCode 内置工具全景调研
│   │   ├── 008-opencode-builtin-agents-orchestration.md  # 内置 Agent 全景与 runLoop 引擎
│   │   ├── 009-tauri-vs-electron.md     #   桌面端框架调研 — Tauri vs Electron 迁移评估
│   │   └── 010-ai-dev-doc-quality.md    #   AI 驱动开发的文档质量保障体系 — 诊断与优化方案
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
    ├── MEMORY.md                      #   索引 + 瞬时状态（< 200 行；稳定知识已下沉到 git 文档）
    ├── acp-branch.md                  #   ACP feat/acp-support 分支专题（main 无此功能）
    ├── vendor-opencode-bump-survey.md #   vendor/opencode 升级调研记录
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
| **功能层** | `docs/*.md` | 16 | 开发者 | 按需更新 |
| **决策层** | `docs/decisions/` | 32 (README + 31 ADR) | 架构师/新成员 | 有重大决策时新增 |
| **讨论层** | `docs/discussions/` | 18 (README + 17) | 架构师 | 探索阶段记录 |
| **归档层** | `docs/archive/` | 9 | 考古/追溯 | 只追加不修改 |
| **设计层** | `design/` | 4+ | 产品/设计 | 需求变更时 |
| **AI 记忆** | auto-memory (本地) | 6 | Claude Code | 每次 session |

## 维护规则

1. **根目录只保留 4 个 .md**：README、AGENTS、CLAUDE、CHANGELOG
2. **新功能文档**放 `docs/`，新决策放 `docs/decisions/NNN-*.md`
3. **任务收尾**更新 CHANGELOG → 同步 staging（conventions.md / gotchas.md）→ 如有 ADR 则新建（详见 CLAUDE.md）
4. **归档只追加不修改**，保证历史可追溯
5. **设计资料**不入 git 主仓（`.gitignore` 排除 .fig 和 prototype/node_modules）
6. **`.claude/memory/`** 是 Claude Code 本地工作记忆，不入版本控制（已在 `.gitignore` 中排除）。GitHub 上看不到此目录。**稳定的团队知识不要只留在此**——应固化到 git 文档（见 CLAUDE.md §记忆与文档分工）
7. **SSOT 原则**：每类事实指定唯一权威源（API 端点→`api-reference.md`、坑点→`gotchas.md`、命令→`getting-started.md`、关键文件→`AGENTS.md`），其余位置放摘要 + 链接，避免多副本漂移
8. **漂移校验**：`bun run --bun scripts/check-docs.ts` 机检 ADR 计数 / 引用路径 / MEMORY 行数；收尾时运行
