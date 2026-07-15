# 041 — 繁体中文支持 + 通用页开关控件升级

> 状态：**✅ 已实现**（D1 toggle + D2/D3 繁体中文构建期生成，ADR-058）· 2026-07-15
> 范围：① 通用设置页布尔项 `checkbox → toggle 开关`（主题选择器**不动**，仍为文字按钮）；② 新增**繁体中文**语言，走**运行时简→繁转换**（简体词典维持唯一 SSOT）。
> 决策定档（用户拍板）：通用页**只换 toggle**、繁中走**运行时转换（方案 A）**、**先出文档再实现**。
> **调研修正（2026-07-15）**：转换器一节经调研从「运行时转换 A」改为「**构建期代码生成 A′**」——见 §六。ADR-058 记最终决策。

---

## 一、缘起

一张参考截图（"其他产品/改版稿"的「设置 · 偏好」页）与当前实现对照，暴露两个点：

1. 通用页的开关项当前是**原生 checkbox（方块打勾）**，参考稿是 **iOS 风格滑动开关（toggle）**。
2. 顺带提出：需要**繁体中文**。

---

## 二、通用页开关控件升级

### 2.1 现状（已核）

`packages/client/desktop/src/pages/Settings.tsx` 的 `GeneralSection`（`:169`）里，**4 个即时生效的布尔项**用原生 checkbox 渲染：

| 项 | config key | 位置 |
|---|---|---|
| 出现任务规划时自动展开侧栏 | `planAutoReveal` | `Settings.tsx:227` |
| 提示音 | `notifySound` | `Settings.tsx:252`（map 循环） |
| 系统通知 | `notifySystem` | 同上 |
| 图标提醒 | `notifyFlash` | 同上 |

四处都是 `<input type="checkbox" ... onChange={e => updateConfig({...: e.target.checked})} />`。

### 2.2 为什么换 toggle（不是纯审美）

- **语义正确性**：这几项是"开/关、立即生效"的二元状态（`onChange` 直接 `updateConfig`，无表单提交）。checkbox 的约定语义是"从一组里勾选/暂存待提交"；toggle 才表达"开关，立即生效"。macOS/Windows 系统设置里这类项一律是 toggle。
- **与参考稿一致**：视觉对齐主流产品设置页。

> 主题选择器（浅/深/跟随系统，`Settings.tsx:181`）**本轮不动**——保持文字按钮；参考稿的"预览缩略卡片"属锦上添花，留待后续视觉专项。

### 2.3 做法：抽共享 `<Toggle>` 组件（关键 = 一致性）

**不要就地在 GeneralSection 塞一个 toggle**，否则项目里 checkbox / toggle 混用更乱。做成受控组件放 `components/ui/toggle.tsx`：

```tsx
// 受控、无障碍（role=switch + aria-checked）、键盘可达
export function Toggle({ checked, onChange, id, disabled }: {
  checked: boolean
  onChange: (v: boolean) => void
  id?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} id={id} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]",
        checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <span className={cn(
        "inline-block size-4 rounded-full bg-white transition-transform",
        checked ? "translate-x-4" : "translate-x-0.5"
      )} />
    </button>
  )
}
```

GeneralSection 里把 4 个 `<input type=checkbox>` 换成 `<Toggle checked={config[key]} onChange={v => updateConfig({[key]: v})} />`，label/hint 结构不变。行位置从「label 内联 checkbox」调整为「label 文字 + 右侧 toggle」两端对齐（截图布局）。

### 2.4 影响面 / 测试

- 仅 renderer，无 Rust / 无 vendor。
- 现有测试若断言 `input[type=checkbox]`（`settings` 相关 test）需改选择器为 `role=switch`。
- **一致性欠账登记**：其它设置页仍有 checkbox（如需统一，后续用同一 `<Toggle>` 收敛）——本轮不扩散，只登记。

---

## 三、繁体中文（方案 A：运行时简→繁转换）

### 3.1 现状（已核）

- i18n 是扁平字典 `translations: Record<Language, Record<string,string>>`（`lib/i18n-context.tsx:16`），`Language = "en" | "zh"`（`:4`）。简体词典 **735 个 key**。
- `t()`（`:1728`）：`translations[language]?.[key] || key`，再做 `{param}` 插值。
- 默认语言检测 `config.ts:57` `detectDefaultLanguage()`：`navigator.language.startsWith("zh") → "zh"`，否则 `"en"`。默认值 `config.ts:70`。
- `"en"|"zh"` 联合类型散落 **4 处**：`config.ts:17`（类型）+ `:57`（detect 返回）、`i18n-context.tsx:4`、`settings-popover.tsx:53`（cast）、`Settings.tsx:213`（cast）。
- 语言选择器两处：`Settings.tsx:203`（`grid-cols-2` 两个硬编码按钮）、`settings-popover.tsx`（Select）。
- **无任何转换依赖**。

### 3.2 为什么选运行时转换（A）而非独立词典（B）

| | A 运行时转换（选） | B 独立繁体词典 |
|---|---|---|
| 维护 | 简体单一 SSOT，新增 key 繁体自动覆盖 | 735 key 翻倍，每加简体键要同步繁体键 |
| 术语精度 | 靠"字形转换 + 术语覆盖表"，UI 高频词 ~30 个覆盖 95% | 人工可润色，最精准 |
| 依赖 | 引入转换器 | 无运行时依赖 |
| 风险 | 长尾术语/歧义字偶有瑕疵 | key 漂移（漏译）需门禁兜 |

务实取 A；将来要营销级 zh-TW，可把转换结果 dump 出来人工润色，平滑升级到 B。

### 3.3 架构

**语言标识**：`Language` 扩为 `"en" | "zh-Hans" | "zh-Hant"`。
- 词典仍只有 `en` + `zh-Hans`（把现有 `zh` 词典键名改为 `zh-Hans`）。
- **旧配置迁移**：持久化里存的老值 `"zh"` → 读取时归一到 `"zh-Hans"`（老用户保持简体不变，零感知）。在 config 载入处做一次 `language === "zh" ? "zh-Hans" : language`。

**转换层**：在 `t()` 里对 `zh-Hant` 分支转换：

```ts
// 伪代码
const raw = translations[baseLang(language)]?.[key] || key   // baseLang: zh-Hant → zh-Hans
let value = raw
if (language === "zh-Hant") value = toTraditional(raw)       // 转换 + 术语覆盖
// 再做 {param} 插值（顺序：先转换后插值，避免把 param 值也转了——param 多为路径/数字，转换器对非中文无副作用，但顺序上仍先转模板）
```

`toTraditional`：
1. **术语覆盖表优先**（手维护，最高优先级）：`软件→軟體`、`界面→介面`、`文件→檔案`、`视频→影片`、`默认→預設`、`屏幕→螢幕`、`智能→智慧`、`质量→品質`、`信息→資訊`、`网络→網路`、`程序→程式`、`登录→登入`、`回车→輸入`…（UI 里出现的先补，边用边加）
2. **字形转换兜底**：候选 `opencc-js`（准，但字典数据体积偏大，需评估打进 bundle 的成本）或裁一张精简 简→繁 字表（体积小，覆盖常用字即可）。**实现时先评估两者体积/准确度再定**——这是方案 A 唯一需要落地时验证的技术点。

**转换缓存**：`t()` 高频调用，`toTraditional(raw)` 对同一 `raw` 结果稳定 → 用 `Map<string,string>` memo，key 为原文。

### 3.4 UI/UE 改动清单

| 位置 | 改动 |
|---|---|
| `i18n-context.tsx:4` | `Language` 加 `zh-Hant`；`zh` 词典改名 `zh-Hans`；`t()` 加转换分支 + memo |
| `config.ts:17/57/70` | 类型加 `zh-Hant`；`detectDefaultLanguage`：`zh-TW`/`zh-HK`/`zh-Hant`/`zh-MO` → `zh-Hant`，其余 `zh*` → `zh-Hans`；旧 `"zh"` 迁移 |
| `Settings.tsx:203` | 语言按钮 `grid-cols-2 → grid-cols-3`，加「繁體中文」 |
| `settings-popover.tsx:53` | Select 加 `zh-Hant` 项；cast 更新 |
| 4 处联合类型 cast | `"en"|"zh"` → 三值 |
| e2e / 单测 | `settings-popover.test` 断言语言项数（当前假定）；加 `t("...", zh-Hant)` 转换单测（覆盖表命中 + 字形兜底） |

### 3.5 验证

- 单测：术语覆盖表每条命中；一段含 `软件/界面/默认` 的串转换后为 `軟體/介面/預設`；未覆盖字走字形转换。
- 真机（用户走查）：切繁中，扫一遍设置页/首页/会话，看有无生硬简体残留或误转（专有名词、代码块中的简体如被误转要排除——注意：**代码/路径/英文** 不应过转，术语表只作用于 UI 文案，`t()` 的 value 才转，用户输入与代码不经 `t()`，天然隔离）。

---

## 四、工作量与顺序

1. **通用页 toggle**（~1–2h）：`ui/toggle.tsx` + GeneralSection 替换 + 改测试。独立、低风险，可先做。
2. **繁中**（~半天）：转换器选型/体积评估是唯一变量；其余是机械改动 + 覆盖表。

两件互不依赖，可分两个 commit。收尾时补 ADR（繁中的运行时转换是架构决策，值得 ADR；toggle 属小改动可并入 CHANGELOG）。

---

## 五、未决 / 待实现时定

- 术语覆盖：opencc `twp` 已覆盖大部分台式词汇（见 §六），override 词典只补它转错的 app 专有词——真机走查时补。
- 是否给繁中单独的默认检测优先级（台港系统 `navigator.language` 通常已是 `zh-TW`/`zh-HK`，detect 直接命中）。

---

## 六、调研结论：转换器从「运行时 A」改为「构建期生成 A′」

> 用户问「方案是否完备、要不要进一步调研」时补做的功课。结论：转换器不是实现细节，而是**分叉架构的真决策**，且原方案 A 不是最优。

**调研事实**（`opencc-js`，npm，nk2028）：

1. `Converter({ from: 'cn', to: 'twp' })` 的 **`twp` 预设 = Taiwan + phrases**，本身就做台式词汇/短语转换（`自行车→腳踏車`、`软件→軟體`、`界面→介面`、`默认→預設`…）⇒ **原方案里那张手维护 30 词术语表绝大部分是多余的**，opencc twp 已覆盖，只剩极少 app 专有词需 override（用 `ConverterFactory(from, to, [customDict])`）。
2. **能在 Node/bun 构建脚本里跑**（无原生二进制、字典 build-time 打包）⇒ 解锁一个原方案漏掉的更优架构。

**A′ 构建期代码生成（最终选）vs A 运行时转换：**

| | A 运行时转换（原） | **A′ 构建期生成（选）** |
|---|---|---|
| opencc 位置 | 打进客户端 bundle（字典数据数百 KB~MB） | 仅 **devDependency**，不进产物 |
| 运行时成本 | 每次 `t()` 转换（靠 memo 摊薄） | **零**（直接查静态繁体词典） |
| SSOT | zh-Hans | zh-Hans（不变） |
| 繁体产物 | 运行时算，不可见 | `scripts/gen-zh-hant.ts` 用 `s2twp` 从 zh-Hans 生成、**提交进仓库、可人工点修** |
| 漂移防护 | 无 | CI/`check-docs` 重生成比对（改了简体没重生成 → 失败），贴合既有模式 |

对桌面应用尤其划算：不给客户端塞转换器/字典、零运行时开销、繁体产物可 review 可 spot-fix。

**A′ 落地形态**：
- `scripts/gen-zh-hant.ts`（`bun run --bun`）：读 `i18n-context.tsx` 的 `zh-Hans` 词典 → 逐值 `Converter({from:'cn',to:'twp'})` + app override 词典 → 写入生成产物（独立 `i18n-zh-hant.generated.ts`，`translations["zh-Hant"]` 从它导入，保持 `i18n-context.tsx` 里 zh-Hans 为唯一手写源）。
- `opencc-js` 进 **devDependencies**（构建期），不进 renderer bundle。
- `check-docs.ts` / CI 加一步：重跑生成，`git diff --exit-code` 生成产物 → 防「改了简体忘了重生成繁体」。

§三 里原 A 的"运行时 `t()` 转换 + memo"作废；`t()` 分支只需 `translations["zh-Hant"]?.[key]`，与 en/zh-Hans 完全同构（无特殊路径）。§3.4 的 UI/UE 改动清单不变。
