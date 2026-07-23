# Research — 内部平台迁移季度进展通报（briefing）

> **本 example 全部为演示用虚构数据（scenario）**：迁移进度、完成度、负责人、里程碑、风险
> 均为示例语料，用于示范 `mode=briefing` + `delivery_purpose=document` 的高密度事实通报形态，
> **不对应任何真实系统或组织**。因此没有外部可溯源事实，`facts.json` 为空数组；
> 每条 evidence 用 `{"scenario":true}`（虚构值）或 `{"source":"user-doc"}`（内部通报口径），
> 每个数据页页脚渲染可见「示意数据」标注（validate_deck E10 硬校验）。

## 为什么用 scenario 而非真实事实
- briefing（进展通报）本质是**内部私有数据**：迁移完成度、负责人、排期不可能有公开 URL 溯源。
- 这正是 evidence 契约里 `scenario` / `user-doc` 两类来源的设计场景——与 http-caching-primer
  （全真实标准、`fact_id` 溯源）形成对照，两个 example 覆盖 evidence 契约的两端。

## 容量估算（§5.1）
- 档位 = `document`（通报讲义近读）；表格/时间线为主，正文页 ~5 页承载 6 域 × 4 列进度 +
  4 个季度里程碑 + 6 项完成/协调 + 3 项风险 → 信息密度饱满且不溢出（probe 兜底）。
- 数据全 scenario：无 research 供给瓶颈，密度由 document 档双边带上界承载。
