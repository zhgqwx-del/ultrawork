# ADR-033: 产物识别改用文件系统真相 + PDF 内嵌预览

- **日期**: 2026-06-16
- **状态**: Accepted（✅ 已实现）

## 背景

真机使用中两处产物相关问题（用户截图驱动）：

1. **产物区漏真产物、误显中间脚本**：研究/文档生成类任务里，agent 常**先 `write` 一个 `.py` 脚本，再用 `bash` 跑脚本生成最终产物**（pdf/docx/xlsx）。但产物识别（桌面 `artifacts-panel` 的 `extractArtifacts` + 编排 `delegate.ts` 的 `extractArtifactPaths`）**只从 `write/edit/create/patch` 工具 input 的路径参数**取产物（外加 delegate D-2 JSON + 文本正则）。结果：
   - `bash` 产出的真产物没有工具路径参数 → **完全识别不到**；
   - 那个中间 `.py` 因被 `write` 写过 → **冒充产物**显示。
2. **PDF 预览空白**：右侧栏点 PDF 预览为空。后端 `GET /file/content` 把 pdf 当 binary 返回空 content，而前端 `isBinaryFile` 的 `BINARY_EXTS` 不含 pdf → 前端按文本去拉、拿空串 → 渲「无内容」空态。

## 决策

### 1. 产物识别 = 文件系统真相 +（产物 / 工作文件）分类

**捕获**：以「会话目录里 mtime ≥ 回合基线的文件」为产物源，捕获包括 bash/脚本副作用在内的任意产出。

- 桌面：新增 scope-free Tauri 命令 `scan_workspace_changes(dir, sinceMs)`（walk 目录取 mtime ≥ 阈值的文件），`artifacts-panel` 在 agent **空闲时**以「会话最早消息 `time.created`」为基线扫描并入产物（复用同一 workspace 范围 / temp 过滤 / 去重管线）。
- 编排：`delegate.ts collectDeliverable()` 的 D-2 `artifacts[]` **只取子会话自己转录里的 write/edit 工具路径**（per-child 准确），**刻意不 fs 扫描工作区**。原因（真机 Team review 发现）：Leader 默认同轮并行委派多个成员、共用一个工作区，mtime 无法区分并发委派谁写的文件 → 扫描会让 A 的 `artifacts[]` 串进 B 的文件。Team 成员的 bash 副作用产物改由桌面 Leader 面板自己的回合窗扫描兜住（成员在 Leader 工作区、Leader 回合内写）。要 per-delegate 精确隔离只能用 worktree（Fan-out 已支持）。
- 桌面扫描命令 `async` 跑在非 UI 线程；限深度 8 / 匹配 500 / 访问 50000 项（大工作区匹配稀疏会强制全树遍历，每项一次 stat，须有访问上限）。
- `Session.tsx` 传给三个面板的 `directory` 用 `session?.directory ?? teamEntry?.workspace`（legacy Team Leader 会话不在 SessionsContext 里，否则扫描/预览拿不到工作区）。
- **两端忽略集一致**：`.git / node_modules / __pycache__ / *.pyc / 隐藏 / temp`，限深度 8 + 数量 500。
- **基线为 0（消息无 time）时不扫**，否则 `since=0` 会把工作区所有既存文件当产物。
- **跨会话归属（真机发现）**：多个会话共用一个工作区时，纯 `mtime ≥ 基线` 会让 A 的产物区串显 B/C 的文件。桌面扫描返回 `{path, mtimeMs}`，前端用 `sessionTurnWindows`（本会话每个回合的 `[user 消息, 该回合 assistant 完成+grace]` 时间窗，active 时末窗开放）+ `filterScanByWindows` 只保留 mtime 落在本会话回合窗内的文件。按回合切窗（非整段 span），连「本会话 idle 期间别会话写文件」的串扰也排除。

**分类**：扩展名分两组——脚本/代码/配置（py/ts/js/sh/json/yaml/… `WORKING_EXTS` 白名单）= 「工作文件」折叠次级组；其余（pdf/docx/xlsx/pptx/html/csv/md/图片/压缩包…）= 「产物」置顶展开。理由：产物空间开放、工作文件集合有界，故以工作文件为白名单、其余皆产物。**无产物类文件时工作文件自动提升**（纯代码任务不至于空面板）。

### 2. PDF 内嵌预览 = pdf.js（不走 assetProtocol）

- `pdf-view.tsx` 用 `pdfjs-dist` **v4.x**（须 pin，见下）渲染各页到 canvas（多页滚动）。
- **刻意不用 Tauri assetProtocol**：工作目录可能在 `$HOME` 之外（外置盘/任意挂载），而 asset scope / plugin-fs scope 都是 `tauri.conf.json` 静态配置、无法按工作区动态化 → 必漏。改由新增 scope-free 命令 `read_file_bytes(path) -> tauri::ipc::Response`（`std::fs::read` 直读、可读任意路径、二进制高效回传）取字节喂 pdf.js。
- worker 经 Vite `?worker` 打成独立 chunk（`GlobalWorkerOptions.workerPort`）。预览头部保留「系统应用打开 / Finder 显示」，渲染失败回落系统打开并显示具体错误。
- **`pdfjs-dist` 必须 pin v4.x**：v5/v6 用了 `Map.prototype.getOrInsertComputed`（2024 TC39 提案），macOS WKWebView JS 引擎不支持 → 真机预览必崩（`getOrInsertComputed is not a function`）。v4.10.38 真机验证正常。这类只能真机 webview 验证，jsdom/headless 测不出。详见 gotchas §6。
- **Word/Excel/PPT 维持「用系统应用打开」**（无内嵌渲染器，刻意；引入 mammoth/SheetJS 依赖重且有损，列为远期可选）。

## 备选方案（已否决）

- **产物：保留纯启发式 + 解析 bash 重定向/转换器命令**——脆弱，仍漏没被命令显式提及的副作用文件。
- **产物：显式 `present_artifact` 登记工具**——精确可带标题，但依赖 agent 主动调用（会漏）、需双后端注入 + prompt 工程；列为后续增强。
- **PDF：assetProtocol + iframe**——scope 静态化漏 `$HOME` 外目录；且跨平台依赖 webview 内置 PDF 阅读器。
- **PDF：读字节→blob→iframe**——免 scope 但仍靠 webview 内置阅读器（Linux WebKitGTK 无 → 空白），不够完备。
- **PDF：像 Word 交系统软件打开**——最省，但 PDF 是这类任务最常见的「最终产物」，产物区对核心产出空着违背初衷。

## 验证中发现并修复的问题（真机 + 多角度 review，按发现顺序）

初版实现后,经 code-review、真机走查、Team 系统 review 逐个暴露并修复了以下缺陷——记录在此以免重蹈:

1. **PDF v6 不兼容 WKWebView（真机,致命）**：`pdfjs-dist` v6 用 `Map.getOrInsertComputed`，macOS WKWebView 引擎不支持 → 真机预览崩 `getOrInsertComputed is not a function`。→ pin v4.10.38 + worker 改 `?worker`/workerPort + render 去掉 v4 不支持的 `canvas` 参。**教训**：pdfjs 升级必须真机 webview 验,jsdom/headless 测不出。
2. **跨会话串扰（真机场景5）**：多会话共用一工作区时,纯 `mtime ≥ 基线` 让 A 的产物区串显 B/C 的文件。→ `sessionTurnWindows`/`filterScanByWindows` 按本会话回合时间窗归属（按回合切窗,连 idle 间隙串扰也排除）。
3. **Team 跨委派串扰（Team review,本可更糟）**：初版给编排 `collectDeliverable` 也加了 fs 扫描,但 Leader 默认同轮并行委派多成员、共用一工作区 → A 的 `artifacts[]` 会串进 B 的文件,且 mtime 无法区分并发委派。→ **移除编排 fs 扫描**,D-2 回归只取子会话 tool 写;Team 成员 bash 产物由桌面 Leader 回合窗扫描兜住。
4. **legacy Team Leader 工作区丢失**：这类会话不在 SessionsContext,`session?.directory` 为 undefined → 扫描/预览/文件树全失效。→ 三面板 `directory` 回退 `?? teamEntry?.workspace`。
5. **性能（大工作区）**：扫描是 O(树大小)、每文件一次 stat,且初版是同步命令 → 大目录卡 UI 线程。→ 命令改 `async`（非 UI 线程）+ 访问上限 50000 项 + 收集 5000 后排序截断 500（保证「newest-first」不被 walk 早停丢掉真产物）。
6. **code-review 杂项**：① 切会话后 `scanned` 残留串显（SessionPage 未 keyed）→ 按 `[directory, baseline]` reset；② 先打开加载失败的文本产物再点 PDF 时旧 `error` 挡住 PDF → skip 分支前先清 `error/content`；③ `read_file_bytes` 同步阻塞大文件 → async；④ 扫描在排序前截断会丢最新文件 → 先收集后排序再截断。

**仍接受的固有限制（非 bug,已记 gotchas）**：并发同工作区委派无法用 mtime 精确归属（要精确隔离用 worktree,Fan-out 已支持）；超 5 万项的超大工作区扫描会被上限截断；中途删除的文件可能因 tool 历史残留显示；`/tmp` vs `/private/tmp` 去重边界（基本只影响测试）。

## 影响

- 新文件：`pdf-view.tsx`、`src/vite-env.d.ts`；新依赖 `pdfjs-dist`。
- 新 Tauri 命令：`scan_workspace_changes`、`read_file_bytes`。
- 改动：`artifacts-panel.tsx`（扫描接入 + 回合窗归属 + 分类 + 两组渲染）、`artifact-preview.tsx`（pdf 分支）、`Session.tsx`（传 `active` + `workspaceDir` 回退）、i18n。`delegate.ts` 维持「D-2 = 子会话 tool 写」不变（未引入 fs 扫描）。
- 测试：Rust 11（+3）、orchestrator 67（+1）、desktop 203（+17：merge/classify 4 + file-icon 路由 3 + 面板渲染走查 6〔含 Team D-2 分组〕+ 回合时间窗 4）；typecheck 8/8；`vite build` 验证 worker bundle。headless live 走查：单委派 bash 产物 + 并行/顺序同工作区无串扰（airtight）。
- gotchas §1（产物识别文件系统真相 + pdf binary content 契约）、§6（scope-free 命令 + pdf.js 接法）固化。
