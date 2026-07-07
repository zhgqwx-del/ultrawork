# ADR-043: 办公 CLI 连接器 — CLI-first 集成范式（飞书 / 钉钉 / 企微三阶段）

- 状态：Accepted（✅ Phase 1 飞书 2026-07-06 · ✅ Phase 2 钉钉 2026-07-07 · ✅ Phase 3 企微 2026-07-07 —— 三家全部实现并真机验收，范式收官）
- 日期：2026-07-06
- 关联：[discussions/027](../discussions/027-office-cli-connectors.md)（完整调研 + Step0 实测 + 真机契约回填，SSOT）、ADR-040/041（内置技能依赖探针 / zip 分发）、ADR-036（工具披露——本范式对其零影响）、gotchas §14（lark-cli 上游契约坑 SSOT）

## 背景

钉钉/飞书/企微三家均已官方开源 Agent-native CLI（本地进程、JSON 输出、dry-run、schema 自省、自带 Agent Skills、凭证自管 OS Keychain），且**三家不约而同拒绝 MCP-first**。要把办公能力接进 agent，有「包一层 MCP wrapper」与「CLI 连接器」两条路线（对比 027 §2）。Phase 1 用门槛最低的飞书 lark-cli 跑通整套框架。

## 决策

### D1 — 「CLI 连接器」卡片范式，刻意不是 MCP
设置页「连接器」分区（原「MCP 连接器」更名，内分 MCP / 办公 CLI 两组）管 检测/安装/鉴权/健康状态；**不写 OpenCode `mcp` 配置**，调用由内置技能引导 agent 走 bash。收益：保留 CLI 原生 `--dry-run`/`--jq`/schema 自省；数百命令零工具表膨胀（对 ADR-036 披露零压力）；凭证由 CLI 自管系统钥匙串，app 全程不碰 token；进程用时 spawn 用完即走。

### D2 — 安装 = Rust 直下 Go 二进制（pin + sha256 + 双源）
不经 npm/内嵌 Node（027 原设想，Step0 实测后拍板偏差）：npm 包只是 wrapper，真身是 GitHub Release 的 Go 二进制。`install_pinned_cli`（数据驱动 `CliInstallSpec`，Phase 2/3 加 spec 不复制管线）：pin 版本 + 6 平台产物 sha256 硬编码校验（照抄官方 install.js 的校验逻辑与 GitHub→npmmirror `/-/binary/` 双源链）→ 解压落 `~/.ultrawork/office-cli/bin`。

### D3 — 自管目录领跑 rich_path（全局 PATH 优先级决策）
`~/.ultrawork/office-cli/bin` 前置到 `compute_rich_path()` **首位**：pin+校验过的二进制必须压过用户 brew/npm 旧装（否则 UI 显示 pin 版已连接、agent bash 却解析到旧版跑挂）；该目录只放自管 CLI，前置无副作用。rich_path memoize + sidecar spawn 时继承 → mid-session 安装免重启即对探针与 agent bash 可见。**调试提示**：用户自装的 lark-cli 升级不会生效（自管版恒优先），这是刻意行为。

### D4 — 鉴权 = 托管页 config init + OAuth 设备流，连接器级授权用 `--recommend`
`config init --new` 输出托管页 URL（**无需手建 App ID**，浏览器完成建应用；child 先入 slot 防双击竞态、pid 守卫清理、app 退出排空）；授权走设备流 `--no-wait --json` + `--device-code` 阻塞轮询。**`--recommend` 而非 `--domain all`**（真机复验实证：`--domain all` 重复授权触发「开通申请审核」流，人工审核不发 token；`--recommend` 免审批 scope 秒过且覆盖上百项）；日历等审核域由技能任务时增量补授。上游六个真机契约坑（stderr 分流/无 ok 状态文档/verification_url/部分授予语义等）SSOT 在 gotchas §14，实拍 payload 单测锚定。

### D5 — 技能 = 薄路由（feishu-assistant，第 7 个内置技能）
lark-cli 把 27 个官方技能**内嵌在二进制里**（`skills list/read`，与版本同步）→ 我们的技能不转译副本，只教 agent：健康检查分诊（`identities.user.available` 判据）→ 按域 `skills read` 加载官方文档 → 安全底线（dry-run/`--yes` 须用户确认/静噪 env）→ 「scope 不足 ≠ 未授权」增量授权路由（不回设置页）。零漂移零维护，走 ADR-041 zip 管线分发。

## 后果

- 与 Gateway 钉钉 channel 规划（入站消息）正交可共存；本范式是 agent→厂商 的出站工具能力。
- bump lark-cli pin：更新 `LARK_CLI_VERSION` + 6 平台 sha256（npm 包 checksums.txt）+ 逐条复核 gotchas §14 契约 + 重跑真机授权流。
- ~~Phase 2 钉钉增量~~ **已交付（2026-07-07）**：探针分类器（`authenticated` 布尔判据——dws 输出契约与 lark 多轴相反，SSOT gotchas §14 dws 段）+ `OFFICE_CLI_CONNECTORS` 条目 + dingtalk-assistant（第 8 个内置技能，薄路由到 materialize 的官方 mono 文档）+ **第六态 `not_enabled`**（token 交换后 CLI 侧白名单检查 → 管理员姓名 + 旧版设置页深链引导）；泛化债已还：`CLI_CHILD_SLOTS: HashMap<id, PendingCliChild>` + hook generation 按 id 拆。**D2 的落地偏差**：dws 是双工件（二进制 + dws-skills.zip）且 npm 源与 GitHub 源 darwin 字节不同 → 不套 `CliInstallSpec` 而共享 helpers（download_to/verify_sha256/extract_tar），GitHub 逐文件 pin ↔ npm 整 tarball pin；**bump dws pin**：更新 `DWS_CLI_VERSION` + 6 平台 sha256（release checksums.txt）+ `DWS_SKILLS_ZIP_SHA256` + `DWS_NPM_TARBALL_SHA256`，并逐条复核 gotchas §14 dws 契约。
- ~~Phase 3 企微增量~~ **已交付（2026-07-07，范式收官）**：`init --noninteractive` 实证存在（QR 扫码流，凭证服务端下发 CLI 自存——「UI 收集凭证」兜底方案不需要，app 零碰凭证原则三家守住）。**第三种安装形态**：GitHub 零 Release，npm 平台分包直下（5 平台、npm↔npmmirror 字节相同单 hash pin、`CliInstallSpec` 扩 `bin_subdir`）；**第三种探针契约**（`auth show` 纯文本 sentinel / JSON `{id,create_time}`）；四态状态机（无 not_configured/not_enabled；规模分级属技能层）。**rule-of-three 泛化全部兑现**：`CLI_CONNECTORS` 注册表（五分发点收敛 + 接线测试）、`CliProbeSpec`/`ParkedFlowSpec`/`ParkedCompleteSpec` 骨架去重、e2e `mkConn` mock 工厂。wecom-assistant 官方文档走 **vendored 单一 commit 快照**（上游无版本化技能工件；SKILL.md→INDEX.md 防嵌套误扫，快照必须 `git archive` 级整树核实——`git checkout -- ` 混合快照坑两轮审查各抓一次）。**bump wecom pin**：更新 `WECOM_CLI_VERSION` + 5 平台 tarball sha256（npm registry 实测）+ 重快照 `references/official/`（整树同一 commit）+ 逐条复核 gotchas §14 wecom 段。
- 新增第四家连接器的成本（泛化后）：Rust 一行注册表 + spec 常量 + 专属 start/complete fn、前端一行 `OFFICE_CLI_CONNECTORS` + 6 个 i18n 键 ×2 语言（有 tripwire 测试）+ DEP_HINTS/BUILTIN_DEP_MAP/SKILL_DEP_BINS 各一条 + 薄路由技能 + e2e `mkConn` 一项。
- 验证资产（Phase 3 收官口径）：cargo 67（三家实拍 payload 锚定 + 注册表接线/checksum 表完整性）· desktop vitest 328（含 `cli-connector-i18n` 键完备 tripwire）· 真浏览器 e2e `office-cli-ui-walkthrough` 11/11（三卡全状态机，回归套件）· 三家真机全流程 + agent 端到端各一轮（lark：缺 scope 增量授权续跑；dws：白名单开通→授权→官方文档按需加载→真调 contact 域；wecom：扫码建机器人→6 品类分级实测→真调 todo 域）。
