# ADR-053 — 回合完成 / 需要交互时的桌面提醒

> 2026-07-12 · 状态：Accepted · 调研 discussions/036 · 分支 `feat/clickable-links-and-artifact-cards`

## 背景

真机反馈：AI 回复完成后，若 app 不是活跃窗口（最小化 / 在用别的软件），**用户不知道它已经完成**，只能反复切回来看。同时——比"完成"更严重的是——**agent 反问或申请权限时用户不响应，任务会超时作废**（ADR-050 实测：question 阻塞在工具内部，session 全程 busy 且**零事件**，静默 195s）。

## 决策

三个通道（提示音 / 系统通知 / 图标提醒），三个独立开关（设置 → 偏好，默认全开，localStorage 持久化）。

### D1 · 门控口径比"窗口未聚焦"更宽

**未聚焦 OR 当前看的不是那个会话** 才提醒。

- 提示音也门控（业界参考实现不门控）：用户盯着屏幕看输出、完事还叮一声 = 噪音 ⇒ 用户会把整个功能关掉 ⇒ 连真该提醒的那次也丢了。
- 但只看焦点不够：在会话 A 干活、后台会话 B 跑完了，**即使窗口聚焦也必须告知**——纯焦点门控做不到这件事。

焦点用 Tauri `isFocused()`，**决策当场重查、不信 `onFocusChanged` 的 payload**（探针实测两者会不一致，discussions/036 §4 V3）。**不用 `document.visibilityState`**（同一状态下 visible/hidden 反复横跳）。

### D2 · in-flight 白名单：只提醒"本 app 内发起过 prompt"的会话

一条规则同时挡掉三类噪音（`notify-registry.ts`）：

| 类别 | 若不挡会怎样 |
|---|---|
| **IM 渠道会话** | 同事给 bot 发条微信 → 你电脑叮一声 + Dock 弹跳 |
| **委派子会话** | 子 agent 完成也发 `session.status`，而渲染层**无从判断陌生 id 是不是子会话**（事件里只有 sessionID，子会话从没 fetch 过） |
| **后端自发的任何会话** | 同上 |

三者都不会被登记 ⇒ 天然静默，**不需要额外判据**。刻意不持久化：重启后补弹一串陈旧通知比丢一次通知更糟。

**登记点必须覆盖所有发起路径**——首版只在输入框的 `sendMessage` 里登记，而 **Home 页新会话首轮（最常用路径：问一句然后走开）直接调 `connector.prompt`** ⇒ 最该提醒的场景永远静默。现由 `src/__tests__/lib/notify-prompt-sites.test.ts` 做**源码扫描守卫**（凡调 `.prompt(` 的文件必须也调 `markLocallyPrompted`），防止新增调用点时复发。

### D3 · "需要交互"必须订阅事件，且必须 per-session

不能从 idle 推断（question 期间 session 全程 busy 且零事件）。

**ACP 后端的 `permission.asked` / `question.asked` 只在 per-session 流上**（`acp-manager` 的 `globalSubscribers` 只喂 `emitStatus()`）⇒ 只挂全局流会对整个 ACP 家族（Claude/Gemini）失聪。故：**为每个 in-flight 会话挂一个 `AttentionWatcher`**（`useSessionSubscribe` 自动路由到该后端的流），opencode 与 ACP 一并覆盖。

### D4 · 通知风暴节流（per-session，三路重置）

`permission: ask` 时 agent 每跑一个 bash 问一次 ⇒ 离开十分钟回来收十几条通知。每个 session 在"已提醒且未处理"期间只提醒一次。

**重置时机三条，缺一不可**：
1. 窗口重新聚焦；
2. **用户回答了**（`permission.replied` / `question.replied` / `question.rejected`）——只靠 ①，"在会话 A 里顺手处理了 B 的提问"之后 B 的标记不会清（窗口从未失焦），**下次真离开时 B 反而静默**；
3. 回合结束（idle）。

节流判定与置位之间**不得有 await**（否则并发的两条 attention 会一起穿过）。

### D5 · `session.error` 不是终态，不能当场报"失败"

opencode 在**上下文溢出触发自动压缩**时也发 `session.error`（`processor.ts` 早退、**不发 idle**，回合继续跑），读附件失败也发。当场报"失败"= 误报 + **把白名单条目消费掉** ⇒ 真正完成时反而不提醒。

改为：**记住错误 → 若该会话又有输出则清除（回合还活着）→ 只有带着错误走到 idle 才报"失败"**，否则报"完成"。

### D6 · 提示音在内存里合成，不引入音频资源

`AudioContext` + 两声和弦（A5→E6，带包络）。**零资源文件、零版权风险、零打包体积**。探针实证：WKWebView 下无用户手势 `resume()` 即成功，窗口最小化时音频时钟照常推进（discussions/036 §4 V2）。Windows(WebView2/Chromium) 需要 sticky user activation——由 D2 天然保证（只有用户亲手发过 prompt 的会话才可能响）。

### D7 · 刻意不做

- **点击通知跳转到会话**：v2 桌面端点击回调支持不确定，收益只是省一次点击（Dock 唤起 + 侧边栏未读点已在）。通知正文带会话标题。
- Dock 角标 / Windows overlay icon（两套 API，`set_badge_count` 在 Windows 不支持）。
- 免打扰时段（系统级勿扰已能挡）。

## 跨平台

| 通道 | macOS | Windows | Linux |
|---|---|---|---|
| 提示音 | ✅ 实测 | ✅（WebView2 有 sticky activation，见 D6） | ⚠️ 依赖 WebKitGTK 的 GStreamer 插件（见下方遗留） |
| 系统通知 | ✅ 实测（**必须打包 .app**，dev 下 API 全绿但横幅不弹） | ✅ 安装版（NSIS/MSI 都写了 AppUserModelID 快捷方式）；**便携版无 toast**；dev 下会显示为 "PowerShell" 品牌 | ✅（notify-rust → zbus，无需 libnotify；但需要 session bus 上有通知守护进程） |
| 图标提醒 | ✅ Dock 弹跳（实测） | ✅ 闪任务栏 | ⚠️ X11 有效；**Wayland 上是空实现**（GTK3 的 `set_urgency_hint` 在 Wayland 后端是空函数）⇒ 默认 GNOME/Ubuntu 下静默无效，如实降级不假装 |

窗口聚焦时 `requestUserAttention` 本身就是 no-op（三平台一致）；重新聚焦时调 `requestUserAttention(null)` 撤回请求——**在 mac 上确实无效，但 Windows 映射到 FLASHW_STOP、X11 清 urgency 标志**（否则该标志会永久置位）。

## 验证

- **单测 532**（判定层 16 条 + 源码扫描守卫 2 条），每条护栏配 **A/B 反证**（撤掉必红）。
- **真浏览器 e2e**（`e2e/notifications.e2e.ts`，Chrome + WebKit 各 **5/5**）：真 opencode + 真模型 + 真 UI 操作；注入假 Tauri 桥使三个副作用（响铃/横幅/弹跳）**全部可观测**。覆盖：Home 首轮+离开→三通道全响 · 聚焦且在看该会话→完全静默 · 聚焦但已离开该会话→仍提醒 · 外部（渠道）会话→静默。**e2e 本身做了 A/B 反证**（撤掉 Home 登记→A 红；撤掉聚焦护栏→B 红）。
- **真机打包 .app（用户手动验收）**：①旗舰场景（新会话+走开）· ②负向对照（盯着看→完全静默）· ③焦点在别处但不在该会话→仍提醒 · ④IM 渠道消息进来→桌面端一声不吭 · ⑥agent 反问→立刻提醒，**均通过**；声音 + Dock 弹跳人耳/人眼确认。**横幅一度不出现，排查结论=系统设置里没给 app 开通知**（不是缺陷）——而这恰好实证了本 ADR 遗留 §3：`isPermissionGranted()=true`、`sendNotification()` 正常返回、底层 `invoke` 也 resolve OK，**全链路零错误而横幅就是不弹** ⇒ 代码无法检测该状态，只能在设置页文案里引导用户去开（已加）。**未测**：⑤三开关独立生效 · ⑦权限风暴节流（需临时改 `permission: ask`）。

## 遗留

1. **Linux `.deb`/`.rpm` 未声明 webkit/GTK 依赖**（既存问题，非本特性引入）：`bundle.linux.*.depends` 只有 `curl`/`lsof`。Debian 的 `libwebkit2gtk-4.1-0` 硬依赖 GStreamer 插件集，我们没声明 ⇒ 提示音在 Linux 上"能不能出声"靠运气。修法是加一行依赖，但**包名跨发行版不同、需真 Linux 验证**，故未在本分支动。
2. **Windows 便携版（未安装）无 toast**（无 Start Menu 快捷方式承载 AppUserModelID）。
3. **通知投递失败在 JS 侧不可观测**（插件的 `show()` 直接 spawn 到 async runtime 并立刻返回 `Ok`）——`try/catch` 永远抓不到投递失败；`isPermissionGranted()` 在桌面端**硬编码返回 granted**，OS 层"通知已关闭"我们看不见。
4. **opencode 原生 `task` 子 agent 的权限请求无法提醒**（事件带的是子会话 id，不在白名单）——与权限 dock 的既有盲区同源。
5. **SSE 漏事件没有轮询兜底**：`use-session-permission` 有 3s 轮询兜底，通知层没有。
6. **真机自动化欠账**（与 ADR-047/048/051 同一条）：三个副作用只能人工验；本轮用 headless 假桥把"决策 + 副作用调用"做成了可自动化的，但"横幅真的画出来了吗"仍靠眼睛。
