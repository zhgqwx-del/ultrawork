# 029 — Sidecar 端口动态化（dev 固定 / prod 动态）

> 状态：**✅ 已实现**（2026-07-09 四阶段全部落地 + 真机验收 → **ADR-045**。①（误杀修复）已单独合入 main；②③④ 在 `feat/dynamic-sidecar-ports`。§10.2 真机验证项：第 1 项（rx 必须持有并消费）已闭环；第 3 项（`Bun.serve({port:0})`）**作废**——Rust 传具体端口，sidecar 从不 bind 0；第 2/4 项（Windows 防火墙 + `netstat` 临时端口段、single-instance 三平台一致性）**仍待真 Windows/Linux 机器实测**）
> 日期：2026-07-09
> 输入：用户提出——软件装到用户机器上后，固定端口可能冲突导致启动不起来；希望 dev 保持固定端口便于调试，prod 侧动态分配以规避冲突。
> 关联：ADR-028（sidecar 凭证）· ADR-037（跨平台）· ADR-031/038（编排层宿主 = ACP sidecar）· gotchas §6（Tauri/进程生命周期）· §3（MCP per-directory）· 本地记忆 `project_sidecar_process_cleanup.md`
> 范围：① 现状端口盘点与冲突行为审计；② 动态端口可行性；③ 方案形状与分期；**不含** sidecar 合并为单端口多路复用（正交议题，见 §8）。

---

## 0. 一句话

**可行，且比预想容易一半**——最重的 `opencode-server` 上游默认端口本来就是 `0`（临时端口）且会把真实端口打到 stdout，是我们自己传 `--port 4096` 把它钉死的；真正的工作量不在"怎么监听"，而在**五类消费者如何得知端口**。但动态端口会顺手拆掉一个没人注意的隐性依赖：**固定端口今天充当着事实上的单实例锁**，直接改会导致第二个 app 实例重复拉起 gateway，造成 IM 长连接顶号 / SQLite 双写。因此本方案的必要组成部分是 `ports.json` 运行时注册表 + 显式单实例，而不只是"换个端口号"。

顺带发现一个**与动态端口无关、现网就存在的缺陷**：端口被无关进程占用时，我们会把它**杀掉**（§3），且 Unix 侧的 `lsof` 匹配过宽，可能误杀只是碰巧拿到该临时端口做出站连接的无辜进程。建议先行单独修复。

---

## 1. 现状盘点

四个 sidecar 全部由 Tauri `setup()` 拉起，端口是 Rust 侧编译期常量（`packages/client/desktop/src-tauri/src/lib.rs:11-14`）：

| 进程 | 端口 | 端口如何传达 | 健康检查 | 入站鉴权 |
|---|---|---|---|---|
| `opencode-server` | 4096 | CLI `--port 4096`（`lib.rs:4759-4767`） | `/global/health` | Basic auth |
| `channel-gateway` | 4097 | **不传**，自身硬编码（`gateway/src/index.ts:12`） | `/channel/health` | 仅 CORS |
| `knowledge-sidecar` | 4098 | **不传**，自身硬编码（`knowledge/sidecar/src/index.ts:14`） | `/kb/health` | 仅 CORS |
| `acp-client` | 4099 | 读 `ACP_CLIENT_PORT` env，但 Rust 未设置 → 实际走默认常量（`acp-client/src/index.ts:17`） | `/acp/health` | 仅 CORS |

外加 `1420` = Vite dev server（`vite.config.ts:20`，`strictPort: true`）。

全仓无任何"找空闲端口"实现：`TcpListener::bind(0)` / `getPort` / 端口自增，零命中。端口字面量散落 111 个文件（含文档/测试/e2e）。

### 1.1 dev 与 prod 的差异

**端口值两模式完全相同，且共用同一套 Rust 常量。Rust 侧无任何 `debug_assertions` 分支。** 差异只在前端如何访问：

- **dev**（`import.meta.env.DEV`）：相对路径 → Vite 代理 → 4096/4097/4098（`vite.config.ts:7-9`）。**ACP 4099 无代理条目**，dev 下也直连绝对地址。
- **prod**：前端直接硬编码 `http://localhost:4096/4097/4098/4099`（`config.ts:21`、`use-channels.ts:14`、`use-knowledge-base.ts:8`、`connector/src/backends/acp-http.ts:7`）。

---

## 2. 四项原始未知的实证结论

动手前逐条实证，避免方案建在假设上：

| 疑问 | 结论 | 证据 |
|---|---|---|
| Tauri CSP 是否白名单了 `http://localhost:4096`？（若是则**硬阻塞**） | ❌ 无阻塞 | `tauri.conf.json:23` `"csp": null` |
| gateway 是否需要稳定入站端口（IM webhook 回调）？ | ❌ 不需要，四家全是**出站**长连接 | `dingtalk-adapter.ts:197` 的 `webhookUrl` 是钉钉返回、我们 POST 出去的；gateway 仅 `index.ts:46` 一处 `Bun.serve` |
| 知识库 MCP（opencode 派生的 stdio 孙进程）是否依赖 4098？ | ⚠️ 实际不依赖，但存在死代码地雷 | `index.ts:122` `mcp-stdio` → `mcpStdio()` → `startMcpBridge({search,indexer,store})` = **direct 模式**；`mcp-bridge.ts:11` 的 `KB_BASE = "http://localhost:4098"` proxy 分支**无人调用** |
| 持久化配置里是否真的写死了端口？ | ✅ 实锤 | 本机 `~/.config/ultrawork/opencode.json` → `"orchestrator": {"environment": {"ACP_CLIENT_PORT": "4099"}}` |

补充：`src-tauri/Cargo.toml` **无** single-instance 插件（§6 风险敞口）。

**留待实现期真机验证**（不影响方案形状）：
1. Tauri shell `spawn()` 返回的 `_rx`（`lib.rs:288` 当前直接丢弃）是否需要持有并消费才能收到 `CommandEvent::Terminated`。
2. Windows：环回 bind 临时端口是否触发 Defender 防火墙提示；`netstat -ano` 解析在临时端口段（49152-65535）的表现。
3. `Bun.serve({ port: 0 })` 回读 `server.port`（Bun 官方 API，近乎确定，仍应写一条断言）。

---

## 3. 今天端口冲突会发生什么 —— 比"起不来"更糟

`prepare_port`（`lib.rs:245-273`）的实际行为：

```
端口被占 → 健康检查 → 不健康 → kill_port_process(port) → 杀完仍占才报错
```

即：用户机器上若有无关程序监听 4098，**我们不会礼让，我们会杀掉它**。

更进一步，Unix 分支用 `lsof -ti :4098`（`lib.rs:88`）。`lsof -i :port` 匹配的是**本地端口或远端端口任一命中**的所有 socket——一个仅仅碰巧拿到 4098 作为出站临时端口的进程也会进入 `kill_pid` 名单。4096-4099 均非 IANA 保留段，撞上完全可能。

**这条缺陷独立于动态端口方案，现网即存在，建议先行单独修复**（见 §7 阶段 ①）。

---

## 4. 可行性：上游已经站在我们这边

```ts
// vendor/opencode/packages/opencode/src/cli/network.ts:5-8
port: { type: "number", describe: "port to listen on", default: 0 }
```
```ts
// vendor/opencode/packages/opencode/src/cli/cmd/serve.ts:19
console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
```

opencode 默认就是临时端口并回报真实端口。另外三个 sidecar 是我们自己的代码，`Bun.serve({ port: 0 })` + 回读 `server.port` 是几行的事。

### 4.1 真正的工作量：五类消费者

| # | 消费者 | 现状 | 处理 |
|---|---|---|---|
| **(a)** | **renderer 四处模块级常量** | `orchestration-client.ts:17`、`use-knowledge-base.ts:8`（含 `:98-100` 的 `EventSource`）、`use-channels.ts:14`、`config.ts:21` | 新增 Tauri command `get_sidecar_ports()`；模块级 `const` 改运行时解析，牵动 `EventSource` 构造时机与 `ApiClient` baseUrl 注入 |
| **(b)** | **localStorage 持久化的 `apiBaseUrl`** | `config.ts:28` key `ultrawork-config` 存绝对地址；设置页还允许用户手改（`Settings.tsx:287`） | 引入 `"auto"` 语义 + 一次性迁移；设置页该字段在 auto 模式下只读 |
| **(c)** | **sidecar 之间** | `gateway/src/bridge.ts:6` 硬编码 `http://127.0.0.1:4096`；`acp-client/src/orchestration.ts:14` 已读 `process.env.OPENCODE_BASE_URL` | gateway 改读 env（Rust 已在注入 `OPENCODE_SERVER_PASSWORD`，顺手加一个）；ACP 侧白送 |
| **(d)** | **opencode 派生的孙进程（delegate-mcp shim）** | `orchestrator-mcp.ts:34-41` 把 `environment: {ACP_CLIENT_PORT: "4099"}` **写进持久化 `opencode.json`** | 见下 |
| **(e)** | **知识库 MCP** | `type:"local"` stdio，direct 模式，无端口依赖 | 无需改；顺手删除 `mcp-bridge.ts` 的 proxy 死分支（§2 地雷） |

**(d) 是唯一有陷阱的一处。** 好消息是 opencode 起本地 MCP 时的 env 合并顺序：

```ts
// vendor/opencode/packages/opencode/src/mcp/index.ts:398-401
env: { ...process.env, ..., ...mcp.environment }
```

孙进程继承 opencode 的 env。所以只要**把 `ACP_CLIENT_PORT` 从持久化配置移除**、改由 Rust 注入 opencode 的 env，shim 即可自动继承正确端口。

⚠️ 但 `...mcp.environment` 排在最后**覆盖**继承值——存量 `opencode.json` 里那条 `"4099"` 会压掉正确端口。**必须有一次开机清理迁移**（本机已确认存在该条目）。

---

## 5. 方案形状

### 5.1 运行时端口注册表（核心）

不把端口到处传，而是引入单一运行时事实源：

```
~/.ultrawork/run/ports.json   (0600)
{ "opencode": {"port": 51234, "pid": 812}, "gateway": {...}, ... }
```

> 目录选型：凭证走 `~/.config/ultrawork/`（须与 opencode 的 xdg-basedir 对齐，`lib.rs:1498-1503`）；端口表是**运行时瞬态**，与 sidecar 二进制同族，放 `~/.ultrawork/run/`（`lib.rs:1622-1632` 已有 `~/.ultrawork/sidecars/` 先例）。

- Rust 开机分配端口 → 起 sidecar → 健康后写 `ports.json`；退出时清理。
- renderer 经 `get_sidecar_ports()` command 取值（走 IPC，不读文件）。
- 直接子进程走 env（快路径）；晚加入的孙进程继承 env（见 §4.1 d）。
- **持久化的 `opencode.json` 中永不出现端口。**

### 5.2 分配策略：先复用 → 再固定 → 后动态

1. 读 `ports.json`，健康检查通过且 pid 存活 → **复用**（保住今天的行为，见 §6）。
2. **dev**（`debug_assertions` 或 `ULTRAWORK_FIXED_PORTS=1`）→ 用 4096-4099 常量。冲突且占用者非我方 → **报错，不杀**。
3. **prod** → 优先尝试 4096-4099（保留日志可读性与排障便利），被占则 `TcpListener::bind(0)` 取临时端口。**占用者不在我方 pid 记录中就绕开，绝不 kill。**

`bind(0)` 后关闭、再交给子进程 bind，存在众所周知的 TOCTOU 窗口。**这个窗口不是理论上的**——阶段 ① 写测试时它当场发作：测试里 `bind(0)` 取端口、drop、再让子进程 bind，被并行跑的兄弟测试的 `bind(0)` 抢走，**6 跑 5 挂**（测试侧的规避办法是改用低于临时端口区间 49152+ 的固定端口；产品侧没有这个奢侈）。

所以重试**是必需的，不是保险**：`start_sidecar` 本就有 15s 健康轮询，bind 失败会让子进程秒退；套一层"最多重试 3 次、每次换端口"。配合下面的 `Terminated` 事件，可以秒级察觉 bind 失败而不是干等 15 秒。

顺带建议**不要再丢弃 `spawn()` 返回的 `_rx`**（`lib.rs:288`）——消费 `CommandEvent::Terminated` 就能立刻区分"启动失败"与"启动慢"，不必干等 15 秒（待验证项 §2.1）。

### 5.3 为什么 dev 必须保持固定

用户提出的"调试方便"成立。此外还有两条**硬约束**把 dev 锁死：

- Vite 代理 target 硬编码于 `vite.config.ts:7-9`，而 **Vite 启动早于 Tauri spawn sidecar**，读不到 `ports.json`。
- 三个 sidecar 的 CORS 白名单硬编码了 `http://localhost:1420`（`gateway-server.ts:35`、`kb-server.ts:41`、`acp-server.ts:16`）。

prod 侧反而无 CORS 问题——origin 是 `tauri://localhost`，与端口无关。

**代价**：dev/prod 走两条代码路径，动态那条在日常开发中零曝光。必须靠一支**强制走动态端口的 e2e** 兜底（现有 `e2e/mcp-status-dynamic.e2e.ts:28` 已有使用非标准端口 4196 的先例）。

---

## 6. 最大风险：动态端口会悄悄拆掉单实例语义

**这条比端口本身重要。**

今天的固定端口 + `prepare_port` 复用路径（`lib.rs:259` `return Ok(true)`）事实上充当了一把**单实例锁**：开第二个 app 实例时，它发现 4096-4099 上跑着健康进程，直接复用，不重复拉起。

改为动态端口后，第二个实例找不到"约定的门牌号"，于是**另起一整套 sidecar**。后果不止浪费内存：

- 两个 `knowledge-sidecar` 同时打开 `~/.ultrawork/knowledge/kb.db`（SQLite 单写者）。
- **两个 `channel-gateway` 同时维持钉钉/企微/飞书长连接**——这几家是顶号语义，会互相踢下线，或一条 IM 消息被 agent 回复两次。

因此 §5.1 的 `ports.json` 复用路径**不是锦上添花，是动态端口方案的必要组成部分**。更稳妥的做法是同时引入 `tauri-plugin-single-instance`（当前 `Cargo.toml` 无此依赖），把单实例显式化，而非继续依赖端口副作用。

---

## 7. 分期建议

| 阶段 | 内容 | 行为变更 | 依赖 |
|---|---|---|---|
| **①** | ✅ **已完成**（分支 `fix/sidecar-port-kill-scope`）：`lsof` 匹配收窄为 `-sTCP:LISTEN`（两平台）；杀之前用 exe 名验归属，无法归属一律放过；Linux 取进程名改读 `/proc/<pid>/exe` 并剥 `" (deleted)"` 后缀；`lsof` 从隐式依赖转显式（deb/rpm depends + CI）。cargo 83，30 次连跑零 flaky | 修 bug | 无（可先行合入） |
| **②** | `ports.json` + `get_sidecar_ports()` + renderer 四处解耦 + gateway 读 env + 移除 `opencode.json` 中的 `ACP_CLIENT_PORT`（含迁移） | **零行为变更的纯重构**（仍用固定值） | ① |
| **③** | prod 动态分配 + `tauri-plugin-single-instance` | 核心变更 | ② |
| **④** | gateway / knowledge / acp 补入站鉴权（§9） | 安全加固 | **④a 三处 EventSource 迁移**（见 §9.1） |

阶段 ② 是零行为变更的重构，最安全，且把最大的一块工作量隔离出来。

**拍板（2026-07-09）**：范围 = **①②③④ 一整轮全做**。①（误杀修复）仍作为独立首个 commit 落地，便于回滚与审查。

**存量迁移成本**：仓库有 8 个 tag（`v0.1.0*` 系列），`0.2.0` 未打 tag、未正式发布。存量用户实质为开发者本机，但 `~/.config/ultrawork/opencode.json` 的 `ACP_CLIENT_PORT` 条目确实存在，迁移逻辑不可省。

---

## 8. 已否决的替代方案

- **Unix domain socket / 命名管道**：彻底消灭端口。但 renderer 是 WebView，`fetch` 与 `EventSource` 走不了 UDS；除非把所有请求改为 Tauri IPC，那样 SSE 流式渲染需整体重写。不划算。
- **四服务合并到单端口做路径前缀多路复用**：把 4 个端口降到 1 个，长期架构更干净，但与"解决端口冲突"**正交**——1 个端口照样会冲突。作为独立议题另行讨论。
- **纯 `bind(0)`（不优先固定端口）**：更纯粹，但让 prod 与 dev 的差异变大，日志/文档/排障成本上升。见 §10 待拍板 1。

---

## 9. 附带收益：安全

`channel-gateway` / `knowledge-sidecar` / `acp-client` 三者的**入站仅有 CORS，无鉴权**（`gateway-server.ts:31-38`、`kb-server.ts:41`、`acp-server.ts:13-18`）。今天任何本地进程都可直接 `curl 127.0.0.1:4098/kb/...`。

临时端口**不是安全边界**（`lsof` 一扫即得），但确实抬高了"随手写死地址来打"的门槛。真正的修法是给这三者也加上 opencode 那套 Basic auth——凭据分发链路（`get_sidecar_credentials`，`lib.rs:1599`）已是现成的。**已拍板纳入本轮（阶段 ④）。**

### 9.1 ⚠️ 阶段 ④ 的隐藏前置：三处裸 `EventSource` 无法带 Authorization 头

`EventSource` 规范不支持自定义请求头。现状分裂为两套：

| SSE 通道 | 传输 | 能否带 Basic auth |
|---|---|---|
| opencode 全局 `/event` + per-session | `connector/src/sse-transport.ts:162` 的 **fetch-reader**（`fetch(url, { headers })`） | ✅ 可以（`api-client/src/client.ts:99` 已在发 `Authorization`） |
| 知识库 `/kb/sources/events` | `use-knowledge-base.ts:103` 裸 `new EventSource(sseUrl)` | ❌ 不行 |
| 编排 `/orchestration/runs/:id/events` | `orchestration-client.ts:56` 裸 `new EventSource(...)` | ❌ 不行 |
| 编排 `/orchestration/delegates/events` | `orchestration-client.ts:78` 裸 `new EventSource(...)` | ❌ 不行 |

因此阶段 ④ 必须先做 **④a**：把这三处迁移到 `@agent/connector` 已有的 fetch-reader transport。这不是新写代码——ADR-030 建那个 transport 的初衷正是"三套 fetch-reader/退避/心跳看门狗收敛一处"，这三处是当时**漏收编的残留**（`sse-transport.ts:7` 的注释里还写着 `desktop use-acp-sse.ts → EventSource, finite retry (5), silent`，那个文件已删，但 EventSource 用法散逸到了这三处）。

**明确否决的替代方案**：把 token 放进 query string（`?token=...`）。会泄漏进日志/进程列表/Referer，且与 opencode 现有 Basic auth 不一致。

`use-channels.ts` 走普通 `fetch`，不受影响。

---

## 10. 拍板结论（2026-07-09）

| # | 议题 | 结论 |
|---|---|---|
| **D1** | prod 端口分配策略 | **优先 4096-4099，冲突（且占用者非我方）才 `bind(0)` 回退**。日志/排障成本低，行为与今天一致。代价：动态分支真实世界少被走到 → **必须有强制走动态端口的 e2e 覆盖**（§5.3） |
| **D2** | 单实例 | **引入 `tauri-plugin-single-instance`**，第二次启动聚焦已有窗口。`ports.json` 的复用路径退化为纯崩溃自愈 |
| **D3** | `Settings.tsx:287` 的 `apiBaseUrl` | **改为 `"auto"` 语义，只读展示当前解析到的端口**。localStorage 存 `"auto"` 而非绝对地址，附一次性迁移 |
| **D4** | 本轮范围 | **①②③④ 一整轮全做**（① 仍作独立首个 commit）。④ 因 §9.1 拆出前置 ④a |

### 10.1 实现期附带决定（无需再拍，记录备查）

- `ports.json` 落 `~/.ultrawork/run/`（0600）。凭证才须与 opencode 的 xdg-basedir 对齐（`lib.rs:1498-1503`），端口表是运行时瞬态，与 `~/.ultrawork/sidecars/` 同族。
- dev 判定 = `cfg!(debug_assertions)` **或** `ULTRAWORK_FIXED_PORTS=1`（后者供 prod 构建本地排障时强制固定）。
- `mcp-bridge.ts` 的 proxy 死分支（`KB_BASE`）**直接删除**，不参数化——`mcp-stdio` 只走 direct 模式（§2）。
- 孤儿 sidecar 沿用今天的"杀掉重建"而非复用（`port_listener_orphaned`，`lib.rs:136-155`）。
- renderer 端口解析用**启动 gate**：在 `main.tsx` 现有 7 个 Provider 外再包一层，拿到端口前不渲染主界面。代价是极短 loading 态，收益是 `config.ts` / `use-knowledge-base.ts` / `orchestration-client.ts` 的下游调用点无需逐个改成 async。

### 10.2 实现期真机验证项（CI 测不到）

1. Tauri shell `spawn()` 的 `_rx`（`lib.rs:288` 现直接丢弃）是否需持有并消费才能收到 `CommandEvent::Terminated`（用于快速区分"bind 失败秒退"与"启动慢"）。
2. **Windows**：环回 bind 临时端口是否触发 Defender 防火墙提示；`netstat -ano` 解析在临时端口段（49152-65535）的表现；`ports.json` 的 0600 在 NTFS 上的语义（与 ADR-044 遗留的 `channels.json` 同一问题）。
3. `Bun.serve({ port: 0 })` 回读 `server.port`（Bun 官方 API，近乎确定，仍应写断言）。
4. `tauri-plugin-single-instance` 在三平台的行为一致性（Linux 需 DBus）。
