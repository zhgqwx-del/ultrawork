# 踩坑清单 (Gotchas)

<!-- last-synced: 2026-06-12 -->

> 本文件是 Ultrawork 开发中**实测确认的坑点与非显然契约**的权威清单（SSOT）。
> 与 [`conventions.md`](./conventions.md) 的分工：conventions = "应该怎么做"（正向模式）；gotchas = "别踩什么"（反向陷阱 + 上游/平台的非直觉行为）。
> 来源：从开发过程的本地工作记忆固化而来，确保团队/AI 协作者 clone 仓库即可获得这些经验，而非重复踩坑。
> 新增坑点流程：开发中先记入 auto-memory 的 staging 区，"收尾"时判定为"稳定+团队需要"的固化到此处（详见 [`CLAUDE.md`](../CLAUDE.md) 收尾流程）。

---

## 1. OpenCode API 类型契约（与直觉不符）

调用 OpenCode API / 处理 SSE 时，以下字段结构是**实测确认**的，与命名直觉不同。端点完整清单见 [`api-reference.md`](./api-reference.md)。

- **PartBase**：每个 MessagePart 都带 `id`、`sessionID`、`messageID` 字段。
- **ToolState**：是**嵌套的可辨识联合**（`{ status: "pending"|"running"|"completed"|"error", ... }`），**不是字符串**。
- **PatchPart**：`{ hash, files: string[] }` —— 不是 `{ path, content, operations }`。
- **FilePart**：`{ mime, url, filename? }` —— 不是 `{ mediaType, path }`。
- **StepFinishPart.tokens**：包含 `cache: { read, write }`。
- **SendMessageRequest.parts**：简单的 `{ type, text? }[]`（**不带** PartBase 字段）。
- **prompt_async model override**：`model` 字段是 `{ providerID: string, modelID: string }` **对象**（不是字符串）；客户端从 `"provider/model"` 字符串解析。
- **SSE 事件**：`message.part.updated`（完整 part upsert）/ `message.part.delta`（按 partID+field 增量 append）/ `message.updated` / `message.part.removed`。
- **SSE 阻塞事件**：`permission.asked`、`question.asked` —— properties 直接是请求对象本身（**不嵌套**）。
- **Permission API**：`POST /permission/{id}/reply` body 为 `{ reply: "once"|"always"|"reject" }`。
- **Question API**：`POST /question/{id}/reply` body 为 `{ answers: string[][] }`；`POST /question/{id}/reject`。
- **构建顺序**：改了 `api-client` 的类型后，必须先在 api-client 里 `tsc --build`，再 typecheck client（否则 client 读到旧 `.d.ts`）。

## 2. OpenCode Server 运行时限制

- **`PATCH /config` 不影响运行时**：只写磁盘 `opencode.json`。运行时模型切换**必须**用 `prompt_async` 的 `model` 参数。
- **`POST /session/:id/prompt_async` 是唯一发送方式**，返回 204（无 body，调 `.json()` 前先判空）。
- **File API 路径必须相对** + 带 `x-opencode-directory` header。绝对路径会被 join 成错误路径。
- **工具参数统一 camelCase**：`filePath`（不是 `file_path`）。
- **Session 列表不按目录过滤**（事故实测，2026-06-10）：`x-opencode-directory` header 只设请求的工作目录上下文，**不过滤 `GET /session`**；按目录过滤必须用 `?directory=` query。前端侧栏的工作区过滤是客户端 `filterByWorkspace`。误以为 header 过滤曾导致全量误删会话——**任何批量删除前先打印清单核对数量**。
- **Permission 规则**：`general` agent 默认 `"*": "allow"`；要拦截需在 `opencode.json` 设 `"permission": { "edit": "ask" }`。
- **SQLite WAL disk I/O**：偶发 500；恢复手段 `PRAGMA wal_checkpoint(TRUNCATE)` + 重启。
- **会话 db 的 WAL 极脆弱（数据恢复实操教训，2026-06-10）**：`opencode-.db` 主文件可能长期不 checkpoint（实测停在两周前），近期数据全部只活在 `-wal` 里；**任何 sqlite3 直接打开（含只读查询和 `.recover`）都会触发 checkpoint 并清空 WAL 历史帧**，毁掉「截断 WAL 回滚到误操作前」的恢复路径。正确顺序：先 `cp -a` 整个目录（db+wal+shm 三件套），再在副本上一次性做 `.recover`；被删行可从 free pages 的 `lost_and_found` 按列前缀（ses_/msg_/prt_）重建。
- **Config.update 文件名 bug**：vendor 已 patch 修复（`config.json` → `opencode.json`），详见 auto-memory `vendor-patches.md`。

## 3. MCP

- **MCP local 必须用 `bunx --bun`**：用 `npx` 会 spawn 多层进程导致 stdio pipe 断裂、`Connection closed`。
- **MCP 启动连接超时 5s**：vendor patch 把启动握手 `CONNECT_TIMEOUT` 从 30s 拆到 5s（runtime tool 调用仍 30s）。坏 MCP 最多拖 5s（ADR-028）。
- **Browser MCP 用内嵌 Node.js v22**（`~/.ultrawork/node/`），不依赖系统 Node。
- **Browser MCP npm 调用**：必须用 `node npm-cli.js install ...`，**不能**直接调 `bin/npm`（symlink 相对路径会断裂）。
- **Playwright MCP 工具名前缀叠加**：注册名 `browser` + 工具名 `browser_take_screenshot` → 实际调用名是 `browser_browser_take_screenshot`。
- **Playwright 截图产物**：返回 base64 attachment；是否落盘取决于 AI 是否传 `path` 参数；temp 路径在 `/var/folders/.../playwright-mcp-output/`。
- **MCP 持久化**：服务配置存 `opencode.json`（已从 localStorage 迁移，Issue#18）；Browser MCP 全局配置存 `~/.config/ultrawork/opencode.json`，跨工作区自动恢复。
- **运行时 `POST /mcp` 是 per-directory instance 的**（2026-06-12 真机实测）：注册只对请求所带 `x-opencode-directory` 对应的 instance 生效——不带 header 注册到默认 instance，工作区会话**看不到**该工具。desktop ApiClient 自动带当前 workspace header → createMCP 即时生效仅限当前工作区，其它工作区靠全局 opencode.json 重启加载。
- **`GET /mcp` 只列配置文件里的 entry**：`MCP.status()` 遍历 `cfg.mcp`，运行时 `POST /mcp` 加的 server 即使 connected 也**不出现在 GET /mcp**（工具实际可用，`MCP.tools()` 走 instance state）。别用 GET /mcp 验证运行时注册是否成功——直接让会话调用工具验证。

## 4. Gateway / Channel（:4097）

- **重编译必须用 `bun run build:gateway`**（或 `scripts/build-gateway.ts`）：`turbo run build` 只输出到 `dist/`，**不会**更新 sidecar binaries 目录。改完不重编译 = 不生效，且 Tauri 会复用旧进程，需重启。
- **测试 Mock**：`DWClient` / `TokenManager` 必须用 `class` mock，不能用 `vi.fn()`。
- **CORS 白名单**：仅允许 `tauri://localhost` / `https://tauri.localhost` / `http://localhost:1420`，不要用 `origin: "*"`。
- **配置/映射持久化**：`~/.ultrawork/channels.json`（+ mutex）、`~/.ultrawork/session-map.json`（chatId → sessionId，重启恢复）。
- **日志**：`/tmp/gateway.log`。

### 微信 ilink 协议实测坑点

- base URL `https://ilinkai.weixin.qq.com`，认证 `Bearer bot_token` + `ilink_bot_token` header。
- `get_bot_qrcode` 返回的 `qrcode` 是 **token（非 URL）**，`qrcode_img_content` 才是真正的扫码 URL。
- `getconfig` 首次调用会报 `GetTypingTicket rpc failed`，**不能用于连接验证**；直接启动 `getupdates` 长轮询即可。
- `getupdates` 长轮询超时时返回的响应**无 `ret` 字段**，需兼容 `ret=undefined` 视为正常。
- 收消息：HTTP 长轮询 `getupdates`（35s），cursor 同步；session 过期 `errcode=-14`。
- 发消息：`sendmessage` POST，markdown 转纯文本；语音消息用 STT text 当文本输入。

## 5. Knowledge / IMA（:4098）

- **DB**：`~/.ultrawork/knowledge/kb.db`（SQLite WAL + FTS5 + `_migrations` 版本管理）。
- **MCP 注册名** `knowledge-base`，command `[sidecarPath, "mcp-stdio"]`，direct（同进程）+ proxy（HTTP `/kb/search`）双模式。
- **ONNX 仍延后**：`bun build --compile` 兼容性未解决，继续用 TF-IDF（质量可接受）。
- **IMA API**：base URL `https://ima.qq.com`，认证头 `ima-openapi-clientid` + `ima-openapi-apikey`；响应字段用 `code`/`msg`（**不是** `retcode`/`errmsg`）。对齐 ima-skill v1.1.7。
- **IMA Wiki `search_knowledge` 限制**：只返回 highlight_content 片段；无跨 KB 端点（需客户端 fan-out）；静默 100 结果截断；订阅 KB 返回 `220030` 无权限。笔记类型条目可经 `get_media_info`(media_type=11) 跨模块到 `get_doc_content` 取全文，非笔记类型仍只有片段。
- **IMA Notes 限制**：`get_doc_content` Error `210005` = not author（共享笔记预期行为，已容错降级）；`list_notebook` 无用户笔记本时返回空数组（系统文件夹不在返回），已合成 `__all_notes__` 虚拟条目兜底；笔记写入需 UTF-8 校验（非 UTF-8 会不可逆乱码）。
- **IMA HTTP 错误**：HTTP 401 返回 JSON body `{code:200002, msg:"skill auth failed"}`；`imaFetch` 已处理非 200 的 JSON 解析；`formatErrorMessage` 覆盖 `20004/200002/110030/110021`。
- **IMA 扫码认证不可行**：无公开 OAuth 端点（详见 ADR-026）。

## 6. Tauri / 桌面

- **`open_file_with_system` / `reveal_file_in_finder`**：用 macOS `open` / `open -R` 命令，绕过 Tauri opener plugin 的 scope 限制。
- **Tauri opener scope 坑**：`opener:allow-open-path` 需配 scope 且对隐藏目录（如 `.ultrawork`）不可靠，改用自定义 Tauri command + `Command::new("open")` 更可靠。
- **`window.open` 打不开系统浏览器**：Tauri WebView 中必须用 `@tauri-apps/plugin-opener` 的 `openUrl()`。
- **titleBarStyle Overlay 坑**：`data-tauri-drag-region` 在 Overlay 模式不生效（tauri-apps/tauri#9503），须用 `getCurrentWindow().startDragging()` + `onMouseDown`，且需 `core:window:allow-start-dragging` 权限（不在 `core:window:default` 中）。
- **Finder 启动 PATH 受限**：从 Finder 启动的 app PATH 不含 nvm/homebrew 等，Tauri `rich_path()` 手动扫描补齐（启动 sidecar 时传入）。
- **Production vs Dev URL**：Dev 有 Vite proxy（相对路径转发），Production 没有。所有 localhost 服务请求必须区分环境：`import.meta.env.DEV ? "" : "http://localhost:4096"`。
- **健康检查端点是 `/global/health`**（不是 `/health` / `/api/health`）。

## 7. 构建 / 运行时

- **系统 Node.js v14 太旧**：不支持 `??=` 等现代语法。所有脚本必须用 `bun run --bun` 执行，不要直接 `npx` / `node`。
- **Universal DMG 构建**：`bun run release [-- --unsigned]`，跨编译双架构 sidecar + Tauri `universal-apple-darwin` lipo 合并。Apple Silicon 主机需先 `rustup target add x86_64-apple-darwin`。
- **Vendor patch apply 后必须重编译 sidecar**（`bun run build:opencode`）。详见 [`CLAUDE.md`](../CLAUDE.md) §Vendor Patch 管理。
- **新 workspace 包别声明与 root hoisted 不同版本的依赖**：bun 会重解析 root 提升版本（实测 acp-client 声明 `vitest ^3.1.4` 把 root 的 4.0.18 降到 3.2.4，砸了 desktop 的 jest-dom matcher 注册）。新包不要自带测试框架版本，或与 root 对齐。
- **Tauri `prepare_port` 会复用端口上健康的旧 sidecar 进程**（不重启）。`build-acp.ts` 在真正重编时会自动 kill :4099 旧进程，保证下次 app 启动跑新二进制；其它 sidecar（gateway 等）改完仍需手动重启 app（见 §4 第一条）。
- **直接 `bun build --compile` 的产物在 macOS arm64 会被 SIGKILL（exit 137）**：bun 产出的二进制完全无签名（`codesign -dv` 报 not signed），且 `codesign -s -` 直接签会报 "invalid or unsupported format"——必须先 `codesign --remove-signature` 再 ad-hoc 签。**官方构建脚本（`scripts/build-acp.ts` 等）已包含这两步**，本地验证编译产物请走 `bun run --bun scripts/build-*.ts`，不要直接跑包内 `bun run build` 的 dist 产物。

## 8. ACP / 外部 Agent（:4099，`@agent/acp-client`）

> 阶段1（ADR-027）实测坑点。SDK pin `@agentclientprotocol/sdk` 0.25.0；claude adapter = `@agentclientprotocol/claude-agent-acp`（0.44 实测；前身 `@zed-industries/claude-code-acp` 永久停在 0.16.2，已弃用）。

- **turn 整形契约（最核心）**：`buildTurnModel` 把「最后一条不含 tool part 的 message」当答案（`assistant-turn.tsx:53`），`isTerminal` 要求 `info.finish && !== "tool-calls"`（`message-list.tsx:110`）。sidecar 必须：工具步骤发过程 message（封板 `finish:"tool-calls"`）、最终文本发独立纯 text message（`finish:"stop"`）、**每个 part 先 `message.part.updated` 建好类型再发 delta**（前端 delta 对未知 part 直接丢弃且新建硬编码 text）。
- **claude adapter 对同一 toolCallId 重复发 `tool_call`**（rawInput 渐进变富）——整形必须按 toolCallId upsert，否则出现卡 pending 的重复 part。acpx 的「tool_call/tool_call_update 同一 upsert」正是为此。
- **SDK 0.25 与早期调研（014 表）的出入**：`usage_update` = `{size, used, cost}`（无 token 明细）；token 明细在 `PromptResponse.usage`（inputTokens/outputTokens/thoughtTokens/cached*）；另有 plan_update/plan_removed/session_info_update 等新变体；`SessionInfoUpdate` 仅 title/updatedAt（无 model）。
- **claude-agent-acp ≥0.44 的 usage 语义（2026-06-11 真机实测）**：`PromptResponse.usage` 是**单轮**累计（adapter 在每次 prompt 开头清零 accumulatedUsage——SDK 类型注释写 "across all turns" 与该 adapter 实际行为**不符**，以实测为准）；**无 `thoughtTokens`**（页脚 reasoning 恒 0 自然隐藏）；流中 `usage_update` 实测带 cost（页脚 cost 可显示）。旧 claude-code-acp 0.16.2 完全不发 usage——token 页脚为空即没升级。
- **0.44 的 thinking 是模型自适应，`MAX_THINKING_TOKENS` 不再保证思考块**：adapter 把该 env 转译为 SDK thinking 选项，但其源码注明 budget「在新模型上退化为 on/off」——on 后是否思考由模型按题目难度决定（真机连试 ultrathink/难题均未触发属正常）。0.16.2 时代「设了就有思考步骤」的预期已失效；0.44 新增 `thought_level`（effort）session config 是新控制杆（**已接入** Settings：agents.json `thoughtLevel` → session/new·load 后 `session/set_config_option`，见下方 thoughtLevel 条目）。`plan` 事件来自 TodoWrite 不变。
- **agents.json 旧包名自动迁移**：`loadAgentConfigs` 对 args 做**精确 token 匹配**重写 `@zed-industries/claude-code-acp` → `@agentclientprotocol/claude-agent-acp` 并写回磁盘（带版本后缀的显式 pin 不动；description 仅默认值才同步换）。见 `agents-config.ts` `migrateLegacyClaudeAdapter`。
- **`CLAUDECODE` env 嵌套检测**：该变量会从 dev shell（如 Claude Code 终端跑 `setup.sh`）一路继承到 claude adapter，旧版 claude-code-acp 据此嵌套会话检测拒绝 `session/new`（claude-agent-acp 0.44 已移除该检测，但底层 SDK 仍可能读）。sidecar 保留 spawn 时清洗 `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`（agent config.env 显式设置除外）。
- **bunx 首启下载 adapter 包可超 15s** → initialize 超时须 ≥30s（现 30s）；claude `session/new` 已知 stall → 60s 超时（acpx 怪癖常量）。
- **会话 ID 直通**：`POST /acp/session` 传 `clientSessionId` 后所有整形事件直接戳客户端会话 ID——前端零改写（旧分支的 sessionID rewrite hack 已不存在）；SSE 端点允许「先订阅、后建会话」。
- **权限回环安全默认**：`request_permission` 挂起后，超时（`ACP_PERMISSION_TIMEOUT_MS`，默认 5min）/ session cancel / agent 断开 / 进程退出均默认 deny/cancelled 并广播 `permission.replied`。
- **权限请求的 `toolCall.kind`**：旧 claude-code-acp 0.16.2 在 `requestPermission` 调用点丢弃 kind（只传 `{toolCallId, rawInput, title}`）；**claude-agent-acp ≥0.44 已带 kind**（spread `toolInfoFromToolUse()`，v0.44.0 tag 源码 + 真机确认）。`permission-label.ts` 分层推断保留为其他 agent / 旧版兜底：显式 kind → TurnShaper 查同 toolCallId 的 `tool_call` 帧 kind（查表前先 `await updateChain` 排空队列）→ rawInput 形状（command/file_path+写字段/url…）→ 反引号 title → 中性 `"tool"`（**不瞎猜 bash**）；`fetch` 映射 `webfetch`。真机验收 bash 权限须用**不在本机 Claude Code 全局 allowlist 的命令**——`ls`/`stat` 之类会被上游放行根本不弹窗。
- **ACP 会话无 `session.status:idle` 事件**：侧栏活动标记靠前端在终态 finish 时补 `markSessionIdle`（use-session-messages）。
- **会话↔agent 绑定 = sidecar 持久化 + localStorage 缓存**（阶段2 connector 已收口，2026-06-11）：绑定权威源是 sidecar 落盘的会话文件（`GET /acp/sessions` 列出），前端启动时经 `BindingStore.hydrate` 合并（sidecar 优先、本地新改动不被覆盖、cache 独有条目保留）；localStorage `uw.acp.sessionAgents` 降级为 warm cache。清 WebView 数据/换设备后绑定**自动恢复**。唯一空窗：绑定后未发首条 prompt（sidecar 无记录）——丢的是零历史空会话，回落 opencode 无损失。注意：hydration 在 AgentProvider 挂载 + ACP health OK 后才完成，期间靠 cache 先行。
- **ACP 会话历史持久化（W4b 已实现）**：sidecar 把整形后的 `{info, parts}` 落盘 `~/.local/share/ultrawork/acp-sessions/<sid>.json`（数据进 xdgData 与 opencode 存量同级，**不是** `~/.config`；env `ACP_DATA_DIR` 可覆盖）。重启后历史从 store 服务（`GET /acp/session/:id/messages`）；agent 上下文在下次 prompt 时经 `session/load` 懒恢复，**replay 事件全部抑制**（不用于渲染）——claude-code-acp 实测 `loadSession: true`。
- **session/load replay 抑制的 idle 窗口必须从 RPC resolve 起算**（无条件重置 lastUpdateAt）：agent 可能在响应 RPC 之后才继续流 replay 通知，否则漏入 shaper 造成重复渲染。常量 `REPLAY_IDLE_MS=80` / `REPLAY_MAX_MS=5000`（acpx）。
- **TurnShaper 的 id 必须带 epoch**（W4b 实测 bug）：shaper 重建（重启/重连）后 seq 从 0 重计，新轮次 message/part id 与持久化历史**完全相同**→新轮覆盖旧历史而非追加（前端渲染同样被覆盖）。id 格式 `acp_msg_<sid>_<epoch>_<seq>`，epoch = Date.now 36 进制 + 实例计数。
- **thoughtLevel（思考力度）机制**：agents.json per-agent `thoughtLevel` 字段（Settings 表单 select），sidecar 在 session/new·session/load 拿到 `configOptions` 后找 `category:"thought_level"`（或 `id:"effort"`）的 select option，值在选项列表内才调 `session/set_config_option`；选项不存在 / 值不合法 / RPC 失败一律 log + 跳过（**调节旋钮永不阻塞会话**）。effort 可选值随模型动态（claude 0.44 真机 `effort=high` 应用成功）；gemini/qoder 无此 option 自然跳过。UI 固定四档 default/low/medium/high。
- **agent 进程 spawn 细节（PATH + cwd）**：spawn 前 PATH 追加 `~/.local/bin`、`~/.bun/bin`、`/usr/local/bin`、`/opt/homebrew/bin`（打包 Tauri app 的 GUI PATH 找不到 qodercli 之类用户级 CLI；显式 PATH 优先）；`connect(cwd)` 把**首个 session 的 cwd**作为子进程工作目录——qoder 的 execute 工具实测**忽略 session cwd 用进程 cwd**（read 工具却正常），不传 cwd 时命令会跑在 sidecar 自己的目录里。
- **gemini（`bunx @google/gemini-cli --experimental-acp`，2026-06-11 真机）**：① **ACP 模式 + interactive shell（node-pty，默认开）→ shell 工具调用永久挂起**——无错误无超时，与运行时（bun/node）和 folder trust 均无关；唯一解 `tools.shell.enableInteractiveShell: false`，且该设置**无 env/flag 形式**，只能经 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 指向 settings 文件。② 未信任目录 headless 直接拒绝执行（`GEMINI_CLI_TRUST_WORKSPACE=true` 解；Ultrawork 自己的权限回环仍是真正闸门）。③ npm wrapper 会用 process.execPath relaunch 自己——bunx 下落到 **bun 运行时**且多一层进程（三阶段关闭看不见）；`GEMINI_CLI_NO_RELAUNCH=true` 保持单进程。→ 三件套 + 托管 settings 文件（`~/.config/ultrawork/gemini-acp-settings.json`，存在则不覆盖）由 `applyGeminiQuirks`（acp-connection.ts）**自动注入**，显式 agent env 永远优先。④ **不发 usage**（tokens/cost 恒空，页脚自然隐藏）。⑤ **shell 工具默认拦截命令替换**——含 `$(…)` 的命令直接 `Blocked: command substitution detected`（tool 帧报 completed、output 是拦截文案，turn 正常继续解释），写验收用例时命令避开 `$()`。⑥ thought/loadSession/权限 kind 全正常；凭证 `~/.gemini/`（Google 登录，**免费档日配额低**——密集真机回归一天可耗尽 `TerminalQuotaError`）；bunx 首启下载 ~17s（30s initialize 超时内）。
- **claude-agent-acp ≥0.44 支持 `_meta.systemPrompt`（2026-06-12 真机验证）**：`session/new`/`session/load` 参数 `_meta.systemPrompt` —— string 形式 = **整体替换** system prompt；object 形式 = **preset append**（`{append: "..."}`，type/preset 被锁定为 claude_code，保留 Claude Code 自身提示）。Team 页 Leader 注入用 object append 形式；重启经 session/load 重注入（manager 持久化 `systemPrompt` 字段）。**其它 adapter（gemini/qoder）不支持** → sidecar 退化为「首条 prompt wire 前置」（`ACPConnection.prompt` 的 systemPrefix 只上 wire，shaper 用户回显保持干净文本）；判定函数 `supportsMetaSystemPrompt`（spawn command 含 `claude-agent-acp`，agents.json `metaSystemPrompt` 字段可显式覆盖）。
- **qoder（`qodercli --acp`，1.0.4 真机）**：① **权限请求有自身内部超时**——不等回复几十秒内自动放弃（tool→error + 答案「permission timed out, try again?」并正常 end_turn），用户须尽快批复；迟到的回复无害（RPC 仍被 resolve，agent 忽略）。② execute 工具忽略 session cwd（见上方 spawn cwd 条目，已修）。③ **发 usage**（input/output tokens 有、无 cost、reasoning 0）→ token 页脚有数据。④ 连接极快（~0.5s，本机已装无 bunx 下载）；loadSession 恢复上下文正常；stdout 无噪音问题（SDK ndJsonStream 对非 JSON 行本就 log+skip 容错）。⑤ 登录态走本机 qodercli 已有凭证，env `QODER_PERSONAL_ACCESS_TOKEN` 可选。

## 9. Orchestrator（编排，:4099 `/orchestration/*`，`@agent/orchestrator`）

> 阶段3 第一批（ADR-031）实测坑点。

- **两类 backend 的 prompt 语义不同，await「turn 完成」必须分支**：`OpenCodeBackend.prompt` 走 `POST /session/:id/prompt_async`（**204 即 resolve，≠ turn 完成**），终态只能等事件；`ACPBackend`/InProc 的 prompt **阻塞至 StopReason**（resolve 即终态）。编排层统一封装在 `runTurn`（orchestrator/src/turn.ts）——新代码不要直接 `await connector.prompt()` 当完成。
- **opencode 终态用双信号 + 残留 idle 防误判**：`session.status` idle 事件偶发丢失（gateway 曾为此加 3min 兜底），`runTurn` 同时认 assistant `message.updated` 的 `finish && finish !== "tool-calls"`；且 **idle 只在本 turn 已见 busy/message 活动后才算数**——订阅先于 prompt，prompt 落地前可能收到上一轮的残留 idle。每步另有硬超时必杀（超时/abort 先 `connector.cancel` 再抛）。
- **编排子会话防侧栏污染（双机制）**：ACP 子会话**不传 `clientSessionId`** → 无 opencode twin 天然不可见（sidecar 里 id 是 UUID 形态）；opencode 子会话带 `parentID` 挂到**跨目录隐藏父会话**（`~/.local/share/ultrawork/orchestrator-hidden` 下，每 run 懒建一个）——`roots:true` 列表过滤 + desktop SSE 插入分支的 `parentID` guard 双保险。**vendor `POST /session` 接受跨目录 parentID**（真机验证，不校验父会话同 directory）。
- **headless run 的子会话权限必须有人应答**：子 agent（如 claude 写文件）发 `permission.asked` 时没有打开的会话页，orchestrator 把它 relay 成 run 事件流的 `step.permission`，run 详情页内联应答（ACP 走 `/acp/session/:id/permission`，opencode 走 api.replyPermission）；不答会挂到 sidecar 的 5min 默认 deny（`ACP_PERMISSION_TIMEOUT_MS`）+ 步骤超时兜底。对已 resolve 的权限重复应答返回 404，无害。
- **run 重启不续跑**：步骤是带副作用的 LLM turn 无幂等保障，sidecar 重启时 running/pending run 一律标 `interrupted`（in-flight step → failed "sidecar restarted"），UI「再跑一次」= 同 recipe 新 run。
- **产物契约靠 prompt 文本约定**（`artifacts.ts buildStepPrompt`）：交付物路径以「（覆盖写）：<path>」行注入，步骤结束 `existsSync` 校验，缺失即 step failed——改契约文案时注意 orchestrator 测试里按此正则解析。
- **delegate 工具防递归是注入侧双保险，不靠深度参数**（第二批 ②）：ACP 子会话 = InProcACPBackend 恒传 `orchestrate:false`（mcpServers 不含 shim，物理无工具）；opencode 子会话 = 每个子 turn 的 prompt 带 `tools:{"orchestrator_*":false}`——vendor 把它落成 **sticky session permission deny**（`session.permission` 持久在会话上，steer 后续轮也安全；GET /session/:id 可见该 ruleset，真机验证）。`POST /orchestration/delegate` 的 depth 恒 0→1，若注入护栏被绕过深度护栏不防递归（接受的残余风险，闸门在注入侧）。
- **阻塞式 delegate 的 MCP 超时三件套**：shim 等待期间每 10s 发 `notifications/progress`（须有 progressToken；vendor `callTool` 带 `resetTimeoutOnProgress:true`，真机 3 帧验证）+ opencode mcp 配置 `timeout:600000`（注意该字段**同时是 connect 超时**，别设过大）+ claude adapter spawn env 兜底 `MCP_TOOL_TIMEOUT=1800000`。
- **list_agents 给 LLM 的状态语义 ≠ 传输层连接态**（2026-06-12 Tauri 真机）：ACP agent 懒连接，未发首条消息前 `conn.status` 恒 disconnected——直接透给 shim 的 `list_agents` 会让 Leader 拒绝委派（qwen3.7-max 真机：「acp:claude 离线」全派 opencode）。`/orchestration/agents` 只透出真实 `error`，其余一律 `available`（delegate 自动连接）；Leader 提示另有「状态离线也照常委派」双保险。新增 LLM-facing 状态字段时谨记：**模型会按字面语义行动**。
- **opencode 主对话有两个「委派」工具并存**（D-8 预言，真机证实）：内置 `task`（只能派自家 subagent）与我们的 `orchestrator_delegate`（跨厂商）。提示词只说「用 delegate 工具」时 qwen 会选内置 task——需要跨厂商委派时主 agent 的指令要点名 `orchestrator_delegate`（工具 description 已写明差异，但模型不保证选对）。
- **delegate-mcp shim 的 stdout 归 MCP 协议**：`acp-client delegate-mcp` 子命令分发在任何 server/manager 初始化之前，日志只走 stderr；新加启动期代码不要在分发前 console.log。
- **「编排模式」Settings 开关已移除（017 第三批，2026-06-12）**：全局 orchestrator MCP 注册降级为 Team 页内部静默 ensure（`lib/orchestrator-mcp.ts`，KB MCP 同模式，幂等）。vendor 仍无 `DELETE /mcp`——条目一旦写入全局 config 即常驻，**安全性靠 prompt 级 deny 闭环**（见下条），不再靠开关。
- **OpenCodeBackend.prompt 的 tools 缺省 = `{"orchestrator_*":false}`（017 拍板 #4 闭环点，2026-06-12）**：connector 层所有**未显式传 tools** 的 opencode prompt 自动 deny delegate 工具——普通会话物理无编排能力；显式传 map 的调用方（orchestrator 子会话 / Team Leader）自管。gateway IM 链路不走 connector，bridge.ts 单独恒传同 deny。**新代码注意：经 connector 发 opencode prompt 时「不传 tools」≠「不限制」**；真要放开 delegate 工具必须显式传含该工具的 map（如 Leader 的 `{"task":false}`）。
- **Team 页 Leader 会话机制（017，2026-06-12）**：Leader = opencode 会话挂**跨目录隐藏 `[team]` 父**（与 `[delegates]` 父同机制、分开懒建），roots:true 列表 + SSE parentID guard 双重防侧栏污染；ACP leader 复用「opencode twin + binding」范式（twin 挂隐藏父，ACP 会话 `clientSessionId=twin id` + `orchestrate:true` + systemPrompt）。注册表 `~/.local/share/ultrawork/team-sessions.json`（sidecar 持有，env `TEAM_SESSIONS_FILE` 覆盖）。**opencode leader 的编排指令每轮经 `promptAsync system` 参数携带**（vendor 语义 = agent base prompt 后追加、per-message 不 sticky）+ 每轮 `tools:{"task":false}` deny 内置 task（sticky）——真机：qwen-plus 不点名工具即自发同轮并行调 `orchestrator_delegate` 跨厂商委派并汇总标注来源。
- **worktree 隔离的输入产物要复制进 worktree**（`worktree.ts stageInputs`）：子 agent cwd 沙箱在 worktree 里，引用主 workspace 绝对路径会触发跨目录读权限弹窗（claude）；产物完成后拷回主 run 目录、worktree 成功即删失败保留（`step.worktreePath` 暴露）。

---

> 维护说明：本清单中"已 patch / 已修复"的条目反映的是**写入时**的状态。引用具体文件/函数/flag 前请确认其仍存在（尤其 vendor 升级后）。可疑或过期条目应在"收尾"时清理。
