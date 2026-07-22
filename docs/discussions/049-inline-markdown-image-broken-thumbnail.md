# 049 — 「画个章鱼/虎鲸」回复里内联图片渲染成破图 `❓`

> 状态：**🟡 根因已实证确认（真实会话 DB + 活端点行为双证）· 方案已定稿（A 内联 data URI + C 兜底 + workspace 限定 + 点击放大 + rich-output 引导）· 未动代码** · 2026-07-22
> 范围：定位「让模型画图（章鱼/虎鲸）后，回复正文出现破损缩略图 `❓`」的根因，评估方案完备性/改动量/风险，给出可执行设计。先出方案不改代码。
> 依据：根因为**真实数据 + 代码实测**（会话 SQLite 原文 + `/file/content` 活端点行为 + vendor `File.read` 源码行号），非凭印象。

---

## 一、缘起

用户对默认会话连发「画个章鱼」「画一个虎鲸」，回复正文里出现破损缩略图 `❓`。用户判断：**不是产物面板/产物归属的问题，而是回复信息本身的渲染问题**。本讨论确认此判断并定位根因。

## 二、根因（真实数据 + 代码实测，闭合链条）

**根因**：模型把画好的 SVG/PNG 写进工作区文件，再在回复正文用 markdown 图片语法 `![alt](本地路径)` 引用；而聊天 markdown 渲染层**没有 `img` 处理器**、WebView 又**无法加载本地文件路径** → 破图 `❓`。

### 证据链

1. **模型行为（会话 DB 原文）**：从当前运行实例的 `~/.local/share/ultrawork/opencode-.db`（opencode 已迁 SQLite，`part` 表）取到那几条回复原文：
   - 章鱼：`![章鱼](/Users/zhangguoqiang/.ultrawork/workspace/octopus.svg)` — **绝对**路径
   - 虎鲸：`![帅气虎鲸](orca_preview.png)` — **相对**文件名
   - 虎鲸：`![虎鲸](/Users/zhangguoqiang/.ultrawork/workspace/orca.svg)` — **绝对**路径

   qwen 纯文本模型不能出图，reasoning 里明确「create an SVG which would look much better」→ 写文件 → 正文用 markdown 图片引用。文件在磁盘真实存在（`octopus.svg` 6167B / `orca.svg` 11214B / `orca_preview.png` 495349B）。

2. **渲染缺陷（代码实测）**：
   - `message-parts.tsx` 的 `MARKDOWN_COMPONENTS` **无 `img` 覆盖**（`grep img:` 空）→ react-markdown（v9.1.0，无 `rehype-raw`）用默认渲染器直接吐 `<img src="本地路径">`。
   - WebView origin 是 Vite（`localhost:1420`）/ 生产 `tauri://`，非工作区。`<img>` 把 `/Users/...svg` 解析成 `http://localhost:1420/Users/...svg`、把 `orca_preview.png` 解析成 `.../session/orca_preview.png` → 一律 404 → 破图占位符 = `❓`。
   - 全仓**无** `convertFileSrc`、`tauri.conf.json` **未配 `assetProtocol`**（`security` 仅 `csp:null`）→ WebView 没有任何合法途径读本地文件。

3. **第二层（本轮新验证，决定方案）**：即便想用 app 已有的 `getFileContent` 通道去救，也有硬约束——vendor `vendor/opencode/packages/opencode/src/file/index.ts:513` 的 `File.read`：
   - `const full = path.join(Instance.directory, file)` + `if (!Instance.containsPath(full)) throw "Access denied: path escapes project directory"`（:515-517）。
   - 图片扩展名走 base64 分支：`{ type:"text", content: base64, mimeType, encoding:"base64" }`（:519-528）。
   - **实测活端点** `/file/content`（带 `Authorization` + `x-opencode-directory: <workspace>` header）：
     - 相对路径 `octopus.svg` → `type:text, mimeType:image/svg+xml, encoding:base64, len:8224` ✅
     - 相对路径 `orca_preview.png` → `mimeType:image/png, base64, len:660468` ✅
     - **绝对**路径 `/Users/.../octopus.svg` → `path.join(dir, 绝对)` 拼坏 → `content:""` ❌
   - 结论：**通道只认 workspace 相对路径**；绝对路径必须先剥前缀转相对；workspace 外的图 `containsPath` 直接拒。

> `x-opencode-directory` header 由 `packages/core/api-client/src/client.ts:105` 注入（= client 的 `workingDirectory`）。产物预览之所以能显示这些 SVG/PNG，正是因为产物面板传的是**相对**路径 + 同一 `getFileContent→base64→data:URI` 通道；而聊天内联 `<img>` 用的是模型原文（含绝对路径）、且没走这条通道 → 只有它坏。

### 与产物无关（确认用户判断）

破图在**聊天正文内联 markdown 图片**这条渲染路径上。产物面板/`artifact-preview` 走**另一条**（相对路径 + `getFileContent`）本身没坏；本 bug **不碰**产物扫描/归属逻辑（与 discussions/044 跨会话产物泄漏无关）。

## 三、三类图片支持面（协议分派）

方案的 `img` 解析器按 src 形态分派，三类全覆盖：

| src 形态 | 处理 | 支持 |
|---------|------|------|
| 远程 `http(s)://…` | 原样透传 `<img src>`（`csp:null` 不拦） | ✅ 直出 |
| base64 / `data:image/…` | 原样透传 `<img src>` 原生解码 | ✅ 直出 |
| 本地路径（相对 / workspace 内绝对） | 绝对→相对 → `getFileContent` → `data:mime;base64` | ✅ 解析后渲染 |
| 本地但 workspace 外 | `containsPath` 拒 → C 兜底 chip | ⚠️ 不内联，可点开/显 alt |
| `javascript:`/`vbscript:` 等 | 拒（与 `MarkdownLink` 安全姿态一致） | — |

## 四、方案（A + C 兜底 + workspace 限定 + 点击放大 + rich-output 引导）

### 4.1 改动文件清单

| 文件 | 改动 |
|------|------|
| `packages/client/desktop/src/lib/path-utils.ts` | 新增 `toWorkspaceRelative(path, dir)`（绝对→相对 + workspace 限定 + `..` 逃逸防护） |
| `packages/client/desktop/src/components/chat/markdown-image.tsx` | **新增** `MarkdownImage`（协议分派 / 解析 / 缓存 / 流式占位 / 失败兜底 / 点击放大） |
| `packages/client/desktop/src/components/chat/message-parts.tsx` | 加 `MarkdownImageContext`；`MARKDOWN_COMPONENTS.img → MarkdownImage`；`MarkdownContent` 加可选 `workspaceDir`/`onArtifactClick` 并用 Provider 包裹 |
| `assistant-turn.tsx` / `assistant-message.tsx` | 给 `MarkdownContent` 透传 `workspaceDir`+`onArtifactClick`（`message-list` 已把二者传到 `AssistantTurn`） |
| `vendor/.../plugin/rich-output.ts` + patch | 追加 1 行 output_format 引导（用相对路径 markdown 图片） |
| 测试 | `markdown-image.test.tsx` + `path-utils` 分支 + 缓存命中不二次请求 |

`about-legal.tsx` 也用 `MarkdownContent` 但不传这俩 prop → 解析器惰性、法务文档不受影响。

### 4.2 路径解析（crux）

```ts
// 返回 workspace 内相对路径；workspace 外/非法 → null（交兜底）
export function toWorkspaceRelative(p: string, dir: string): string | null {
  if (!isAbsolutePath(p)) {
    if (p.includes('..')) return null
    return p.replace(/^\.?\//, '')
  }
  const d = dir.replace(/[\\/]$/, '')
  if (p === d) return null
  if (p.startsWith(d + '/')) return p.slice(d.length + 1)
  return null
}
```

### 4.3 `MarkdownImage`（伪代码）

```tsx
const dataUriCache = new Map<string, string>()  // module 级，key = `${dir}|${rel}`

function MarkdownImage({ src, alt }) {
  const ctx = useContext(MarkdownImageContext)   // { workspaceDir?, onArtifactClick? }
  const api = useApi()
  const scheme = classify(src)                   // data | http | local | invalid

  if (scheme === 'data' || scheme === 'http')
    return <img src={src} alt={alt} loading="lazy" />          // 直出
  if (scheme !== 'local' || !ctx?.workspaceDir)
    return <span>{alt || src}</span>                            // 惰性（about-legal / 非法）

  const rel = toWorkspaceRelative(src, ctx.workspaceDir)
  if (rel == null) return <FallbackChip alt={alt} />            // workspace 外

  const key = `${ctx.workspaceDir}|${rel}`
  const [st, setSt] = useState(() =>
    dataUriCache.has(key) ? { uri: dataUriCache.get(key) } : { loading: true })
  useEffect(() => {
    if (dataUriCache.has(key)) return
    let cancelled = false
    api.getFileContent(rel).then(r => {
      if (cancelled) return
      if (r.content && r.mimeType?.startsWith('image/')) {
        const uri = `data:${r.mimeType};base64,${r.content}`
        dataUriCache.set(key, uri); setSt({ uri })
      } else setSt({ error: true })
    }).catch(() => !cancelled && setSt({ error: true }))
    return () => { cancelled = true }
  }, [key, rel, api])

  if (st.uri)   return <img src={st.uri} alt={alt} className="cursor-zoom-in"
                    onClick={() => ctx.onArtifactClick?.({ type:'file', path: rel })} />
  if (st.error) return <FallbackChip alt={alt} rel={rel}
                    onClick={ctx.onArtifactClick && (() => ctx.onArtifactClick({type:'file',path:rel}))} />
  return <span>{alt || '…'}</span>                              // 流式/加载中占位
}
```

`classify`：`data:`→data；`http(s)://`→http；`javascript:|vbscript:|…`→invalid；否则 local。

### 4.4 关键设计点（7 条补充，前 2 条本轮新发现）

1. **绝对路径先转相对**（否则章鱼那条修不好；server 只认相对、`path.join` 会拼坏绝对路径）。
2. **workspace 限定是 server 强制的**（`containsPath`），不只是加固——workspace 外图天然无法内联，**必须**落 C 兜底。
3. **流式期**：半截 src 解析失败 → 显 alt 占位（不显刺眼 `❓`）；`useEffect` 依赖 `key`，src 补全后 key 变化自然重试，无需定时器。
4. **module 级缓存** data URI（PNG 有 ~645KB base64，避免每 token 重渲染重复拉）。可选 LRU 上限（P2）。
5. **点击放大 = `onArtifactClick({type:'file',path:rel})`** → 触发**现有** `ArtifactPreview`，零新 UI/lightbox。
6. **非聊天场景惰性**（`about-legal` 无 `workspaceDir` → 不解析、显 alt）。
7. **协议白名单**与现有 `MarkdownLink` 一致（拒 `javascript:` 等），保持 `transcript-links.test.tsx` 守的安全门不回归。

### 4.5 rich-output 引导（软手段，D）

在 output_format 段追加一句（大意）：引用工作区生成的图片时用 workspace 相对路径的 markdown 图片 `![说明](文件名.svg)`，不要用绝对路径。属 vendor patch 增量，走既有 `experimental.rich_output` 开关。减少绝对路径产出，但**不作主修**（模型可能忽略、修不了历史内容）。

## 五、否决 / 非目标

- **否决 Option B（Tauri asset protocol + `convertFileSrc`）**：只在 Tauri 原生窗口成立，Vite web / Playwright e2e 失效；还要放开 CSP `img-src`、配 scope、处理跨平台路径。移动件多、可测性差。
- **否决 D 作主修**：提示词不可靠、修不了历史。仅作软手段。
- workspace 外本地图**刻意不内联**（`containsPath` 强制，安全优先），只给 chip。
- 大图不做压缩/缩略（P2 可选）。
- 不改产物扫描/归属。

## 六、改动量与风险

- **改动：中偏小、高度局部化**（聊天 markdown 渲染层）：1 个新小组件 + Context 透传（保持 `MARKDOWN_COMPONENTS` 模块级常量不破坏现有 memo）+ 2 处 props 透传 + 1 行插件引导 + 测试。无架构/Tauri 配置/server 路由/依赖变更。
- **风险：低到中**。主要风险=流式闪烁 & 大图性能（§4.4-3/4 覆盖）；安全面不扩大（相对路径 + 协议白名单 + server `containsPath` 三重）；纯渲染增强、可回退、必要时可挂 kill switch。

## 六点五、实现后复审发现（2026-07-22，自动化验证抓出）

初版实现（D1–D4）后做多角度复审 + 自动化验证，抓出 **2 个真实缺陷 + 1 个测试缺陷**：

1. **⭐ react-markdown `urlTransform` 清空 data:/Windows 路径（真实缺陷）**：默认 `defaultUrlTransform` 在 src 到组件前把 `data:` URI 与 `C:\` 盘符路径**清空为 `""`**（实测 probe：`data:image/png…`→`""`、`C:\Users\…`→`""`、`C:/Users/…`→存活、`/Users/…`→存活、`javascript:`→`""`）。→「base64 直出」「Windows 本地图」初版**根本不显示**。修=聊天 `MarkdownContent` 传自定义 `urlTransform`（保 `data:image/` + Windows 盘符，其余交默认）。见 ADR-065 D3.5。
2. **classify 误判 Windows 盘符为 scheme（真实缺陷）**：`C:\` 命中 `^[a-z]:` → 被判 blocked。修=盘符分支前置于 scheme 拦截。
3. **wiring 测试 mock 致无限渲染循环（测试缺陷，非产品）**：mock `useApi:()=>({getFileContent})` 每渲染返回新对象 → `useEffect` 的 `api` dep 每次变 → 死循环（真实 `useApi` connector 记忆化稳定）。修=mock 返回稳定对象。**顺带印证**：真实 `useApi` 必须稳定，否则会循环——已确认 `handleArtifactClick` 亦 `useCallback` 稳定。
4. **已知边界**：markdown 把 `\` 当转义符 → 纯反斜杠路径 `![](C:\a\b.png)` 解析即坏 → 优雅降级 chip。可存活=相对 + 正斜杠绝对。

自动化验证手段：`markdown-image-wiring.test.tsx`（真 `MarkdownContent` 管线，非隔离组件）+ react-markdown urlTransform 实测 probe + 早先对活服务器 `/file/content` 实测 base64 + 719 全绿 + typecheck 8/8。

## 七、验证清单

- 单测：`MarkdownImage`（data/http 直出、js 拒、本地相对成功、绝对内成功、绝对外兜底、空/非图兜底、无 workspaceDir 惰性、点击回调、缓存命中不二次请求）；`path-utils.toWorkspaceRelative` 分支；`transcript-links` 安全不回归。
- 真机（我给可测点，视觉归用户）：重发「画个章鱼/虎鲸」内联出图非 `❓`；相对 `orca_preview.png` 与绝对 `.svg` 都显示；点内联图开右侧预览；造 workspace 外绝对路径→兜底 chip；造远程 `https://…png` 与 `data:…` 均直出；about-legal 不受影响。
