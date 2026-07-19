# 045 — 应用内 HTML 预览 + 打开按钮类型化 + deckcraft 居中修复

> 状态：**✅ 已实现 + 真机验收通过** · 2026-07-19 · ADR-062
> 范围：产物预览把 HTML 从「只读代码视图」改为「应用内浏览器预览（sandboxed iframe）」+ 预览/源码切换 + 「用默认应用打开」推广到所有类型且图标类型化；顺带修 deckcraft deck 在窄视口不居中的既有缺陷。
> 根因层级：**均已代码 + 双引擎实测确证**（非猜测）。

---

## 一、缘起

用户对比自家真机预览与其它桌面 agent，提两点：① HTML 预览不该是「打开编辑器」（代码视图），应是浏览器预览；② 预览右上角可加「用默认应用打开」入口。真机验证 HTML 预览时又发现 deck **右偏不居中**；随后提出打开按钮图标能否随文件类型变化。

## 二、根因（逐环确证）

### 2.1 HTML 落代码视图
`artifact-preview.tsx` 分派链 `pdf → binary → 空 → patch → 图片 → markdown → 【兜底】CodeMirror`，**无 `isHtml` 分支**（判断函数 `isHtml` 存在但没人用它做渲染分派）。`.html` 非图片/md/pdf/binary → 掉进 CodeMirror 只读代码视图（带行号+语法高亮，视觉像编辑器）。全项目零 `<iframe>`/`WebviewWindow`，从无应用内网页渲染。

### 2.2 deck 窄视口右偏（真机暴露）
deck fit 脚本（`shell.html`）：`.stage{width:1280px;margin:0 auto}` + `transform-origin:top center`。视口 <1280 时 `margin:auto` 退化为 0、stage 左对齐溢出，缩放锚点钉在 stage 自身中心 x=640 ≠ 视口中心 → 右偏。**实测**（半屏 1145px）：偏 68px；640px 偏 320px；且 resize 修不好（不是时序问题）。仅视口≥1280 才恰好居中——半屏预览恒 <1280 故每次触发（把独立浏览器窗口拉窄同样偏，是 deck 潜在缺陷）。

## 三、可行性核验（HTML iframe 方案，均确证放行）

| 隐患 | 结论 | 证据 |
|---|---|---|
| HTML 有外部相对资源 → srcdoc 加载不了 | deckcraft **完全自包含**（CSS/JS 内联、图片 data-URI、build 期 `_RESIDUAL_IMG` 硬校验）| `build_deck.py` |
| 前端拿不到 HTML 全文 | 已拿到：`getFileContent` 返回字符串（`.html` 属 text 扩展 → 原始文本非 base64，`vendor/opencode file/index.ts`）| `artifact-preview.tsx:213` |
| CSP/assetProtocol 拦 iframe | `csp:null`、无 meta CSP → 不拦；`srcDoc` 无需 assetProtocol/convertFileSrc（当前都没启用）| `tauri.conf.json` |

## 四、实现

- **D1 iframe 预览**：分派链插 `isHtml && !htmlSourceView` → `<iframe srcDoc={content} sandbox="allow-scripts" title=basename className="size-full border-0 bg-white">`。外层容器布局条件本就对 HTML 走 overflow-hidden 全高，零改动。
- **D2 预览/源码切换**：`htmlSourceView` state（切文件时重置）+ 头部 `Code`/`Eye` 钮；源码态复用现有 CodeMirror 兜底。
- **D3 打开按钮**：合并原 PDF/HTML 两个重复按钮为一个、条件放宽到所有 `file`；`openAppIcon(path,mime)` 按类型返回 lucide 图标（见 ADR-062 D3）。
- **D4 deck 居中**：`shell.html` → `.stage{margin:0}` + `transform-origin:top left` + `transform:translateX((vw-1280*s)/2) scale(s)`。重生成示例 deck + 重跑 pack + 同步两 sentinel（`c7d2c72d`）。

## 五、被否方案（打开按钮取 OS 默认应用真实图标）

用户问能否显示「该文件类型默认应用的真实图标」。评估：需三套原生（macOS `NSWorkspace.icon(forFile:)`、Windows `SHGetFileInfo`→HICON→PNG、Linux `xdg-mime`→`.desktop` `Icon=`→freedesktop 主题查找），新增原生 crate + Tauri 命令 + 缓存；**无法 headless 验**（Playwright 够不到 OS 集成）、Linux 天生不稳（空/错/SVG）、Windows HICON→PNG alpha 坑多、纯装饰性收益。**否决**，改走零风险的语义化 lucide 图标（A 方案）。

## 六、验证

- **单测**（jsdom 真组件）：HTML 默认渲 iframe（srcDoc/sandbox 断言）、预览↔源码切换、打开按钮对非 HTML 也出现、7 类型→lucide glyph 映射 + 兜底（10 例）。坑：lucide 0.562 把 `FileVideo` 别名到 `file-play` glyph，核对全部导入图标真实渲染后对齐测试。
- **双引擎 Playwright**（committed `e2e/html-preview-iframe.e2e.ts`，Chromium=WebView2 / WebKit=WKWebView+WebKitGTK）：真 deck 渲染（10 slide）、fit 脚本在 `allow-scripts` 下运行（`#stage` 得 `scale`）、沙箱隔离（不透明源、父 DOM/`__TAURI__` 均 SecurityError）、**居中**（sub-1280 off=0px）、对照组（无 allow-scripts → 脚本被挡、证断言有区分力）。
- **居中专项**：真实重生成 deck 两引擎 5 宽度全居中；320→2560 + 边界 + 实时 resize 全 0px 偏移且左右对称；OLD/NEW 对比证垂直零变化、横向溢出反被消除（旧版 52/304px 溢出滚动条 → 0）。
- **导出无回归**：`extract_layout.py` 拆 `head`+单 section、注入自己的 `.stage/.slide margin:0`、窗口固定 1280、**不含 fit 脚本** → 居中改动对 pptx/extract 零影响（deckcraft-selftest 48/0 佐证）。
- **门禁**：typecheck 0 · check-docs 0 · desktop **683** · sentinel 确定性（重跑 pack 复现 `c7d2c72d`）。
- **真机**：macOS WKWebView 出厂窗口验收通过（HTML 渲染/居中/切换/打开默认应用/类型图标）。

## 七、跨平台 / 打包 / mode

- 纯 renderer + `shell.html` 静态模板（打进 builtin zip、构建期 pack、运行时按 sentinel 重解压）。无原生代码、无新 crate、无硬编码路径。
- iframe/srcDoc/sandbox 是 Web 标准，双引擎实测覆盖三平台渲染器；`open_file_with_system` 走 `tauri_plugin_opener`（三平台原生）。
- 单/Team 共用唯一 `ArtifactPreview`（`Session.tsx` 单挂载、不按 mode 分叉），渲染是 `path+content` 的纯函数。

## 八、已知边界

- deck 居中修复只对**新生成**的 deck 生效（旧 deck 内嵌旧脚本）。
- 打开按钮显示语义图标、非 OS 真实应用图标（见 §五，刻意）。
- 关联的既有 bug「跨会话产物泄漏」独立记于 discussions/044（与本次改动无关）。
