# spec_lock.md 格式 + tokens.css 派生规则

spec_lock 是**执行契约**：设计确认后一次写定，之后每批页面生成前重读，所有颜色/字号/风格判断只能来自它——这是长 deck 对抗上下文漂移的核心机制。

## spec_lock.md 模板（逐节填写）

```markdown
# spec_lock — <deck 标题>

## Style
- 风格：<design-styles 里选定的风格 id> · 一句气质定位
- 关键纪律：<从风格文件抄 3-5 条本 deck 最相关的>

## Canvas
- 1280×720 · 页边距 64px · 8px 间距模数

## Colors（唯一 HEX 来源）
| 变量 | 值 | 用途 |
|---|---|---|
| --c-bg | #XXXXXX | 页面底色 |
| --c-bg2 | #XXXXXX | 次级底/分区底 |
| --c-primary | #XXXXXX | 主色：标题、深色底、结构元素 |
| --c-accent | #XXXXXX | 强调：关键数字/强调词，每页 ≤2 处 |
| --c-muted | #XXXXXX | 弱化：辅助线、次级标签 |
| --c-text | #XXXXXX | 正文墨色 |
| --c-on-dark | #XXXXXX | 深色底上的文字 |
- 色彩论证：一句话说明主色/强调色为何是它（品牌/内容/语境来源）。写不出这句 = 在抄配方，重推。

## Typography
- 字体栈：--font-stack（西文在前中文在后，见 typography-cjk.md）
- 字号 ramp：--fs-display / --fs-h1 / --fs-h2 / --fs-h3 / --fs-body / --fs-num / --fs-caption
- 字重：仅 300/500/700；中文强调靠字重 + accent 色，禁斜体

## Page Plan（逐页节奏表，来自 outline.json）
| 页 | rhythm | layout | 一句主旨 |
| ... |

## Forbidden
- 任何 palette 外颜色（字面 hex/rgb/hsl/渐变）· ramp 外字号 · 斜体 · emoji
- breathing 页卡片网格 · box-shadow · 标题下划线 · 圆角卡片铺满网格
- <可加风格专属禁项>
```

## tokens.css 派生（机械转换，写完 spec_lock 立即做）

把 Colors + Typography 两节转成一个 `:root` 块存 `<project>/tokens.css`，是 deck 里**唯一**允许出现字面 HEX 的地方：

```css
:root{
  --c-bg:#FBF9F4; --c-bg2:#F1EDE3; --c-primary:#14424E; --c-accent:#C75B12;
  --c-muted:#6E8887; --c-text:#1C1B18; --c-on-dark:#F7F4EC;
  --font-stack:"Helvetica Neue","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  --fs-display:64px; --fs-h1:44px; --fs-h2:30px; --fs-h3:24px;
  --fs-body:21px; --fs-num:80px; --fs-caption:14px;
}
```

规则：
- 七个 `--c-*` 与七个 `--fs-*` + `--font-stack` 一个不能少（shell.html 结构层依赖它们）
- 深色风格（如 tech-dark）把 --c-bg 设为深色、--c-primary 相应调整即可，结构层不用改
- 字号 ramp 可按风格微调（±4px 级），但生成开始后**永不再动**

## 色彩推导协议（写 Colors 前走三步）

1. **采样**：主色来自品牌资产 / 内容语境 / 文化色彩记忆，不凭空发明
2. **收敛**：2-3 个有彩色 + 中性明度序列，避开禁用色（见 content-guidelines.md）
3. **论证**：写出「为什么是这个色」一句话进 spec_lock
