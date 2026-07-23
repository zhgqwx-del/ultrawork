# Research — Lumo 口袋投影仪发布（showcase）

> **本 example 是一个明确虚构的产品发布**：产品「Lumo 口袋投影仪」、品牌「Lumo Labs」、
> 全部规格/价格/用户引言均为演示用虚构值（scenario），**不对应任何真实产品或公司**。
> 用于示范 `mode=showcase` + `delivery_purpose=presentation`（投影远观、通风、亮点节奏）的形态，
> 与 http-caching-primer（document 密集）、platform-migration-brief（document 通报）形成
> **消费距离三档对照**——同为门禁全绿，但 presentation 档正文最短、每页要点最少、留白最多。

## 为什么 presentation 档
- 发布会 deck 投影给一屋子人远观 → `delivery_purpose=presentation`：`p` ≤26 视觉宽、
  S03 ≤4 点、S10 ≤5 行（对比 document 档 42/5/8）。airy 是**主动追求**的亮点节奏，不是内容被砍。
- 与 mode 正交：`showcase` 只决定页序（悬念→亮点→规格→CTA）与语气（短促有力），**不碰密度**；
  密度由 presentation 档驱动。

## 数据来源
- 全 scenario（虚构产品）：无外部可溯源事实，`facts.json` 为空数组；evidence 用
  `{"scenario":true}`（虚构规格）/`{"source":"user-doc"}`（内部产品定义稿）。
  每个数据页页脚渲染可见「示意数据/虚构产品」标注（validate_deck E10 硬校验）。

## 容量估算（§5.1）
- 档位 = presentation（远观）；亮点页每页 ≤4 点、正文 ≤26 视觉宽 → 刻意留白，一页一亮点。
  规格表 ≤5 行足够承载核心参数，不堆细节（细节留给产品页/文档档 deck）。
