# 来源与许可（provenance）

本目录是企业微信官方 wecom-cli 仓库 `skills/` 的 vendored 快照：

- 上游仓库：https://github.com/WecomTeam/wecom-cli
- 快照 commit：`72e14f7695f34d28f1ff23ea504ddd2210a87c13`（npm `@wecom/cli@0.1.9` 的 gitHead——与连接器 pin 的 CLI 版本严格对应）
- 许可：MIT（见同目录 `LICENSE`）
- 唯一改动：各技能的 `SKILL.md` 改名为 `INDEX.md`（避免被 OpenCode 的 `skills/**/SKILL.md` 递归扫描识别成独立技能，绕过 wecom-assistant 的健康检查路由）；内容零改动，内部 `references/` 相对链接不受影响。

**维护**：bump `WECOM_CLI_VERSION`（lib.rs）时，从新版本 npm 包的 gitHead 重新快照本目录（保持 INDEX.md 改名），并复核 gotchas §14 wecom 段契约。

上游无随版本分发的技能工件（官方走 `npx skills add` 拉 repo HEAD、不 pin），vendored 快照是与 pin 版本对应的唯一可靠方式——工具 schema 本就由 CLI 服务端动态发现，文档漂移风险低。
