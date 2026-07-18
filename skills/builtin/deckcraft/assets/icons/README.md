# deckcraft 图标库 — tabler-outline（stroke 线性风格，viewBox 0 0 24 24）

来源：Tabler Icons（MIT，https://tabler.io/icons），经 ppt-master（MIT）转拷。

## 用法（生成页面时）

1. 按英文语义关键词检索（不要 glob 全目录）：
   `ls ${SKILL_DIR}/assets/icons/tabler-outline/ | grep -i <keyword>`
   常用词根：chart / arrow / check / alert / user / settings / rocket / shield / clock / database / cloud / code
2. Read 选中的 .svg，**内联**到页面 HTML 中（不要用 <img src> 引外部文件——deck.html 必须自包含）。
3. 内联时把 stroke 色改为 CSS 变量：`stroke="currentColor"` 并在容器上设
   `color:var(--c-muted)`（或 --c-primary/--c-accent，遵守 accent 每页 ≤2 处）。
   禁止硬编码 hex（validate E1 会拦）。
4. 尺寸用 width/height 属性控制（24/32/48px 档），保持线宽视觉一致：同页图标同尺寸。

## 纪律

- 每页图标 ≤4 个；图标是辅助语义不是装饰，可有可无时选无（反 slop）。
- 全 deck 只用这一个库（风格一致性）；品牌 logo 走 scripts/fetch_assets.py。
