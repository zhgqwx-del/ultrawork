# 039 — 多模态输入：图片 / 文件 / 截图

> 状态：**P0+P1+P2 均已实现**（P2 截图按钮见 ADR-056）· 2026-07-15
> **P2 macOS 真机验收 A/B/C/D 全通过**（A 主路径 · B 授权引导〔打包 `.app` 真身份〕· C 隐藏窗口开关持久化 · D 边界）；全分支两轮对抗审查抓 9 个真缺陷（P2 六 + P0+P1 三）全部修复重验。**Windows/Linux 运行时并入真机欠账**。
> 范围：P0 管道拓宽 + P1 桌面三入口 + P2 应用内截图按钮（均已实现）。**P3（IM 渠道入站图片）本轮不做**。
>
> **P2 收尾补记（2026-07-15）**：① 全分支复审在已提交的 P0+P1 里补抓 3 个缺陷——>8MB PDF 被硬拒（应降级 document）· `checking` 门控 paint→effect 竞态 · Session `disabled` 切 agent 后陈旧（附件到文本后端 ACP 抛错），均已修（见 CHANGELOG Fixed）。② 两条方法论血泪已固化到 gotchas §12：byte-scan 不能当命令注册 oracle（webview 资源压缩嵌入、注册是编译期保证）· `tauri dev` 借终端 TCC 身份（TCC 类功能必须打包 `.app` 才测得准）。

---

## 一、目标

对齐钉钉 / 微信 / 飞书的输入体验：输入框除文本外，还能接受**图片、文件、截图**。

---

## 二、现状盘点：后端早就支持，卡在我们自己的管道

### 2.1 引擎侧（vendor/opencode）——**零改动**

`FilePartInput` 契约完备：

```ts
// vendor/opencode/packages/opencode/src/session/message-v2.ts:181
export const FilePart = PartBase.extend({
  type: z.literal("file"),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string(),              // 支持 data: / file:// / http(s):
  source: FilePartSource.optional(),
})
```

- `prompt.ts:1049` 按 `url.protocol` 分流：`data:` / `file:` 各一条路径。
- `message-v2.ts:655` 把非 `text/plain` 的 file part 直接转成模型的多模态 block `{type:"file", url, mediaType}`。
- **没有上传端点**（`openapi.json` 里 `/file*` 全是 GET），附件只能内联在 prompt body 里。

### 2.2 我们的管道——`text: string` 焊死在四层

| 层 | 位置 | 现状 |
|---|---|---|
| 输入框 | `chat-input.tsx:30` | 纯 textarea；无 `onPaste`、无 `onDrop`、无附件槽 |
| hook | `use-session-messages.ts:744` | `sendMessage(text: string, model?)`；`:779` 乐观 UI 硬编码 `parts:[{type:"text"}]` |
| connector | `connector/src/types.ts:176` · `connector.ts:87` · `backends/opencode.ts:221` | `prompt(sessionId, text: string, opts?)` |
| api-client | `api-client/src/client.ts:491` | **`parts: [{type:"text", text: message}]` 硬编码**（唯一的 parts 构造点） |

隐蔽缺口：用户消息渲染时**主动丢弃非 text part**（`message-list.tsx:142` 过滤后 join 成 string，`user-message.tsx:9` 的 props 就是 `content: string`）——即使发出去了，自己的气泡里也看不见图。

### 2.3 Tauri 侧——几乎零成本

- **CSP = `null`**（`tauri.conf.json:25`）→ `data:` 图片畅通，`artifact-preview.tsx:397` 已是活样板。
- **拖拽零依赖**：`getCurrentWebview().onDragDropEvent()` 直接给**绝对路径**，`core:default` 已含所需权限，不用装插件、不用加 capability。
  - ⚠️ `dragDropEnabled` 未配置 → Tauri v2 默认 `true` → **HTML5 `ondrop` / `DataTransfer.files` 收不到事件**（被原生 handler 吃掉）。两条路二选一，走原生 API（能拿路径，HTML5 拿不到）。
- **读文件有现成命令**：`read_file_bytes(path)`（`lib.rs:1322`，scope-free）。
- **assetProtocol / plugin-fs scope 这条路已被 ADR-033 判死**（工作区可在任意挂载点，静态 scope 必漏），别回头踩。

---

## 三、核心判断：附件不是一类东西，是三类

opencode 对 mime 的处理是三条完全不同的路，**混为一谈必翻车**：

| 类别 | mime 填法 | opencode 行为 | 我们要做的 |
|---|---|---|---|
| **图片 / PDF** | 真实 mime（`image/png`、`application/pdf`） | `isMedia` 命中 → 真多模态喂模型 | **必须按模型能力门控**（见下） |
| **文本类**（txt/md/csv/json/源码） | **一律 `text/plain`** + `file://` | 调它自己的 Read 工具把内容读进来，自带行范围裁剪 | 免费，直接用 |
| **Office / 二进制**（docx/xlsx/pptx/zip） | —— | **完全不管**。填真实 mime → 盲目 base64 糊给 provider 后报错；填 `text/plain` → `Cannot read binary file` | **不内联**，见 §3.2 |

### 3.1 图片必须做模型能力门控（否则用户看到的是模型莫名道歉）

`provider/transform.ts:240` `unsupportedParts()`：模型不支持 image 输入时，opencode 把这个 part **替换成一段错误文本**扔给模型：

```
ERROR: Cannot read <name> (this model does not support image input). Inform the user.
```

⇒ 发送前必须拦下来，给出明确 UI 提示（"当前模型不支持图片，请切换到 XXX"）。

**⚠️ 门控字段用哪个（实测修正）**：`GET /config/providers` 返回的模型对象里，能力位在 **`capabilities.input.image` / `capabilities.input.pdf`**（布尔），**不是**顶层的 `attachment`：

```jsonc
"capabilities": {
  "attachment": true, "toolcall": true, "reasoning": true,
  "input":  { "text": true, "image": true, "pdf": true, "audio": false, "video": false },
  "output": { "text": true, ... }
}
```

`transform.ts:265` 门控的正是 `capabilities.input[modality]` ⇒ **我们必须用同一个字段**，否则前端放行、后端拒收，用户看到模型莫名道歉。（`capabilities.attachment` 是另一个语义，别用。）

**⚠️ 产品影响（实测）**：本机 166 个模型里 87 个支持 image 输入，但**用户日常在用的 `myqwen` provider（默认 `qwen3.7-max`）3 个模型里 0 个支持图片**。`alibaba-cn` 有 23 个支持（如 `qwen3.7-plus`）。⇒ 功能上线后，用户按当前默认模型发图会直接撞门控 ⇒ **门控提示里必须给出"可切换到哪些模型"的具体建议**，不能只说"不支持"。

### 3.2 Office 文件：不内联，拷进工作区 + 注入路径

opencode 没有任何抽取器 / OCR（官方 UI 干脆在客户端白名单里禁掉了这类上传，`app/.../prompt-input/files.ts:53`）。

**我们的解法比"内联"更强**：把文件拷进工作区，prompt 里注入路径，让 agent 用**它自己的工具**去读——办公 CLI 连接器（ADR-043）、bash、read 全都在手。这也是钉钉/飞书做不到的（那边 bot 只能拿到一个下载链接）。

### 3.2b 大文件：eager 内联 vs lazy 路径，按**成本**分流而不是按扩展名

关键事实（vendor `tool/read.ts:15-18`，已核实）：Read 工具**有截断**——`DEFAULT_READ_LIMIT = 2000` 行 / `MAX_BYTES = 50 KB`，且截断时明确告诉模型怎么续读：

```
(Output capped at 50 KB. Showing lines 1-834. Use offset=835 to continue.)
```

这条改变了整个分析。逐类的真实成本：

| 类型 | 真实行为 | 有界吗 |
|---|---|---|
| **图片** | 客户端降采样到 `MAX_IMAGE_EDGE` 再内联 | ✅ 输出有界，**源文件大小无所谓** |
| **文本** | `file://` → 服务端 Read 工具 → **只读前 50KB / 2000 行** + 续读提示 | ✅ **本来就有界**。这实质上已经是「预览 + 路径 + 按需分页」 |
| **PDF** | `file://` → `prompt.ts:1212` → **整份 base64 塞给模型，零截断** | ❌ **无界** |
| **Office/二进制** | 拷进工作区 + 给路径 | ✅ 懒加载 |

⇒ **PDF 是唯一的实质缺陷**：一个 2MB 的 PDF 可能有 300 页，多模态模型每页约 1.5–3k token ⇒ **单条消息几十万 token**，爆上下文或被 provider 拒。

**定下的策略（按成本分流）：**

- **PDF 按页数分流**（不是按字节——字节说明不了任何问题）：客户端用**已有的 pdf.js**（`PdfView` 在用）数页数，`≤ MAX_INLINE_PDF_PAGES (20)` → 内联（模型能看排版/图表/扫描件）；超过 → 降级成 `document`：拷进工作区 + 给路径，agent 按需分段读。**解析失败（加密/损坏）= 当作过长处理**——要防的那个失败不可逆，而路径这条路总是走得通。
- **上限按类型分别定**，因为一刀切在**两个方向**都错：

  | 类型 | 上限 | 理由 |
  |---|---|---|
  | image | 30 MB | 反正降采样，源文件大小不构成成本。旧的 5MB 会误杀 12MB 手机照片 |
  | text | 50 MB | 反正服务端只读 50KB。旧的 5MB 会误杀 20MB 日志——而它本可完美工作 |
  | pdf | **8 MB** | 见下方修正——PDF 的每个字节模型都要付钱 |
  | document | 100 MB | 要拷贝，agent 自己读 |

- **单条消息内联总预算 `MAX_INLINE_TOTAL_BYTES = 15 MB`**。

#### ⚠️ 3.2b 的一次自我推翻（对抗审查抓出，同类复发）

上面这套策略**第一版是错的**，而且错法和它自己要修的那个 bug 一模一样：

我最初写的 `inlineBytesOf` 是 `if (!wireUrl.startsWith("data:")) return 0` —— 认为 `file://` 不进请求体所以**零成本**。对文本成立（Read 工具截断到 50KB），**对 PDF 是致命的**：服务端会把 `file://` 的 PDF **整份读出来 base64 再持久化**（探针实测：发出去 `file://`，落库变成 `data:image/...;base64`）。于是一份 49MB / 20 页的扫描 PDF 全部通过闸门，而预算显示「已用 0 / 15MB」。

**根因：把「请求体格式」当成了「成本模型」**——和「按扩展名分流却不算成本」是同一个错误的两个面。

修正后的成本模型：

| 类型 | 计入预算的字节 | 为什么 |
|---|---|---|
| 图片（data:） | base64 长度 × 3/4 | 真正内联 |
| **PDF（file://）** | **完整文件大小** | 服务端会整份 base64 化，模型每字节都要付 |
| 文本（file://） | `min(size, 50KB)` | 唯一真便宜的：Read 工具截断 |
| document | 0 | 只给路径，agent 自己读 |

- **pdf.js 动态引入**：**不是**为了代码分割（`artifact-preview` 静态 import 了 `PdfView`，pdf.js 无论如何都在主 chunk——用真实 `vite build` 验过）。动态是为了让「只有输入框」的模块不把 `?worker` 拖进依赖图（也让单测能渲染 Home）。**worker 本身改成首次使用才创建**，这样才真的省掉一个常驻线程。

**不需要专门做"摘要技能"**：服务端已经给了 50KB 预览 + `offset` 续读提示，agent 手上还有 read/grep/bash。要补的不是新技能，而是上面这套分流。

### 3.3 落盘位置：`<workspace>/.ultrawork/attachments/<sessionId>/`

**已核实**：`collect_changed_files`（`lib.rs:1882`）跳过所有以 `.` 开头的条目，且有测试钉着（`lib.rs:6103-6125` 断言 `.hidden` 目录内容不出现在结果里）。

⇒ 落在 dot-dir 里对 ADR-033 的产物扫描**天然隐形**，用户拷进来的 docx 不会被误标成"agent 生成的产物"。**不需要新增排除逻辑。**

粘贴/截图产生的图片（内存字节，无源文件）：MVP 走 `data:` URL 不落盘（免 GC、免新命令）；若后续要复用产物预览组件再考虑落盘。

---

## 四、方案

### P0 — 管道拓宽（所有方案的共同地基，~1d）

把 `text: string` 拓成 `parts[]`，四层同步改：

1. `api-client/src/client.ts:485` — `promptAsync` 开放 parts 入口。类型无需改协议（`PromptAsyncRequest.parts` 已是 `Array<{type: string; [k:string]: any}>`，`types.ts:444`），但**应该收紧成 discriminated union**，别继续用 `any` 兜底。
2. `connector` 三处（`types.ts:176` / `connector.ts:87` / `backends/opencode.ts:221`）。
3. `use-session-messages.ts:744` — `sendMessage` 接受 attachments；`:779` 乐观 user message 要带 file parts。
4. `message-list.tsx:142` + `user-message.tsx:9` — 用户气泡不再丢弃 file part，图片出缩略图。
5. `message-parts.tsx:77` — `FileBlock` 对 `image/*` 分支出图（现在只画一个文件名卡片）。

**ACP backend 本轮不动**（`backends/acp.ts:99` → `acp-http.ts:180` 只发 `{text}`，且 `inproc-acp-backend.ts:35` 硬编码 `promptCapabilities.image = false`）。Team 会话暂不支持附件，UI 上要禁用附件入口而不是静默丢弃。

### P1 — 桌面三入口（~2–3d）

| 入口 | 实现 | 成本 |
|---|---|---|
| **➕ 按钮** | `@tauri-apps/plugin-dialog` 的 `open()`，`dialog:allow-open` 权限**已有**（`Settings.tsx:1401` 在用） | 最低 |
| **拖拽** | `getCurrentWebview().onDragDropEvent()` → 绝对路径 → `read_file_bytes` | 低，无新依赖 |
| **粘贴** | DOM `paste` 事件 → `clipboardData.files` → Blob | 低，无新依赖（**待探针**，见 §5） |

**粘贴白送截图能力**：用户按 `Cmd+Shift+Ctrl+4`（mac）/ `Win+Shift+S`（Win）截图后，图已在剪贴板 → 直接 `Cmd+V`。零平台代码、零权限申请。

同时要做：**大小/数量上限**（图片单张 ≤5MB、单轮 ≤10 个）+ **大图降采样**（截图动辄 4K，token 成本很实在）。

#### UI 参考（对照 2026-07-14 飞书 / 微信 Mac 实机截图）

两家的输入框工具条：

- 飞书：`Aa · 😊 · @ · ✂️⌄ · ➕ · ⤢ · ➤`
- 微信 Mac：`😊 · 📦 · 📁 · ✂️⌄ · 🎤`

由此定下三条：

1. **截图是一级图标，不是 ➕ 的子项**。两家都把剪刀独立成键 —— 在 IM 心智里"截图"和"发文件"平级，不是附件的一种子类型。
2. **剪刀带下拉箭头**，里面是「截图时隐藏当前窗口」这类选项 ⇒ §4 P2 的 hide→capture→show **做成用户可切换、默认开**，不要硬编码。
3. **➕ 不做二级菜单**。飞书那个九项菜单（图片/视频、本地文件、云文档、日程、个人名片、任务…）是因为它有多种**来源**（云文档/日程是飞书自己的业务对象）；我们只有一个来源=本机文件 ⇒ **➕ 直接开系统文件选择器**（多选，filter 图片+PDF+文档），多一层菜单只是徒增点击。

我们的工具条落点：`➕ · ✂️⌄`（不需要 emoji / @ / 富文本格式）。

附件 chips 区：缩略图横排在 textarea **上方**，悬停出 ✕，**与文字共存**。i18n key `aria.attachment` 还留着（`i18n-context.tsx:793`），当年那个死「+」按钮在 `ab08528e` 被删了——这次是把它真正接上。

已发送气泡里的图片：圆角缩略图、最大宽度约容器 1/4、点开看大图（照抄微信）。缩略图渲染复用 `artifact-preview.tsx:397` 已有的 `data:` 图片路径。

### P2 — 应用内截图按钮（~2d）

**决策：借系统截图工具，不自绘框选覆盖窗口。** 自绘（xcap + 冻屏 overlay）三平台统一但要 +2~3d，还要自己处理多显示器 / HiDPI / Esc 取消；系统工具这些全都自带，而且是用户已经熟悉的交互。

| 平台 | 实现 | 备注 |
|---|---|---|
| **macOS** | `screencapture -i -x <tmp.png>` | `-i` 交互框选（系统自带十字准星 / 放大镜 / 空格贴窗口 / Esc 取消），`-x` 静音。**落文件而非剪贴板 ⇒ 不需要 clipboard 插件**；取消时退出码非 0 且不产文件，天然可判 |
| **Windows** | `ms-screenclip:` 唤起截图工具 | ⚠️ **只写剪贴板，没有文件、没有回调** ⇒ 必须装 `tauri-plugin-clipboard-manager` + `clipboard-manager:allow-read-image`，并做有界轮询（唤起前记剪贴板状态，唤起后轮询新图，超时 60s / 主窗重获焦点且无新图 = 取消）。<br>⚠️ 唤起 URI **必须**走 `tauri-plugin-opener` 的 Rust API，**不能** `cmd /c start`（ADR-054 闪窗 + gotchas §12 的 cmd 元字符注入面）<br>备选：轮询体验若不可接受 → xcap + 自绘冻屏 overlay（+2~3d） |
| **Linux** | 按序探测 `gnome-screenshot -a -f` / `spectacle -r -b -n -o` / `grim`+`slurp` / `import` | 都没有 → **按钮禁用 + tooltip「请用系统截图后 Ctrl+V」**。**不给 deb/rpm 加 depends**（gotchas.md:347 的教训：假设 `lsof` 存在导致 Linux 静默退化） |

**跨越三平台的硬约束**：

- 所有 `Command::new` **必须走 `sys_cmd()` 唯一构造器**（ADR-054，源码级守卫会挡）。
- 截图前 hide 主窗口、截完 show。**严禁在事件循环里同步阻塞**——ADR-055 的血泪：`blocking_show` 在事件循环启动前调导致 app 永久冻死。spawn 走 async command / 后台线程。
- Rust 侧用运行时 `if cfg!(target_os=…)` 分支而非 `#[cfg]` 属性（ADR-037：本机 `cargo check` 才能验全分支）。

---

## 五、探针结果（2026-07-14 实测，macOS）

> Playwright 在这两件事上**结构性无效**（它驱动 Chromium，不是 WKWebView / 不是原生窗口）——与 ADR-047/048/051/054 撞的是同一堵墙。故用 `swiftc` 编最小宿主直接实测。脚本留在 session scratchpad。

### ✅ 探针 1（P1 地基）：WKWebView 的 DOM `paste` 能拿到完整图片 — **通过**

最小 WKWebView 宿主 + 程序化 `paste:`，PNG 放进 `NSPasteboard`：

```json
{"fired":true,"types":["Files"],
 "items":[{"kind":"file","type":"image/png"}],
 "files":[{"name":"image.png","type":"image/png","size":7342}],
 "blobRead":{"ok":true,"dataUrlPrefix":"data:image/png;base64,iVBORw0KGgo..."}}
```

`clipboardData.files[0]` 是正经 `image/png` File，`FileReader` 读出的字节数与源文件**完全一致**。⇒ **P1 的粘贴入口在 macOS 上成立，零依赖。**（Windows/Linux 的 WebView2 / webkit2gtk 仍需真机复验，并入 Windows 欠账批次。）

### ⚠️ 探针 2（P2）：macOS `screencapture` **必须**要屏幕录制权限，且**静默失败**

用一个全新的、没被授权过的 ad-hoc .app bundle（`com.ultrawork.probecap.tcc`）实测——TCC 按代码身份授权，从 Terminal 里测不出我们 app 的处境。探针自证式：app 自己画一个纯红浮动窗口，只截它自己那块矩形，数红色像素占比。

| 模式 | `CGPreflightScreenCaptureAccess` | 退出码 | 产出文件 | 红色像素 | 实际内容 |
|---|---|---|---|---|---|
| `-R` 非交互矩形 | `false` | **0** | ✅ 800×600 | **0.0%** | 纯壁纸 |
| `-i` **交互框选** | `false` | **0** | ✅ 754×402 | **0.0%** | 纯壁纸 |

**三条结论：**

1. **交互式 `-i` 没有豁免。** 人眼明明看见红框、并在框里拖出了选区，截出来仍是壁纸 ⇒ **用户看到的 ≠ `screencapture` 返回的**。
2. **失败是完全静默的**：退出码 0、文件正常产出、尺寸都对，只是窗口内容被系统悄悄剥光。⇒ **任何"看退出码判成功"的实现都会假绿。**
3. 直接 spawn `screencapture` **不会**自动弹授权框，只会静默降级。

### ✅ 探针 2b：`CGRequestScreenCaptureAccess()` 能主动弹出系统授权框 — **通过**

用全新 bundle id（`com.ultrawork.probereq.v1.tcc`，保证是干净身份）实测：调用后系统弹出「"ProbeReq"想要录制此电脑的屏幕」对话框（**人工目视确认**——这一步程序内读不到：该 API 立即返回 `false`，对话框是异步弹的；而"截图看一眼"需要屏幕录制权限，正是被测对象，鸡生蛋）。

⇒ **引导态可以做成一键式**，不必让用户自己去系统设置里翻。

**⇒ P2 macOS 分支的强制设计：**

- 截图前必须调 **`CGPreflightScreenCaptureAccess()`** 查授权，**不能**依赖退出码（退出码永远是 0）。
- 未授权时调 **`CGRequestScreenCaptureAccess()`** 一键拉起系统授权框（已实测可弹；**不能**指望 spawn `screencapture` 时自动弹）。
- 授权后 macOS 要求**重启 app** 才生效（授权后 preflight 不会立刻翻 true）⇒ 必须做「已授权，请重启 Ultrawork」的引导态。
- **未授权时按钮降级到 P1 路径**（提示「按 `Cmd+Shift+Ctrl+4` 截图后粘贴」），而不是显示一个坏掉的按钮 —— 这也是 **P1 必须先于 P2 落地**的硬理由：没有 P1 打底，P2 的未授权态就是死胡同。
- 这是 macOS 的系统性代价，钉钉/微信同样要申请这个权限，绕不过去。

> 注意：**这一条完全不影响 P1**。用户用系统快捷键截图 → 剪贴板 → `Cmd+V`，走的是系统截图工具自己的权限，我们 app 无需任何授权。**P1 仍是零权限路径**——这也进一步说明 P1 该先落地、P2 是锦上添花。

### ✅ 探针 3（承重假设）：OpenCode 真的收 file part，模型真的看得见 — **通过**

**这是全案的地基**：P0/P1/P2 全压在"往 `parts` 里塞 file part 就能通"上，而此前只有源码阅读、没发过一个真实请求。故对**正在运行的本机 sidecar（:4096）发真请求**验证。

为了让结论不含糊，ground truth 用一张**印着随机 6 位数字的 PNG**（`swiftc` 生成）——模型能一字不差读出数字才算真看见，避免"描述一下这张图"那种可以靠猜蒙混的问法。

```
POST /session/:id/prompt_async
  parts: [ {type:"text", ...}, {type:"file", mime:"image/png", url:"data:image/png;base64,..."} ]
  model: { providerID: "alibaba-cn", modelID: "qwen3.7-plus" }

ground truth                 = 868708
prompt_async                 = HTTP 2xx（schema 未拒绝 file part）
user message 持久化后的 parts = ['text', 'file']      ← file part 落库，渲染侧拿得到
assistant answer             = '868708'
VERDICT: MODEL_SAW_THE_IMAGE
```

三点一次性坐实：① OpenCode schema 收下 file part；② `data:` URL 端到端走通；③ **file part 会被持久化进 user message** ⇒ P0 里"用户气泡渲染图片缩略图"确实拿得到数据，不是空中楼阁。

### ⏳ 探针 4（未验，需 Windows 真机）

Windows `ms-screenclip:` 的取消检测是否可靠 → 决定 P2 Windows 分支选型（剪贴板轮询 vs 自绘冻屏 overlay）。并入 Windows 真机欠账批次。

---

## 六、非目标（本轮明确不做）

- **P3 — IM 渠道入站图片**。四个适配器遇到图片**仍在静默丢弃**（钉钉 `dingtalk-adapter.ts:151` / 飞书 `feishu-adapter.ts:191` / 企微压根没注册 `message.image` 事件 / 微信 `wechat-adapter.ts:204`）。
  - ⚠️ **本文档此前写着「本轮只补一句『暂不支持图片』的回复」——那句话是假的，gateway 一个文件都没动。** 由一轮「静默失败」视角的对抗审查揪出（讽刺的是，本特性立项就是为了治这个病，而文档本身犯了同款：写得像做了，实际没做）。现已如实改回：**这一条完全没做，整体挂账到 P3。**
  - 未来成本排序：企微最便宜（SDK 自带 `downloadFile(url, aeskey)`，消息体直接带 5 分钟有效加密 URL）→ 飞书（`messageResource.get`）→ 钉钉（`downloadCode` 换临时 URL）→ 微信 ilink 最贵（要自己实现 AES-128-ECB + CDN，ADR-018 里就写着"Phase 3 后续"）。
- **出站发图**（agent 把图片发回 IM）。`ChannelAdapter.sendMessage(chatId, content: string)` 也是纯文本。
- **ACP / Team 会话附件**。
- **docx/xlsx 的客户端抽取**。走 §3.2 的路径交给 agent 自己读。
