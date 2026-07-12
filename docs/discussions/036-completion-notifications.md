# 036 — 任务完成 / 需要交互时的桌面提醒（调研 + 方案）

> 2026-07-12 · 待落 ADR-053 · 状态：**方案已定，3 项未知已用真机探针全部关闭（见 §4）**

## 触发

真机反馈：AI 回复完成后，如果 app 不是当前活跃窗口（最小化、或在用别的软件），**用户不知道它已经完成了**，只能反复切回来看。期望在任务完成时提醒——提示音 / 系统通知 / 任务栏闪烁。

用户给了一张友商设置页截图作参考：「通知提醒」分区三个开关——**提示音**（对话完成或需要交互时播放）、**系统通知**（窗口未聚焦时显示）、**任务栏闪烁**（窗口未聚焦时闪烁任务栏图标）。

---

## 一、平台能力（本机核过 tauri 2.10.3 / tauri-runtime 2.10.1 源码，非凭记忆）

| 手段 | API | 三平台行为 | 新依赖 |
|---|---|---|---|
| **任务栏闪烁 / Dock 弹跳** | `Window::request_user_attention(Some(UserAttentionType::…))`（JS 侧 `getCurrentWindow().requestUserAttention()`） | **macOS**：Dock 图标弹跳（`Critical` = 弹到聚焦为止，`Informational` = 弹一次）· **Windows**：闪任务栏按钮 + 窗口 · **Linux**：WM urgency hint，**依赖桌面环境，可能什么都不发生** | 无（Tauri 自带，只需在 `capabilities/default.json` 放开权限） |
| **系统通知** | `tauri-plugin-notification` v2 | 三平台均支持 | **有**：Cargo.toml + package.json + capabilities 三处 |
| **提示音** | WebView `new Audio(asset)` 或 WebAudio | 三平台一致（都是 WebView 内播放） | 无（但需一个音效资源，见待验证 V2） |

源码里两条值得记的契约：

- `request_user_attention` 文档明确写 **「窗口已聚焦时此调用无效」** —— 正好是我们要的语义，不需要自己判焦点去抑制。
- 传 `None` 用于撤销请求，但 **macOS 上 `None` 无效**（撤不掉，只能靠用户聚焦窗口自动停）。所以别设计成「N 秒后自动停止弹跳」——mac 上做不到。

`set_badge_count`（Dock 角标）也存在，但 **Windows 不支持**（要改用 `set_overlay_icon`）。本轮不做，留作后续。

---

## 二、核心设计：**什么时候该响**（比「怎么响」重要得多）

### 2.1 事实来源：全局 `session.status: idle`，不是渲染层 `isStreaming`

`use-sessions.ts:253` 的全局 SSE 已经折叠了**所有**会话的 busy/idle（含没打开的后台会话），这是天然挂载点。

**不要用渲染层的 streaming 标志**：`assistant-turn.tsx:204` 的 `useStableStreaming` 已经为它写了防抖，因为它会 false→true→false 抖动 ⇒ 拿它触发会重复响。

### 2.2 【坑 A】不能 diff 活跃集合

`server.instance.disposed` 会**一次性清空所有 busy 标记**（`use-sessions.ts:266`）。若实现成「谁从 `activeSessionIds` 里消失就算完成」，sidecar 一重启就**放一串通知**。必须按事件类型判定（收到 `session.status:idle` 才算完成），不能观察集合缩小。

### 2.3 【坑 B】IM 渠道会话 + 委派子会话 —— 一个口径同时解决

- **IM 渠道会话**：微信/钉钉/企微/飞书的消息走同一批 session、同样会 idle。你在开会，别人给 bot 发条消息，你的电脑就叮一声 + Dock 弹跳 = **纯骚扰**。而桌面端**不知道**哪些 session 是渠道绑定的（映射在 gateway 的 `session-map.json` 里）。
- **委派子会话**：`use-sessions.ts:240` 只是把 `parentID` 的子会话挡在**列表**外，`session.status` 处理是**按 sessionID 无条件标记**的 ⇒ 子 agent 完成时也会走到触发点。更麻烦的是 status 事件里只有 sessionID，渲染层**无从判断**这个陌生 id 是不是子会话（它从没 fetch 过）。

**统一解法：in-flight 白名单。** 只对「**本 app 内发起过 prompt**」的 session 记一个集合，只有集合里的 session 完成时才提醒。IM 会话、委派子会话、任何未知来源的会话天然不在集合里——**不需要额外判据，一箭三雕**。

代价：app 重载（dev HMR / 用户刷新）会丢集合 ⇒ 那一轮不提醒。可接受，不做持久化（持久化反而会在重启后补弹一串陈旧通知）。

### 2.4 【坑 C】「需要交互」不能靠 idle 推断，且当前订阅够不着后台会话

ADR-050 已坐实：agent 反问时**阻塞在工具内部，session 全程 busy 且零事件**（真二进制实测静默 195s）。所以「需要你操作」**必须**订阅 `permission.asked` / `question.asked`（外加委派子权限 `delegate.permission`）。

而 `use-session-permission` 现在是 **session-scoped**（`useSessionSubscribe(sessionId, …)`）—— 只订阅当前打开的那个会话。要让**后台会话**的提问也能提醒，得把订阅提到全局层。**这是本方案唯一一笔真实的结构改造**（ADR-048 已经因为同一个原因把委派权限订阅从 composer 提到 Session 级，这次是再提一层）。

**优先级判断**：「需要交互」比「回合完成」更值得做——它是三类事件里唯一一个**用户不响应就永久卡住**的（不回 question，agent 一直等，最后超时把整个任务浪费掉）。「完成」晚 10 分钟看到只是晚 10 分钟。**若要砍范围，砍「完成」保「交互」，不能反过来。**

### 2.5 【坑 D】通知风暴（权限循环）

权限设成 `ask` 时（ADR-048 验收时就配过），agent **每跑一个 bash 都要问一次**。用户离开 10 分钟回来会看到十几条系统通知 + Dock 弹了十几次。

**节流规则**：每个 session 在「已提醒且用户还没回来处理」期间**只提醒一次**；用户聚焦窗口后重置该 session 的提醒资格。（不是按时间窗节流——按时间窗在长时间离开时仍会积累。）

### 2.6 【坑 E】失败也要提醒

idle guard（ADR-034/049）会把挂死的请求落成 `info.error` 终态。**「任务失败了」比「任务完成了」更需要通知**，文案分开（`session.error` 事件 + 终态 `finish` 判定）。

### 2.7 门控口径：比截图的参考实现更宽一点

截图里的参考：提示音**不看焦点**（一直响），通知/闪烁只在未聚焦时。

**我们的口径：三者统一为「窗口未聚焦 **或** 当前正在看的不是那个会话」。**

- 提示音也要门控：用户正盯着屏幕看输出，完事还叮一声 ⇒ 噪音 ⇒ 用户去设置里把它整个关掉 ⇒ 连「真该提醒」那次也丢了。
- 但「未聚焦」不够：用户在会话 A 干活、后台会话 B 跑完了，**即使窗口聚焦也需要知道**——截图那个参考实现覆盖不了这种情况。多出的成本≈0（判定函数本来就拿得到 完成的 sessionId + 当前路由的 sessionId）。

**焦点判定用 Tauri 的 `isFocused()` + `onFocusChanged` 事件，不用 `document.visibilityState`** —— 最小化在部分 WebView 里 visibilityState 不变（老坑）。

---

## 三、方案

### 3.1 分层（副作用薄、决策纯）

```
事件源（全局 SSE）                判定层（纯函数，可单测）        副作用适配器
─────────────────────            ──────────────────────         ─────────────
session.status: idle      ┐                                  ┌ playChime()          (WebView Audio)
session.error             ├─→  shouldNotify({               ├ sendSystemNotification() (plugin)
permission.asked          │       event, inFlightSet,       └ requestUserAttention()   (Tauri window)
question.asked            │       focused, viewingSessionId,
delegate.permission       ┘       notifiedSessions, config
                                 }) → { sound, system, flash }
```

**判定层必须是纯函数** —— 上面 5 个坑（disposed 风暴 / 渠道会话 / 委派子会话 / 抖动 / 风暴节流 / error 终态）全部在这一层用单测钉死。副作用层薄到不值得测（e2e 结构上也够不着，见 §5）。

### 3.2 设置项

照 `planAutoReveal` 的现成模式（`config.ts` 的 `AppConfig` → localStorage `ultrawork-config` → `Settings.tsx` 的 `GeneralSection`）加三个布尔：

| key | 文案（zh） | 默认 |
|---|---|---|
| `notifySound` | 提示音 —— 对话完成或需要您操作时播放提示音 | on |
| `notifySystem` | 系统通知 —— 窗口未聚焦时显示系统通知 | on |
| `notifyFlash` | 任务栏闪烁 —— 窗口未聚焦时闪烁任务栏 / Dock 图标 | on |

i18n 的 `en` / `zh` 两块必须**同步**改（`i18n-context.tsx` 是扁平点号 key 的单文件）。

### 3.3 macOS 通知权限：**按需申请，不在启动时申请**

启动时弹权限窗，用户还没建立心智，容易随手拒。**第一次真的要发通知时才 `requestPermission()`**；被拒则**静默降级**成只闪 Dock + 提示音，不做二次骚扰、不弹自制引导。

### 3.4 刻意不做（本轮）

- **点击通知跳转到对应会话**：v2 桌面端的点击回调支持不确定（底层 notify-rust / mac-notification-sys），验证 + 三平台兼容成本不低；收益只是省一次点击（点 Dock 唤起 app → 侧边栏未读点，ADR-051 刚做完，本来就在那儿）。**替代**：通知正文带上会话标题 + 事件类型，唤起后一眼知道去哪。Rust 侧唤起窗口的现成代码在 `lib.rs:5384`（single-instance 的 `unminimize/show/set_focus`），将来要做时直接复用。
- **Dock 角标 / 任务栏 overlay icon**（`set_badge_count` Windows 不支持，要走 `set_overlay_icon`，两套代码）。
- **音量 / 音效选择 / 免打扰时段**（系统级勿扰已经能挡系统通知）。

---

## 四、三项未知 —— 真机探针结果（2026-07-12，macOS 15 / Apple Silicon）

探针做法：临时给 app 挂一个 `VITE_NOTIFY_PROBE=1` 才启动的渲染层探针 + 一个 Rust `probe_log` 命令（webview console 在 `tauri dev` 终端里看不见，gotchas §7），窗口状态用 AppleScript 驱动，**dev 与打包 .app 各跑一遍**。

### V1 · 系统通知 —— **dev 下 API 会撒谎（假绿）**

| | `isPermissionGranted()` | `sendNotification()` | macOS 通知注册表（`ncprefs.plist`） | 横幅 |
|---|---|---|---|---|
| **`tauri dev`（未打包二进制）** | 直接 `true`（**权限根本没申请**） | 三次全部**不抛异常** | **查无 `com.ultrawork.desktop`**（86 个 app 里没有它） | **没弹** |
| **打包 .app** | `granted` | 不抛异常 | 跑完立刻出现 `"bundle-id" => "com.ultrawork.desktop"`，`lsappinfo` 也认 | **弹了**（人眼确认） |

**结论 + 铁律**：通知链路**只能用打包后的 .app 验，dev 里的「成功」一律不作数** —— 返回值全绿而横幅一条没出，是这个功能最容易踩的假绿。→ 固化进 gotchas §6（Tauri）。

Windows toast 的 AppUserModelID 前提（大概率同样「装完才正常」）仍未验 —— 与 ADR-045/046 的 Windows 真机欠账合并。

### V2 · 提示音 —— **能播，且不需要任何音频资源文件**

- `AudioContext` 创建时确实是 `suspended`（无用户手势），但 **`resume()` 在零用户手势下成功**，此后全程 `running`。
- 活体证据不是「没报错」，是 **`ctx.currentTime` 持续推进**（每 tick 精确 +5.00s）—— **窗口最小化期间照样推进**（`isMinimized=true` 的两个 tick 同样 +5s），AnalyserNode 采到 RMS ≈ 0.085 非零 ⇒ 音频图真的在产样本。
- `HTMLAudioElement.play()` 在 聚焦 / 失焦 / 最小化 / cmd+H 隐藏 **四种状态全部 resolve**，一次 `NotAllowedError` 都没有。
- 人耳确认：**声音真的出来了**（RMS 只证明图渲染了样本，不证明到达扬声器 —— 这一步只能靠耳朵）。

**⇒ 定案**：走 WebView 播放，**不需要 Rust 侧音频**（`rodio` / `afplay` 的脏方案全部作废）。音效**在内存里合成 WAV**（写 44 字节头 + 正弦样本，探针里已验证可行）⇒ **零资源文件、零版权风险、零打包体积**。

### V3 · 「未聚焦」的四种物理状态 —— **一个 bool 全覆盖**

| 状态 | `isFocused` | `isMinimized` | `isVisible` | `document.visibilityState` |
|---|---|---|---|---|
| 聚焦 | `true` | false | true | visible |
| 别的 app 在前台（我们的窗口仍可见） | **`false`** | false | true | **visible/hidden 反复横跳** |
| 最小化 | **`false`** | true | false | hidden |
| cmd+H 隐藏 | **`false`** | false | false | hidden |
| 别的 app 全屏（我们在另一个 Space） | **`false`** | false | true | **横跳** |

- **`isFocused()` 单独一个 bool 就够** —— 四种「用户看不见」的状态它全是 `false`。门控不需要再看 minimized/visible。
- **`document.visibilityState` 实测不可用**：同一状态下在 visible/hidden 间**反复横跳**（按遮挡计算）⇒ 拿它当门控会既漏触发又误触发。§2.7 「别用 visibilityState」被实测坐实。
- **【新发现，方案原本没写】`onFocusChanged` 的事件 payload 与随后 `isFocused()` 的查询会不一致** —— 抓到过 payload=`true` 但当场查是 `false`。⇒ **决策时必须重新查一次 `isFocused()`，不能只信事件 payload**，否则会在切窗口的瞬间做出错误判断。

### 顺带确认

`requestUserAttention(Critical)` 调用不抛异常，**Dock 图标真的在弹跳**（人眼确认）。Linux 的 WM urgency hint 仍未验。

---

## 五、验收策略

- **单测**（判定层纯函数）：disposed 风暴不误报 · 渠道会话不通知 · 委派子会话不通知 · 权限风暴只提醒一次 · error 终态要提醒 · 聚焦且正在看该会话时全部静默 · 三个开关各自独立生效。每条配 **A/B 反证**（撤掉修复必须变红——ADR-050/051 两次抓到「撤掉守卫仍全绿」的假测试）。
- **真机手动验收**（**必须打包后的 .app**）：系统通知 / Dock 弹跳 / 提示音三个副作用 **headless e2e 结构上够不着** —— 这跟 ADR-047/048/051 撞的是同一堵墙（Tauri 原生窗口自动化那笔基建欠账）。
- **三平台**：Linux 的闪烁依赖 WM，可能无效 —— **如实降级、不假装成功**（文档写清楚）。Windows/Linux 真机同样欠账（与 ADR-045/046 的 Windows 欠账可以合并一次验）。

---

## 六、范围与工作量

约 **1 天**（探针已把三个未知关掉，实现路径无岔路）：

1. 全局 permission/question 订阅（把 `use-session-permission` 的订阅提到全局层）—— 唯一的结构改造
2. in-flight 白名单（发 prompt 时登记，idle/error 时消费）
3. 判定层纯函数 + 单测（六个坑全在这层钉死）
4. 三个副作用适配器：
   - 提示音 = 内存合成 WAV + `HTMLAudioElement`（**无资源文件**，V2 已验）
   - 系统通知 = `tauri-plugin-notification`（Cargo + npm + capabilities `notification:default`）
   - 闪烁 = `requestUserAttention(Critical)`（capabilities `core:window:allow-request-user-attention`）
   - 焦点 = `getCurrentWindow().isFocused()`，**决策当场重查**，不信 `onFocusChanged` 的 payload（V3 新发现）
5. 设置页三开关 + i18n 双语
6. **验收必须在打包 .app 上做**（V1：dev 下通知 API 全绿但横幅不弹）
