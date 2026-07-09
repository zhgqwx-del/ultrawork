# ADR-045: Sidecar 端口动态化（dev 固定 / prod 动态）+ 单实例 + 三 sidecar 入站鉴权

- 状态：Accepted（✅ 四阶段全实现 + 真机验收 2026-07-09）
- 日期：2026-07-09
- 关联：discussions/029（尽调与拍板 SSOT）· ADR-028（sidecar 凭证）· ADR-030（connector SSE transport）· ADR-031/038（编排层宿主 = ACP sidecar）· ADR-037（跨平台）· gotchas §6/§12 · conventions §13

## 背景

四个 sidecar 的端口（opencode 4096 / gateway 4097 / knowledge 4098 / acp 4099）是 Rust 编译期常量，散落 111 个文件。软件装到用户机器上后端口冲突会导致启动失败——**且比"起不来"更糟**：`prepare_port` 在端口被占且健康检查失败时会**杀掉占用者**，而 Unix 侧 `lsof -ti :PORT` 匹配过宽（本地端口**或**远端端口任一命中），可能误杀只是碰巧拿到该临时端口做出站连接的无辜进程。4096-4099 均非 IANA 保留段。

尽调（discussions/029）证实动态化比预想容易一半——上游 opencode 默认端口本就是 `0` 且会把真实端口打到 stdout，是我们自己传 `--port` 把它钉死的。真正的工作量不在"怎么监听"，而在**五类消费者如何得知端口**。

## 决策

1. **误杀修复先行（阶段 ①，独立 commit）**：`lsof` 收窄为 `-sTCP:LISTEN`（Windows netstat 同步过滤 `LISTENING`）；**杀之前用 exe 名验归属**，无法归属一律 fail-closed 放过——宁可漏回收端口，不可误杀用户进程；Linux 取进程名改读 `/proc/<pid>/exe` 并剥 `" (deleted)"` 后缀（`ps -o comm=` 在 Linux 截断到 15 字符）。

2. **运行时端口注册表（阶段 ②）**：端口由 Rust 启动时决定一次，经三条通道下发——直接子进程走 env（`GATEWAY_PORT`/`KB_PORT`/`ACP_CLIENT_PORT`/`--port`）、renderer 走 `get_sidecar_ports()` IPC、孙进程读 `~/.ultrawork/run/ports.json`（0600）。**持久化的 `opencode.json` 中永不出现端口**（附开机迁移剥除存量 `ACP_CLIENT_PORT`）。renderer 用**启动 gate**（`main.tsx` 在 `createRoot` 前 await 一次），下游 base-URL helper 保持同步，无需把每个 hook 改成 async。

3. **D1 — prod 优先固定、冲突回退动态（阶段 ③）**：优先尝试 4096-4099，被占且占用者非我方 → `TcpListener::bind(0)` 取临时端口，**绝不 kill**。dev（`cfg!(debug_assertions)`）钉死固定端口并**报错不绕行**——Vite 代理 target 与三 sidecar 的 CORS 白名单都是编译期常量，dev 悄悄换端口只会伪装成别处的 bug。`ULTRAWORK_DYNAMIC_PORTS=1` 强制走 prod 路径（供 e2e），`ULTRAWORK_FIXED_PORTS=1` 反向锁定（供 prod 构建排障）。

4. **D2 — 引入 `tauri-plugin-single-instance`（阶段 ③）**：固定端口过去是**事实上的单实例锁**（第二个实例发现 4096-4099 上有健康进程就复用）。动态端口拆掉了这个副作用，第二个实例会另起一整套 sidecar → gateway 双开导致 IM 长连接顶号、两个 knowledge-sidecar 双写单写者 SQLite。显式化，不再依赖涌现行为；`ports.json` 的复用路径退化为纯崩溃自愈。

5. **D3 — `apiBaseUrl` 改 `"auto"` 语义（阶段 ②）**：localStorage 不再存绝对地址，设置页 auto 模式下只读展示解析到的端口。一次性迁移把旧的 `""` / `http://localhost:4096` 归一为 `"auto"`，**刻意保留**用户显式填写的远程地址不被迁移。

6. **D4 — 三 sidecar 补入站 Basic auth（阶段 ④）**：此前三者入站只有 CORS，无鉴权。CORS 只约束浏览器，不是边界；临时端口也不是边界（`lsof` 一扫即得）。复用 ADR-028 的每装机随机凭证。前置 **④a**：三处裸 `EventSource` 迁到 connector 的 fetch-reader（`EventSource` 规范不支持自定义请求头，带不了 `Authorization`）。

## 关键实现约束（踩过的坑）

- **环形依赖**：opencode 需要 acp 端口（喂给它派生的 delegate-mcp 孙进程），acp 又需要 opencode 端口。解法 = opencode 先起（端口随后确定，喂给 gateway/acp），而 **delegate-mcp shim 自己读 `ports.json`**——shim 运行时 acp 早已落定。`ports.json` 由此从只写变成有真实读者。
- **`bind(0)` → close → spawn 的 TOCTOU 窗口是实证会发作的**，不是理论：阶段 ① 写测试时被并行兄弟测试的 `bind(0)` 抢走，6 跑 5 挂。故**重试循环是必需的，不是保险**。
- **必须消费 `spawn()` 返回的 rx**：插件 channel 容量为 1 且 stdout/stderr reader 走 `block_on(tx.send())`，只持有不 drain 会把子进程的写卡死（旧代码直接丢弃 rx 才是安全的）。专用线程 `blocking_recv` 拿 `CommandEvent::Terminated`，~200ms 识破「子进程秒退」，不再干等 15s。
- **`opencode.json` 里的 `mcp.environment` 排在 env 合并顺序最后、会覆盖继承值**（vendor `mcp/index.ts`），一条 stale `"4099"` 足以压掉正确端口 → 迁移不可省。
- **`/health` 也在鉴权之内**：`prepare_port` 把「健康响应者」当成自家 sidecar 直接复用，所以能答 health 必须证明持有凭证。
- **鉴权中间件必须挂在 `cors()` 之后**：hono 的 cors 自己应答预检 OPTIONS 且不调 `next()`，浏览器那个不带凭证的预检因此不会被 401 掉。

## 后果

- **dev/prod 走两条代码路径**，动态那条在日常开发中零曝光 → 由 `ULTRAWORK_DYNAMIC_PORTS=1` 驱动的 `e2e/dynamic-ports.e2e.ts` 兜底（真二进制、断言 4096-4099 全程无人监听）。
- 端口不再是单实例锁；任何依赖"端口被占=另一个我在跑"的推理都失效，改由 single-instance 插件保证。
- 三 sidecar 的任何新调用方**必须带 `Authorization`**；`EventSource` 从此在本项目不可用（带不了头），SSE 一律走 `createSseTransport`。
- `mcp-bridge.ts` 的 proxy 死分支（硬编码 `:4098`）直接删除，不参数化——`mcp-stdio` 只走 direct 模式。
- **真机验证覆盖**（discussions/029 §10.2）：① rx 必须持有并消费——已闭环；③ `Bun.serve({port:0})` 回读——**作废**（Rust 传具体端口，sidecar 从不 bind 0）；② Windows 防火墙/`netstat` 临时端口段解析、④ single-instance 三平台一致性（Linux 需 DBus）——**仍待真 Windows/Linux 机器实测**，CI 只保证编译与单测。

## 已知边界

- 三个后台 sidecar 若在启动 gate 之后才因抢占改端口，靠 `sidecar-ports-changed` 事件通知 renderer 重建 connector；opencode 因同步阻塞启动，其端口在 renderer 读取前必然已定。
- 单实例插件在 Linux 依赖 DBus，未实测。
- 鉴权只做认证不做授权：任何持有凭证的本机进程可调用全部路由（凭证文件 0600）。
