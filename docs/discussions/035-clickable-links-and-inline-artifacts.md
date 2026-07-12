# 035 — 回复内链接可点 + 转录区内联产物（调研 + 方案）

> 2026-07-12 · 分支 `feat/clickable-links-and-artifact-cards` · P0 已落地（`4a271866`）· P1 已落地（`1c2c5413`）· **P2 已砍** · 待落 ADR-052

## 触发

真机反馈两条：

1. AI 回复里的链接（网站 URL）**点不开**。
2. Agent 产出的产物**只在右侧栏有体现**，期望主会话里也能看到缩略图，并且点击后的预览行为与右侧栏一致。

拆开是两件完全独立的事，根因、成本、风险都不同。P0（链接）已收；P1/P2（产物）是本文档的主体。

---

# 第一部分：链接点不开（P0，已落地）

## 根因

`components/chat/message-parts.tsx` 的 markdown `<a>` 渲染成裸锚点 + `target="_blank"`。Tauri WebView **既不开系统浏览器、也不开新窗口，请求被直接吞掉** ⇒ 点击毫无反应。

讽刺的是这条坑项目自己早就写死在 `docs/gotchas.md` §151 和 `docs/conventions.md` §外部链接（「必须用 `openUrl()`」），设置页 7 处外链也都照做了 —— **只有聊天正文违反了自己的约定**。remark-gfm 的 autolink 让裸 URL 走同一个渲染器，所以 markdown 链接和裸 URL 一起坏。

## 顺带挖出的两个更严重的既存 bug

| 位置 | 症状 | 严重度 |
|---|---|---|
| `components/session/artifact-preview.tsx`（md 产物预览） | 用的是 ReactMarkdown **默认 `<a>`**（无 components map、无 target）⇒ 点击**在 webview 内原地导航，整个 app 被网页顶掉且无返回键** | 比"点不开"严重得多 |
| `pages/Settings.tsx` 5 处（官网 / License / 技能源码 / 关于页快捷链接） | 同样是裸 `<a target="_blank">`，此前**也是点不开的** | 同 P0 |

## 方案（已实施）

- **`lib/external-url.ts`** —— `isOpenableUrl()` / `openExternal()`，协议白名单只放行 `http/https/mailto/tel`。

  **这是安全边界，不是洁癖。** `openUrl` 走系统 handler（`open`/ShellExecute/xdg-open），而转录区渲染的是**模型输出**，模型输出只是半可信的：它可以被 agent 抓取到的页面内容带偏，也可以（经 IM 渠道）被第三方发给 bot 的消息带偏。放行 `file:` 或自定义 scheme ⇒ 等于用系统权限唤起任意本地 app / 文件。

  **推论（重要）**：**不要**为了放行 IM deeplink 去给 ReactMarkdown 传一个宽松的自定义 `urlTransform` —— react-markdown v9 的 `defaultUrlTransform` 本来就帮我们挡掉了 `javascript:` / `data:` / `file:`，传了自定义的就把那一层拆了，只剩我们这一层。

- **`components/ui/markdown-link.tsx`** —— 全 app 唯一的 markdown `<a>` 渲染器（两处 ReactMarkdown 共用）。
  - 可点的 → `preventDefault()` + `openExternal()`；`href` 保留在元素上，右键复制链接仍可用；`title` 显示真实目标（**反钓鱼**：链接文字是模型选的，不必等于它指向哪）。
  - **相对链接（`./report.pdf`）/ 锚点（`#section`）→ 渲染成惰性文本**。模型很爱写这些，而它们对系统浏览器毫无意义。一个看着能点、点了没反应的链接，比从没承诺过能点的文本更糟。

- **Rust 侧 `navigation_guard` 插件（fail-closed）** —— 只有 app 自己的文档能导航，外链交给系统浏览器。

  理由：JS 侧走 `openExternal` 是个**约定**，而约定会烂。转录区渲染模型写的 markdown、产物预览渲染模型写的文件，**任何一处漏一个 `<a>` 就足以把 app 黑洞掉**。最后一道防线必须在 Rust。

## 验证

- 单测 desktop **479**（基线 458，+21）· Rust **125**（基线 122，+3）· typecheck 8/8。
- **A/B 反证**：把转录区的 `a` 改回旧的裸锚点 ⇒ `transcript-links.test.tsx` 确实红 2 条。
  该测试是**专门**为守护 `message-parts.tsx` 本身而写的 —— 只测共享组件的话，有人把 `message-parts` 改回去测试照样全绿，那就是个**会撒谎的测试**。
- **真跑了 app**：起 vite + `target/debug/ultrawork`，窗口正常起来、日志无 `blocked navigation` ⇒ 导航守卫没有误伤 app 自己的初始加载（判错的后果是白屏，这是本改动最危险的回归路径）。

## 已知欠账

- **prod origin 未运行时验证**：`tauri://localhost`（mac/Linux）/ `http://tauri.localhost`（Windows）只有 Rust 单测覆盖，**没在打包产物里跑过**。判错 = **prod 白屏**。
- **「点击真的开了浏览器」只能人工验**：`openUrl` 是 Tauri IPC，headless 浏览器里不存在；WKWebView 无调试端口（ADR-047/048 记的那笔自动化基建欠账）。
- `Settings.tsx` 的 `openUrl(status.action_url!)` **刻意未动** —— 那是我们自己后端返回的 OAuth/管理页 URL（非模型输出），且可能合法地是非 http deeplink，套白名单反而会打断一条已在工作的流程。

---

# 第二部分：转录区内联产物（P1/P2，待落 ADR-052）

## 业界调研：方向被背书，但**缩略图这件事几乎没人做**

### 主流做法

| 产品 | 内联卡片？ | 缩略图？ | 点击行为 |
|---|---|---|---|
| **Claude Artifacts** | ✅ 消息里一张卡片（名字 + 类型标签 "Interactive artifact"） | ❌ | 展开成分屏；全宽模式隐藏 chat |
| Claude 文件生成（xlsx/pptx/docx/pdf） | ✅ 对话内下载项 | ❌（推断：图标 + 文件名） | 下载 / 系统应用打开 |
| ChatGPT Canvas | 侧栏为主；一次性文件是消息内下载链接 | ❌ | 右侧 pane |
| Cursor / Windsurf | ✅ 内联 diff 卡片 + **chat 底部「本轮变更文件」汇总条** | 用 diff 片段代替 | 展开 diff / 跳编辑器 |
| GitHub Copilot Agent | ✅ chat 里 "Total changes" 列表 | 用 diff 片段代替 | 逐个 review |
| **Gemini Canvas（移动端）** | ✅ **多产物 → 多张内联卡片**（官方文档明确背书） | ❌ | 点卡片打开 |
| **Perplexity Labs** | ✅ **贴着这一轮 query 下方的 Assets tab** | ❌ | 查看 / 下载 |
| Devin | ❌ 全在右侧工作区 | ❌ | 右栏编辑器 |

**结论**：面向"混合交付物"（md/pdf/pptx/png）的产品 —— Claude、Gemini、Perplexity、Manus —— **全部**在对话流附近提供了产物入口。**只有 Devin 是"只在右栏"，而 Devin 的用户是工程师、产物是代码仓库。我们目前的形态在业界是少数派。**

**最接近的参照物 = Claude Artifacts**，而我们**已经有它的全部地基**：
- 它的「卡片 = handoff（交接把手），不是 workspace」= 我们要加的内联卡片；
- 它的「split pane / full-width 隐藏 chat」= 我们已有的 `previewMode: closed|half|full`（**几乎是同一个设计**）；
- 它的「侧边栏 Artifacts 专区」= 我们已有的右侧栏产物列表。

### ⚠️ 缩略图：业界空白，且**我们的旗舰格式恰恰是最难的**

- **查不到任何主流 AI chat 产品在对话流里出 PDF 首页缩略图。**
- **查不到任何一家给 Office 文档（pptx/docx/xlsx）出内容缩略图。**
- Claude 的内联卡片用的是**类型标签**，不是缩略图。
- 代码类产品（Cursor/Copilot）用 **diff 片段**代替缩略图。

**这直接挑战了用户诉求的表述**：用户要的是"缩略图"，但**业界证明真正解决"找不到"的是卡片本身（发现性 + 一键入口），不是缩略图**。缩略图是我们**可以**做（桌面 app 有本地渲染能力，这是 Web 产品做不到的空位），但：
- 它**没有业界参照**；
- **pptx（ppt-master 旗舰场景）技术上出不了图** —— 除非走 LibreOffice headless → PDF → 渲首页 PNG，而这在三平台上是**真成本**（macOS 有 QuickLook、Windows 有 Shell thumbnail API，跨平台一致性不可低估）。

⇒ **P1（卡片）交付绝大部分价值。P2（缩略图）后来被砍掉 —— 见下文「P2：砍掉」。**

### 噪音控制：一个带数字的硬指标

- **【实证，VS Code Copilot issue #261081】** "N files changed" 面板**超过 4–5 个文件**就会占满 chat 面板高度、把对话挤走。**这是整个调研里唯一一个带具体数字的证据，直接采信作折叠阈值。**
- **但别折叠过头**：Cursor 把 chat 内 diff 默认改成 compact 后被用户骂到官方承认「full should be default」。**我们现在"产物只在右侧栏"正是过度折叠的状态 —— 和 Cursor 踩的是同一个坑。**
- **别自动打开预览**：ChatGPT Canvas 自动弹出是它被骂最惨的点。ADR-048 定的「只出徽标、不自动展开、手动关过则不再自动」是对的，**继续沿用**。
- **「区分最终产物 vs 中间脚本」业界无人做**。做了是创新但无参照，且分类错了比不分类更烦人。

---

## 代码侧调研：三个会咬人的结构性问题（全部实证）

### ① 时间窗归属：窗口会重叠，且窗口数 ≠ turn 数（**致命**）

产物有两个来源：(A) 工具/part 派生（`extractArtifacts`，能直接拿到 `msg.info.id`）；(B) **fs 扫描派生**（Rust `scan_workspace_changes` → `{path, mtimeMs}`，再用 `sessionTurnWindows` + `filterScanByWindows` 按时间窗归到本 session）。

要做 per-turn 归属，就得靠 (B) 的时间窗。**但这套窗口是为"会话级过滤"设计的，扛不住 per-turn 的精度要求**：

- **窗口重叠是常态，不是边角**（实证）。窗口 end 取 `completed`、下一个窗 start 取下一条 user 消息的 `created`，而**用户边看流式边打字是常态** ⇒ 实测重叠 **30 秒**（`TURN_GRACE_MS = 5000` 只是零头）。
  > 仓库现有单测 `artifacts-panel.test.ts:112-117` 的期望值 `[[1000,7000],[5000,11000]]` —— **它自己断言的两个窗口就是重叠的**。会话级用 `windows.some(...)` 所以无害；per-turn 就是**归属歧义**。

- **窗口数 ≠ assistant turn 数**（实证，致命）。用户**连发两条消息**时，`groupIntoTurns`（`message-list.tsx:15-27`）只产生 **1 个** assistant turn，而 `sessionTurnWindows` 产生 **2 个**窗口 ⇒ **按索引配就全部错位**，且多出一个不对应任何 turn 的"**幽灵窗**"，它还会认领那 5s 内写的文件。

- **`allMessages` vs `displayMessages` 错配**（实证）。`useSessionArtifacts` 吃的是**全量** `allMessages`，而 `MessageList` 渲染的是**窗口化后的最近 15 个 turn**（`TURN_INIT = 15`）⇒ **卡片必须按 message id 对齐，绝不能按索引。**

- **末窗提前关闭的丢失面**（推断，未真机验）。若 `time.completed` 的 SSE 比 `busy` 翻假晚到，`done` 回退成 `created` ⇒ 一个耗时 60s 的 step，其末尾写出的文件会掉出窗口。后续消息到达会重扫自愈，但**最后一个 turn 之后没有新消息，不会自愈**。

**⇒ 结论：不能复用 `filterScanByWindows`。** per-turn 需要一个新函数：
- 返回 `{path, turnId}` 而非 `string[]`（现有实现 `.map(h => h.path)` 把 `mtimeMs` 和"命中哪个窗"一起扔了）；
- 重叠时取**最后一个**匹配窗（`findLast` 而非 `some`）—— 语义是"归给最近的 turn"；
- **窗口必须携带 `anchorMessageId`**（该窗内第一条 assistant 消息的 id），无 assistant 消息的幽灵窗标 `null` 直接丢弃 ⇒ 错位从结构上消失。

### ② last-wins 归属：**不要改 `extractArtifacts`**（原方案被推翻）

先前拍板"产物归到最后一次写它的 turn（last-wins）"。**语义方向正确，但实现方式必须换。**

- **好消息：未读徽标零风险**（实证）。`use-artifact-unread.ts` 的 seen 是 `Set<path>`、unread 是集合查表 ⇒ **结构上对顺序免疫**。实测纯重排后 `unread = 0`。ADR-048 那两个徽标坑（新会话首轮恒 0 / 老会话幻觉徽标）的根因是 `settled` 时序和 `hasHistory` 门控，**不在顺序这条链上**。

- **坏消息：直接改 `extractArtifacts` 会引入两个静默回归**（实证）。被保留的那条 entry 的元数据会翻成"最后一次出现"的值：
  - **`mime` 丢失** —— 文件先由 `file` part 带 `mime` 出现，后被 `write` 工具重写（无 mime）⇒ `mime` 变 `undefined`，`FileIcon` 和预览的类型判断失去提示。
  - **`patch` 类型翻成 `file`** ⇒ `isWorkingFile` 的 "Patches stay deliverables" 失效 ⇒ 一个本来带 diff 标的交付物**掉进默认收起的工作文件组，从列表里"消失"**。

- **而当前 479 个测试一条都拦不住这两个回归**（实证：用 shim 把 `extractArtifacts` 换成 last-wins 跑全量套件，63 files / 479 tests **全绿**，canary 双跑证明 shim 确实生效）。套件里**没有任何一条断言守护 extract 的顺序、`mime` 保留、或 `type` 归属**。

- **副产物：侧栏用 first-wins 本来就更好**。last-wins = 按"最近更新"排 ⇒ 用户反复迭代的**主交付物会一直往下沉**，而一次性写完就没再动的边角文件浮在顶上。first-wins（首次产出序 ≈ 叙事顺序）对侧栏是更合理的排序。

**⇒ 正确解法：两套视图共用一份数据，只有归属表用 last-wins。**
- `ordered` / `deliverables` / `working` / `nav.index` / 徽标 —— **全部保持今天的 first-wins，`extractArtifacts` 一个字都不改**（零 diff、零回归面、零 e2e 重跑）。
- turn 归属**另建一张派生表**：按 user message 把 transcript 切成 turn，**逐 turn 调用现有的 `extractArtifacts`**（复用全部正则/校验/相对路径逻辑，不复制一行代码），后面的 turn 覆盖前面的 → `Map<turnId, Artifact[]>`。
- 卡片点击时**回 `ordered` 里按 path 查同一个 `Artifact` 对象** ⇒ mime/type 用的还是 first-wins 那份 richer 元数据 ⇒ **上面两个回归从结构上不存在**。

> 这正是 ADR-048 D5 那个架构该有的用法：把数据提到 Session 层做 SSOT，然后在 SSOT 上**挂派生表**，而不是去改 SSOT 的排序语义。

### ③ 转录区会重复展示（实证，但面很窄）

`ExecutionFlow` 已经在 turn 的"执行过程"折叠块里渲染文件行 —— 但**只有 `file` / `patch` 两种 part 会渲染 `ArtifactRow`**；`tool` case 走 `ToolRow`，**不产生文件行**（工具的 filePath 只出现在展开两层后的 Input JSON 里，output 还被截断到 500 字符）。

| 产物来源 | 转录区是否已可见 | 重叠 |
|---|---|---|
| `FilePart` | ✅ | **100% 重复** |
| `PatchPart` | ✅（聚合成一行） | 重复，但粒度不同 |
| 工具 input 路径（write/edit/screenshot…） | ❌ | 不重复 |
| delegate JSON `artifacts` | ❌ | 不重复 |
| 工具 output 正则 / attachments | ❌ | 不重复 |
| **fs 扫描** | ❌ **转录区完全不存在** | 不重复 |

⇒ **重复只发生在 file/patch part 上，而它们在真实 opencode 会话里是少数**（ADR-048 记的"fs 扫描是产物没丢的主因"正说明这点）。

**建议：改 `ExecutionFlow`，而不是给底部卡片打补丁。** 把 `execution-flow.tsx` 的 `case "file"` / `case "patch"` 的 `ArtifactRow` 拿掉（或降级成不可点纯文本）—— 它是"执行过程"时间线，文件产出不属于过程；而且它只覆盖产物集里最小的一个子集，留着 = **一个残缺的产物列表和底部完整的那排并排**。答案区的 `FileBlock`/`PatchBlock` **保留**（那是模型显式当正文一部分产出的附件，语义不同）。

### ④ `classifyArtifacts` 在 per-turn 下语义漂移（实证）

`classifyArtifacts` 的"无 deliverable 就把 working 提升为 deliverable"是对**传入的整个集合**判断的，不是文件属性：

```
classifyArtifacts([gen.py])             → deliverables=[gen.py], working=[]
classifyArtifacts([gen.py, report.pdf]) → deliverables=[report.pdf], working=[gen.py]
```

⇒ per-turn 下**同一个 `gen.py` 会在 turn1 显示为 deliverable、在 turn3（产出 pdf 的那轮）显示为 working file**。

**这和业界调研独立撞上同一个结论**（"区分最终产物 vs 中间脚本"业界无人做，分类错了比不分类更烦人）。

**⇒ per-turn 卡片区不用 `classifyArtifacts`**：只用 `isWorkingFile` 做**排序权重**（deliverable 排前），不做"提升"、不分组。`classifyArtifacts` 留给会话级右侧栏。

---

## P2（缩略图）：**砍掉**

**拍板：不做缩略图。** 用户最初的诉求表述是"产物缩略图"，但调研的结论是**卡片本身（图标 + 文件名 + 类型标签）就是业界主流形态，而缩略图几乎无人做**：

- Claude Artifacts 的内联卡片用的是**类型标签**（"Interactive artifact"），不是缩略图；
- 查不到任何主流 AI chat 产品在对话流里出 **PDF 首页缩略图**；
- **Office 文档（pptx/docx/xlsx）无一家做** —— 而 pptx 恰是 ppt-master 的旗舰场景，技术上还偏偏是唯一出不了图的（只能走 LibreOffice headless → PDF → 渲首页 PNG，三平台一致性是真成本）。

P1 落地的卡片形态**已经就是**业界标准形态。真正解决"找不到"的是**卡片本身**（发现性 + 一键入口），不是缩略图。继续做 P2 = 承担 pdf.js 批量渲染、LRU 缓存失效、objectURL 生命周期、三平台 Office 渲染这一整套成本，换一个业界证明没人需要的东西。

### ⚠️ 唯一的例外，留作**待观察项**：图片

调研里有一条容易被读漏：**所有产品对图片都是直接渲染图片内容**，不是缩略图、也不是卡片。Claude / ChatGPT 生成一张图表，是把**图**摆进回复里。

也就是说，我们现在对图片的处理（一张写着 `chart.png · PNG` 的卡片）**低于**业界标准而非符合 —— agent 的截图/图表文件名往往是 `screenshot-2026-07-12.png` 这类零信息量的东西，卡片上的文件名等于什么都没说。

| 格式 | 业界做法 | P1 现状 | 结论 |
|---|---|---|---|
| pdf / pptx / docx / html / md / 代码 | 图标 + 文件名 + 类型标签 | ✅ 一致 | **不做** |
| **图片** | **直接渲染图片内容** | ❌ 只有图标 | **待观察** |

**若真机反馈显示图片产物常见**，再做一个窄得多的东西：**图片卡片内嵌一个固定尺寸的小图**（如 40×40）。这样保持卡片的"交接把手"隐喻、不破坏统一形态，且：

- **固定尺寸是硬约束**。`use-stick-to-bottom` 靠 ResizeObserver 观察内容层；图片**异步加载**会改变历史 turn 的高度，而 **WebKit 没有 scroll anchoring**（ADR-047 已记，Tauri 用的正是 WKWebView）⇒ **用户正在读旧回复时，上方某张图加载完会把视口顶走**。固定槽位 ⇒ 加载前后布局高度不变 ⇒ 问题从结构上消失。
- **不缓存 objectURL，缓存降采样后的小 dataURL**：`read_file_bytes` → Blob → 画到小画布 → `toDataURL('image/jpeg')` → **objectURL 当场 revoke**。整类泄漏问题消失，内存有上限（小 jpeg ≈ 10–20KB，不管源文件多大）。缓存键用 `path + mtimeMs`（文件被重写后必须换图，否则显示旧版 = 又一个撒谎的 UI）。
- **`mtimeMs` 已经从 Rust 传上来了**（`ScanHit.mtimeMs`），只是被 `filterScanByWindows` 的 `.map(h => h.path)` 扔掉 —— turn 归属和缓存失效都要它。
- **只对图片走这条路。** pdf.js 批量渲染（单一共享 worker，会串行排队）、LibreOffice、Office 缩略图**全都不碰** —— 那才是原 P2 里 80% 的成本和坑。
- **HTML 永不出视觉缩略图**：iframe 缩放会执行脚本、加载远程资源，而 `csp: null` ⇒ 白送的攻击面。

> 取字节一律走 **`read_file_bytes`**（scope-free）。`gotchas.md` §157 已定：**不能用 assetProtocol**，因为 workspace 可能在 `$HOME` 之外，而 scope 是静态配置、动态化不了。asset protocol 不需要启用。

---

## 方案（待落 ADR-052）

### P1 — 转录区产物卡片（已落地，commit `1c2c5413`）

1. **数据**：`Artifact` 增 `mtimeMs?`（从 `ScanHit` 保留）。`extractArtifacts` **不改**。
2. **归属**：新建 `useTurnArtifacts` 派生表 —— 按 user message 切 turn，逐 turn 调 `extractArtifacts`，last-wins 覆盖；fs 扫描项按新的 `{path, turnId}` 函数归属（窗口携带 `anchorMessageId`、丢弃幽灵窗、重叠取 `findLast`）。**按 message id 对齐，不按索引。**
3. **UI**：`AssistantTurn` 底部（答案区之后、footer 之前）一排卡片 = 图标 + 文件名 + 类型标签。点击 → 复用已有的 `onArtifactClick`（管线**已经从 `Session.tsx` 一路铺到 `message-parts.tsx`**）⇒ 与右侧栏**同一个入口**，行为一致是免费的。
4. **噪音**：**默认展开 ≤ 4 个**（依据 vscode#261081 实测阈值），超出折叠成「还有 N 个」。**不用 `classifyArtifacts` 分组**，只用 `isWorkingFile` 排序。
5. **不自动打开预览**（只出卡片）。
6. **turn 未完成时不显示卡片**（fs 扫描只在 idle 跑，产物本就晚到；流式期间显示会导致 turn 完成后重新归属、卡片跳位）。
7. 去掉 `ExecutionFlow` 里的 `file`/`patch` ArtifactRow（见 ③）。
8. i18n 文案。

### ~~P2 — 缩略图~~（已砍，见上）

卡片形态即业界标准形态，缩略图无人做。**唯一待观察项 = 图片卡片内嵌小图**，等真机反馈判断图片产物是否常见再定。

### 后续可选（都不在当前范围）

- **相对链接接产物预览**：模型爱写 `[报告](./report.pdf)`，现在渲染成惰性文本。接进 `onArtifactClick` 是个诱人的协同点，但需防路径穿越（限制在 workspace 内）。
- **pptx 封面图**：需 ppt-master 技能导出封面 png + 重打 zip（走 ADR-041 的 pack 流程）。产品侧解法，成本比看上去大。
- **ExecutionFlow 里的 `file`/`patch` ArtifactRow**：P1 选择了在卡片侧对答案区 `FileBlock` 去重，而没有动 ExecutionFlow —— 它在默认收起的"执行过程"块里，语义是"过程中出现的 part"，与底部"这一轮产出了什么"不同。若真机觉得重复，再考虑摘掉。

## 守护（P1 已补齐）

desktop **502**（基线 479，+23）· typecheck 8/8 · 真 app 启动无 panic。

1. turn 归属的 last-wins（文件被重写后归属确实改变）。
2. **侧栏顺序不因本特性而改变**的回归断言（`extractArtifacts` 输出逐字不变）。
3. 窗口重叠 / 幽灵窗 / 连发两条消息 时归属不错位。
4. 卡片按 message id 对齐（转录区只渲染最近 15 个 turn、归属按全量消息算，两者不错开）。
5. 折叠阈值 · 流式期间不显示 · 答案区 FileBlock 去重。
6. **接线的集成测试**（`useSessionArtifacts → MessageList → AssistantTurn`，mock fs 扫描）——
   单测直接调 `attributeArtifactsToTurns`，绕过 hook 和 prop，接错了也会全绿。

**七条 A/B 反证**逐条撤掉护栏确认会红。其中第一版「幽灵窗」用例**是假的**：撤掉守卫仍全绿
——构造的时间区间是包含关系，反向扫描无论如何先命中真 turn，**压根走不到守卫**。守卫真正
保护的是「文件落在幽灵窗和一个**更早**的真 turn 里、但不在更晚的 turn 里」，此时没有守卫
会先命中幽灵窗、然后在 `anchorId` 检查处**把文件整个丢掉**（侧栏有、转录区没有）。已重写。

**真机待验**（headless 够不着）：真实 fs 扫描经 Tauri `invoke`，所以「bash 副作用写出的产物
出现在正确的 turn 下」只能人工验 —— 与 ADR-047/048 同一笔自动化基建欠账。
