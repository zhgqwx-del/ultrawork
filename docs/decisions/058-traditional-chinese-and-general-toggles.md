# ADR-058：繁体中文（构建期简→繁生成）+ 通用页布尔项改 toggle 开关

- 状态：已接受（Accepted — **✅ 已实现**：D1 toggle + D2/D3 繁体中文构建期生成，desktop 632 测试 + typecheck + check-docs §9 漂移守卫全绿；**繁体全局视觉走查待用户执行**，Win/Linux CI 兜底）
- 日期：2026-07-15
- 背景调研：`docs/discussions/041-traditional-chinese-and-general-toggles.md`（含 opencc-js 调研实证）
- 相关：ADR-037（跨平台）· ADR-053（通知项即当前 4 个布尔项之三）· ADR-048（planAutoReveal）

## 背景

两件由一张参考截图（「其他产品/改版稿」的设置·偏好页）引出的事：

1. 通用设置页的**布尔开关项**当前用原生 `checkbox`（方块打勾）渲染，参考稿用 iOS 风格**滑动开关（toggle）**。
2. 需要新增**繁体中文**语言。

现状（已核对代码）：

- `Settings.tsx:169` `GeneralSection` 里 4 个**即时生效**的布尔项（`planAutoReveal` + `notifySound`/`notifySystem`/`notifyFlash`）都是 `<input type="checkbox" onChange={…updateConfig…}>`。
- i18n 是扁平字典 `Record<Language, Record<string,string>>`（`i18n-context.tsx:16`），`Language = "en" | "zh"`，简体 **735 key**；`t()`（`:1728`）= `translations[language]?.[key] || key` + `{param}` 插值。默认语言 `config.ts:57` 按 `navigator.language.startsWith("zh")`。`"en"|"zh"` 联合类型散落 4 处（`config.ts:17`、`i18n-context.tsx:4`、`settings-popover.tsx:53`、`Settings.tsx:213`）。**无任何转换依赖**。

## 决策

### D1：布尔项改 toggle，抽共享 `<Toggle>` 组件（不就地改）

这几项是「开/关、立即生效」的二元状态（`onChange` 直接 `updateConfig`，无表单提交）——`checkbox` 的约定语义是「从一组里勾选/暂存待提交」，`toggle` 才表达「开关，立即生效」（macOS/Windows 系统设置同此）。

- 新增 `components/ui/toggle.tsx`：受控组件（`checked`/`onChange`），`role="switch"` + `aria-checked` 无障碍、键盘可达、`focus-visible` ring，用现有 `--color-primary`/`--color-border` token。
- `GeneralSection` 4 处 `checkbox` 换成 `<Toggle>`，label/hint 结构不变，行改为「文案 + 右侧 toggle」两端对齐。

> **明确否决：就地在 GeneralSection 塞一个 toggle 而不抽组件。** 项目里其它设置页仍有 checkbox；不做成共享组件会造成 checkbox/toggle 混用，比现状更乱。共享组件是「日后统一收敛」的前提。
>
> **明确不做（本轮）**：主题选择器（`Settings.tsx:181`）保持文字按钮——参考稿的「明暗预览缩略卡片」属视觉锦上添花，需画 mockup，留后续视觉专项。其它设置页的 checkbox 本轮**不扩散替换**，仅登记为一致性欠账。

### D2：繁体中文 = 新增 `zh-Hant` 语言，简体仍是唯一手写 SSOT

`Language` 扩为 `"en" | "zh-Hans" | "zh-Hant"`：

- 现有 `zh` 词典键名改为 `zh-Hans`（唯一手写中文源，735 key 不复制）。
- **旧配置迁移**：持久化里老值 `"zh"` 读取时归一到 `"zh-Hans"`（老用户保持简体、零感知）——在 config 载入处 `language === "zh" ? "zh-Hans" : language`。
- `detectDefaultLanguage`（`config.ts:57`）：`zh-tw`/`zh-hk`/`zh-hant`/`zh-mo` → `zh-Hant`，其余 `zh*` → `zh-Hans`，非中文 → `en`。
- 语言选择器：`Settings.tsx:203` `grid-cols-2 → grid-cols-3` 加「繁體中文」；`settings-popover.tsx` Select 加项；4 处联合类型 cast 更新。
- `t()` 对 `zh-Hant` **无特殊路径**——与 en/zh-Hans 完全同构地查 `translations["zh-Hant"]?.[key]`（繁体词典由 D3 构建期产出）。

### D3：繁体词典 = 构建期 `opencc-js s2twp` 生成，不做运行时转换

调研（discussions/041 §六）确认两点，据此**否决原「运行时转换」方案，改为构建期代码生成**：

1. `opencc-js` 的 `twp` 预设（Taiwan + phrases）本身就做台式词汇/短语转换（`软件→軟體`、`界面→介面`、`默认→預設`…）⇒ 无需手维护大术语表，只需极小 app 专有词 override（`ConverterFactory(from, to, [customDict])`）。
2. `opencc-js` 能在 Node/bun 构建脚本里跑 ⇒ 可在**构建期**把简体词典转成繁体静态产物。

落地形态：

- `scripts/gen-zh-hant.ts`（`bun run --bun`）：读 `zh-Hans` 词典 → 逐值 `Converter({from:'cn', to:'twp'})` + app override 词典 → 写 `i18n-zh-hant.generated.ts`，`translations["zh-Hant"]` 从中导入。
- `opencc-js` 进 **devDependencies**——**不进 renderer bundle**、**零运行时开销**、繁体产物入库可 review/可人工 spot-fix。
- `check-docs.ts`/CI 加一步：重跑生成 + `git diff --exit-code` 生成产物，防「改了简体忘重生成繁体」漂移。

> **明确否决：运行时转换（把 opencc 打进客户端、在 `t()` 里转 + memo）。** 对桌面应用而言它平白给 bundle 塞数百 KB~MB 字典、每次 `t()` 付转换成本，且繁体产物不可见不可 review。构建期生成同样保持简体单一 SSOT，却零运行时代价、产物可审。
>
> **明确否决：独立手写繁体全量词典（735 key 再翻一份）。** 维护翻倍、每加简体键要同步繁体键；构建期生成从同源产出，key-completeness 自动满足。若日后要营销级 zh-TW 品质，可把生成产物人工润色（或扩 override 词典）平滑升级。

## 影响面

- **纯 renderer + 一个 build 脚本**，无 Rust、无 vendor patch。
- 新依赖：`opencc-js`（devDependencies）。
- 新文件：`components/ui/toggle.tsx`、`scripts/gen-zh-hant.ts`、`i18n-zh-hant.generated.ts`。
- 改动测试：断言 `checkbox` 的设置页 test 改 `role=switch`；`settings-popover.test` 语言项数 +1；加繁体生成/键完整性校验。
- 范围外（明确不做）：AI **回复内容**的语言（属 system-prompt/locale 议题，非 UI i18n）；主题预览卡片；其它设置页 checkbox 批量替换。

## 验证（实现时）

- Toggle：`role=switch`/`aria-checked` 无障碍 + 键盘 + 明暗主题；4 项开关读写 config 正确。
- 繁体：`gen-zh-hant.ts` 幂等（重跑无 diff）；抽查 `软件/界面/默认` → `軟體/介面/預設`；切三语无 key 残缺（fallback 到 key）。
- 真机（用户走查）：切繁中扫设置页/首页/会话，看有无误转/生硬简体残留（代码/路径/用户输入不经 `t()`，天然不被转）。
- typecheck + desktop 测试全绿。

## 收尾时更新

- 实现后本 ADR 状态改为「✅ 已实现」+ 真机结论。
- `CHANGELOG.md`、`AGENTS.md`（新 Key Files：toggle.tsx / gen-zh-hant.ts）、`document-map.md`（文件计数）、`decisions/README.md` 索引。
