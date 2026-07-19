# ADR-062: 应用内 HTML 产物预览（sandboxed iframe）+ 打开按钮类型化

- 状态：Accepted（✅ 已实现 + 真机验收通过，2026-07-19）
- 日期：2026-07-19
- 关联：discussions/045（完整分析、根因、验证、被否方案）、ADR-048（产物预览/右栏互斥）、ADR-033（产物识别 + PDF 预览）、ADR-061（deckcraft，本次居中修复的落点）、ADR-037（跨平台）

## 背景

产物预览分派链（`artifact-preview.tsx`）此前**没有 HTML 分支**：`.html` 掉进兜底的 `CodeMirror` 只读代码视图，用户看到的是带行号的源码而非渲染后的网页。想看真网页只能点右上「在浏览器打开」外弹系统浏览器。对比同类桌面 agent，应用内直接预览 HTML 是基本预期。

## 决策

### D1 — HTML 产物在应用内渲染为 sandboxed iframe（不再落代码视图）
分派链在 markdown 之后、CodeMirror 兜底之前插 `isHtml && !htmlSourceView` 分支，渲染 `<iframe srcDoc={content} sandbox="allow-scripts">`。
- **可行前提（均已核验）**：deckcraft 产出的 deck.html **自包含**（CSS/JS 内联、图片 data-URI，`build_deck.py` 有 `_RESIDUAL_IMG` 硬校验）→ `srcDoc` 无 base URL 也能整渲；前端经 `getFileContent` 已持有 HTML 全文字符串；`tauri.conf.json` `csp:null` 且 index.html 无 meta CSP → iframe/srcdoc 不被拦；无需启用 assetProtocol/convertFileSrc。
- **安全姿态**：`sandbox="allow-scripts"` **不带 `allow-same-origin`** → iframe 得不透明源，脚本能跑（deck 自适应 fit 脚本需要）但**够不到父页面/Tauri IPC**（实测 `window.parent.document`、`window.parent.__TAURI__` 均抛 SecurityError）。比现状「在浏览器打开」（真实浏览器、真实 origin、带 cookie）**更收敛**，非退步。

### D2 — 预览 ⇄ 源码切换（保留退路）
HTML 头部加 `Code`/`Eye` 切换钮，默认预览、可切原始 HTML 源码（CodeMirror）。覆盖非 deckcraft 的多文件 HTML（相对资源在 srcdoc 失效时可看源码）。

### D3 — 「用默认应用打开」推广到所有文件类型 + 图标类型化
把原先仅 PDF/HTML 的打开按钮放宽到所有 `file` 型产物（`open_file_with_system` 本就支持任意路径、三平台）；按钮图标由固定 `AppWindow` 改为 `openAppIcon(path)` 按类型给 lucide 语义图标（html→Globe、pdf/文档→FileText、图片→Image、代码→FileCode、表格/演示/音视频/压缩包各对应、其它兜底 AppWindow）。**明确否决**取 OS 默认应用真实图标（需 AppKit/Win32/freedesktop 三套原生 + HICON→PNG/图标主题查找，不可 headless 验、Linux 不稳，纯装饰性收益不抵成本——详见 discussions/045）。

### D4 — 顺带修 deckcraft deck 在窄视口不居中（本次预览暴露的既有缺陷）
半屏预览恒 <1280px，暴露 deck fit 脚本的居中缺陷：`.stage{margin:0 auto}` + `transform-origin:top center` 仅在视口≥1280 才居中，<1280 时缩放锚点（stage 中心 x=640）≠ 视口中心 → 整体右偏（把独立浏览器拉窄同样偏）。修法（`shell.html` 模板）：`.stage{margin:0}` + `transform-origin:top left` + `translateX((vw-1280*s)/2)`，脚本独占水平居中。print 路径 `transform:none!important` 照旧、PDF/pptx 导出不受影响（extract 绕过 fit 脚本）。

## 后果

- HTML 产物默认应用内预览，右上打开按钮图标随类型变化。
- 纯 renderer + 模板改动，无 Tauri 配置/权限/CSP 变更，无原生代码、无硬编码路径，三平台一致、mode 无关（单/Team 共用同一 `ArtifactPreview`）。
- deck 居中修复只对**新生成**的 deck 生效（旧 deck 内嵌旧脚本）。
- **验证**：jsdom 单测（iframe/toggle/打开按钮/7 类型图标，10 例）+ 双引擎 Playwright e2e（Chromium=WebView2、WebKit=WKWebView/WebKitGTK：真 deck 渲染/沙箱隔离/fit 脚本运行/居中 320→2560+实时 resize）+ deckcraft-selftest 48/0 + typecheck 0 + desktop 683 + check-docs 绿。真机（macOS WKWebView）验收通过。
