# 050 — deckcraft deck 应用内预览底部大片可滚动空白

> 状态：**🟢 根因已实证确认 · 方案 A（`zoom`）已实现并通过双引擎回归 · 真机 UI 观感待用户** · 2026-07-22
> 实现：`shell.html`（fit 脚本 `transform:scale`+负 margin → `zoom` · `.stage` margin:0 auto 居中 · `@media print` `#stage{zoom:1!important}`）+ 重打包 `skills-builtin.zip`（构建期 `beforeBuildCommand` 自动从源重生成）+ 重建示例 fixture `examples/ai-coding-pilot/deck.html` + 更新 e2e `html-preview-iframe.e2e.ts`（断言改 zoom + 新增「无底部空白」门禁）。零业务 TS 改动（预览组件 `artifact-preview.tsx` 未动）。决策：方案 A `zoom` · 老 deck 不兜底 · PDF 经用户共识非缺陷。
> 范围：定位「deckcraft 生成的 deck 在应用内预览时底部多出大片可滚动空白，而直接打开文件正常、其他会话的独立 HTML 也正常」的根因，验证方案完备性/隔离性/通用性，给出可执行设计。先出方案不改代码。
> 依据：根因为**真实产物 + 真浏览器布局测量 + 派生脚本源码**，非凭印象。问题 2（教学课件内容单薄）不在本讨论范围，另行处理。

---

## 一、缘起

用户用 deckcraft 做 PPT（如「洛必达法则求未定式极限」教学 deck），在应用内预览 **HTML / PDF** 产物时，发现**底部多出很多空内容、可以滑动滚动**；但在文件目录里直接打开同一 PDF/HTML 却正常；且在其他会话中单独生成的 HTML 产物也没有此问题。用户要求先定位根因再形成方案，不先改代码。

本讨论确认：**HTML 预览的底部空白是确定性缺陷**，根因量化；**PDF 文件本身干净**（另见 §五）。

## 二、根因（真实产物 + 浏览器测量，闭合链条）

**根因**：deckcraft 的 `assets/templates/shell.html` 屏幕适配（fit）脚本用 **`transform: scale(s)` 缩放整个舞台 + 负 `marginBottom` 补偿**。但 `transform` 不改变元素的布局盒子尺寸，负 margin 又**无法减小 `scrollHeight`** → 文档可滚动高度停在**未缩放**的全尺寸 `h`，而肉眼可见的 deck 只到 `s·h`，末尾残留 **`(1−s)·h`** 的空白可滚动区（预览里表现为深色 `#3a3a3a` 舞台底色）。

### 涉及代码

`skills/builtin/deckcraft/assets/templates/shell.html`：

```css
/* 结构层 */
html,body{background:#3a3a3a}
.stage{width:1280px;margin:0}
.slide{width:1280px;height:720px;...;margin:24px 0}
```
```js
/* 屏幕预览 fit 脚本（shell.html:48-70） */
function fit(){
  if (!h) h = st.scrollHeight;               // 缓存未缩放全高
  var vw = document.documentElement.clientWidth;
  var s = Math.min(1, (vw - 32) / 1280);     // 预览面板 <1312px 时 s<1
  st.style.transformOrigin = "top left";
  st.style.transform = "translateX(" + ((vw - 1280 * s) / 2) + "px) scale(" + s + ")";
  st.style.marginBottom = (-(1 - s) * h) + "px";   // ← 想收回空间，但 scrollHeight 不认负 margin
}
```

`marginBottom` 负值只把 body 的**高度**拉低，但 `.stage` 的布局盒子仍实打实占到 `h`（transform 视觉缩小、布局不变），这部分溢出仍计入视口 `scrollHeight` → 空白不消。

### 证据链（真实 `lhopital-rule.html`，14 页，真 Chrome 无头测量）

| 预览宽度 vw | 缩放 s | `body.scrollHeight` | 末页视觉底部 | **末尾空白** |
|---|---|---|---|---|
| 1188（典型面板宽） | 0.903 | 10392（=未缩放全高） | 9409 | **983 px** |
| 1000（更窄） | 0.79 | 10392 | 7883 | **2509 px** |
| 1400（s=1，不缩放） | 1.0 | 10392 | ~10392 | ~0 |

- 空白严格 = `(1−s)·h`：**越窄缩放越多、空白越大**，与 fit 脚本的 `-(1-s)*h` 补偿量吻合。
- 同测得 `scrollHeight(10392) == offsetHeight(10392)` → **排除** margin-collapse 等干扰，锁定为「负 margin 补偿对 scrollHeight 无效」。
- 用例子 deck（10 页）复测规律一致（vw=1188→694px、900→2363px、700→3522px），非单一产物偶发。

### 为什么"直接打开文件正常""独立 HTML 正常"

- **直接打开**：浏览器窗口通常 ≥1312px 宽 → `s=1` → 不缩放 → 无空白。应用内预览面板（半栏/全栏都 < 1312）→ `s<1` → 有空白。**这正是"文件正常、预览异常"的分水岭**，不是文件坏。
- **独立 HTML**：没有 `stage`/`transform:scale`/负 margin 这套机制 → 无此问题。缺陷锁定在 deckcraft 特有的 fit 脚本。

## 三、方案（改 fit 脚本：`transform:scale` + 负 margin → `zoom`）

**核心思路**：换用 `zoom: s`。`zoom` 会**同时缩放布局与绘制**，`scrollHeight` 自动 = `s·h`，无需负 margin、无需 `translateX` 居中（`margin:0 auto` 即可）、**无需缓存 `h`**。

### 3.1 拟改内容（示意，最终以实现 diff 为准）

`shell.html` 结构层与 fit 脚本：

```js
function fit(){
  var vw = document.documentElement.clientWidth;
  var s = Math.min(1, (vw - 32) / 1280);
  st.style.zoom = String(s);        // 缩放布局+绘制，scrollHeight 随之正确
}
```
```css
.stage{width:1280px;margin:0 auto}   /* zoom 后仍按视口居中 */
```

`@media print` **必须同步中和新属性**（这是唯一跨路径义务，见 §四）：

```css
@media print{
  ...
  #stage{zoom:1!important;margin:0!important}   /* 取代原 transform:none!important */
}
```

### 3.2 候选方案对比（两者均实测能消除空白）

| 方案 | 做法 | 实测 scrollHeight | 残留空白 | 评价 |
|---|---|---|---|---|
| **A. `zoom:s`（推荐）** | zoom 改布局，scrollHeight 自动正确；删负 margin/translateX/`h` 缓存 | 9385 | −22px(≈0) | 最简、少 3 个易错点、**顺带消除 `h` 时序隐患**（见下）；`zoom` 非标准属性但本项目只跑 WebKit/WebView2/WebKitGTK 全支持 |
| B. `overflow:hidden` 裁剪容器 + 显式设高 `s·h` | 保留 transform，外套容器裁掉溢出、把可滚动高度钉到视觉高度 | 9385 | −24px(≈0) | 纯标准 CSS 更保守；需加一层 DOM + print 重置容器；仍依赖 `h` 缓存 |

**推荐 A** 的额外收益：现脚本 `if(!h) h = st.scrollHeight` 若在**字体/图片解码完成前**被首次采集会算错 `h`，负 margin 随之偏差——这是一个潜在时序隐患。方案 A 完全不使用 `h`（zoom 自动 reflow），一并消除。

### 3.3 双引擎验证（推荐方案 A）

在真实 `lhopital-rule.html`、vw=1188 下用 Playwright 实测运行时替换为 `zoom`：

| 引擎（对应真机） | 改前 scrollHeight | zoom 后 scrollHeight | 末尾空白 |
|---|---|---|---|
| Chromium（Windows WebView2 / Linux WebKitGTK 近似） | 10392 | 9385 | −22px |
| WebKit（macOS WKWebView） | 10392 | 9385 | −22px |

两引擎行为一致，`zoom` 在 macOS 真机引擎上可用。

## 四、完备性 / 隔离性证明（修复只碰预览，不动派生路径）

`deck.html` 被多条路径共用。已核对源码，**除预览与 PDF 外，其余路径都在装配时丢弃 fit `<script>`、在原生 1280×720/scale=1 下渲染**，故对 fit 脚本的改动**可证明中立**：

| 路径 | 是否运行 fit 脚本 | 证据 |
|---|---|---|
| **应用内 HTML 预览**（缺陷现场） | ✅ 运行 | `artifact-preview.tsx` iframe `srcDoc` 整份 deck |
| **PDF 导出**（`--print-to-pdf` 整份 deck） | ⚠️ 运行但被压制 | `@media print` `#stage{transform:none!important;...}`；**本方案改 zoom 后须改成 `zoom:1!important`** |
| 溢出探针 `probe_overflow.py` | ❌ 不运行 | 拆单页 `head+flat+sec+PROBE_JS+"</div></body></html>"`，fit 脚本在所有 `<section>` 之后 → 被排除（probe_overflow.py:116） |
| 截图/图片 pptx `export_deck.py --shots` | ❌ 不运行 | 同上拆单页装配（export_deck.py:151） |
| 可编辑 pptx `extract_layout.py` | ❌ 不运行 | 源码注释明写「the isolated page drops the screen-fit `<script>`, so every getBoundingClientRect is at scale 1 on an exact 1280×720 canvas」（extract_layout.py:5-6） |

**结论**：唯一需要一起改的是 `@media print` 的重置属性（PDF 是另一条会跑 fit 脚本的路径，靠它压制）。probe / 截图 / pptx 三条测量路径不受影响。

## 五、关于 PDF（如实记录，非本方案缺陷）

用户同时反映 PDF 预览也有底部空白。**实测 PDF 文件本身干净**：

- 真实 `lhopital-rule.pdf` = 14 页，每页精确 `960×540 pt`（= 1280×720px @96dpi，16:9），**无多余页、无多余空白**。
- 例子 `deck.pdf` 同样 10 页全 960×540 pt。
- `@media print` 已把屏幕 fit 逻辑压掉；`PdfView` 仅把每页 canvas 顺序堆叠（`pdf-view.tsx`），末尾无幻影空白。

**判断（已与用户共识，2026-07-22）**：PDF **不是同一缺陷**——用户真机确认目前看不是真缺陷。最可能是末页为收尾页（内容稀疏），在连续滚动视图里读起来像"多了空白"，但它在文件里也是同样稀疏的一页。不把 PDF 计入本方案，本方案只修 HTML 预览空白。

## 六、部署范围与注意事项

- **前向生效**：fix 改内置技能 `shell.html`，**只对之后新生成的 deck 生效**；已生成的老 deck（含本次 lhopital）不会自动变好，需重跑 `build_deck.py`+export 重出，或另行决定是否在预览层兜底老产物（老产物内嵌的是旧 fit 脚本，预览层无法无侵入改写自包含 `srcDoc`——倾向不兜底，说明即可）。
- **改完须重打包**：`shell.html` 属 `skills/builtin/` 树，改后 `bun run --bun scripts/pack-builtin-skills.ts` 重生成 `skills-builtin.zip`（首启解压源）。
- **`shell.html` 是标注"结构层禁止改动"的模板**：本次属于对结构层 fit 机制的定向修复，需在 SKILL.md/注释同步说明改动原因，避免后续误判为可回退。

## 七、回归清单（改后必过）—— ✅ 全通过（用新 shell 重建示例 10 页 deck，2026-07-22）

1. ✅ **预览空白归零**：Chromium + WebKit 双引擎，vw=1400/1188/1000/700 测得末尾空白 **−24/−21/−18/−13px**（≈0，负值=末页底边距），改前同宽度为 694/2363/3522px。
2. ✅ **横向居中**：各宽度 stage 左右边距相等（vw=1400 L=R=60；其余 L=R=16），`margin:0 auto`+zoom 居中正确。
3. ✅ **PDF 无回退**：`export_deck.py --pdf` → 10 页，每页 `MediaBox` 统一 960×540 pt（`@media print` 的 `zoom:1!important` 生效，PDF 未被缩放）。
4. ✅ **溢出探针无回退**：`probe_overflow.py` → 10 页 0 findings，exit 0。
5. ✅ **截图无回退**：`export_deck.py --shots` → 每页 1280×720。
6. ✅ **窗口缩放（动态 resize）**：sandboxed iframe 内 live 拖动 1400→800→1188，每次 fit() 重跑、zoom 更新、空白持续 ≈0、居中持续 true（新代码无缓存状态，resize 与初次挂载同构）。
7. ✅ **生产路径完全复刻**：`<iframe srcDoc sandbox="allow-scripts" size-full>` 内经 Playwright frame 访问测量，vw=1920/1312/1188/800/500 空白全 ≈0、居中 true，双引擎一致。
8. ✅ **e2e 门禁更新**：`html-preview-iframe.e2e.ts` 断言从 `transform:scale` 改 `zoom`，**新增「末页下方无空白 gap≤30px」断言**（旧机制此处 ~950px），双引擎 11/11 PASS；示例 fixture 同步重建。
9. ✅ **无回归**：typecheck 8/8 · desktop vitest **719/719** · 无其他测试耦合 fit 内部实现。

## 八、决策（已锁定，2026-07-22）

- [x] **§五 PDF** — 用户真机确认目前看不是真缺陷；本方案不含 PDF。
- [x] **方案 A（`zoom`）** — 采用；不走 B（裁剪容器）。
- [x] **老 deck 不做预览层兜底** — fix 前向生效，已生成的老 deck 需重跑 build/export 才受益。
- [ ] 实现落地后本讨论定稿；对结构层模板的定向修复建议开 ADR 留档。

---

## 附：测量方法（可复现）

真 Chrome / WebKit 无头加载 `file://…/lhopital-rule.html`，设 `viewport.width`、`deviceScaleFactor:2`，`await document.fonts.ready` + 300ms 后测：`body.scrollHeight`、末个 `.slide` 的 `getBoundingClientRect().bottom`、`#stage` 的 `scrollHeight/offsetHeight`、computed `transform/marginBottom`。候选修复在运行时把 `#stage` 的 `transform/marginBottom` 换成 `zoom` 后重测。脚本经 `playwright-core@1.61.1` + 系统 Chrome / ms-playwright WebKit。
