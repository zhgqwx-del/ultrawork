# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

<!-- Round 1-18 使用线性编号；此后改用 GitHub Issue# 标识（如 #42: 描述） -->

## [Unreleased]

### Added
- **Team 页——agent 驱动编排的独立 surface（Agent OS 阶段3 第三批，017 五项拍板全实现，M1-M6）**：`/orchestration` 扩为两 tab（「Team 协作」新 +「流水线」现有表单平移 `pipeline-tab.tsx` 零逻辑改动）。**Team tab**（`team-tab.tsx`）= Leader 会话聊天面：Leader 下拉（默认 opencode）+ 成员勾选（默认全选、创建后锁定）+ 历史 Team 会话列表（sidecar 注册表）+ 聊天面全复用既有栈（MessageList/ChatInput/DelegateDock/Permission·QuestionDock，delegate 卡片零新渲染器）。**Leader system 提示**（`team-leader-prompt.ts`，017 §2.4：拆分判断/子任务自包含/同轮并行委派/汇总标注来源/点名 `orchestrator_delegate`·`mcp__orchestrator__delegate`/禁内置 task·subagent/cwd 注入/成员清单动态拼接）。**per-backend 注入**：opencode leader = 全局 MCP 静默 ensure（`orchestrator-mcp.ts`，KB 同模式幂等）+ 每轮 `promptAsync system`（新参数，vendor per-message append）+ 每轮 `tools:{"task":false}` deny 内置 task；ACP leader = `POST /acp/session` 新 `systemPrompt` 参数 → claude adapter ≥0.44 **`_meta.systemPrompt` object append（真机验证支持）**，持久化 + session/load 重注入，非 claude adapter 退化首条 prompt wire 前置（shaper 用户回显保持干净）。**sidecar Team 注册表**：`team-routes.ts`+`team-store.ts`（`/orchestration/team/sessions` 3 端点：跨目录隐藏 `[team]` 父懒建 + leader/twin 挂 parentID 防侧栏污染 + ACP leader 失败回滚 twin + `team-sessions.json` 持久化重启恢复）。测试：acp-client 87（+15）/ desktop 147（+8）/ connector 75（+4）/ api-client 53（+2）。真机（备用端口栈 14096/14099）：qwen-plus leader **不点名工具**自发同轮并行 `orchestrator_delegate` ×2 跨厂商（opencode+claude 子会话）+ 汇总标注来源；deny 双向验证（leader `task` sticky / 普通会话 `orchestrator_*` 探针回复 DENIED）；claude leader `_meta.systemPrompt` 生效（复述职责/成员/点名工具）；sidecar 重启注册表恢复 + systemPrompt 重注入 + 上下文连续

- **@agent/orchestrator 编排层第二批（Agent OS 阶段3，ADR-031 ②⑤③，M1-M7）**：**agent 驱动 delegate**——`acp-client delegate-mcp` stdio shim（`delegate`/`list_agents` 工具，@modelcontextprotocol/sdk 1.27.1）→ HTTP 回连新端点 `POST /orchestration/delegate`（**阻塞**返回 D-2 契约 `{status, sessionId, deliverable, tokens, cost}`；等待期每 10s MCP progress keepalive，vendor `resetTimeoutOnProgress` 真机 3 帧验证）+ `GET /orchestration/delegates(+/events)` + `GET /orchestration/agents`。**双注入路径（D-3 opt-in）**：ACP per-session（agents.json `orchestratorMcp` + session `orchestrate` 旗标持久化、session/load 重注入、InProcACPBackend 恒 false=子会话硬护栏）/ opencode 全局（Settings「编排模式」开关，write_mcp_config + 运行时 createMCP；`KNOWN_SIDECAR_NAMES` 加 acp-client）。**opencode 子会话防递归**：promptAsync→connector→runTurn 全链路 `tools` 参数，子 turn 恒传 `{"orchestrator_*":false}`（vendor 落为 sticky session permission deny + Wildcard，源码+真机双验证）。**Fan-out**：pipeline 执行器泛化为 DAG 调度（inputs 全 completed 即并行、失败跳传递性下游、独立分支跑完、cancelRun 中止全部在途）+ 按步 `isolation:"worktree"`（git worktree --detach 到 xdgData，输入产物 stage 进 worktree、交付物拷回主 run 目录、成功删失败留、releaseConnector 防 SSE 泄漏）；隐藏父会话提前到 run 启动创建（消并行竞态）；现有 pipeline 测试零修改通过（行为锁）。**Desktop**：主对话 delegate 卡片（ExecutionFlow 识别 `orchestrator_delegate`/rawInput 形状 → 目标 agent+任务+交付物+子会话懒加载）+ DelegateDock（全局 delegate SSE 首帧 snapshot，阻塞期权限按 workspace 过滤内联应答）+ `use-child-session-history` hook（展开必拉+终态 refetch+generation 计数复用）+ run 详情按依赖深度分层渲染 + Fan-out 创建模板（planner→workers〔worktree 勾选〕→聚合）+ 步骤级 model 下拉。测试：orchestrator 65（+15）+ acp-client 72（+10）+ desktop 139（+9）+ api-client/connector 各 +3。真机（备用端口栈）：delegate 端点/shim stdio/主 agent 全闭环（qwen 调 orchestrator_delegate）/子会话 deny+隐藏父+侧栏零污染/Fan-out 3 步含 worktree 并行聚合回收全过
- **@agent/orchestrator 编排层第一批（Agent OS 阶段3，ADR-031，M1-M4）**：新包 `packages/core/orchestrator`——spawn/await/steer/cancel 原语 + 治理护栏（maxConcurrent=8 信号量排队 / maxDepth=1 / 每步超时必杀）+ `runTurn` 双语义终态检测（opencode promptAsync fire-and-forget 须等 idle+finish 双信号防残留 idle 误判；ACP 阻塞 prompt resolve 即终态）+ QueueOwner 实现（per-session promise 链，接口阶段2 已预留 connector）+ 代码驱动 Pipeline recipe（产物文件串接 `<workspace>/.ultrawork/runs/<runId>/`，交付物缺失判失败，失败传播 skipped）+ run JSON 持久化（重启标 interrupted 不续跑）。**宿主在 ACP sidecar :4099**（`InProcACPBackend` 直连 ACPManager + per-workspace OpenCodeBackend 缓存 + opencode 凭证三级解析），新增 `/orchestration/*` 5 端点（per-run SSE 首帧全量快照 + `step.permission` 子会话权限 relay）。**Desktop 独立路由 `/orchestration`**（创建表单 + run 列表 + step 时间线详情 + 权限内联应答 + 子会话懒加载 MessageList 只读复用 + 再跑一次），零侵入主聊天；子会话防侧栏污染（ACP 无 twin + opencode 跨目录 parentID 隐藏父会话 + SSE parentID guard）。orchestrator vitest 49 + acp-client bun test 19 + desktop 4 新用例；真机验收：2-step 跨厂商 pipeline（opencode/qwen 分析 → claude 读产物写报告，权限经 relay 应答）端到端、cancel 中途、4s 超时、重启 interrupted、侧栏零污染全过。Fan-out 与 agent 驱动 delegate（宿主 MCP 工具）留下一批
- **@agent/connector 控制+事件统一层（Agent OS 阶段2，ADR-030，M1-M5）**：新包 `packages/core/connector`——可插拔 backend adapter（`OpenCodeBackend` 包装 api-client + 全局 /event 流；`ACPBackend` 收编 :4099 客户端，acp-stdio 族通用）+ 参数化 SSE transport（三套 fetch-reader/退避/心跳看门狗收敛一处）+ 按会话绑定派发（prompt/cancel/fetchHistory/replyPermission/deleteSession/双形态 subscribe）+ capabilities 声明门控（revert/model/questions/sessionStatus…）+ 阶段3 边界预留（QueueOwner 接口 stub、onSessionCreate hook 挂载点）。Desktop 三处 isACP 分流全删（统一 `useSessionSubscribe`，ACP 双流合并保住标题事件）；Gateway bridge 换 OpenCodeBackend（无限重试退避保真、轮询兜底语义零变化、bridge.test 35 用例语义零删除）；删除 desktop 的 `sse-client.ts`/`agent-router.ts`/`use-acp-sse.ts`/`agent-types.ts`（并行第二客户端不复存在）。connector 新增 72 测试
- **会话↔agent 绑定持久化（收 gotchas §8 localStorage-only 债）**：sidecar 新增 `GET /acp/sessions`（acp-manager `listSessions()`），desktop 启动时 `BindingStore.hydrate` 从 sidecar 恢复绑定（sidecar 优先、本地新改动不被覆盖、cache 兜「绑定后未发首条 prompt」空窗）；清 WebView 数据/换设备后 ACP 会话绑定自动恢复（真机验证：清 localStorage 重启恢复 8 条绑定 + 历史完整）
- **gemini / qoder 二期接入（阶段1 剩余项②，branch A acp-stdio 零 bespoke 代码）**：两个 agent 真机全清单通过（initialize capabilities / turn 整形含 reasoning / 权限回环 allow·reject·cancel / loadSession 重启上下文连续 / usage）。**gemini 三大怪癖**真机定位并产品化修复——ACP 模式 interactive shell（node-pty）挂死、folder trust 拒执行、npm wrapper relaunch 到 bun 运行时：`applyGeminiQuirks`（acp-connection.ts）spawn 期自动注入 `GEMINI_CLI_TRUST_WORKSPACE`/`GEMINI_CLI_NO_RELAUNCH`/`GEMINI_CLI_SYSTEM_SETTINGS_PATH` 三件套 + 托管 settings 文件（`enableInteractiveShell:false`，无 env 形式只能走 settings；显式 agent env 永远优先），+5 离线测试。**qoder 怪癖**：权限请求内部超时自动放弃（须尽快批复，迟到回复无害）、execute 工具忽略 session cwd——`connect(cwd)` 把首个 session cwd 作为子进程工作目录修复；qoder 发 usage（token 页脚有数据）。agent spawn PATH 追加 `~/.local/bin` 等用户 bin 目录（打包 app GUI PATH 找不到 qodercli）。详见 gotchas §8 per-agent 条目
- **Settings 预置模板库 UX**：「添加 Agent」表单顶部模板 chips（Claude Code / Gemini CLI / Qoder CLI / 自定义，`agent-templates.ts`）一键填充 command/args/env，替代全手填；已存在同 id 的模板置灰；i18n zh/en
- **thought_level（思考力度）开关（claude adapter 0.44 effort session config 接入）**：agents.json per-agent `thoughtLevel` 字段 + Settings 表单 select（默认/低/中/高）；sidecar 在 session/new·session/load 后按 `configOptions` 验证并调 `session/set_config_option`（option 不存在/值不合法/失败一律跳过不阻塞会话，gemini/qoder 无此 option 自然跳过）；claude 真机 `effort=high` 应用成功。mock agent 扩展 configOptions + set_config_option，+5 离线测试
- **ACP token 页脚解锁（阶段1 剩余项①收口）**：claude adapter 升级 `@zed-industries/claude-code-acp` 0.16.2 → `@agentclientprotocol/claude-agent-acp` 0.44.0（上游包改名转移，旧包永久停更不发 usage）——既有 usage→tokens 映射链路（TurnShaper.endTurn→SSE→页脚→session-store）随之全通：AssistantTurn 页脚显示单轮 input/output/cache tokens + cost（usage_update 实测带 cost），per-turn 独立非累计，重启后历史页脚保留。`agents-config.ts` 新增 `migrateLegacyClaudeAdapter`：load 时精确 token 匹配自动重写已配置用户的 agents.json（显式版本 pin 不动），+6 离线测试。0.44 顺带改进：requestPermission 已带 kind（`permission-label.ts` 推断层保留为其他 agent 兜底）。跨 28 版真机回归全过（W1 整形/权限回环/W4b session·load/#742 取消/#750 messageId 兼容）；已知行为变化：thinking 改为模型自适应（`MAX_THINKING_TOKENS` 不再保证思考块，见 gotchas §8）
- **W4b ACP 会话历史持久化（ADR-027 阶段1 收尾项①）**：sidecar 新增 `session-store.ts`——与前端同构的 event-fold reducer 把整形消息落盘 `~/.local/share/ultrawork/acp-sessions/<sid>.json`（数据进 xdgData 与 opencode 存量同级；`ACP_DATA_DIR` 可覆盖），user echo 落定与 assistant 终态封板时写盘；新端点 `GET /acp/session/:id/messages`（整形历史）+ `DELETE /acp/session/:id`；重启后 `clientSessionId↔acpSessionId` 映射恢复，下次 prompt 经 `session/load` 懒恢复 agent 上下文（**replay 全抑制**：idle 80ms / 上限 5s，acpx 常量；idle 窗口从 RPC resolve 起算），无 loadSession 能力的 agent 降级新建会话；前端 `use-session-messages` 按 isACP 分流历史加载、删除会话联动清理。离线测试 +6（store reducer/roundtrip、replay 抑制零外泄、manager 重启恢复、deleteSession），mock agent 支持 `session/load` 回放。真机验收：重启 app 后历史可见不重复、claude 经 session/load 答出此前记住的内容（上下文连续）
- **档1 入口收紧（one session, one agent）**：Home 输入框加 AgentSelector（受控模式，选 ACP 时隐藏 ModelSelector），发送时 createSession→绑定→按 agent 分流 prompt——**会话出生即绑定**；侧栏「+」改为回 Home（不再直接建空会话）；Session 页 AgentSelector 在会话有消息后锁定（tooltip 说明）——杜绝中途切 agent 导致历史在 opencode/ACP 两个 store 间「消失」的假象
- **claude thinking 默认开启**：DEFAULT_AGENTS 的 claude 条目带 `env MAX_THINKING_TOKENS=8192`（claude-code-acp 据此发 thought chunk→ExecutionFlow「深度思考」步骤）；Settings 编辑 env 可关/调，PUT 热生效。Settings agent「未连接」状态加 tooltip（发消息时自动连接）
- **Agent OS 阶段0→1 落地（ADR-027 档1，首批 claude + opencode）**：新包 `@agent/acp-client`（ACP Client Sidecar :4099，SDK 0.25.0，参考 `feat/acp-support` 设计在 main 上重写）——`TurnShaper` 把 ACP `session/update` 整形成 opencode SSE 形状（工具步骤→过程 message `finish:"tool-calls"`、答案→独立纯 text message `finish:"stop"`、先 part.updated 再 delta、toolCallId upsert、plan/TodoWrite→reasoning part、user 回显），复用 ADR-029 渲染器零前端渲染改动；`clientSessionId` 直通消掉旧分支的 sessionID 改写 hack。**W3 权限回环**（去 auto-approve：挂起 promise + `permission.asked` SSE + `POST /acp/session/:id/permission`，复用 permission-dock；超时/cancel/断开/进程退出默认 deny）。**W4** per-agent `knowledgeMcp` opt-in 透传知识库 MCP（默认关，B4）。**W5** 三阶段优雅关闭（acpx 常量）+ claude `session/new` 60s 超时 + `/acp/health` 带 agent 连接态
- Agent OS 桌面端接入（零侵入增量，opencode 流不动）：输入区 **AgentSelector**（会话级 agent 绑定，localStorage 持久化；ACP 绑定时隐藏 ModelSelector）+ Settings **「外部 Agent」**section（连接/断开/增删改/知识库开关，i18n zh/en）；`use-session-messages` 发送/停止按绑定分流；`use-acp-sse` 引用计数共享 EventSource（消息+权限复用一条连接）；ACP 终态 finish 补 `markSessionIdle`
- Agent OS 构建/运行链路：`scripts/build-acp.ts`（hash 增量 + **重编时自动清理 :4099 旧进程防陈旧**——Tauri `prepare_port` 会复用健康旧进程）；`setup.sh --dev` 一键全栈；tauri `externalBin` + `lib.rs` 后台启动（rich_path）；`build-release.ts` per-target/lipo 接入 Universal DMG
- Agent OS 测试三层：mock ACP agent 离线 stdio e2e（3 用例 56 断言：allow 全链路/reject 不执行工具/超时默认 deny）+ 真实 claude spike 脚本落盘 fixture + desktop vitest 用 fixture 喂真实 `buildTurnModel` 断言切分/终态/流式不闪烁（4 用例）；真机浏览器驱动验证（工具调用渲染 + 权限 dock 全交互 + 文件真实落盘）
- `docs/gotchas.md` 新增 §8 ACP/外部 Agent（turn 整形契约、claude adapter 怪癖、CLAUDECODE 继承、权限安全默认等 10 条）+ §7 两条构建坑；`docs/conventions.md` 新增 §11 ACP 接入模式（整形契约/测试三层/真机验证法）

### Changed
- **非 Leader opencode prompt 隔离闭环（017 拍板 #4）**：`OpenCodeBackend.prompt` 的 `tools` 缺省值改为 `{"orchestrator_*":false}`（connector 层兜底；显式传 map 的调用方——orchestrator 子会话/Team Leader——自管）+ gateway IM 链路显式恒传同 deny——普通会话物理无编排工具，全局 MCP 常驻无泄漏面；api-client `promptAsync` 新增 `system` 选项（per-message append，Team Leader 每轮编排指令）

### Removed
- **「编排模式」Settings 开关（017 拍板 #5）**：删 `use-orchestrate-mode.ts` + `OrchestrateModeToggle` + `settings.orchestrate.*` i18n；全局 orchestrator MCP 注册降级为 Team 页内部静默 ensure；用户已有 config 条目无需迁移（ensure 幂等同名覆写）；Tauri `remove_mcp_config` 保留（MCP 服务管理仍用）

### Fixed
- **list_agents 向 LLM 泄漏传输层连接态导致 Leader 拒绝委派**（017 Tauri 真机走查发现）：ACP agent 懒连接的 disconnected 被模型当「离线不可用」全派 opencode——`/orchestration/agents` 改为仅透出真实 error、其余一律 available（delegate 自动连接）+ Leader 提示补「状态离线也照常委派」双保险
- **ensureOrchestratorMcp 冷启动 flake 被静默吞掉**（017 GUI 走查发现）：POST /mcp 以 200+status:"failed" 返回握手超时（60MB shim 冷启动可超 vendor 5s connect 窗口），原 catch 只兜网络错——加 status 检查 + 重试一次
- **停止按钮高速流式下点击被吞**（GUI 回归发现）：停止按钮在消息流内容区里，高速流式回流 + 自动滚动使按钮在 pointerdown 与 pointerup 之间位移 → 浏览器不派发 click，表现为「点击停止无效」（后端 cancel 实测 14ms 生效，纯前端触达问题）。修复：ExecutionStatus 停止键改 `onPointerDown`；ChatInput 发送键在流式时变为**位置固定的停止键**（`loading && onStop`），+2 测试
- **ACP 权限弹窗标签精修（阶段1 剩余项①）**：claude-code-acp 的 `requestPermission` 只传 `{toolCallId, rawInput, title}`——内部算出的 kind 在调用点被丢弃（0.16.2 源码核实），旧逻辑一律回退 "bash" 造成标签与实际操作不符。新增 `permission-label.ts` 分层推断（显式 kind → TurnShaper 查同 toolCallId 的 tool_call 帧 kind〔先 await updateChain 消时序竞争〕→ rawInput 形状 → 反引号 title → 中性 "tool"）；`fetch` 映射 external_directory→webfetch；pattern 剥反引号；dock 标签表补 Web Fetch / Tool Action。离线 +9 用例（mock agent 还原 claude 真实形状：无 kind 带 rawInput）；真机（无头 + GUI）三类验证 write→edit / bash→bash / read→read 全过
- **TurnShaper id 代际碰撞**（W4b 测试发现）：sidecar 重启后 shaper seq 从 0 重计，新轮次 message/part id 与持久化历史相同导致覆盖而非追加——id 加入 epoch（`acp_msg_<sid>_<epoch>_<seq>`）
- ACP 真机验证修复：`CLAUDECODE` env 从 dev shell 继承到 claude-code-acp 触发嵌套检测拒绝建会话（spawn 时清洗）；ACP 会话侧栏活动 spinner 不熄（终态补 markSessionIdle）；claude adapter 对同一 toolCallId 重复发 `tool_call` 导致重复 part 卡 pending（按 toolCallId upsert）

### Changed
- **ExecutionFlow 交互优化**：折叠箭头从最右侧移到紧跟内容之后（头部与思考/工具/旁白行统一「内容 · 耗时 · 箭头」左对齐布局）；耗时实时计算——新增 `useNow` hook（100ms tick，仅激活进行中的行），流式中「深度思考」/运行中工具/头部总耗时实时走秒，结束定格为最终值；`live=isStreaming` 防恢复的历史回合残留 running 态永久走秒
- 共存/UX 影响分析（参考 AionUi 源码核实）：新增 `agent-os-target-architecture.md` §3.6「对现有交互/UI 的影响与共存策略」——档1 原地增量零侵入（D-3 复用 ADR-029 渲染器）、档2 独立 opt-in 面（镜像 AionUi `pages/team` 与 `pages/conversation` 分离的现网范式）、唯二回归风险区（W1 turn 整形质量 / connector 迁移），结论「不需要 UI/UE 大改」。ADR-031 D-7 加「档2 走独立 orchestration 路由、主聊天零侵入」；016 §6 加 UI 共存范式 + Apache-2.0 许可证说明（可借鉴/copy，多为模式参考）
- AionUi 调研源码核验（016 升级置信度 + 一处反向修正）：直读 `iOfficeAI/AionUi`（含完整稀疏检出）核实——✅`NON_ACP_BACKENDS`/`resolveConversationType`（`teamMapper.ts:51`，逐字一致，源码级坐实 ADR-030 D-8）、Team/TeamAgent 数据模型 + `TeamMcpPhase` 状态机 + IPC 事件（`teamTypes.ts`）、SQLite `teams`/`mailbox`/`team_tasks` 表（`schema.ts`）。⚠️**反向发现并修正**：Team MCP Server 的**分发/mailbox handler 源不在公开 repo**（src 里无文件读写那两张表、唯一 stdio MCP 源是 imageGenServer、`team-mcp-stdio.js` 是预构建产物 glob）——Team Mode 运行期真实（e2e + 打包件）但 handler 不可读。016/ADR-031 据此把「Team MCP Server 源码核验」降为「数据层/schema 源码核验 + 运行期真实、handler 源不公开（只借鉴数据流、不照抄实现）」；ADR-030 D-8 佐证不受影响（teamMapper 是真实源码）
- 跨文档对齐 review（清同类残留）：`decisions/README.md` ADR-030 索引标题改「可插拔 backend：OpenCode REST / ACP / 其它」（原「双 backend」与已改 ADR 标题打架）；`architecture-phase1.md` Part II connector 草案（表行 + §规划章节 banner）补「已被 ADR-030 取代/细化 + D-8 开放 backend 类」指针；ADR-027 D-1 + ADR-030 D-5 的「两/双 backend」加「首发两类，D-8 后泛化为开放可插拔 backend 类」指针
- `agent-os-target-architecture.md` 全文对齐 review：修正 §3.1 协议层（外部后端补 product-native 非-ACP 一支，不再写成「外部必走 ACP」）、§9 信息缺口（qoder flag 已调研 + openclaw 三面，指向 015 §11）、TL;DR（补 backend 分类法 #4 + 协议层措辞）、§2 图注（backend 类开放）、§6 护栏标 ADR-031 D-5、头部加修订标记
- ADR-030 修订（D-8 backend 分类法泛化，来源 discussion 015）：`BackendKind` 从封闭 union 开放化；引入「协议族（acp-stdio / product-native〔HTTP+SSE 或 WebSocket〕 / acp-remote）× adapter」两轴——**真正的轴是协议族（ACP 标准 vs 产品自有）而非线缆，两族对等并列，WebSocket 归 product-native 内的线缆不单列**；选型决策树按「native + 保真 + 性能」选；opencode 显式标 default + reference；`BackendCapabilities` 扩展黑盒降级字段（permissions/fileDiffs/plan/reasoning/historyReplay）。同步更新 `agent-os-target-architecture.md` §0（C4/C5）+ §3.3（两族对等、传输族、未来扩展）
- openclaw 调研修正（核实其 Gateway WebSocket Protocol）：openclaw 对外有**三条面**——ACP-stdio 桥（最差，丢权限/MCP/diff）< OpenAI HTTP（中）< **WebSocket Gateway（native + 最富**：streamed agent events + tool results + approvals + sessions，所有第一方客户端走它）。修正先前「openclaw native 可能是 HTTP / WS 仅内部」的说法——WebSocket 是其证实的对外客户端协议、真正 native 面；接 openclaw 仍是 branch C 私有协议 bespoke（015 §3.4/§5/§6 + ADR-030 D-8 + 目标架构 C5 同步）
- ADR-027/030/031 末尾「待决策」项标记为已拍板，统一指向 `docs/agent-os-target-architecture.md` §0 决策基线表（防止「ADR 仍写待决策、目标架构已定」的漂移）

### Added
- `docs/agent-os-kickoff.md` 开发启动指引：换窗口/换电脑/换项目的启动方式 + 可直接贴的首条 prompt——① 同项目新窗口（首读清单 + 阶段0 + W1 spike prompt）；② 换电脑（clone + `./setup.sh`，附 MEMORY 不随 git 走、durable 设计在 git 的说明）；③ 另一类似项目（可移植决策 vs ultrawork 专属假设的甄别表 + 适配 prompt）；含 AionUi Apache-2.0 法律说明。document-map 功能层 15→16
- discussion 016「AionUi 多 agent 调研 — 直接竞品 + 档1/档2 实现参考 + D-8/ADR-031 验证」（调研记录 + 讨论中）：AionUi（iOfficeAI 开源 Electron 多-agent 桌面，20+ agent via ACP + 内置 Aion CLI）几乎同形态、已 ship 档1（并行多后端）+ 档2（Team Mode = 经内置 Team MCP Server 的 Leader-delegate + 异步 mailbox 回卷 + shared/isolated 工作区）。**逐条验证我们 ADR-027/030 D-8/031**——尤其代码 `NON_ACP_BACKENDS={aionrs,openclaw-gateway,nanobot,remote}` else acp 一字不差印证 D-8 + 独立佐证 015 的 openclaw-gateway(WebSocket)非 ACP。无 IM/RAG → 护城河仍在 ACP 之外（档1/档2 = 追平项）。含可借鉴落地蓝本（Team MCP Server / MCP 注入状态机 / Team 数据模型 / SQLite）。传播：011 加 §2.4、ADR-030 D-8 加现网佐证、ADR-031 加 AionUi delegate 先例 + 实现参考、013 §8 / 015 / target-arch §9 竞合更新 + 收紧护城河表述
- discussion 015「Backend 接入分类法 —「支持 ACP 非二元」与非-ACP/HTTP 后端」（调研记录 + 讨论中）：openclaw vs hermes 的 ACP 实现文档/资料级调研——**openclaw** `openclaw acp` 是 Gateway 薄桥（ACP→WebSocket 二次组装，缺权限/MCP/diff/plan，loadSession 空线程）→ branch C 黑盒二等后端；**hermes** `hermes acp` 原生包 AIAgent loop（权限/file diff/plan/流式全有）→ branch A acp-stdio 通用零增量；**qoder**（阿里 Qoder CLI）亦原生富 ACP（权限/MCP/多模态齐）→ branch A，唯启动命令两源不一（Zed `qoder acp` vs Qoder 文档/acpx `qodercli --acp`）+ slash 透传待实测。提出传输族 × adapter 两轴 + 选型决策树 + 黑盒 capabilities 降级 + opencode default/reference 特权；含置信度说明与 §11 信息缺口（desk research，真·实测待落地前做）
- 《Ultrawork as Agent OS — 目标架构》设计文档（`docs/agent-os-target-architecture.md`，开发起点）：独立完备地把 ADR-027/030/031 + discussions 011-014 收敛为目标架构。含 §0 决策基线表（17 项待决策已逐条拍板——战略保持 REST / 不做 ACP Server、首批 claude+opencode、`feat/acp-support` **参考重写**、SDK ≥0.21.x、宿主 MCP 仅知识库 opt-in、迁移顺序、queue-owner 延后、orchestrator 独立包、Pipeline 先、delegate opt-in、懒加载等）+ 分层总览图（渲染统一 sidecar → 控制统一 connector → 编排 orchestrator）+ 端到端数据流（档1 单会话 / 档2 delegate）+ Gateway×多agent IM 流式适配 + 安全治理护栏 + 阶段0-4 路线图 + 立即可做的开发起点（claude+opencode，标出 W1 turn 整形为最高风险点）
- ACP「统一交互层 / Agent OS」架构调研线（纯文档，无代码）：① 横向对标 discussion 011（Ultrawork vs openclaw / hermes-agent / opencode desktop，多维对比 + 优劣 + 建议）；② P1 可执行方案 discussion 012（IM 流式重构 / 持久记忆注入 / 多 Agent UI 暴露，MVP+Phase2）；③ Agent OS 可行性 discussion 013（经 ACP 调度多 agent 后端 — 三档模型「会话级→delegate/编排→自动调度」、否决「对等换手」伪命题、connector 分层、源码级纠偏 openclaw acpx/dispatch 失实命令）；④ 阶段1 实现底稿 discussion 014（ACP 单 agent 异构归一化，file:line 级事件桥/权限/能力/进程 + 映射对照表）。均含对 acpx/openclaw 真实源码的逐文件调研
- ADR-027 ACP 多 Agent 后端支持（正式化，原为 `feat/acp-support` 分支预留编号）：经 ACP 统一调度多 agent 后端（opencode 留 REST / claude·qoder·gemini 走 ACP）；D-1~D-5 决策（三档模型、归一化放 sidecar 复用 ADR-029 渲染器、先档1 后档2 依赖关系）+ 阶段1（W0 re-baseline → W1 事件桥 → W2 前端 → W3 权限 → W4 能力协商 → W5 进程稳定性，含 acpx 源码级常量）实现章节
- ADR-030 @agent/connector 控制+事件统一层：后端无关的 `call + subscribe` 抽象 + 可插拔 backend（OpenCodeBackend 包 api-client / ACPBackend 包 agent-router），收敛 Desktop+Gateway 三套 SSE/三份鉴权/两份退避重复；修正 architecture-phase1 Part II connector 草案两处缺陷（漏 SSE、未含 ACP backend）；为阶段3 暴露 spawn/steer 原语
- ADR-031 多 Agent 编排（档2 delegate）：自建 orchestrator（opencode 当不了跨厂商编排器）+ delegate 工具（agent 驱动，经宿主 MCP）+ workflow recipe（代码驱动）混合；交付物契约回卷（非 transcript 注入）；治理护栏（maxConcurrent / maxDepth=1 / 子 agent 便宜模型 / 预算超时）；首发 Pipeline+Fan-out（模式由原语组合，非内置）；嵌套委派 UI 接 ADR-029/P1-3
- 文档质量保障体系优化（Discussion 010）：新增 `docs/gotchas.md`（踩坑清单 SSOT — OpenCode 类型契约 / Server 运行时限制 / MCP / Gateway / IMA / Tauri / 构建 7 章，从本地工作记忆固化进 git，团队/AI clone 即得）+ `docs/quality-gates.md`（改动合入/收尾前的完成定义 checklist）+ `scripts/check-docs.ts` + `bun run check:docs`（机械校验 ADR 计数 / 文档引用路径存在性 / MEMORY 行数，可挂 CI/pre-commit）
- 技术讨论文档 Discussion 010：AI 驱动开发的文档质量保障体系 — 现状诊断（MEMORY 超限被截断 / 救命知识只在本地记忆 / 收尾同步有损 / 文档-代码漂移无校验 / 多副本无 SSOT）+ 按类别优化方案 + 优先级路线图（已落地）
- 主对话「执行流程」收纳（ADR-029）：把一个 user 回合产出的 N 条 assistant message（每工具循环 step 一条）合并渲染——中间过程（思考/工具/叙述）收进可折叠的执行流程时间线（无卡片包裹、连续左竖线、行内二级展开工具 INPUT/OUTPUT、状态图标 spinner/停止/✗/✓、思考中 pulse），最终答案在容器外干净渲染，回合结束追加居中带横线的统计页脚（时间·输入·输出·推理·缓存·成本·模型）。流式判定改用 finish 终态避免多步抖动；`AssistantTurn` 自定义 memo 比较器避免流式中历史回合重渲染。新增组件 `assistant-turn`/`execution-flow`/`message-parts` + 回合逻辑单测（8 例）
- 发布前 readiness 硬化（ADR-028）：macOS Universal DMG 构建支持（`build-release.ts --unsigned` 模式 + 双架构 sidecar cross-compile + Tauri `universal-apple-darwin` lipo 合并）+ Sidecar 凭证随机化（首启生成 32 字节 hex 持久化到 `~/.config/ultrawork/sidecar-auth.json` 0600 权限 + `ULTRAWORK_SIDECAR_PASSWORD` env 覆盖）+ Sidecar 副本机制（启动期从 `.app/Contents/MacOS/<name>` 复制到 `~/.ultrawork/sidecars/<name>`，路径稳定 + 跟随 app 升级自动覆盖）+ MCP 启动急切 warm-up（Rust 端 OpenCode 健康后 fire `GET /mcp` 触发服务端 lazy InstanceState init，首发消息体感时延降到 <1s）+ Tauri capability 收紧（去 shell/fs 过宽权限）+ Bun.serve 显式 127.0.0.1 绑定（不再 LAN 暴露）+ opencode.json 原子写 + Mutex（跨进程并发更新不损坏 JSON）+ 完整 README 故障排查 + 系统语言自动检测
- 知识库能力 Phase 4c（ADR-026）：IMA 写入能力 — MCP 工具 `knowledge_save_note`（AI 自主新建/追加笔记）+ HTTP 端点 `/kb/notes/create` + `/kb/notes/append` + 本地图片自动过滤 + 写入错误码处理
- 知识库能力 Phase 4a（ADR-026）：IMA Notes API 集成（对齐官方 ima-skill v1.1.7）— Notes 全文搜索 (search_note) + 全文读取 (get_doc_content) + Wiki 搜索 get_media_info 增强（笔记类型条目跨模块读取全文）+ AddSourceDialog 新增模块选择步骤（知识库文件 vs 笔记）+ IMAConfig.module 字段 + IMA 凭证 UX 优化（一键打开凭证页面 + clientId 自动复用 + 首次保存成功 toast 提示）
- 知识库能力 Phase 3（ADR-026）：第三方平台 Adapter（IMA 优先）+ 凭证配置向导 + 测试连接 + 统一 ID-based API（Schema v3）+ 跨源搜索（本地+IMA 合并排序）+ Filter Chips 知识源分类筛选
- 知识库能力 Phase 2（ADR-026）：Parent-Child 双层分块（父块 ~60 行上下文 + 子块 ~12 行精确匹配）+ MarkItDown 集成 (PDF/docx/xlsx/pptx) + SSE 索引进度实时推送 + 文件监听自动重索引 + Schema 迁移系统
- 知识库能力 Phase 1（ADR-026）：Knowledge Sidecar (:4098) + 本地文件夹 RAG + 混合检索 (BM25+TF-IDF+RRF) + MCP tool 对接 AI + Settings 知识库管理 UI
- 知识库架构设计文档 ADR-026：覆盖本地 RAG / 第三方平台 / 自定义 API / 在线文档 四类场景，含行业调研和实现参考
- 技术讨论文档 Discussion 004：OpenCode 多 Agent 机制调研（默认 agent 决议 / 自定义 agent 配置 / task 子 agent 委派 + 在 Ultrawork 里的实际呈现），纯代码分析，含完整源码定位
- 技术讨论文档 Discussion 005：Permission Dock 与 Question Dock 机制调研（服务端 Effect Deferred 挂起式询问原理 / SSE 事件链路 / 前端底部输入区「占位替换卡片」UI 形态 / 渠道无头场景 Gateway 自动批准-拒绝策略），纯代码分析，含完整源码定位
- 技术讨论文档 Discussion 006：自定义 LLM Provider 机制调研（provider 四层数据 merge / `opencode.json` provider schema / `@ai-sdk/openai-compatible` 默认 SDK + Anthropic 兼容 / `resolveSDK` baseURL·apiKey·headers 注入链 / 前端与 api-client 现状缺口 / 兼容 OpenAI·Anthropic 协议的自带 Key+Base URL 实现路径），含源码定位 + 真实 HTTP API 实测结论（PATCH /config 后 GET /provider 同进程即时生效、深合并保留 mcp、GET /config 读运行时内存态）
- 技术讨论文档 Discussion 007：OpenCode 内置工具全景调研（工具统一框架 `Tool.define` / 输出截断 / 权限挂起 / 注册中心动态过滤；文件·搜索·联网·执行编排四大类逐工具分析 — 参数·流程·使用场景·启用条件；`multiedit` 与 `plan_enter` 未注册原因考据；agent 权限默认值与 Permission Dock 触发时机；自定义工具·插件工具加载链与 `tool.definition` 改写 hook），纯代码分析，含完整源码定位
- 技术讨论文档 Discussion 008：OpenCode 内置 Agent 全景、相互调用机制与 runLoop 引擎调研（7 个内置 agent 含隐藏的 compaction/title/summary；三种 agent 协同形式 — 路径 A `task` 委派子 agent / 路径 B 引擎调度 compaction·title / 路径 C primary 间模式切换；为何 `build` 无法 `task` 调用 `compaction`（primary 被 `task.ts:29` 过滤）；`runLoop` 引擎技术流程 — 调用分层·Runner 并发模型·每轮迭代分支·`processor.process` 三态返回·单步流式事件处理含 doom-loop 与溢出检测；多 agent 运行位置区分 — 同 runLoop 跨轮切换 vs 委派子 session 独立 runLoop·并行委派·嵌套封顶两层；委派的闭环与异常 — `<task_result>` 回灌·失败隔离·abort 级联·`task_id` 续接），纯代码分析，含完整源码定位
- 技术讨论文档 Discussion 009：桌面端框架调研 — Tauri 现状确认、与 Electron 的原理/能力边界对比、迁移代价评估（确认桌面壳为 Tauri v2 + Rust + 系统 WebView；逐项核对 Ultrawork 实际能力需求无 Tauri 硬缺口；实测产物推翻"包体轻量"主论据 — 单架构 `.app` 258MB 中 Tauri 壳本体仅 12MB(<5%)、其余 245MB 为三 sidecar，换 Electron 仅 +43% 同数量级；补安全模型 + 系统 WebView 版本绑定 OS 两个易忽略维度；记录上游 OpenCode 同时维护 Tauri/Electron 双实现可作迁移蓝本；结论维持 Tauri 不迁移 + 列出触发重评估条件 + 低成本对冲建议），纯调研分析，含源码实证索引

### Changed
- 架构文档重构（Discussion 010 P2）：`architecture-phase1.md` 拆为 **Part I 现状（已实现）/ Part II 规划中（🔲 设计草案）**——把散落各处的规划内容（connector 抽象、Agent Workspace 身份/记忆持久化 IDENTITY/SOUL/MEMORY/HISTORY、Proactive Services、Process Lifecycle 进程注册表）统一收拢到 Part II，Part I 前半保持纯现状；顶部新增 TL;DR + 目录；`~/.ultrawork/` 现状布局保留在 Part I（区分已实现 ✅ 目录 vs 🔲 规划文件）。`architecture-full.md` 4732→4540 行：移除与 phase1 纯重叠的 connector 数据流 / Key APIs / Build / Updating（约 −197 行，改为指针）、Module Overview 表已实现包行瘦身为指针、Agent Workspace 旧 `.agent/` per-project 模型标注「已被用户级 `~/.ultrawork/` 取代」、彻底 SolidJS→React（仅保留决策记录与 meta 警示）、标题/顶部收敛为「远期愿景 Phase 2+」。`document-map.md` 同步两文件描述。check:docs 0 漂移
- 文档内容对齐与可读性（Discussion 010 第二轮，P1+P3）：修正 getting-started 测试用例数（Gateway 113→120+ / Desktop 123→130+ + 补 Knowledge 测试命令）；ADR-021 加「代码现状说明」（Session.tsx 已拆分，旧行号失效）+ TL;DR；ADR-026 加 TL;DR/快速导览（区分已落地 vs 仅规划）；ADR-011 补「被取代」指向 ADR-020/026；decisions README 加 ADR-027 占位行保持编号连续；conventions §4/§7 加到 gotchas 的交叉指针（收紧 SSOT）；architecture-full 顶部标注「技术栈以 phase1 为准（React 19 非 SolidJS）」；testing.md 补 Channel Gateway / Knowledge Sidecar 测试项 + 标注 Knowledge 覆盖缺口；test-config-isolation 加状态标注（指向 ADR-028 / quality-gates）。**未改 architecture-phase1/full 主体结构，留待下一轮重构**
- 文档体系重构（Discussion 010）：`MEMORY.md`（本地工作记忆）207 → 58 行回归"索引 + 瞬时状态"，稳定坑点/类型契约下沉到 `docs/gotchas.md`、Key Files 地图迁入 `AGENTS.md`、ACP 分支细节迁入本地 `acp-branch.md`；`CLAUDE.md` 新增「记忆与文档分工」节 + 收尾流程加 MEMORY 体检（防膨胀）与漂移校验步骤；`AGENTS.md` 修正 ADR 计数 27→28 + 补 Key Files；`document-map.md` 补 gotchas/quality-gates/discussion 002+010/auto-memory 文件清单 + SSOT 维护规则；`discussions/README.md` 明确「调研记录(权威) vs 讨论中(提案)」状态语义；`architecture-full.md` 顶部标注「远期愿景·非当前实现」
- 文档与代码整体对齐（以代码为准）：AGENTS.md 补 `@agent/knowledge-sidecar` 包 + WeChat 渠道 + typecheck 5 包 + build:knowledge/release 命令 + ADR 计数 27 + 凭证随机化说明；architecture-phase1.md 状态表/Module Overview/Overview 三处补 Knowledge Sidecar (:4098) 与 WeChat ilink；document-map.md 文档计数与目录树更新（功能层 12 / 决策层 28 / 新增讨论层 / 归档层 9 / auto-memory 实际位置）；api-reference.md 顶部加过时横幅并修正发送端点为 `prompt_async`；requirements.md 补微信 Channel 已实现项；README.md 架构树/技术栈/核心功能补 Knowledge Sidecar + WeChat、bun 最低版本 1.3.10→1.3.12、补全 vendor patch 描述；getting-started.md 补 build:knowledge + 4098 端口 + typecheck 5 包；build-and-deploy.md 修正 externalBin（3 个 sidecar，gateway 名 `channel-gateway`）；decisions/README.md 修正 ADR-020/021/024 状态 Proposed→Accepted（已实现）；CLAUDE.md vendor patch 表与重新生成命令补全 `mcp/index.ts`(CONNECT_TIMEOUT) + `script/build.ts`(跨编译)，避免重新生成时丢改动；根目录 `.plan.md` 归档为 `docs/archive/initial-monorepo-plan.md`
- Sidecar 运行位置：`knowledge-sidecar` 从 `.app/Contents/MacOS/` 改为启动期复制到 `~/.ultrawork/sidecars/<name>` 后从此处运行（Option C，ADR-028）。MCP 路径不再随 `.app` 移动或开发模式切换而失效。Marker 文件 `.<name>.source` 用源端 size+mtime 做幂等检测，app 升级时自动覆盖。
- Sidecar 凭证：从硬编码 `opencode:test123` 改为首启随机生成 32 字节 hex，持久化到 `~/.config/ultrawork/sidecar-auth.json`（Unix 0600 权限，避免 umask race）。前端通过 `get_sidecar_credentials` Tauri command 拿凭证，旧 `test123` 默认自动迁移。Gateway 通过 spawn env `OPENCODE_SERVER_PASSWORD` 接收凭证。`ULTRAWORK_SIDECAR_PASSWORD` env 可覆盖（不持久化，CI/测试用）。
- macOS 应用 bundle identifier 从 `com.ultrawork.app` 改为 `com.ultrawork.desktop`（Tauri 警告 `.app` 后缀与 macOS app bundle 扩展冲突）
- Bun.serve sidecar 显式 `hostname: "127.0.0.1"`：Gateway/Knowledge 不再默认 0.0.0.0 LAN 暴露
- Tauri capability 收紧：移除 `shell:default`、`shell:allow-spawn`、`shell:allow-execute`、全部 `fs:*`，仅保留 `core:default` + `core:window:allow-start-dragging` + `dialog:default` + `dialog:allow-open` + `opener:default`（前端不直调 plugin-shell / plugin-fs，IPC 走 custom Tauri command）
- `opencode.json` 写入改为 tmp + rename 原子操作（tmp 名带 pid + nanos 避免跨进程冲突），全局 `OPENCODE_JSON_LOCK` 串行化 RMW
- MCP CONNECT_TIMEOUT 拆分（vendor patch）：MCP 启动连接握手用 5s，listTools / tool 执行保持 30s。坏 MCP 最长拖 5s 而非 30s（ADR-028）
- 默认语言改为按系统 locale 自动检测（`navigator.language` 以 `zh` 开头 → 中文；其他 → 英文），替代之前的硬编码 `en`
- 知识库文档解析从 MarkItDown (Python) 替换为纯 TS 库（unpdf/mammoth/xlsx/jszip），消除 Python 外部依赖
- MCP 配置统一使用全局路径 `~/.config/ultrawork/opencode.json`，移除工作区级别 opencode.json 的 MCP 配置
- macOS 标题栏切换为 Overlay 模式，隐藏原生标题文字，内容延伸到窗口顶部（ADR-023）
- 窗口拖拽改用 `startDragging()` API（workaround for tauri-apps/tauri#9503）
- 工作目录头部重构：项目名突出显示 + 智能缩略路径 + Finder 打开 + 一键复制（ADR-024）

### Security
- 移除硬编码 sidecar 凭证（`opencode:test123`），改首启随机 32 字节 hex + 文件级 0600 权限。详见 ADR-028。
- Sidecar 网络绑定收紧到 127.0.0.1（Gateway / Knowledge / OpenCode），关闭同 LAN 暴露面。
- Tauri capabilities 缩减到实际使用项，去掉前端 `shell:allow-spawn` / `shell:allow-execute` / `fs:*` 权限。
- 升级 `hono` 4.7→4.12.23，修补 ~10 个上游 advisory（DoS / 路径遍历 / 原型污染 / cookie 处理等）。

### Fixed
- MCP 面板 `knowledge-base` 永远显示"已禁用"：`use-mcp-servers.ts:43` 三元表达式 typo（两个分支都返回 `disabled`），叠加 OpenCode lazy MCP init 时序，导致 runtime 拿不到状态时 UI 永远显示 disabled。修复 typo + 自动 2/4/8s 三轮重试。
- 微信 Channel 添加后 sidebar 状态长时间停留在"连接中"：WeChat adapter `connect()` 启动长轮询后立即返回，state 留在 "connecting" 等首次 `getUpdates` 长轮询响应；同时前端 `onWeChatDone` 只 refresh 一次刚好抓到瞬时状态。修复：adapter 改为发出首次请求即乐观切到 `connected`（失败由 catch 路径回到 error），且前端多次定时 refresh。
- Gateway → OpenCode 调用全部 401：`bridge.ts` 硬编码 `OPENCODE_PASSWORD = "test123"`，凭证随机化后所有 Channel（DingTalk/WeChat）功能无声响中断。修复：Gateway 改 lazy 读 `process.env.OPENCODE_SERVER_PASSWORD`，Tauri spawn 时通过 env 传入。
- `~/.config/ultrawork/sidecar-auth.json` umask race：原 `fs::write` 用默认 umask 创建（通常 0644）后再 `chmod 0600`，中间有微秒窗口本机其他用户可读凭证。修复：`OpenOptions::mode(0o600).open()` 一次创建。
- `opencode.json` tmp 文件名冲突：之前固定 `opencode.json.tmp`，跨进程并发写时互相覆盖。修复：tmp 名加 pid + nanos，rename 失败时清理孤儿。
- `start_sidecar` 健康检查超时残留 pid：之前静默返回 Ok，spawn 的 sidecar 进程继续运行到 app 关闭。修复：超时时 `kill` pid + 从 registry 移除 + 返回 Err。
- 知识库 MCP 配置写两份：`useKnowledgeBase.ensureMCPRegistered` 之前同时调 `write_mcp_config`（全局，符合 ADR-020）和 `api.patchConfig`（写工作区 opencode.json）。删除后者，仅保留全局 + `api.createMCP` 运行时注册。
- 测试脚本 `scripts/test-long-session.ts` 和 `test-api-client.ts` 硬编码 `test123` → 凭证随机化后全部 401。修复：改读 `~/.config/ultrawork/sidecar-auth.json` + `ULTRAWORK_SIDECAR_PASSWORD` env 兜底。
- 孤儿文件 `packages/client/desktop/src-tauri/opencode.json`（含开发者本机绝对路径）从工作树移除。
- IMA 凭证验证错误提示显示原始 JSON：HTTP 401 响应 `{code:200002, msg:"skill auth failed"}` 未解析，现在正确提取 msg 展示友好提示
- IMA Notes 模块无笔记本时添加流程死胡同：`list_notebook` 无用户笔记本返回空数组，现在合成"全部笔记"虚拟条目兜底
- AddSourceDialog 凭证验证异常时临时 source 未清理：`handleTestConnection` 网络异常后 tempId 不在 catch 作用域内，残留孤儿记录
- AddSourceDialog 选择知识库/笔记本双击竞态：快速双击可重复创建 source，新增 savingRef 互斥锁
- Session 幽灵残留：后端数据库丢失的 session 无法删除/重命名，现在 404 时自动清理本地状态；新增 `session.deleted` SSE 事件处理防止前端状态与后端不同步；引入 `ApiError` 类携带 HTTP 状态码替代脆弱的字符串匹配
- Sidecar 进程生命周期：应用退出时自动清理所有 sidecar 进程（OpenCode/Gateway/Knowledge），消除 zombie 进程残留
- 主内容区上下不对称：恢复顶部圆角和间距，与底部形成对称卡片布局（ADR-025）
- 侧边栏折叠态 macOS 交通灯溢出：平台感知宽度适配（macOS 68px / 其他 48px）（ADR-025）
- 侧边栏展开/折叠切换时 Logo 和底部头像垂直位置跳变（ADR-025）
- 知识库状态点刷新后回退：初次加载显示绿点（已索引），刷新后变灰点（空闲）。根因：`GET /kb/sources` 列表端点漏合并 indexer 运行时 status 字段 + indexer 完成索引后不写回 DB。修复：REST 端点补充 `status` 合并 + indexer 新增 `syncStatusToDB()` 持久化
- 知识库索引 SSE 竞态条件：后端索引完成过快导致 SSE 事件在前端 source 加入 state 之前到达被丢弃，进度条永久停在扫描态。修复：后端延迟 50ms 启动索引 + 前端 500ms fallback 刷新
- 知识库本地文件夹索引进度条一致性：所有文件夹索引时统一显示进度条（扫描阶段不确定态 + 索引阶段确定态 + 完成过渡 1.2s），重建索引时正确重置进度状态
- 运行时模型切换后 `sending` 状态卡住导致输入框永久禁用（`server.instance.disposed` 事件重置状态）
- `session.error` SSE 事件未处理，后端 API 错误（鉴权失败、额度不足等）静默吞掉无提示

### Added
- ADR-024: 工作目录路径展示优化
- ADR-023: macOS 标题栏 Overlay 模式
- ADR-022: 运行时模型切换的副作用分析与修复

### Removed
- 移除 IMA MCP Server POC 代码（`packages/knowledge/ima-mcp/`）及 workspace2 MCP 配置，ADR-019 标记为 Withdrawn

### Added
- ADR-021: 长对话性能优化 — React.memo 全消息组件 + CSS content-visibility + 分页加载(limit=80) + 历史窗口(15轮初始/8轮backfill) + "加载更早消息"按钮
- `useSessionMessages` hook：从 Session.tsx 提取消息状态 + SSE 处理 + 历史窗口 + 发送/停止
- `useSessionPermission` hook：从 Session.tsx 提取权限/问题处理 + 轮询 fallback
- `useSessionScroll` hook：智能滚动管理（markAuto/isAuto 区分 + ResizeObserver + settle 延迟 + passive 事件 + overflow-anchor）
- `api-client`: `requestWithResponse()` 基础方法 + `getMessagesPaginated()` 分页接口 + `PaginatedMessagesResponse` 类型
- `scripts/test-long-session.ts`：长对话生成测试脚本
- `scripts/sync-plugin-version.ts`：vendor/opencode 更新后自动同步 `PINNED_PLUGIN_VERSION` + 重新生成 patch 文件
- `package.json` 新增 `sync:plugin-version` 脚本

### Changed
- Session.tsx 从 763 行瘦身为 252 行组装层，核心逻辑拆分到 3 个 hook
- `assistant-message.tsx`: MARKDOWN_COMPONENTS 提取到模块顶层，FileBlock/PatchBlock 拆为独立 memo 组件
- `workspaceRefreshKey` 从 O(n×m) useMemo 改为 SSE 增量计数器
- 消息初始加载改用分页 API（limit=80），仅渲染最近 15 轮

### Fixed
- Gateway Bridge stale session：sidecar 重启后旧 session-map 映射失效导致渠道消息无回复。新增 `getSession` 主动验证 + 自动重建 session；新增 `session.error` SSE 事件处理作为兜底
- `build-gateway.ts`：bun ≥1.3.12 编译的 gateway 二进制缺少签名导致 macOS SIGKILL，构建后自动 ad-hoc 签名（与 `build-opencode.ts` 对齐）
- Gateway Bridge 即时确认（⏳）延迟：将 ack 移到 session 验证之前发送，避免网络调用阻塞用户反馈
- opencode sidecar 每次启动都触发 npm reify：`installDependencies` 将 `@opencode-ai/plugin` 版本固定为 `1.3.13` + 添加快速路径（已安装则跳过），消除启动时的无效网络请求
- `build-opencode.ts`：bun ≥1.3.12 编译产物缺少签名导致 Apple Silicon SIGKILL，构建后自动 ad-hoc 签名；签名失败时报错退出（不再静默复制无效二进制）；用 mtime 区分 smoke test 失败与真实编译错误

### Changed
- 微信 Channel（Phase 1）：ilink 协议接入，扫码登录 + 文本收发 + 语音 STT
- 微信 Channel（Phase 2）：侧边栏渠道状态指示器 + 打字指示器
- 微信 QR 登录 UI：Settings → Channels → 添加微信 → 二维码扫码 → 自动连接
- 渠道类型选择：添加渠道改为下拉菜单（钉钉 / 微信）
- Gateway QR API：`POST /channel/wechat/qrcode` + `GET /channel/wechat/qrcode-status`
- ChannelConfig 联合类型：`DingTalkChannelConfig | WeChatChannelConfig`，支持不同渠道不同配置字段
- Bridge 动态渠道前缀：session 标题自动加 `[微信·xxx]` 或 `[钉钉·xxx]`
- 侧边栏渠道状态：展开模式显示 连接数/总数 + 状态点，折叠模式显示状态图标，点击跳转 Settings

- 钉钉 Channel 即时确认：收到消息立刻回复 `⏳ 收到，正在处理`
- 钉钉 Channel Session 命名：AI 回复后自动加 `[钉钉·用户名]` 前缀，侧边栏可区分来源
- 钉钉 Channel `/new` 指令：重置当前聊天 session，开启新对话
- Session 映射持久化：chatId→sessionId 写入 `~/.ultrawork/session-map.json`，gateway 重启后自动恢复
- 侧边栏实时更新：通过 SSE 订阅 `session.updated` 事件，钉钉新建/更新 session 实时反映

### Changed
- vendor/opencode 子模块更新至 `8e9e79d`（2026-04-03 dev），获取最新模型列表（含 qwen3.6-plus-free 等新模型）
- vendor patch 文件更新以匹配新版代码结构

- Bridge queue 清理：完成后自动删除 entry，防止内存泄漏
- Bridge poll timer 超时保护：5 分钟自动停止，防止 session 卡住时无限轮询
- Bridge shutdown 时先 flush 待发消息再清理，避免用户收不到回复

- 工作区自动恢复：启动时自动恢复上次工作区，无需每次手动确认
- 默认工作区：首次安装自动创建 `~/.ultrawork/workspace/`，零配置即可使用
- Tauri commands: `ensure_default_workspace`, `check_directory_exists`
- 全新品牌 Logo：等轴测水晶棱镜设计（靛蓝→青色渐变），替换旧版字母 "U" 图标
- Logo React 组件 `<Logo />`（`useId` 避免多实例 gradient ID 冲突），用于侧边栏 + Settings 关于页
- 全平台应用图标更新：PNG/ICO/ICNS/iOS/Android 全尺寸（via `@tauri-apps/cli icon`）
- Logo 设计源文件：`design/logo/` (SVG + 1024px PNG + 预览 HTML)
- Browser MCP 双模式架构：按需下载 Node.js v22 + 默认 Playwright MCP（标准）+ 可选 chrome-devtools-mcp（高级），DMG 零增量
- 按需下载 Node.js：首次启用浏览器时从 nodejs.org 下载 (~45MB)，strip 优化，后续复用
- Tauri commands: `download_node`, `detect_browser_env`, `install_playwright_mcp`, `install_devtools_mcp`, `get/set_browser_mode`, `kill_browser_mcp_processes`
- 设置页 + sidebar 双入口模式切换 UI（标准/高级），安装过程 toast 分阶段反馈（下载→安装→注册）
- 浏览器进程清理：模式切换时自动清理 Chrome 子进程，防止"会话锁定"
- 产物面板：MCP 工具产物提取（input 参数 + output 文本），过滤 temp 路径和 data URI

### Changed
- MCP 服务持久化从 localStorage 迁移到 `opencode.json`：通过 Tauri command 直接读写工作区配置文件，OpenCode 重启后自动连接，不依赖 WebView 缓存（含浏览器 MCP 自动恢复）
- Tauri commands 新增: `read_mcp_config`, `write_mcp_config`, `remove_mcp_config`
- MCP 服务页面文案统一为「MCP 服务」（原「远程服务」「服务」不一致）
- 隐藏面向开发者的内置命令 `/init`、`/review`，普通用户不再看到（skills-panel + command-selector + Settings 页统一过滤）
- 任务追踪从线性 Round 编号迁移到 GitHub Issue# 标识，支持多人并行开发
- CLAUDE.md 收尾流程从「轮次收尾」改为「任务收尾」，conventions.md last-synced 改用日期格式
- document-map.md 标注 `.claude/memory/` 为本地文件（不入 git），新增维护规则说明
- CHANGELOG 新条目格式改为 `#issue-number: 描述`
- 新增 commit message 约定：`fix(#42): 描述` 格式

### Fixed
- setup.sh 新 clone 后 build:opencode 失败 — vendor/opencode 依赖未安装导致 `@opentui/solid/preload` 解析失败
- build-opencode.ts `Bun.file().size()` 应为属性访问 `.size`，修复 bun 1.3.10 兼容性
- Round 18: vendor/opencode submodule 指向本地 commit 导致同事 clone 失败 — 重置到上游 commit + patch 管理
- Round 18: core 包 `tsc --noEmit` 与 `composite: true` 冲突，新环境无 `.d.ts` 导致 typecheck 失败 — 改为 `tsc --build`
- Round 18: `.gitignore` 补充 `opencode.json`（本地配置）和 `*.tsbuildinfo`（构建缓存）
- Round 17: DMG 打包后渠道页面无法加载 — Gateway 缺少 CORS 支持 + 前端 production 下未使用绝对 URL

## [0.1.0] - 2026-03-09

### Added
- Round 15: 深色模式统一纯黑 (#000000) + CodeMirror 6 产物预览（17 语言包）
- Round 14: Channel UX 优化 — 自动工作区/模型同步/自动连接/启动加速
- Round 13: 钉钉 Channel Gateway — dingtalk-stream WebSocket + 独立 sidecar + Desktop UI
- Round 12: 新建会话乐观消息 + Sidebar 真实活跃状态追踪
- Round 11: 技能面板增强 — useSkills hook + 分组面板 + Settings 管理
- Round 10: 远程服务设置页面 — useMCPServers hook + ServicesSection
- Round 8: 技术债清理 — Provider 缓存/SSE 重连/React key 修复
- Round 7: 产物预览优化 + MCP bunx 提示
- Round 5: 工作区管理 — WorkspaceSelector + x-opencode-directory + SSE 全局化
- Round 4: 模型管理 + MCP/Slash Commands + 文件产物预览
- Round 3: Permission Dock + Question Dock
- Round 2: 结构化消息渲染（7 Part types）+ 执行状态 + 进度面板
- Round 1: UI 架构重构对齐设计稿
- Round 0: Error Boundary + Toast + 环境修复
- Phase 2: 完整 UI 体验（布局/消息/SSE/设置/会话管理）
- Phase 1: MVP — Tauri sidecar + 基础聊天

### Fixed
- Round 15: Bridge SSE 竞态修复 + idle 超时兜底 + webhook 过期 fallback
- Round 9: 16+5 缺陷修复（竞态/闭包/内存泄漏/状态管理）

### Tests
- 236/236 单元测试通过 (Gateway 113 + Desktop 123)
- TypeCheck 4/4 通过
- 手动测试 E1-E10 + U1-U12 + M1-M4 + C1-C4 = 30 项通过
