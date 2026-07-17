# Ultrawork 文档地图

> 全部文档约 95 个 Markdown 文件，按用途分五层：入口层、功能层、决策层、讨论层、归档层。
> （计数为约数，非权威；准确性由 `scripts/check-docs.ts` 校验 ADR/路径等可机检项。）
> **本文件不逐条罗列 decisions/discussions 文件名**——那两层的权威索引是各自目录的 `README.md`，此处只放层级说明 + 指针（罗列必然漂移）。

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
│   ├── agent-os-target-architecture.md #  Agent OS 目标架构（开发起点，阶段1-3 已落地）：ADR-027/030/031 + discussions 011-014 收敛；§0 决策基线表 + 阶段0-4 路线图
│   ├── build-and-deploy.md            #   构建部署：Sidecar 编译、Tauri 打包、签名、跨平台
│   ├── api-reference.md               #   API 参考：OpenCode Server 全部端点、请求/响应格式、认证
│   ├── conventions.md                 #   开发规范：代码约定、状态管理模式、SSE 处理、组件模式（正向模式）
│   ├── gotchas.md                      #   踩坑清单：OpenCode/MCP/Gateway/IMA/Tauri 反向陷阱 + 上游非直觉契约（SSOT，从 MEMORY 固化）
│   ├── quality-gates.md                #   质量门禁：改动合入/收尾前的完成定义 checklist
│   ├── testing.md                     #   测试策略：测试框架、用例设计、手动测试清单
│   ├── requirements.md                #   需求文档：产品定位、包状态摘要、功能需求与实现状态
│   ├── vendor-patch-workflow.md       #   Vendor patch 管理：patch 内容表 + 重新生成/更新 submodule 完整流程（从 CLAUDE.md 外移）
│   ├── test-config-isolation.md       #   配置隔离测试说明（ADR-020 验证）
│   ├── document-map.md                #   本文件：文档树 + 功能说明索引
│   │
│   ├── decisions/                     # ═══ 架构决策层 (ADR) ═══
│   │   ├── README.md                  #   ADR 权威索引：模板说明 + 全部决策一览表（编号/标题/状态/日期）★ 找 ADR 从这里进
│   │   └── 001..043                   #   ADR 正文（Tauri/Sidecar/消息渲染/知识库/ACP 多 agent/connector/orchestrator/内置技能/跨平台/软刷新/zip 分发/BYOK 搜索/办公 CLI 连接器等）
│   │
│   ├── discussions/                   # ═══ 讨论层（探索/调研，提案可能演变为 ADR）═══
│   │   ├── README.md                  #   讨论权威索引（区分「调研记录(权威参考)」vs「讨论中(待定提案)」vs「已落地」）★ 找讨论从这里进
│   │   └── 001..025                   #   调研/方案正文（mobile-relay/sidecar-sharing/custom-provider/vendor-bump-perf/工具披露/会话一致性/plan 面板/ppt-master 等）
│   │
│   └── archive/                       # ═══ 历史归档层（README.md 是索引）═══
│       ├── README.md                  #   归档索引：每个文件的归档原因 + 何时值得回看
│       ├── progress-raw.md            #   完整开发进度（Phase 1 → Round 15 全部记录）
│       ├── initial-monorepo-plan.md   #   项目初始化计划（原根目录 .plan.md，归档）
│       ├── architecture-full.md       #   远期愿景架构（Phase 2+，FROZEN 2026-07-03）
│       ├── mcp-technical-flow.md      #   MCP 端到端技术流程（已被 gotchas §3/§11 + conventions §7 + ADR 取代）
│       ├── knowledge-base-replication-guide.md  # 知识库能力复制指南（KB 已落地，ADR-026 为权威）
│       ├── agent-os-kickoff.md        #   Agent OS 启动 prompt（阶段0-3 已全部落地，使命完成）
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
| **功能层** | `docs/*.md` | 13 | 开发者 | 按需更新 |
| **决策层** | `docs/decisions/` | 61 (README + 60 ADR) | 架构师/新成员 | 有重大决策时新增 |
| **讨论层** | `docs/discussions/` | 42 (README + 41) | 架构师 | 探索阶段记录 |
| **归档层** | `docs/archive/` | 14 | 考古/追溯 | 归档时可加 FROZEN 头，之后只追加不修改 |
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
8. **漂移校验**：`bun run --bun scripts/check-docs.ts` 机检 ADR/分层计数 / 引用路径与 Markdown 链接 / gotchas·conventions §N 章节号 / 版本号一致性 / MEMORY 行数；收尾时运行，CI `docs` job 同跑作合并门禁
