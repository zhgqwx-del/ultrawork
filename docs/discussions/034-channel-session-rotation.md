# 034 — IM 渠道会话轮转与侧边栏发现性（调研 + 方案）

> 2026-07-12 · 落地为 ADR-051 · 分支 `feat/channel-session-rotation`

## 触发

真机反馈：「通过 channel（微信/钉钉/飞书/企微）发的消息，在桌面端各自也只有一个 session，刚才测试的时候，因为这些 session 是很久之前的，桌面端收到信息后也没有排在 session list 最上面，找了半天才找到。」

用户初始提议：**给 channel session 加 idle 轮转（6~12h）**，超时后就用新 session。

## 第一个结论：这是两个问题，而提议治的是另一个

| | 问题 | 修法 |
|---|---|---|
| **A** | 发现性——列表不把有新活动的会话顶上来 | 排序 + 分组 + 视觉标识 |
| **B** | 会话语义——一个 IM 单聊永远复用同一 session，上下文无限增长 | idle 轮转 |

用户遇到的是 **A**。idle 轮转治的是 **B**，对 A 只是**顺带缓解**（新 session 因 `time.created` 新而恰好排前面）。**只要还有任何形式的会话复用（哪怕 60 分钟内的），A 就还在。** 所以两个都要修，但不能用 B 掩盖 A。

### A 的机械根因（读码确认，两条叠加）

1. `use-sessions.ts` 收到 SSE `session.updated` 时是**原地替换**：
   ```ts
   const idx = prev.findIndex((s) => s.id === sid)
   if (idx >= 0) { const next = [...prev]; next[idx] = { ...prev[idx], ...info }; return next }  // 索引不动
   ```
   服务端排序（`ORDER BY time_updated DESC`）是对的、SSE 也确实推了完整对象过来——但位置纹丝不动，只有手动 refetch 才重排。
2. 排序用 `time.updated`，**分组却用 `time.created`**（`groupSessionsByDate`）。于是几周前建的渠道会话哪怕今天刚被激活，**即使手动刷新也还钉在「更早」里**。

两条叠加 = 「找了半天」的完整机制。

## 业界调研

分水岭是 IM 有没有 thread。

**有 thread（Slack/Discord）**：thread 即天然会话边界，`1 thread = 1 session`，**基本不需要 idle 轮转**。
- Claude Tag：1 thread = 1 working session，thread 内任何人回复即续（不需再 @）；sandbox idle 释放但 thread 永不过期
- Devin：1 thread = 1 session，`!new` 强制开新；有 sleep 语义（不活动即冻结，@ 一下就醒）但**不是轮转**——冻结而非切断
- Cursor / OpenHands / opencode 官方 Slack 包：同上
- Codex / Copilot coding agent：**任务制**——每次 mention 开一个新 cloud task，thread 只是上下文来源

**无 thread（微信/企微/钉钉单聊）= 我们的处境**：只能「一个聊天窗口一个长 session」+ 人造边界。

| 项目 | idle 轮转 | 动机 / 备注 |
|---|---|---|
| **cc-connect**（本地 coding agent → 飞书/钉钉/企微） | **30 分钟**（`reset_on_idle_mins`，0=关） | 原话：防 *context drift*（陈旧的失败命令、调试噪声被反复重新 ingest）。轮转后不带上下文，但旧 session 可 `/list` + `/switch` 找回 |
| **OpenClaw** | **60 分钟**（`idleMinutes`）+ daily 4am，先到先赢；官方示例 DM 240min / 群 120min | 明确主张 **reset 默认什么都不带**，要连续性就用 **compaction** 而不是 reset。**心跳/cron 等系统事件不刷新 idle 计时** |
| **Hermes**（NousResearch） | 默认 **none**，可选 idle/daily/both | 两条护栏：重置前先让 agent 保存重要上下文；**有后台任务在跑的 session 永不自动重置** |

**关键数字：30 / 60 / 最长 240 分钟。没有一家用 6~12 小时。**

原因很清楚：**它们轮转是为了防上下文污染，不是为了让会话在 UI 里冒头。** 6~12h 的阈值意味着「只有隔夜才换」——白天连续用一整天，上下文照样无限增长，B 根本没被治到。

**两条业界共识**：
- **能 compaction 就别 reset**（窗口满 → 压缩，同 session；时间过久 → 才 reset）。OpenClaw / Hermes 都这么讲。
- **没有任何一家在做「话题漂移检测」**自动开新会话。实际用到的触发只有 4 类：显式命令、新 thread、idle 超时、daily 定时。

**UI 侧最完整的公开参考是 OpenClaw Control UI**：按渠道分区 + **未读小圆点**（派生自「已读时间 < 最新活动」）+ pin/archive。这正是我们要的形状。

## 方案（→ ADR-051）

**P0（修 A，也就是用户真正遇到的）**
- 排序**渲染期派生**，不进 state（ADR-048 的手法）
- 分组键改 `time.updated`，与排序键统一；`frozen` 参数**必填不给默认值**（让 tsc 抓漏传）
- **hover 冻结**：唯一的真实危害是列表在光标下位移导致误点

**P0.5（发现性做扎实——"不靠位置找"）**
- 渠道徽标 + 未读圆点。**这和 P0 是同一个问题的两半**：排序修好了但一堆会话长得一样，还是得逐个读标题。
- 数据源只能自建 registry（opencode Session schema **没有** metadata 字段，`PATCH /session` 只收 title + archived）

**P1（轮转，重新定位其目的）**
- 默认 **60 分钟**（不是 6~12h），lazy 判定
- **必须告知用户** + `/resume` 对称切回
- 三条护栏（in-flight / 活动时钟 / 群聊身份）

顺序有依赖意义：**轮转会产生更多 session**，发现性没修好之前先做轮转，只会让列表更乱。

## 被真环境推翻/抓出的东西

- **`${gatewayBaseUrl()}/channel/sessions` 双前缀 404**——该函数本身已含 `/channel`。徽标**永远不出现且日志无声**（失败被 catch→退避静默吞掉）。单测结构上看不见（fetch 没跑）；**真浏览器 e2e 第一次跑就抓到**。
- **`os.homedir()` 不认运行时改的 `HOME`**（Bun 里只在进程启动时解析一次）。单测用 `vi.stubEnv("HOME")` 隔离**完全没生效**，真的覆盖了开发者的 `~/.ultrawork/session-map.json`。
- **并发 `save()` 争用固定临时文件名**——本轮把落盘从「建/删会话时」变成「每条消息」，把窄竞态变成常态。
- **两个测试在撒谎**（A/B 抓出）：`vi.stubEnv` 不被 `restoreAllMocks()` 清理导致 env 泄漏；「question 挂起时不轮转」的测试撤掉护栏**仍然全绿**（该路径 early-return，压根走不到轮转判定——护栏真正保护的是「普通 turn 在飞」）。

## 留作后续

- **daily 4am 兜底**未做（OpenClaw 有）。单靠 idle 已覆盖真实场景，加它会引入时区边界。
- **群聊仍是全群一个 session**。业界默认按发送者隔离（Hermes `group_sessions_per_user` 默认开）——与 ADR-050 已修的「旁人插话被当成答案」同根。
- **轮转阈值用户不可调**（env 在打包后传不进去）。若要可调，做进设置页。
- **permission 仍是无条件自动放行**（ADR-044 D5 / ADR-050 遗留）。
