# ADR-052 — 回复内链接可点 + 转录区按轮次的产物卡片

- 状态：已实现（2026-07-12，分支 `feat/clickable-links-and-artifact-cards`）
- 关联：discussions/035 · ADR-033（产物识别）· ADR-037（跨平台）· ADR-047（贴底滚动）· ADR-048（预览/侧栏互斥 + 分级通知）
- 触发：真机反馈——① AI 回复里的链接点不开；② 产物只在右侧栏有体现，希望主会话里也能看到、点开

---

## 背景

两件事根因、成本、风险完全不同，拆开处理。

### 链接点不开

markdown 的 `<a>` 渲染成裸锚点 + `target="_blank"`。Tauri WebView **既不开系统浏览器、也不开新窗口，请求被直接吞掉** ⇒ 点击零反应。

讽刺的是这条坑项目自己早就写进 `gotchas.md` §6 和 `conventions.md`（「必须用 `openUrl()`」），设置页 7 处外链也都照做了——**只有聊天正文违反了自己的约定**。remark-gfm 的 autolink 让裸 URL 走同一个渲染器，所以两者一起坏。

顺带挖出两个更严重的既存 bug：
- **md 产物预览**用的是 ReactMarkdown **默认 `<a>`**（无 components map、无 target）⇒ 点击**在 webview 内原地导航，整个 app 被网页顶掉且无返回键**。
- **设置页/关于页 5 处**裸 `<a target="_blank">`（官网 / License / 技能源码），此前**也是点不开的**。

### 产物发现性

业界调研（Claude Artifacts / Gemini Canvas / Perplexity Labs / Cursor / Copilot / Devin / Manus）结论：面向混合交付物的产品**全部**在对话流附近提供产物入口，**只有 Devin 是「只在右栏」**——而 Devin 用户是工程师、产物是代码仓库。**我们此前的形态在业界是少数派。**

最接近的参照物 = **Claude Artifacts**，而我们**已经有它的全部地基**：卡片→半屏/全屏预览状态机（ADR-048 的 `previewMode`）、侧栏产物专区、`onArtifactClick` 管线已一路铺到 `message-parts`。缺的只是**「这个产物是哪一轮产出的」**这条信息。

---

## 决策

### D1 — 链接一律走 `openExternal`，协议白名单是安全边界

`lib/external-url.ts` 的 `isOpenableUrl()` / `openExternal()`，只放行 `http/https/mailto/tel`。

**这不是洁癖。** `openUrl` 走系统 handler（`open`/ShellExecute/xdg-open），而转录区渲染的是**模型输出**——它可以被 agent 抓取到的页面内容带偏，也可以（经 IM 渠道）被第三方发给 bot 的消息带偏。放行 `file:` 或自定义 scheme = **用系统权限唤起任意本地 app / 文件**。

**推论**：**不要**为了放行 IM deeplink 给 ReactMarkdown 传宽松的自定义 `urlTransform`——react-markdown v9 的 `defaultUrlTransform` 本来就挡掉了 `javascript:`/`data:`/`file:`，传了自定义的就把那一层拆了。

`components/ui/markdown-link.tsx` 是全 app 唯一的 markdown `<a>` 渲染器（两处 ReactMarkdown 共用）。相对链接 / 锚点渲染成**惰性文本**——模型很爱写它们，而一个看着能点、点了没反应的链接，比从没承诺过能点的文本更糟。`title` 显示真实目标（**反钓鱼**：链接文字是模型选的，不必等于它指向哪）。

### D2 — Rust 侧 `navigation_guard` 兜底（fail-closed）

只有 app 自己的文档能导航，外链交给系统浏览器。

理由：JS 侧走 `openExternal` 是个**约定**，而约定会烂。转录区渲染模型写的 markdown、产物预览渲染模型写的文件，**漏一个裸 `<a>` 就足以把 app 黑洞掉**。最后一道防线必须在 Rust。

**⚠️ 已知边界（实测）**：它**管不到 `target="_blank"` / `window.open`**。Tauri 只给 wry 的 *navigation* handler 开了插件钩子；new-window 请求走另一条路（Windows `NewWindowRequested` / Linux `NEW_WINDOW_ACTION`），wry 在没有 per-webview handler 时**静默丢弃**——守卫根本看不到。所以它兜的是**危险的那种**（原地导航），不是**无害的那种**（`_blank` 被吞）。**JS 侧仍然绝不能发 `target="_blank"`。**

### D3 — 产物归属：派生表做 last-wins，**SSOT 一个字不改**

一个文件被多轮反复改写时，归属到**最后一次写它的那一轮**（预览打开的永远是磁盘上的当前内容；卡片挂在产出第 1 版的那轮就是撒谎）。

**但绝不能把 `extractArtifacts` 改成 last-wins。** 它有三个消费者（侧栏行序、预览 prev/next 计数器、deliverable/working 划分），**没有一个想要 last-wins**，而改了会引入两个**静默回归**：被保留的 entry 的元数据翻成「最后一次出现」的值 ⇒ **`mime` 丢失**（`file` part 带 mime，后来重写它的 `write` 工具不带）、**`patch` 类型翻成 `file`**（把带 diff 标的交付物打进默认收起的工作文件组 ⇒ 从列表里「消失」）。

**而当时 479 个测试一条都拦不住这两个回归**（用 shim 把 `extractArtifacts` 换成 last-wins 跑全量套件：63 files / 479 tests 全绿，canary 双跑证明 shim 确实生效）。

⇒ `lib/turn-artifacts.ts` 是一张**派生表**：逐 turn 复用现有的 `extractArtifacts`，后面的 turn 覆盖前面的；卡片拿的仍是 `ordered` 里那份 rich 的 `Artifact` 对象。ADR-048 D5 把数据提到 Session 层做 SSOT，这正是该架构该有的用法——**在 SSOT 上挂派生表，而不是去改 SSOT 的排序语义**。

**副产物**：侧栏用 first-wins（首次产出序 ≈ 叙事顺序）**本来就更合理**——last-wins 会让反复迭代的主交付物一直往下沉。

### D4 — 时间窗必须重做，不能复用 `filterScanByWindows`

fs 扫描产物要靠时间窗归属，但那套窗口是为**会话级过滤**设计的，扛不住 per-turn 精度：

- **窗口重叠是常态，不是边角**（实证）。窗口 end 取最后一条消息的 `completed`、下一个窗 start 取下一条 user 消息的 `created`，而**边看流式边打下一条是正常用法** ⇒ 实测重叠到**数十秒**，`TURN_GRACE_MS = 5000` 只是零头。会话级只问「落进任何一个窗吗」所以无所谓；per-turn 必须选一个 ⇒ **取最后一个匹配窗**（最近的那一轮）。
- **窗口数 ≠ turn 数**（实证，致命）。`sessionTurnWindows` 按 user 消息切窗，`groupIntoTurns` 按连续 assistant 消息切 turn ⇒ **用户连发两条消息**时两者发散，任何按索引的配对**从此全部错位**，而那个多出来的**幽灵窗**还会认领期间写的文件。
  ⇒ 窗口携带 **`anchorId`**（= turn 的第一条 assistant 消息 id = `groupIntoTurns` 的 `turnKey`），幽灵窗标 `null`。**卡片按 message id 对齐、绝不按索引**——转录区只渲染最近 15 个 turn，而归属是按全量消息算的，按索引必错。
- **分组只看 role，从不看时钟**。`groupIntoTurns` 不看时间戳；若 `buildTurnWindows` 跳过 `time.created` 缺失的消息，anchor 就可能变成第二条 assistant 消息的 id ⇒ 查表 miss ⇒ **那一轮的卡片整条消失**。时间戳只用来撑宽窗口，从不决定归属。
- **幽灵窗覆盖的文件不能丢**。会话级过滤器**算**幽灵窗（它只问「任何一个窗」），所以这类文件在侧栏看得见——per-turn 若直接丢弃，就是**同一份数据两个视图无声不一致**。回落到「文件出现时最近的那个真 turn」。

### D5 — per-turn 不做 deliverable/working 分级

`classifyArtifacts` 的「没有 deliverable 就把 working 提升」是**集合的属性、不是文件的属性** ⇒ per-turn 下同一个 `gen.py` 会在只写脚本的那轮算交付物、在同时产出 pdf 的那轮算工作文件。**业界也无人做产物分级**（分错了比不分更烦人）——两条独立结论撞在一起。只用它**排序**，不重新分类。

### D6 — 噪音控制：折叠阈值 4，但只折一层

**超过 4–5 个产物就会刷爆对话**（microsoft/vscode#261081 实测，是整个调研里唯一带具体数字的证据）。

**但别折叠过头**：Cursor 把 chat 内 diff 默认改成 compact 后被用户骂到官方承认「full should be default」。**我们此前「产物只在右侧栏」正是过度折叠的状态**——和 Cursor 踩的同一个坑。

另：**流式期间不显示卡片**（fs 扫描只在 idle 跑，此时列表既不全、又因窗口敞开而仍在移动，卡片会先出现再跳到别的 turn）；**不自动打开预览**（ChatGPT Canvas 自动弹出是它被骂最惨的点，ADR-048 的分级通知策略继续沿用）。

### D7 — 缩略图：**砍掉**

用户最初的诉求是「产物缩略图」，但调研结论是**卡片形态（图标 + 文件名 + 类型标签）就是业界主流形态，缩略图几乎无人做**：Claude Artifacts 用类型标签；查不到任何主流 AI chat 出 PDF 首页缩略图；**Office（pptx/docx/xlsx）无一家做**——而 pptx 恰是 ppt-master 的旗舰场景、技术上还偏偏是唯一出不了图的。

**真正解决「找不到」的是卡片本身**（发现性 + 一键入口）。继续做缩略图 = 承担 pdf.js 批量渲染、LRU 缓存失效、objectURL 生命周期、三平台 Office 渲染这一整套成本，换一个业界证明没人需要的东西。

**唯一待观察项：图片。** 业界对图片是**直接渲染内容**，不是缩略图也不是卡片 ⇒ 我们现在给图片一张写着 `chart.png` 的卡片，其实**低于**业界标准（agent 的截图文件名往往零信息量）。若真机反馈显示图片产物常见，再做一个窄得多的东西：**图片卡片内嵌固定尺寸小图**。固定尺寸是硬约束（异步加载改历史 turn 高度，而 **WebKit 无 scroll anchoring**，会把用户正在读的视口顶走）；缓存降采样 dataURL 而非 objectURL；**只对图片走这条路**。

---

## 性能

`byTurn` 的 memo **不能依赖每 token 变化的 `messages`**。实测：归属表的成本约等于**整个既有产物管线**（per-delta +105%；120 turn 时约 14ms 同步 JS/delta，直接掉帧），而这些计算**全是废的**——流式期间卡片压根不显示，且已完成 turn 的产物不会因为后面还在跑而改变。

⇒ `active` 时复用上次的表。**缓存按 sessionID 分键**——否则中途切会话会把上一个 session 的卡片挂到另一个 session 的 turn 下。

---

## 跨平台

- `is_app_navigation` 三平台已实证：**Linux（webkit2gtk）与 macOS 相同**走 `tauri://localhost`，Windows 走 `http(s)://tauri.localhost`，**没有第四种情况**。
- **prod 不会白屏**：用 `tauri build` 实际传的 `--features tauri/custom-protocol` 跑，`is_dev()` 确为 false、prod origin 全部放行、`localhost` 被拦。
- `opener:default` 权限确实含 `allow-open-url`，其 scope（`http/https/mailto/tel`）**与我们的白名单逐字一致**，三平台同一份 TOML。
- **顺带修一个 Windows 上会丢产物的既存 bug**：`isValidArtifactPath` 用裸 `startsWith` 比路径。Windows 上 root 从 Rust 来是 `C:\ws\proj`，而模型写 `write` 调用**惯用正斜杠** ⇒ 判定「不在工作区」⇒ **产物被整个丢弃，侧栏和转录区都没有，且无任何提示**。同一个 `startsWith` 还有兄弟目录碰撞（`/ws/proj` 吃掉 `/ws/proj-old`）。已改成分隔符无关 + 结尾分隔符校验。

---

## 验证

- 单测 desktop **514** · Rust **127** · typecheck **8/8**
- **真浏览器 e2e**（`e2e/transcript-artifacts.e2e.ts`，真 opencode + 真 write 工具 + mock LLM）：**Chrome 11/11 · WebKit 11/11**
- **真机**（真 Tauri 窗口 + 真 WKWebView + 真 Rust + 真 qwen，用 macOS 辅助功能驱动）：**5/5**
  - 真 Rust 文件扫描器发现 bash 副作用产物 → 卡片出现在正确轮次
  - last-wins：bash 重写同一文件后，卡片从第一轮搬到第二轮
  - 点卡片 → 半屏预览 + 右侧栏互斥
  - **点链接 → 前台 app 变成 Chrome、URL 正确**（真正的 OS 动作）
  - `navigation_guard` 全程零误拦
- **每条修复都做了 A/B 反证**（撤掉即变红）

**A/B 抓出三个自己写的假测试**（这是本轮最该记住的）：
1. 第一版「幽灵窗」用例——撤掉守卫仍全绿，因为构造的时间区间是包含关系、反向扫描**压根走不到守卫**。
2. Rust 的 prod 断言是**同义反复**（`assert_eq!(is_app_navigation(u), tauri::is_dev())` 两边同一个表达式，而 `cargo test` 下 `is_dev` 恒为 true）⇒ 把门控整个删掉照样绿，**唯一致命分支从没被测过**。
3. e2e 断言按「第 n 个卡片条」定位 turn——没有产物的 turn 不渲染卡片条 ⇒ 后面全部错位。**这和归属逻辑里刚修掉的「按索引配对」是同一类错误，讽刺地出现在测试里。**

---

## 后果

- 转录区多了一个渲染块，但成本被 memo + `!streaming` 门控住（流式期间零重算）。
- `extractArtifacts` 的输出顺序、侧栏、预览导航、未读徽标**全部零改动**。
- **`ExecutionFlow` 里的 `file`/`patch` ArtifactRow 保留未动**——它在默认收起的「执行过程」块里，语义是「过程中出现的 part」，与底部「这一轮产出了什么」不同。卡片侧只对**答案区**已渲染的 `FileBlock`/`PatchBlock` 去重。若真机觉得重复，再考虑摘掉。
