# 质量门禁 / 完成定义 (Quality Gates)

<!-- last-synced: 2026-06-27 -->

> 一页式 checklist：一处改动在"算完成 / 可合入 / 可收尾"之前必须满足的条件。
> 背景：本项目主要由 AI（Claude Code）开发，没有人类的隐性"完成感"。显式门禁让每次改动有统一、可对照的标准，避免漏项。
> 测试运行方式见 `docs/testing.md` / `docs/getting-started.md`，本文只列"必须过什么"。

---

## 0. 适用范围

| 改动类型 | 必过门禁 |
|---------|---------|
| 纯文档 | §1 文档门禁 |
| 代码改动（bug fix / 小改） | §2 代码门禁（相关包）+ §1 |
| 新模块 / 里程碑 / 技术迁移 | §2 + §3 状态门禁 + §1 + 收尾流程（CLAUDE.md）|

---

## 1. 文档门禁

- [ ] 新增/移动文档已登记到 `docs/document-map.md` 与对应索引（ADR → `decisions/README.md`，discussion → `discussions/README.md`）。
- [ ] 没有把"稳定的团队知识"只写进本地 MEMORY（应进 git，见 CLAUDE.md §记忆与文档分工）。
- [ ] 同一事实未产生新的"无主副本"——要么放进 SSOT，要么放摘要 + 指针。
- [ ] `bun run --bun scripts/check-docs.ts` 通过（ADR 计数一致、引用路径存在、MEMORY < 200 行）。

## 2. 代码门禁

- [ ] **TypeCheck 全绿**：`bun run --bun turbo run typecheck`（5/5 包）。
      改了 `api-client` 类型须先在其中 `tsc --build` 再检查 client（见 `gotchas.md` §1）。
- [ ] **相关包单测通过**：
      - Desktop：`cd packages/client/desktop && bun run --bun vitest run`
      - Gateway：`cd packages/channel/gateway && bun run --bun vitest run`
      - Knowledge：`cd packages/knowledge/sidecar && bun run --bun vitest run`
- [ ] 改了 **Gateway** 源码 → `bun run build:gateway` 重编译 sidecar（否则不生效）。
- [ ] 改了 **vendor/opencode** 源码 → 重新生成 patch 文件 + `bun run build:opencode`（流程见 CLAUDE.md §Vendor Patch 管理）。
- [ ] 涉及 OpenCode/MCP/Gateway/IMA/Tauri 的改动 → 已对照 `docs/gotchas.md` 对应章节，未踩已知坑。
- [ ] **跨平台自检（mac/win/linux，详见 `docs/conventions.md` §13）**：新增/改动代码无硬编码 `/` 拼路径、无 `process.env.HOME`、无硬编码 `:`(PATH)/`​/tmp`、无 unix-only 命令（`lsof`/`ps`/`pgrep`/`which`/`open`/`/bin/sh`）未做平台分支；Renderer 路径用 `path-utils`（吃 `\`）；unix-only API/crate 已 `#[cfg]` 门控。**强制门禁是 CI**（`.github/workflows/ci.yml` 三平台 typecheck+test+`cargo test`）——本机改完无法验 Windows，靠 CI 兜底；本机至少 `turbo run typecheck` + `cargo test`(src-tauri) 绿。
- [ ] 失败如实报告：测试红了就说红了，不把"跳过"说成"通过"。

## 3. 状态门禁（仅里程碑式变更）

- [ ] `docs/requirements.md` 功能状态标记已更新（`🔲→✅` / `[ ]→[x]`）。
- [ ] `docs/architecture-phase1.md` 顶部状态表 / Module Overview / Data Flow 已对齐。
- [ ] 有架构决策 → 新建 `docs/decisions/NNN-*.md` 并更新索引；被取代的 ADR 标 Superseded。
- [ ] `AGENTS.md` 包状态 / Key Files / ADR 计数已更新。
- [ ] `CHANGELOG.md` `## [Unreleased]` 已追加摘要。

---

> 与收尾流程的关系：`CLAUDE.md` §任务收尾流程是**动作清单**（怎么做），本文是**验收清单**（做没做到）。收尾结束前对照本页过一遍。
