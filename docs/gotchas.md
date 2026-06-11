# 踩坑清单 (Gotchas)

<!-- last-synced: 2026-06-11 -->

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

## 8. ACP / 外部 Agent（:4099，`@agent/acp-client`）

> 阶段1（ADR-027）实测坑点。SDK pin `@agentclientprotocol/sdk` 0.25.0。

- **turn 整形契约（最核心）**：`buildTurnModel` 把「最后一条不含 tool part 的 message」当答案（`assistant-turn.tsx:53`），`isTerminal` 要求 `info.finish && !== "tool-calls"`（`message-list.tsx:110`）。sidecar 必须：工具步骤发过程 message（封板 `finish:"tool-calls"`）、最终文本发独立纯 text message（`finish:"stop"`）、**每个 part 先 `message.part.updated` 建好类型再发 delta**（前端 delta 对未知 part 直接丢弃且新建硬编码 text）。
- **claude adapter 对同一 toolCallId 重复发 `tool_call`**（rawInput 渐进变富）——整形必须按 toolCallId upsert，否则出现卡 pending 的重复 part。acpx 的「tool_call/tool_call_update 同一 upsert」正是为此。
- **SDK 0.25 与早期调研（014 表）的出入**：`usage_update` = `{size, used, cost}`（无 token 明细）；token 明细在 `PromptResponse.usage`（inputTokens/outputTokens/thoughtTokens/cached*）；另有 plan_update/plan_removed/session_info_update 等新变体；`SessionInfoUpdate` 仅 title/updatedAt（无 model）。
- **claude-code-acp（0.16.2）不发 usage**（PromptResponse 仅 stopReason，源码确认）→ token 页脚为空属上游缺口；thought chunk 仅在 thinking 开启时出现，**开启方式 = per-agent env `MAX_THINKING_TOKENS`**（`acp-agent.js:771` 读取→SDK maxThinkingTokens；DEFAULT_AGENTS 已默认 8192，Settings 编辑 env 可关/调，热生效）；其 `plan` 事件来自 TodoWrite 工具。
- **`CLAUDECODE` env 嵌套检测**：该变量会从 dev shell（如 Claude Code 终端跑 `setup.sh`）一路继承到 claude-code-acp，触发其嵌套会话检测拒绝 `session/new`。sidecar 已在 spawn agent 时清洗 `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`（agent config.env 显式设置除外）。
- **bunx 首启下载 adapter 包可超 15s** → initialize 超时须 ≥30s（现 30s）；claude `session/new` 已知 stall → 60s 超时（acpx 怪癖常量）。
- **会话 ID 直通**：`POST /acp/session` 传 `clientSessionId` 后所有整形事件直接戳客户端会话 ID——前端零改写（旧分支的 sessionID rewrite hack 已不存在）；SSE 端点允许「先订阅、后建会话」。
- **权限回环安全默认**：`request_permission` 挂起后，超时（`ACP_PERMISSION_TIMEOUT_MS`，默认 5min）/ session cancel / agent 断开 / 进程退出均默认 deny/cancelled 并广播 `permission.replied`。
- **claude 的权限请求必缺省 `toolCall.kind`**（已修 2026-06-11）：claude-code-acp 内部 `toolInfoFromToolUse()` 算出了 kind，但 `requestPermission` 调用点只传 `{toolCallId, rawInput, title}` 把 kind 丢弃（0.16.2 `dist/acp-agent.js:585,641`）。补救在 `permission-label.ts` 分层推断：显式 kind → TurnShaper 查同 toolCallId 的 `tool_call` 帧 kind（查表前先 `await updateChain` 排空队列）→ rawInput 形状（command/file_path+写字段/url…）→ 反引号 title → 中性 `"tool"`（**不再瞎猜 bash**）；`fetch` 映射改 `webfetch`。真机验收 bash 权限须用**不在本机 Claude Code 全局 allowlist 的命令**——`ls` 之类会被上游放行根本不弹窗。
- **ACP 会话无 `session.status:idle` 事件**：侧栏活动标记靠前端在终态 finish 时补 `markSessionIdle`（use-session-messages）。
- **ACP 会话历史持久化（W4b 已实现）**：sidecar 把整形后的 `{info, parts}` 落盘 `~/.local/share/ultrawork/acp-sessions/<sid>.json`（数据进 xdgData 与 opencode 存量同级，**不是** `~/.config`；env `ACP_DATA_DIR` 可覆盖）。重启后历史从 store 服务（`GET /acp/session/:id/messages`）；agent 上下文在下次 prompt 时经 `session/load` 懒恢复，**replay 事件全部抑制**（不用于渲染）——claude-code-acp 实测 `loadSession: true`。
- **session/load replay 抑制的 idle 窗口必须从 RPC resolve 起算**（无条件重置 lastUpdateAt）：agent 可能在响应 RPC 之后才继续流 replay 通知，否则漏入 shaper 造成重复渲染。常量 `REPLAY_IDLE_MS=80` / `REPLAY_MAX_MS=5000`（acpx）。
- **TurnShaper 的 id 必须带 epoch**（W4b 实测 bug）：shaper 重建（重启/重连）后 seq 从 0 重计，新轮次 message/part id 与持久化历史**完全相同**→新轮覆盖旧历史而非追加（前端渲染同样被覆盖）。id 格式 `acp_msg_<sid>_<epoch>_<seq>`，epoch = Date.now 36 进制 + 实例计数。

---

> 维护说明：本清单中"已 patch / 已修复"的条目反映的是**写入时**的状态。引用具体文件/函数/flag 前请确认其仍存在（尤其 vendor 升级后）。可疑或过期条目应在"收尾"时清理。
