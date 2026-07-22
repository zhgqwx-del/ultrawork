# ADR-065: 聊天正文内联 markdown 图片渲染（本地图片经通道转 data URI + workspace 限定 + 兜底）

- 状态：Accepted（✅ 已实现 + 复审修 2 缺陷 + 单测 desktop 719 / rich-output 15；真机 UI 观感待用户，2026-07-22）
- 日期：2026-07-22
- 关联：discussions/049（完整根因链 + 真实 DB 证据 + 端点实测 + 伪代码）、ADR-035/discussions/035（回复内链接可点 + `MarkdownLink` 协议白名单，复用同一安全姿态）、ADR-062（应用内 HTML 产物预览，复用同一 `getFileContent→base64→data:URI` 通道 + `ArtifactPreview`）、ADR-064（rich-output 插件，引导句挂其上）

## 背景

让默认会话模型「画个章鱼/虎鲸」后，回复正文出现破损缩略图 `❓`。

**根因（真实数据 + 代码实测，闭合链条）**：模型（qwen 纯文本、不能出图）把 SVG/PNG 写进工作区文件，再在回复正文用 markdown 图片 `![alt](本地路径)` 引用（会话 DB 原文：`![章鱼](/Users/.../octopus.svg)`、`![帅气虎鲸](orca_preview.png)`）。而：

1. `message-parts.tsx` 的 `MARKDOWN_COMPONENTS` 无 `img` 覆盖 → react-markdown 直接吐 `<img src="本地路径">`；
2. WebView origin（Vite `localhost:1420` / `tauri://`）无法解析本地 FS 路径 → 404 → 破图 `❓`；
3. 全仓无 `convertFileSrc`、未配 `assetProtocol`。

关键约束（本轮实测）：app 已有的 `getFileContent` 通道（vendor `File.read`，`file/index.ts:513`）**只认 workspace 相对路径**——`path.join(Instance.directory, file)` 会把绝对路径拼坏，`containsPath` 拒绝逃逸目录；图片扩展名走 base64+mimeType 分支。活端点实测：相对 `octopus.svg`→`image/svg+xml` base64 ✅；绝对路径→空 ❌。

与产物无关：产物面板走另一条（相对路径 + 同一通道）本身没坏；本 bug 不碰产物扫描/归属（与 discussions/044 无关）。

## 决策

### D1 — 内联本地图片经 `getFileContent → data URI`（Option A），按 src 协议分派
新增 `MarkdownImage` 组件挂到 `MARKDOWN_COMPONENTS.img`，按 src 形态分派：
- `data:` / `http(s)://` → 原样透传 `<img src>`（远程图与 base64 直出，`csp:null` 不拦）；
- 本地路径 → 经 `getFileContent(相对路径)` 取回 base64 + mimeType，拼 `data:mime;base64,…` 渲染。

**否决 Option B（Tauri `assetProtocol` + `convertFileSrc`）**：只在原生窗口成立，Vite web / Playwright e2e 失效，还需放开 CSP `img-src`、配 scope、跨平台路径；移动件多、可测性差。复用 A 通道则 dev/prod/e2e/三平台一致，且与 ADR-062 HTML 预览、产物预览同一机制。

### D2 — 绝对路径先转相对 + workspace 限定（server 强制）
新增 `path-utils.toWorkspaceRelative(p, dir)`：相对路径规整（拒 `..` 逃逸）；绝对路径剥 `workspaceDir` 前缀转相对；workspace 外 → `null`。
- **绝对→相对是必需**（否则「章鱼」那条绝对路径修不好，`File.read` 的 `path.join` 会拼坏）。
- **workspace 限定不只是加固**，是 server `containsPath` 强制的——workspace 外图天然无法内联。

### D3 — 失败/越界兜底（Option C）+ 流式占位 + 缓存 + 点击放大
- workspace 外 / 加载失败 / 空内容 / 非图 mime → 渲染兜底 chip（可点击）而非破图 `❓`。
- 流式期半截 src 解析失败 → 显 alt 文本占位；`useEffect` 依赖 `key`，src 补全后自然重试（无定时器）。
- module 级 `Map` 缓存 data URI（key=`dir|rel`；PNG 有 ~645KB base64，避免每 token 重拉）。
- 点击内联图 → `onArtifactClick({type:'file', path: rel})` 触发**现有** `ArtifactPreview`，**零新 UI**。

### D3.5 — 自定义 `urlTransform`（复审发现的必需项）
react-markdown 的默认 `urlTransform`（`defaultUrlTransform`）会在 src 到达 `img` 组件**之前**把 `data:` URI 与 Windows 盘符路径（`C:\`，`c:` 被识别为 scheme）**清空为 `""`**——实测坐实。若不处理，「base64 直出」与「Windows 本地图」两类**根本不显示**（这是初版实现的真实缺陷，复审阶段抓出）。给聊天 `MarkdownContent` 传自定义 `urlTransform`：`data:image/` 与 `^[A-Za-z]:[\\/]` 原样保留，其余 `defaultUrlTransform`（`javascript:`/`data:text/html` 仍拦）。链接安全不减：`MarkdownLink` 经 `isOpenableUrl`（仅 http/https/mailto/tel）二次过滤，passthrough 的 `data:`/`C:\` href 仍渲染为惰性文本。同步修 `classify`：`C:\`/`C:/` 在通用 scheme 拦截前判为 local。

**已知边界（markdown 固有，非 renderer 可修）**：markdown 把 `\` 当转义符 → `![](C:\a\b.png)` 纯反斜杠路径在解析阶段即被破坏 → 优雅降级为兜底 chip。可存活形态=相对路径 + 正斜杠绝对（`C:/…`）；D5 的相对路径引导正是缓解。

### D4 — Context 透传 + 非聊天场景惰性 + 安全姿态
- `MarkdownContent` 加可选 `workspaceDir`/`onArtifactClick`，经 `MarkdownImageContext` 传给 `MarkdownImage`（保持 `MARKDOWN_COMPONENTS` 模块级常量、不破坏现有 memo）。`assistant-turn.tsx` / `assistant-message.tsx` 透传（`message-list` 已把二者传到 `AssistantTurn`）。
- `about-legal.tsx` 不传这俩 prop → 解析器惰性，法务文档不受影响。
- 协议白名单与 `MarkdownLink` 一致（拒 `javascript:` 等），`transcript-links.test.tsx` 守的安全门不回归。

### D5 — rich-output 插件引导（软手段，非主修）
在 ADR-064 的 output_format 段追加两句：① 引用工作区图片用相对路径 markdown 图片、勿用绝对路径；② 生成 SVG/图片后**直接引用该文件**，勿为展示而**整页截屏**（会把浏览器白边烤进图）——窄范围、不禁一般截图（渲染结果本身是重点时截图仍 OK）。②缘于真机复审：`orca_preview.png` 实测是模型整页截屏（PNG 2640×1326 vs orca.svg 1000×600，右/下边缘像素 = 纯白 255,255,255 烤进文件），非渲染 bug，故用引导减少此类。属 vendor patch 增量、走 `experimental.rich_output` 开关。仅作软手段（模型可能忽略、修不了历史），主修仍是 D1–D4 的渲染层。副作用评估：仅系统提示多几十 token；措辞已限定"展示自己生成的图片"场景，不误伤合法截图；对非 qwen 模型中性。

## 后果

- **正面**：回复内联图片正确显示（远程/base64 直出、本地转 data URI）；破图消失；点击可放大复用既有预览；三类图片全覆盖。
- **改动面**：中偏小、高度局部化于聊天 markdown 渲染层——1 个新组件 + Context 透传 + 2 处 props + 1 行插件引导 + 测试；无架构/Tauri 配置/server 路由/依赖变更。
- **风险**：低到中。主要=流式闪烁 & 大图性能（已由占位 + 缓存覆盖）；安全面不扩大（相对路径 + 协议白名单 + server `containsPath` 三重）；可回退。
- **跨平台**：renderer 用 `@/lib/path-utils`（WebView 无 `node:path`），`toWorkspaceRelative`/`classify` 双分隔符兼容；无硬编码路径（`workspaceDir` 运行时来自 `session.directory`/`teamEntry.workspace`）；三平台同构。**限制**：Windows 纯反斜杠 markdown 图片路径受 markdown 转义破坏（见 D3.5），mac/Linux 无此问题，Windows 相对/正斜杠正常。
- **单/Team 覆盖**：单 agent + Team 主会话（Leader）经 `Session.tsx` 统一透传 `workspaceDir`，均支持；DelegateDock 子会话 / OrchestrationRun 视图暂未透传（内联本地图落兜底 chip，图仍在父会话显示），后续增强。
- **非目标**：workspace 外图刻意不内联（安全优先，只给 chip）；大图不压缩/缩略（P2）；不改产物逻辑；delegate/orchestration 子视图内联解析（后续）。
- **验证**：desktop 719（+25：markdown-image 11 + wiring 7 + toWorkspaceRelative 7）+ rich-output 15 + react-markdown `urlTransform` 实测 + **真 Playwright 双引擎 e2e**（`e2e/inline-image-render.e2e.ts`：mock-llm → 真 opencode 服务真 SVG → Vite → Chromium+WebKit → 真 MarkdownImage，各 6/6 PASS，含负向对照）。真机 UI 观感待用户。

## 后续（可选）
- 大图降采样缩略 / 缓存 LRU 上限（P2）。
- 若真机发现绝对路径仍高频，观察 D5 引导效果再决定是否强化。
