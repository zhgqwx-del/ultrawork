# health-contention — `/global/health` 事件循环争用复现 harness

复现并实测 vendor/opencode（v1.15.13 起）的一个性能现象：**O(1) 的 `/global/health` 在多文件目录下会被同进程的目录扫描工作（File.scan / snapshot.add）饿死，单次探活延迟越过 500ms**。

> 配套分析：`docs/discussions/020-vendor-bump-perf-regression.md` §2.2 / §2.3 / **§10**（含本 harness 的实测数据与结论）。
> 所有脚本用 `bun run`（不要 `npx`/系统 node）。探活客户端必须是**独立进程**——同进程探活会和 server 一起冻结，测不出延迟。

## 机制一句话

`/global/health` handler 是 O(1)（`handlers/global.ts:75-77`），但与所有 instance 路由**共用一个事件循环 + 一个 listener**（`server.ts:59,189`）。`git`/`ripgrep`/`stat` 是异步子进程不阻塞循环；真正冻结循环的是**裸同步 JS 段**（File.scan 祖先循环、snapshot 的 `\0`-list `split`/`Set`）。单次扫描通常 <150ms，**>500ms 来自累积**（回合内 snapshot 高频 `add()` 6–9×、bootstrap 无界并发、超大仓库）。

## 脚本

| 脚本 | 作用 |
|------|------|
| `tier1-server.ts` | Tier-1 最小 server：`/global/health` O(1) + `/load?n=` 跑一段同步 File.scan 式循环。剥离 opencode，确定性证明机制。 |
| `probe-timeline.ts` | 通用独立进程探针：连续打点 `/global/health`，中途 fire 一个 trigger，打印延迟时间线 + p50/p90/p99/max + `>500ms` 失败数。 |
| `gen-tree.ts` | 生成多文件 git 仓库（`git init`+commit），用于 Tier-2 触发真实 bootstrap。 |

`probe-timeline.ts` 环境变量：`FIRE_AT`（首次触发时刻 ms）、`FIRE_REPEAT`（触发次数，模拟 snapshot 一回合多次 add）、`FIRE_GAP`（触发间隔 ms）、`TOTAL_MS`（总时长）。

## Tier-1：确定性机制证明（秒级，无需 opencode）

```bash
bun run scripts/perf/health-contention/tier1-server.ts 4790 &

# 单次同步块：看 O(1) health 排在其后
bun run scripts/perf/health-contention/probe-timeline.ts \
  http://127.0.0.1:4790/global/health "http://127.0.0.1:4790/load?n=300000" "isolation"

# 高频累积越过 500ms（模拟回合内 snapshot add 6-9x）
FIRE_REPEAT=14 FIRE_GAP=25 TOTAL_MS=3000 \
bun run scripts/perf/health-contention/probe-timeline.ts \
  http://127.0.0.1:4790/global/health "http://127.0.0.1:4790/load?n=250000" "churn"

kill %1
```

## Tier-2：真实 v1.15.13

需要一个 v1.15.13 源码 worktree（从 vendor submodule）：

```bash
# 1. 拉 v1.15.13 worktree 并装依赖（一次性）
cd vendor/opencode && git worktree add --detach /tmp/oc-v1.15.13 v1.15.13 && cd /tmp/oc-v1.15.13 && bun install

# 2. 生成多文件仓库（30w 文件约 3 分钟）
bun run scripts/perf/health-contention/gen-tree.ts /tmp/huge 300000 200

# 3. 起 v1.15.13 server（unsecured，loopback）
cd /tmp/oc-v1.15.13 && OPENCODE_SERVER_PASSWORD= \
  bun run --cwd packages/opencode --conditions=browser src/index.ts serve --port 4791 --hostname 127.0.0.1 &

# 4. 冷触发该目录 bootstrap + 同时探活（probe-timeline 会 fire /project/current 触发懒加载）
bun run scripts/perf/health-contention/probe-timeline.ts \
  http://127.0.0.1:4791/global/health \
  "http://127.0.0.1:4791/project/current?directory=/tmp/huge" "cold-bootstrap"
```

> 提示：实例 bootstrap 是**懒加载**且**带缓存**——同一目录第二次触发不再重扫。要测「首次最坏情况」请用 fresh server。`directory` 经 query / `x-opencode-directory` header 解析（`middleware/workspace-routing.ts:87`）。

## 实测参考值（Apple Silicon, bun 1.3.12，见 020 §10.2）

- 空载 health ~1–4ms；Tier-1 单次 300k → max ~108ms；Tier-1 高频 14×250k → **30/187 >500ms FAIL**。
- 真实冷 bootstrap 10w（fresh server 首次）→ trigger 546ms、health max 236ms；30w → health max ~55ms（单纯文件数影响有限，**累积才致命**）。
